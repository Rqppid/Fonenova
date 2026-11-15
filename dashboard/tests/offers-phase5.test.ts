import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoLiveView } from '@/components/offers/golive-view'
import { InvoiceSteps, type InvoiceSetup } from '@/components/offers/invoice-steps'
import { DEFAULT_DRAFT_SETTINGS, type XeroApi, type XeroInvoiceDetail } from '@/lib/offers/draft'
import { checkEdit } from '@/lib/offers/edit'
import { seedClients, type Client } from '@/lib/offers/clients'
import { goLiveChecks, MANUAL_ITEMS, readyToGoLive, type GoLiveFacts } from '@/lib/offers/golive'
import { approveInvoice, confirmBill, expectedCostCents, fileInvoice, sendInvoice, suggestBills, type InvoiceDeps } from '@/lib/offers/invoice-flow'
import type { Fulfilment, Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'
import type { XeroInvoice, XeroPair } from '@/lib/types'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...Array.from({ length: 200 }, (_, i) => i % 255)])
const WAVE_CONTACT = '1597cc5c-fbed-4817-a4e1-53149bb46d77'

function mutexStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const tails = new Map<string, Promise<unknown>>()
  return {
    name: 'mem', data,
    async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } },
    async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) },
    async del(k: StoreKey) { data.delete(k) },
    async withLock<T>(name: string, fn: () => Promise<T>) {
      const prev = tails.get(name) ?? Promise.resolve()
      const run = prev.then(fn, fn)
      tails.set(name, run.catch(() => {}))
      return run
    },
  }
}

/** A real accepted offer for Wave (or the test client) whose draft 2026051 exists in Xero. */
function offer(o: { test?: boolean; approve?: Fulfilment['approve']; send?: Fulfilment['send']; orgName?: string } = {}): Offer {
  const test = o.test === true
  const f: Fulfilment = { orderRef: test ? 'TEST-001' : 'FN-ORD-016', test, startedAt: HOURS(3), reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1, invoiceId: 'inv-1', invoiceNumber: '2026051', org: o.orgName ?? (test ? 'Demo Company (UK)' : 'Fonenova Ltd') }, ...(o.approve ? { approve: o.approve } : {}), ...(o.send ? { send: o.send } : {}) }
  return {
    id: 'of_p5', status: 'accepted',
    source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'Mobile One <bv@mobileone.example>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) },
    text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }],
    shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null },
    pricing: { clientId: test ? 'c_test' : 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(4) },
    sends: [{ clientId: test ? 'c_test' : 'c_wave', clientName: test ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 481_000, shippingCents: 24_000, units: 10, test, gmailMessageId: 'g1', outcome: 'accepted', resolvedAt: HOURS(1) }],
    fulfilment: f, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [],
  }
}

interface XeroState { isDemo: boolean; orgName: string; invoice: Partial<XeroInvoiceDetail> | null; approveFails?: boolean; stayDraft?: boolean; emailFails?: boolean; pdf?: Uint8Array; calls: { approve: number; email: number; pdf: number }; sentFlag: boolean }
function fakeXero(init: Partial<XeroState> = {}) {
  const st: XeroState = { isDemo: false, orgName: 'Fonenova Ltd', invoice: {}, calls: { approve: 0, email: 0, pdf: 0 }, sentFlag: false, ...init }
  const base = (): XeroInvoiceDetail => ({ id: 'inv-1', number: '2026051', status: 'DRAFT', reference: 'FN-ORD-016', currency: 'EUR', totalCents: 481_000, contactId: WAVE_CONTACT, contactEmail: 'accounts@wave.example', hasAddress: true, sentToContact: st.sentFlag })
  const api: XeroApi = {
    async organisation() { return { name: st.orgName, isDemo: st.isDemo } },
    async invoiceNumbers() { return ['2026047'] },
    async findByReference() { return null },
    async createDraft() { throw new Error('not used') },
    async getInvoice() { return st.invoice === null ? null : { ...base(), ...st.invoice, sentToContact: st.sentFlag || st.invoice.sentToContact === true } },
    async approveInvoice() { st.calls.approve++; if (st.approveFails) throw new Error('Xero would not approve it: nope'); if (!st.stayDraft) st.invoice = { ...st.invoice, status: 'AUTHORISED' } },
    async emailInvoice() { st.calls.email++; if (st.emailFails) throw new Error('Xero emailing failed (500)'); st.sentFlag = true },
    async invoicePdf() { st.calls.pdf++; return st.pdf ?? PDF },
  }
  return { api, st }
}

