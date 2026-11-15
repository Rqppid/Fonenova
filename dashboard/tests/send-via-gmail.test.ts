import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { XeroWriteCard } from '@/components/dashboard/xero-write-card'
import { InvoiceSteps } from '@/components/offers/invoice-steps'
import { DEFAULT_DRAFT_SETTINGS, type XeroApi, type XeroInvoiceDetail } from '@/lib/offers/draft'
import { seedClients } from '@/lib/offers/clients'
import { sendInvoice, type InvoiceDeps } from '@/lib/offers/invoice-flow'
import { mimeMessage } from '@/lib/gmail'
import type { Fulfilment, Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, ...Array.from({ length: 300 }, (_, i) => i % 251)])
const WAVE = '1597cc5c-fbed-4817-a4e1-53149bb46d77'

function mem(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const tails = new Map<string, Promise<unknown>>()
  return { name: 'mem', data, async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(n: string, fn: () => Promise<T>) { const prev = tails.get(n) ?? Promise.resolve(); const run = prev.then(fn, fn); tails.set(n, run.catch(() => {})); return run } }
}

function offer(test = false): Offer {
  const f: Fulfilment = { orderRef: test ? 'TEST-001' : 'FN-ORD-016', test, startedAt: HOURS(3), reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1, invoiceId: 'inv-1', invoiceNumber: '2026051', org: test ? 'Demo Company (UK)' : 'Fonenova Ltd' }, approve: { state: 'done', at: HOURS(1) } }
  return { id: 'of_g1', status: 'accepted', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'M <m@x.example>', to: 'i@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }], shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null }, pricing: { clientId: test ? 'c_test' : 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(4) }, sends: [{ clientId: test ? 'c_test' : 'c_wave', clientName: test ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 481_000, shippingCents: 24_000, units: 10, test, gmailMessageId: 'g1', outcome: 'accepted', resolvedAt: HOURS(1) }], fulfilment: f, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

function setup(o: Offer, opts: { isDemo?: boolean; inv?: Partial<XeroInvoiceDetail>; mailFails?: boolean; noMail?: boolean; allowReal?: boolean; allowLive?: boolean; clientEmails?: string[] } = {}) {
  const isDemo = opts.isDemo ?? o.fulfilment!.test
  const store = mem()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: opts.clientEmails ?? ['accounts@wave.example', 'finance@wave.example'] } : c.id === 'c_test' ? { ...c, xeroContactId: WAVE, invoiceEmails: opts.clientEmails ?? ['owner@example.test'] } : c)))
  const mails: { to: string; subject: string; text: string; html: string; attachments: { filename: string; mime: string; bytes: Uint8Array }[] }[] = []
  const calls = { xeroEmail: 0, pdf: 0 }
  const inv = { id: 'inv-1', number: '2026051', status: 'AUTHORISED', reference: 'x', currency: 'EUR', totalCents: 481_000, contactId: WAVE, contactEmail: 'accounts@wave.example', hasAddress: true, sentToContact: false, ...opts.inv } as XeroInvoiceDetail
  const api: XeroApi = { async organisation() { return { name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo } }, async invoiceNumbers() { return [] }, async findByReference() { return null }, async createDraft() { throw new Error('n/a') }, async getInvoice() { return { ...inv } }, async emailInvoice() { calls.xeroEmail++ }, async invoicePdf() { calls.pdf++; return PDF } }
  const pings: string[] = []
  const d: InvoiceDeps = { store, now: NOW, allowReal: opts.allowReal ?? true, allowLiveXero: opts.allowLive ?? true, allowApprove: true, ownerAddress: 'owner@example.test', notify: async (t) => { pings.push(t); return true }, knownOrderIds: async () => [], xero: () => api, reply: async () => ({ id: 'r' }), replied: async () => false,
    ...(opts.noMail ? {} : { mail: async (m) => { if (opts.mailFails) throw new Error('Gmail did not send it (500)'); mails.push(m); return { id: 'gm1' } } }),
    filing: { dirs: null, upload: async () => ({ kind: 'ok' }) }, bills: async () => ({ bills: [], pairs: [] }), savePair: async () => {} }
  return { d, mails, calls, pings, get: () => (store.data.get('offers') as Offer[])[0] }
}