function setup(o: Offer, x: ReturnType<typeof fakeXero>, opts: { allowLive?: boolean; allowApprove?: boolean; allowReal?: boolean; dirs?: InvoiceDeps['filing']['dirs']; upload?: InvoiceDeps['filing']['upload']; client?: Partial<Client>; bills?: XeroInvoice[]; pairs?: XeroPair[] } = {}) {
  const store = mutexStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: ['accounts@wave.example'], ...opts.client } : c.id === 'c_test' ? { ...c, xeroContactId: WAVE_CONTACT, invoiceEmails: ['owner@example.test'], ...opts.client } : c)))
  const pings: { text: string; link?: { label: string; url: string } }[] = []
  const uploads: { path: string; size: number }[] = []
  const saved: XeroPair[] = []
  const d: InvoiceDeps = {
    store, now: NOW, dashboardUrl: 'https://dashboard.example.test', allowReal: opts.allowReal ?? false, allowLiveXero: opts.allowLive ?? false, allowApprove: opts.allowApprove ?? false, ownerAddress: 'owner@example.test',
    notify: async (t, l) => { pings.push({ text: t, link: l }); return true },
    knownOrderIds: async () => [], xero: () => x.api, reply: async () => ({ id: 'r' }), replied: async () => false,
    filing: { dirs: opts.dirs === undefined ? { wave: 'Documents/Invoices/Wave', telecom: 'Documents/Invoices/Telecom', other: 'Documents/Invoices/Other' } : opts.dirs, upload: opts.upload ?? (async (path, bytes) => { uploads.push({ path, size: bytes.length }); return { kind: 'ok' } }) },
    bills: async () => ({ bills: opts.bills ?? [], pairs: opts.pairs ?? [] }),
    savePair: async (p) => { saved.push(p) },
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, pings, uploads, saved, get }
}
const LIVE_ON = { allowLive: true, allowApprove: true, allowReal: true }

describe('approving', () => {
  it('needs the confirmation, and does nothing without it', async () => {
    const x = fakeXero(); const t = setup(offer(), x, LIVE_ON)
    expect(await approveInvoice('of_p5', t.d, { confirm: false })).toMatchObject({ ok: false, message: expect.stringContaining('confirmation') })
    expect(x.st.calls.approve).toBe(0)
  })
  it('approves a real draft in the live organisation when both switches are on, checks the result, and tells you nothing was sent', async () => {
    const x = fakeXero(); const t = setup(offer(), x, LIVE_ON)
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(x.st.calls.approve).toBe(1)
    expect(t.get().fulfilment!.approve).toMatchObject({ state: 'done' })
    expect(t.pings.at(-1)!.text).toContain('Invoice 2026051 approved')
    expect(t.pings.at(-1)!.text).toContain('Nothing has been sent yet')
  })
  it('live approving is its own switch: off without OFFERS_ALLOW_APPROVE, and without live Xero', async () => {
    const x = fakeXero()
    const a = setup(offer(), x, { allowLive: true, allowApprove: false })
    expect(await approveInvoice('of_p5', a.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('OFFERS_ALLOW_APPROVE') })
    const b = setup(offer(), x, { allowLive: false, allowApprove: true })
    expect(await approveInvoice('of_p5', b.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('XERO_WRITE_ALLOW_LIVE') })
    expect(x.st.calls.approve).toBe(0)
  })
  it('a test invoice is never approved in the live organisation, but can be in the Demo Company without any switch', async () => {
    const live = fakeXero(); const a = setup(offer({ test: true, orgName: 'Fonenova Ltd' }), live, LIVE_ON)
    expect(await approveInvoice('of_p5', a.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('never approved in the live') })
    expect(live.st.calls.approve).toBe(0)
    const demo = fakeXero({ isDemo: true, orgName: 'Demo Company (UK)', invoice: { reference: 'TEST-001' } }); const b = setup(offer({ test: true }), demo)
    expect(await approveInvoice('of_p5', b.d, { confirm: true })).toMatchObject({ ok: true })
    expect(demo.st.calls.approve).toBe(1)
  })
  it('a real order is not approved in a demo organisation', async () => {
    const x = fakeXero({ isDemo: true, orgName: 'Demo Company (UK)' }); const t = setup(offer({ orgName: 'Demo Company (UK)' }), x)
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: false })
    expect(x.st.calls.approve).toBe(0)
  })
  it('refuses when the selected organisation is not the one the draft was made in', async () => {
    const x = fakeXero({ orgName: 'Demo Company (UK)', isDemo: true }); const t = setup(offer(), x, LIVE_ON)
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('not the one this draft was made in') })
    expect(x.st.calls.approve).toBe(0)
  })
  it.each([
    ['the total changed in Xero', { totalCents: 480_000 }, 'accepted'],
    ['it is not in euros', { currency: 'GBP' }, 'not euros'],
    ['the contact was swapped', { contactId: '99999999-0000-0000-0000-000000000000' }, 'different contact'],
    ['the contact has no address', { hasAddress: false }, 'Add an address in Xero before approving'],
    ['the address cannot be checked', { hasAddress: null }, 'Could not check'],
    ['it is no longer a draft', { status: 'VOIDED' }, 'voided in Xero'],
  ])('blocks when %s, and approves nothing', async (_n, inv, text) => {
    const x = fakeXero({ invoice: inv as Partial<XeroInvoiceDetail> }); const t = setup(offer(), x, LIVE_ON)
    const r = await approveInvoice('of_p5', t.d, { confirm: true })
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining(text) })
    expect(x.st.calls.approve).toBe(0)
    expect(t.get().fulfilment!.approve).toMatchObject({ state: 'blocked' })
  })
  it('a draft that is already approved in Xero is marked done without approving again; one deleted in Xero is blocked', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' } }); const t = setup(offer(), x, LIVE_ON)
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(x.st.calls.approve).toBe(0)
    const y = fakeXero({ invoice: null }); const u = setup(offer(), y, LIVE_ON)
    expect(await approveInvoice('of_p5', u.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('not in Xero any more') })
  })
  it('three clicks at once approve once', async () => {
    const x = fakeXero(); const t = setup(offer(), x, LIVE_ON)
    await Promise.all([1, 2, 3].map(() => approveInvoice('of_p5', t.d, { confirm: true })))
    expect(x.st.calls.approve).toBe(1)
  })
  it('if Xero does not show it approved afterwards, it is a failure that says to check Xero', async () => {
    const x = fakeXero({ stayDraft: true }); const t = setup(offer(), x, LIVE_ON)
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('Check it in Xero') })
    expect(t.get().fulfilment!.approve!.state).toBe('failed')
  })
})