describe('sending the invoice through Gmail with the PDF attached', () => {
  it('sends from the connected Gmail to every invoice email of the client, with the invoice PDF, and does not use Xero\'s email', async () => {
    const t = setup(offer())
    expect(await sendInvoice('of_g1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    expect(t.mails).toHaveLength(1)
    const m = t.mails[0]
    expect(m.to).toBe('accounts@wave.example, finance@wave.example')
    expect(m.subject).toBe('Invoice 2026051 from FoneNova Ltd')
    expect(m.text).toContain('invoice 2026051 for €4,810.00 (EUR)')
    expect(m.attachments).toHaveLength(1)
    expect(m.attachments[0]).toMatchObject({ filename: 'Invoice-2026051.pdf', mime: 'application/pdf' })
    expect(m.attachments[0].bytes).toEqual(PDF)
    expect(t.calls.xeroEmail).toBe(0)
    expect(t.get().fulfilment!.send).toMatchObject({ state: 'done', detail: 'accounts@wave.example, finance@wave.example (Gmail, PDF attached)' })
    expect(t.pings.some((p) => p.includes('2026051 was emailed to accounts@wave.example'))).toBe(true)
  })
  it('a test invoice is marked [TEST] and is only ever sent in the Demo Company', async () => {
    const t = setup(offer(true))
    expect(await sendInvoice('of_g1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    expect(t.mails[0].subject).toBe('[TEST] Invoice 2026051 from FoneNova Ltd')
    expect(t.mails[0].to).toBe('owner@example.test')
    const live = setup(offer(true), { isDemo: false })
    live.get().fulfilment!.draft.org = 'Fonenova Ltd'
    ;(live.d.store as ReturnType<typeof mem>).data.set('offers', [{ ...live.get(), fulfilment: { ...live.get().fulfilment!, draft: { ...live.get().fulfilment!.draft, org: 'Fonenova Ltd' } } }])
    expect(await sendInvoice('of_g1', live.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('never sent from the live') })
    expect(live.mails).toHaveLength(0)
  })
  it('keeps the same gates as every other send: the confirmation, the approval, live Xero and real sending', async () => {
    expect(await sendInvoice('of_g1', setup(offer()).d, { confirm: false, via: 'gmail' })).toMatchObject({ ok: false })
    const unapproved = offer(); delete unapproved.fulfilment!.approve
    expect(await sendInvoice('of_g1', setup(unapproved).d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: 'Approve the invoice first.' })
    const noReal = setup(offer(), { allowReal: false })
    expect(await sendInvoice('of_g1', noReal.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('OFFERS_ALLOW_REAL_SEND') })
    const noLive = setup(offer(), { allowLive: false })
    expect(await sendInvoice('of_g1', noLive.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('XERO_WRITE_ALLOW_LIVE') })
    expect(noReal.mails.length + noLive.mails.length).toBe(0)
  })
  it('sends only an approved invoice for the total the client accepted, to an address that exists', async () => {
    expect(await sendInvoice('of_g1', setup(offer(), { inv: { status: 'DRAFT' } }).d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('only an approved one') })
    expect(await sendInvoice('of_g1', setup(offer(), { inv: { totalCents: 480_000 } }).d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('not what the client accepted') })
    expect(await sendInvoice('of_g1', setup(offer(), { clientEmails: [] }).d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('no invoice email') })
    const a = setup(offer(), { noMail: true })
    expect(await sendInvoice('of_g1', a.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('Gmail is not connected') })
  })
  it('does not depend on the Xero contact\'s email, which the Xero way does', async () => {
    const t = setup(offer(), { inv: { contactEmail: null } })
    expect(await sendInvoice('of_g1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    const x = setup(offer(), { inv: { contactEmail: null } })
    expect(await sendInvoice('of_g1', x.d, { confirm: true, via: 'xero' })).toMatchObject({ ok: false, message: expect.stringContaining('no email address') })
  })
  it('three clicks at once send once; an already-emailed invoice is not emailed again; a failure says where to look and is not retried by itself', async () => {
    const t = setup(offer())
    await Promise.all([1, 2, 3].map(() => sendInvoice('of_g1', t.d, { confirm: true, via: 'gmail' })))
    expect(t.mails).toHaveLength(1)
    const sent = setup(offer(), { inv: { sentToContact: true } })
    expect(await sendInvoice('of_g1', sent.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true, message: expect.stringContaining('already emailed') })
    expect(sent.mails).toHaveLength(0)
    const bad = setup(offer(), { mailFails: true })
    expect(await sendInvoice('of_g1', bad.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('Sent folder of info@fonenova.com') })
    expect(bad.get().fulfilment!.send!.state).toBe('failed')
  })
  it('the Xero way still works as before', async () => {
    const t = setup(offer())
    expect(await sendInvoice('of_g1', t.d, { confirm: true, via: 'xero' })).toMatchObject({ ok: true })
    expect(t.calls.xeroEmail).toBe(1)
    expect(t.mails).toHaveLength(0)
  })
  it('the panel has both buttons, Gmail first', () => {
    const o = offer(); delete o.fulfilment!.send
    const html = renderToString(h(InvoiceSteps, { offer: o, setup: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: true, orgIsLive: true } })).replace(/<!-- -->/g, '')
    expect(html.indexOf('send-gmail-button')).toBeGreaterThan(-1)
    expect(html.indexOf('send-gmail-button')).toBeLessThan(html.indexOf('send-xero-button'))
    expect(html).toContain('Send with Gmail (PDF attached)')
    expect(html).toContain('Use one, not both')
  })
})

describe('the Gmail message with an attachment', () => {
  const raw = mimeMessage({ from: 'info@fonenova.com', to: 'a@x.example, b@x.example', subject: 'Invoice 2026051 – €', text: 'Hello', html: '<p>Hello</p>', fromName: 'FoneNova', attachments: [{ filename: 'Invoice-2026051.pdf', mime: 'application/pdf', bytes: PDF }] })
  it('is a mixed message: text and html together, then the PDF as an attachment, every line short', () => {
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="qpm_')
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="qp_')
    expect(raw).toContain('Content-Type: application/pdf; name="Invoice-2026051.pdf"')
    expect(raw).toContain('Content-Disposition: attachment; filename="Invoice-2026051.pdf"')
    expect(raw).toContain('To: a@x.example, b@x.example')
    expect(raw.split('\r\n').every((l) => l.length <= 998)).toBe(true)
    const b64 = raw.split('Content-Disposition: attachment; filename="Invoice-2026051.pdf"\r\n\r\n')[1].split('\r\n--qpm_')[0].replace(/\r\n/g, '')
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(PDF)) // the file survives intact
  })
  it('a plain message is unchanged: no attachments, no mixed wrapper', () => {
    const plain = mimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 't', html: '<p>t</p>' })
    expect(plain).toContain('multipart/alternative')
    expect(plain).not.toContain('multipart/mixed')
  })
  it('a hostile file name cannot break out of its header', () => {
    const m = mimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 't', html: 'h', attachments: [{ filename: 'a"\r\nBcc: evil@x.example.pdf', mime: 'application/pdf', bytes: PDF }] })
    expect(m).not.toMatch(/\r\nBcc: evil/)
  })
})