describe('sending', () => {
  const approved = { state: 'done' as const, at: HOURS(1) }
  it('needs the approval first, and the confirmation', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' } })
    const t = setup(offer(), x, LIVE_ON)
    expect(await sendInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: false, message: 'Approve the invoice first.' })
    const u = setup(offer({ approve: approved }), x, LIVE_ON)
    expect(await sendInvoice('of_p5', u.d, { confirm: false })).toMatchObject({ ok: false })
    expect(x.st.calls.email).toBe(0)
  })
  it('emails a real client only with live Xero AND real sending on, each its own switch', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' } })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), x, { allowLive: true, allowReal: false }).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('OFFERS_ALLOW_REAL_SEND') })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), x, { allowLive: false, allowReal: true }).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('XERO_WRITE_ALLOW_LIVE') })
    expect(x.st.calls.email).toBe(0)
    const t = setup(offer({ approve: approved }), x, LIVE_ON)
    expect(await sendInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(x.st.calls.email).toBe(1)
    expect(t.get().fulfilment!.send).toMatchObject({ state: 'done', detail: 'accounts@wave.example' })
    expect(t.pings.some((p) => p.text.includes('2026051 was emailed to accounts@wave.example'))).toBe(true)
  })
  it('a test invoice is never sent from the live organisation; in the Demo Company it goes only to the owner\'s own address', async () => {
    const live = fakeXero({ invoice: { status: 'AUTHORISED' } })
    expect(await sendInvoice('of_p5', setup(offer({ test: true, orgName: 'Fonenova Ltd', approve: approved }), live, LIVE_ON).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('never sent from the live') })
    const demo = fakeXero({ isDemo: true, orgName: 'Demo Company (UK)', invoice: { status: 'AUTHORISED', reference: 'TEST-001', contactEmail: 'owner@example.test' } })
    const t = setup(offer({ test: true, approve: approved }), demo)
    expect(await sendInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    const stranger = fakeXero({ isDemo: true, orgName: 'Demo Company (UK)', invoice: { status: 'AUTHORISED', reference: 'TEST-001', contactEmail: 'someone@else.example' } })
    expect(await sendInvoice('of_p5', setup(offer({ test: true, approve: approved }), stranger).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('not one of') })
    expect(stranger.st.calls.email).toBe(0)
  })
  it('refuses when Xero would email an address that is not one of the client\'s invoice emails, or none', async () => {
    const wrong = fakeXero({ invoice: { status: 'AUTHORISED', contactEmail: 'old@wave.example' } })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), wrong, LIVE_ON).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('old@wave.example') })
    const none = fakeXero({ invoice: { status: 'AUTHORISED', contactEmail: null } })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), none, LIVE_ON).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('no email address') })
    const noClientEmails = fakeXero({ invoice: { status: 'AUTHORISED' } })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), noClientEmails, { ...LIVE_ON, client: { invoiceEmails: [] } }).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('no invoice email') })
    expect(wrong.st.calls.email + none.st.calls.email + noClientEmails.st.calls.email).toBe(0)
  })
  it('only an approved invoice is sent, and one Xero already emailed is not emailed again', async () => {
    const draft = fakeXero({ invoice: { status: 'DRAFT' } })
    expect(await sendInvoice('of_p5', setup(offer({ approve: approved }), draft, LIVE_ON).d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('only an approved one') })
    const sent = fakeXero({ invoice: { status: 'AUTHORISED', sentToContact: true } }); const t = setup(offer({ approve: approved }), sent, LIVE_ON)
    expect(await sendInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(sent.st.calls.email).toBe(0)
  })
  it('three clicks at once send once', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' } }); const t = setup(offer({ approve: approved }), x, LIVE_ON)
    await Promise.all([1, 2, 3].map(() => sendInvoice('of_p5', t.d, { confirm: true })))
    expect(x.st.calls.email).toBe(1)
  })
  it('a failed email says it may or may not have gone, is not retried by itself, and the next press checks Xero first', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' }, emailFails: true }); const t = setup(offer({ approve: approved }), x, LIVE_ON)
    const r = await sendInvoice('of_p5', t.d, { confirm: true })
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('may or may not have been sent') })
    expect(t.get().fulfilment!.send!.state).toBe('failed')
    x.st.sentFlag = true // it had gone after all
    expect(await sendInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true, message: expect.stringContaining('already emailed') })
    expect(x.st.calls.email).toBe(1)
  })
  it('files the PDF straight after a successful send, and a filing problem never undoes the send', async () => {
    const x = fakeXero({ invoice: { status: 'AUTHORISED' } })
    const t = setup(offer({ approve: approved }), x, LIVE_ON)
    await sendInvoice('of_p5', t.d, { confirm: true })
    expect(t.uploads).toEqual([{ path: 'Documents/Invoices/Wave/Invoice-2026051/Invoice-2026051.pdf', size: PDF.length }])
    const y = fakeXero({ invoice: { status: 'AUTHORISED' } })
    const u = setup(offer({ approve: approved }), y, { ...LIVE_ON, upload: async () => ({ kind: 'error', message: 'OneDrive could not be reached' }) })
    expect(await sendInvoice('of_p5', u.d, { confirm: true })).toMatchObject({ ok: true })
    expect(u.get().fulfilment!.send!.state).toBe('done')
    expect(u.get().fulfilment!.filing).toMatchObject({ state: 'failed', reason: 'OneDrive could not be reached' })
  })
})

describe('filing the PDF', () => {
  const approved = { state: 'done' as const, at: HOURS(1) }
  it('is skipped, with the reason, when the folders are not set up', async () => {
    const x = fakeXero(); const t = setup(offer({ approve: approved }), x, { ...LIVE_ON, dirs: null })
    expect(await fileInvoice('of_p5', t.d)).toMatchObject({ ok: false, message: expect.stringContaining('INVOICE_FILING_DIRS') })
    expect(t.get().fulfilment!.filing!.state).toBe('skipped')
    expect(x.st.calls.pdf).toBe(0)
  })
  it('only files an approved invoice, once, in the client\'s own folder as <number>.pdf', async () => {
    const x = fakeXero(); const t = setup(offer({ approve: approved }), x, LIVE_ON)
    expect(await fileInvoice('of_p5', setup(offer(), x, LIVE_ON).d)).toMatchObject({ ok: false, message: expect.stringContaining('Approve the invoice first') })
    expect(await fileInvoice('of_p5', t.d)).toMatchObject({ ok: true })
    expect(await fileInvoice('of_p5', t.d)).toMatchObject({ ok: true, message: 'Already filed.' })
    expect(t.uploads).toEqual([{ path: 'Documents/Invoices/Wave/Invoice-2026051/Invoice-2026051.pdf', size: PDF.length }])
    expect(t.get().fulfilment!.filing).toMatchObject({ state: 'done', detail: 'Documents/Invoices/Wave/Invoice-2026051/Invoice-2026051.pdf' })
  })
  it('an existing file is left alone and said so; a OneDrive problem is a failure that can be tried again', async () => {
    const x = fakeXero()
    const a = setup(offer({ approve: approved }), x, { ...LIVE_ON, upload: async () => ({ kind: 'exists' }) })
    expect(await fileInvoice('of_p5', a.d)).toMatchObject({ ok: true, message: expect.stringContaining('left alone') })
    const b = setup(offer({ approve: approved }), x, { ...LIVE_ON, upload: async () => ({ kind: 'unavailable', message: 'OneDrive is not connected on the dashboard' }) })
    expect(await fileInvoice('of_p5', b.d)).toMatchObject({ ok: false })
    expect(b.get().fulfilment!.filing).toMatchObject({ state: 'failed' })
    expect(await fileInvoice('of_p5', b.d)).toMatchObject({ ok: false }) // pressing again tries again (failed is not 'done')
  })
})