describe('the Settings card shows the organisation it is for', () => {
  const base = { configured: true, connected: true, settings: DEFAULT_DRAFT_SETTINGS }
  const card = (isDemo: boolean, theme: string) => renderToString(h(XeroWriteCard, { state: { ...base, orgName: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo, orgs: [{ tenantId: isDemo ? 'demo-id' : 'live-id', name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo, selected: true, justConnected: false }], settings: { ...DEFAULT_DRAFT_SETTINGS, brandingThemeId: theme } } as never, notice: null })).replace(/<!-- -->/g, '')
  it('each organisation\'s own theme is what it starts with', () => {
    expect(card(false, '50f6809e-live')).toContain('value="50f6809e-live"')
    expect(card(true, 'f9b09cb4-demo')).toContain('value="f9b09cb4-demo"')
    expect(card(false, '50f6809e-live')).not.toContain('f9b09cb4-demo')
  })
})

describe('the Invoice block says what happened', () => {
  const render = (o: Offer) => renderToString(h(InvoiceSteps, { offer: o, setup: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: true, orgIsLive: true } })).replace(/<!-- -->/g, '')
  it('a Gmail send reads "Emailed from info@fonenova.com", a Xero send reads "Emailed by Xero"', () => {
    const g = offer(); g.fulfilment!.send = { state: 'done', at: HOURS(1), detail: 'info@fonenova.com (Gmail, PDF attached)' }
    expect(render(g)).toContain('Emailed from info@fonenova.com to info@fonenova.com (Gmail, PDF attached)')
    expect(render(g)).not.toContain('Emailed by Xero')
    const x = offer(); x.fulfilment!.send = { state: 'done', at: HOURS(1), detail: 'accounts@wave.example' }
    expect(render(x)).toContain('Emailed by Xero to accounts@wave.example')
  })
})