describe('the OneDrive PDF module', () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals() })
  const JSON_DIRS = JSON.stringify({ wave: 'Documents/Invoices/Wave Phone', telecom: 'C:\\Users\\x\\OneDrive\\Documents\\Invoices\\EU Telecoms', other: 'Documents/Invoices/Other' })
  it('reads the three folders (Windows paths too) and refuses anything unusable', async () => {
    const { filingDirs } = await import('@/lib/onedrive-invoice')
    expect(filingDirs(JSON_DIRS)).toEqual({ wave: 'Documents/Invoices/Wave Phone', telecom: 'Documents/Invoices/EU Telecoms', other: 'Documents/Invoices/Other' })
    for (const bad of [undefined, '', 'not json', '{}', JSON.stringify({ wave: 'a', telecom: 'b' }), JSON.stringify({ wave: '../x', telecom: 'b', other: 'c' }), JSON.stringify({ wave: 'a', telecom: '', other: 'c' })]) expect(filingDirs(bad), String(bad)).toBeNull()
  })
  it('only ever names Invoice-<7 digits>.pdf, and never in the ledger or VAT locations', async () => {
    const { filingDirs, invoiceFilePath } = await import('@/lib/onedrive-invoice')
    const dirs = filingDirs(JSON_DIRS)!
    expect(invoiceFilePath(dirs, 'wave', '2026051')).toBe('Documents/Invoices/Wave Phone/Invoice-2026051/Invoice-2026051.pdf')
    for (const n of ['', '2026', 'INV-0001', '../2026051', '20260511']) expect(invoiceFilePath(dirs, 'wave', n), n).toBeNull()
    process.env.FN_ONEDRIVE_EXPENSES_DIR = 'Documents/Invoices/Wave Phone'
    expect(invoiceFilePath(dirs, 'wave', '2026051')).toBeNull()
  })
  it('creates and never replaces: conflict means "already there"; no write access, a bad file or name is refused before anything is sent', async () => {
    vi.resetModules()
    const fs = await import('node:fs'); const os = await import('node:os'); const pth = await import('node:path')
    const dir = fs.mkdtempSync(pth.join(os.tmpdir(), 'fn-pdf-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, MS_CLIENT_ID: 'ms-id' })
    const seen: { url: string; method: string }[] = []
    let status = 201
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { seen.push({ url, method: init.method ?? 'GET' }); return new Response('{}', { status }) }))
    try {
      const { getStore } = await import('@/lib/store')
      const { fileInvoicePdf } = await import('@/lib/onedrive-invoice')
      const store = getStore()
      expect(await fileInvoicePdf('A/Invoice-2026051/Invoice-2026051.pdf', PDF, store)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('not connected') })
      await store.set('onedrive:tokens', { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scope: 'Files.Read offline_access' })
      expect(await fileInvoicePdf('A/Invoice-2026051/Invoice-2026051.pdf', PDF, store)).toMatchObject({ kind: 'unavailable', message: expect.stringContaining('no write access') })
      await store.set('onedrive:tokens', { accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scope: 'Files.ReadWrite offline_access' })
      expect(await fileInvoicePdf('A/2026051.pdf', PDF, store)).toMatchObject({ kind: 'error' })
      expect(await fileInvoicePdf('A/Invoice-2026051/Invoice-2026051.pdf', new Uint8Array([1, 2, 3]), store)).toMatchObject({ kind: 'error' })
      expect(seen).toHaveLength(0)
      expect(await fileInvoicePdf('A B/Invoice-2026051.pdf', PDF, store)).toEqual({ kind: 'ok' })
      expect(seen[0].method).toBe('PUT')
      expect(decodeURIComponent(seen[0].url)).toContain('conflictBehavior=fail')
      expect(seen[0].url).toContain('A%20B/Invoice-2026051.pdf')
      status = 409
      expect(await fileInvoicePdf('A/Invoice-2026051/Invoice-2026051.pdf', PDF, store)).toEqual({ kind: 'exists' })
      status = 403
      expect(await fileInvoicePdf('A/Invoice-2026051/Invoice-2026051.pdf', PDF, store)).toMatchObject({ kind: 'unavailable' })
      expect(seen.every((s) => s.method === 'PUT')).toBe(true) // nothing is ever deleted or read back
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("matching Mobile One's bill", () => {
  const bill = (id: string, cents: number, p: Partial<XeroInvoice> = {}): XeroInvoice => ({ id, number: `MO-${id}`, reference: '', kind: 'bill', status: 'AUTHORISED', contactName: 'Mobile One Trade B.V.', currency: 'EUR', date: '2026-11-13', dueDate: null, totalCents: cents, amountDueCents: cents, amountPaidCents: 0, payments: [], ...p })
  const o = offer()
  const cost = 10 * 45_000 + 12_000 // items at Mobile One's prices + Mobile One's shipping
  it('the order cost is the items plus Mobile One\'s shipping', () => expect(expectedCostCents(o)).toBe(cost))
  it('suggests unpaired Mobile One euro bills within 1% of the cost, closest first, and nothing else', () => {
    const pairs: XeroPair[] = [{ orderId: 'FN-ORD-010', invoiceId: 'i', billId: 'taken-bill-0000000000000000', confirmedAt: '' }]
    const list = [bill('b1-0000000000000000000', cost + 500), bill('b2-0000000000000000000', cost), bill('taken-bill-0000000000000000', cost), bill('b4-0000000000000000000', cost, { contactName: 'Someone Else' }), bill('b5-0000000000000000000', cost, { currency: 'GBP' }), bill('b6-0000000000000000000', cost, { status: 'VOIDED' }), bill('b7-0000000000000000000', cost * 2), bill('b8-0000000000000000000', cost, { kind: 'sale' })]
    expect(suggestBills(o, list, pairs).map((b) => [b.id, b.diffCents])).toEqual([['b2-0000000000000000000', 0], ['b1-0000000000000000000', 500]])
  })
  it('pairing saves a Xero pair (order, the draft invoice, the bill) and remembers it on the offer', async () => {
    const t = setup(offer(), fakeXero(), { bills: [bill('b2-0000000000000000000', cost)] })
    expect(await confirmBill('of_p5', 'b2-0000000000000000000', t.d)).toMatchObject({ ok: true })
    expect(t.saved).toEqual([{ orderId: 'FN-ORD-016', invoiceId: 'inv-1', billId: 'b2-0000000000000000000', confirmedAt: NOW.toISOString() }])
    expect(t.get().fulfilment!.bill).toMatchObject({ billNumber: 'MO-b2-0000000000000000000', totalCents: cost })
    expect(await confirmBill('of_p5', 'b2-0000000000000000000', t.d)).toMatchObject({ ok: false, message: expect.stringContaining('already paired') })
  })
  it('refuses a bill that is not a suggestion, a test order, and an order with no draft', async () => {
    const t = setup(offer(), fakeXero(), { bills: [bill('b2-0000000000000000000', cost)] })
    expect(await confirmBill('of_p5', 'zzzzzzzzzzzzzzzzzzzz', t.d)).toMatchObject({ ok: false, message: expect.stringContaining('not a suggestion') })
    const u = setup(offer({ test: true }), fakeXero({ isDemo: true }), { bills: [bill('b2-0000000000000000000', cost)] })
    expect(await confirmBill('of_p5', 'b2-0000000000000000000', u.d)).toMatchObject({ ok: false, message: expect.stringContaining('test order') })
    expect(u.saved).toHaveLength(0)
  })
})

describe('the screen and the edit checks', () => {
  const setupOn: InvoiceSetup = { allowApprove: false, allowReal: false, allowLiveXero: true, filingConfigured: false, orgIsLive: true }
  const render = (o: Offer, s: InvoiceSetup | undefined = setupOn, bills = []) => renderToString(h(InvoiceSteps, { offer: o, setup: s, bills })).replace(/<!-- -->/g, '')
  it('approve is disabled until the box is ticked, and says when live approving is off', () => {
    const html = render(offer())
    expect(html).toContain('data-testid="approve-button"')
    expect(html).toMatch(/data-testid="approve-button"[^>]*disabled|disabled[^>]*data-testid="approve-button"/)
    expect(html).toContain('OFFERS_ALLOW_APPROVE')
    expect(html).toContain('I have checked the draft in Xero')
    expect(html).toContain('Approve it first.')
    expect(html).toContain('data-testid="filing-off"')
  })
  it('shows done steps, the bill candidates and filing state', () => {
    const o = offer({ approve: { state: 'done', at: HOURS(1) }, send: { state: 'done', at: HOURS(1), detail: 'accounts@wave.example' } })
    o.fulfilment!.filing = { state: 'done', detail: 'Documents/Invoices/Wave/Invoice-2026051/Invoice-2026051.pdf' }
    const html = render(o, { ...setupOn, filingConfigured: true }, [{ id: 'b1', number: 'MO-1', supplier: 'Mobile One Trade B.V.', date: '2026-11-13', totalCents: 462_000, diffCents: 0 }] as never)
    expect(html).toContain('Emailed by Xero to accounts@wave.example')
    expect(html).toContain('Documents/Invoices/Wave/Invoice-2026051/Invoice-2026051.pdf')
    expect(html).toContain('data-testid="bill-candidate"')
    expect(html).toContain('Pair this bill')
  })
  it('a test offer has no bill step; nothing shows before the draft exists', () => {
    expect(render(offer({ test: true }))).not.toContain('data-testid="step-bill"')
    const noDraft = offer(); noDraft.fulfilment!.draft = { state: 'pending', attempts: 0 }
    expect(render(noDraft)).toBe('')
  })
  it('the new actions are checked: confirmation defaults to no, the bill id must look like one', () => {
    expect(checkEdit({ action: 'invoice_approve', id: 'of_p5' })).toEqual({ ok: true, value: { action: 'invoice_approve', id: 'of_p5', confirm: false } })
    expect(checkEdit({ action: 'invoice_send', id: 'of_p5', confirm: true })).toEqual({ ok: true, value: { action: 'invoice_send', id: 'of_p5', confirm: true } })
    expect(checkEdit({ action: 'invoice_send', id: 'of_p5', confirm: 'yes' })).toEqual({ ok: true, value: { action: 'invoice_send', id: 'of_p5', confirm: false } })
    expect(checkEdit({ action: 'invoice_file', id: 'of_p5' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'bill_confirm', id: 'of_p5', billId: 'b2-0000000000000000000' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'bill_confirm', id: 'of_p5', billId: 'x' })).toMatchObject({ ok: false })
  })
})

describe('Telegram when the draft is ready', () => {
  it('says the invoice is ready to check and approve, and the button opens the offer on the dashboard (it approves nothing)', async () => {
    const { fulfilOffer } = await import('@/lib/offers/fulfil')
    const o = offer({ test: true }); delete o.fulfilment; o.status = 'accepted'
    const created: unknown[] = []
    const store = mutexStore(); store.data.set('offers', [o]); store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_test' ? { ...c, xeroContactId: WAVE_CONTACT } : c)))
    const pings: { text: string; link?: { label: string; url: string } }[] = []
    const api: XeroApi = { async organisation() { return { name: 'Demo Company (UK)', isDemo: true } }, async invoiceNumbers() { return [] }, async findByReference() { return null }, async createDraft(b) { created.push(b); return { id: 'inv-9', number: b.InvoiceNumber, status: 'DRAFT' } } }
    await fulfilOffer('of_p5', { store, now: NOW, dashboardUrl: 'https://dashboard.example.test', allowReal: false, allowLiveXero: false, ownerAddress: 'owner@example.test', notify: async (t, l) => { pings.push({ text: t, link: l }); return true }, knownOrderIds: async () => [], xero: () => api, reply: async () => ({ id: 'r' }), replied: async () => false })
    const last = pings.at(-1)!
    expect(last.text).toContain('invoice 2026001 is ready to check and approve')
    expect(last.text).toContain('nothing approved or sent')
    expect(last.link).toEqual({ label: 'Approve on dashboard', url: 'https://dashboard.example.test/offers?id=of_p5' })
    expect(created).toHaveLength(1)
  })
})

describe('the go-live checklist', () => {
  const facts = (p: Partial<GoLiveFacts> = {}): GoLiveFacts => ({
    xero: { configured: true, connected: true, isDemo: false, orgName: 'Fonenova Ltd' },
    flags: { allowLiveXero: true, allowReal: false, allowApprove: true, filingConfigured: true },
    gmail: { connected: true, canRead: true }, oneDrive: { connected: true, canWrite: true }, telegram: true,
    settings: { ...DEFAULT_DRAFT_SETTINGS, brandingThemeId: 'aaaaaaaa-0000-0000-0000-000000000000' },
    clients: seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: ['accounts@wave.example'], offerEmails: ['offers@wave.example'] } : c.id === 'c_eutelecoms' ? { ...c, termsConfirmed: true, invoiceEmails: ['a@eu.example'], offerEmails: ['o@eu.example'] } : c)),
    offers: [{ ...offer({ test: true, approve: { state: 'done' }, send: { state: 'done' } }) }],
    ticks: Object.fromEntries(MANUAL_ITEMS.map((m) => [m.id, '2026-11-15T09:00:00Z'])),
    ...p,
  })
  const find = (cs: ReturnType<typeof goLiveChecks>, id: string) => cs.find((c) => c.id === id)!
  it('everything in place except the final switch is "ready", and real sending is shown as its own step, off', () => {
    const cs = goLiveChecks(facts())
    expect(readyToGoLive(cs)).toBe(true)
    expect(find(cs, 'switch_real_send')).toMatchObject({ status: 'todo' })
    expect(find(cs, 'demo_journey').status).toBe('ok')
  })
  it('a fresh system has things to do: nothing connected, no real client ready, nothing ticked', () => {
    const cs = goLiveChecks(facts({ xero: { configured: true, connected: false, isDemo: null, orgName: null }, flags: { allowLiveXero: false, allowReal: false, allowApprove: false, filingConfigured: false }, clients: seedClients(), offers: [], ticks: {} }))
    expect(readyToGoLive(cs)).toBe(false)
    expect(find(cs, 'xero_write').status).toBe('todo')
    expect(find(cs, 'client_c_wave').detail).toContain('payment terms not chosen')
    expect(cs.filter((c) => c.group === 'manual').every((c) => c.status === 'todo')).toBe(true)
  })
  it('every real client needs terms, a Xero contact and offer and invoice emails; the test client is not on the list', () => {
    const cs = goLiveChecks(facts({ clients: seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: [], offerEmails: ['o@x.example'] } : c)) }))
    expect(find(cs, 'client_c_wave').detail).toContain('no invoice email')
    expect(cs.some((c) => c.id === 'client_c_test')).toBe(false)
    expect(readyToGoLive(cs)).toBe(false)
  })
  it('an unticked manual item blocks "ready"; a demo with a draft but no approve and send is a warning, not done', () => {
    expect(readyToGoLive(goLiveChecks(facts({ ticks: {} })))).toBe(false)
    expect(find(goLiveChecks(facts({ offers: [offer({ test: true })] })), 'demo_journey').status).toBe('warn')
  })
  it('the screen shows the groups, the manual items as tick boxes, and the summary', () => {
    const html = renderToString(h(GoLiveView, { checks: goLiveChecks(facts({ ticks: {} })), ready: false })).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="golive-summary"')
    expect(html).toContain('still to do')
    expect(html).toContain('Only you can confirm these')
    expect(html.match(/type="checkbox"/g)).toHaveLength(MANUAL_ITEMS.length)
    expect(html).toContain('stay separate on purpose')
  })
})
