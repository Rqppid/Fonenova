import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientsView } from '@/components/offers/clients-view'
import { InvoiceSteps } from '@/components/offers/invoice-steps'
import { buildDraftBody, DEFAULT_DRAFT_SETTINGS, raiseDraft, themeFor, type DraftBody, type XeroApi, type XeroInvoiceDetail } from '@/lib/offers/draft'
import { checkEdit } from '@/lib/offers/edit'
import { parseFilingDirs, pdfPathFor, isInvoicePdfPath } from '@/lib/offers/filing-paths'
import { checkClients, FOLDERS, seedClients } from '@/lib/offers/clients'
import { approveInvoice, fileInvoice, recheckDraft, type InvoiceDeps } from '@/lib/offers/invoice-flow'
import type { Fulfilment, Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const LIVE_THEME = '50f6809e-6b9b-4257-bfec-7cbba46712c7'
const DEMO_THEME = 'dddddddd-0000-0000-0000-000000000000'

function mem(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return { name: 'mem', data, async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(_n: string, fn: () => Promise<T>) { return fn() } }
}

// ---------------------------------------------------------------------------
// A branding theme belongs to one Xero organisation
// ---------------------------------------------------------------------------
describe('the branding theme is per organisation', () => {
  const s = { ...DEFAULT_DRAFT_SETTINGS, brandingThemeId: LIVE_THEME, brandingThemeIds: { 'demo-org-id': DEMO_THEME } }
  it('an organisation uses its own; the older single id is the live organisation\'s and never goes to a demo', () => {
    expect(themeFor(s, { id: 'DEMO-ORG-ID', isDemo: true })).toBe(DEMO_THEME) // matched whatever the letter case
    expect(themeFor(s, { id: 'other-demo', isDemo: true })).toBeNull() // the live id is never sent to a demo
    expect(themeFor(s, { id: 'live-org-id', isDemo: false })).toBe(LIVE_THEME)
    expect(themeFor({ ...s, brandingThemeIds: { 'live-org-id': 'cccccccc-0000-0000-0000-000000000000' } }, { id: 'live-org-id', isDemo: false })).toBe('cccccccc-0000-0000-0000-000000000000')
    expect(themeFor({ ...DEFAULT_DRAFT_SETTINGS }, { id: 'x', isDemo: false })).toBeNull()
  })
  const run = async (isDemo: boolean, id: string) => {
    const bodies: DraftBody[] = []
    const api: XeroApi = {
      async organisation() { return { name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo, id } },
      async invoiceNumbers() { return isDemo ? [] : ['2026047'] },
      async findByReference() { return null },
      async createDraft(b) { bodies.push(b); return { id: 'i', number: b.InvoiceNumber, status: 'DRAFT' } },
    }
    const client = isDemo ? { ...seedClients()[2], xeroContactId: '11111111-2222-3333-4444-555555555555' } : { ...seedClients()[0], termsConfirmed: true }
    await raiseDraft({ api, store: mem(), reference: isDemo ? 'TEST-001' : 'FN-ORD-016', client, test: isDemo, lines: [{ description: 'x', qty: 1, unitSaleCents: 100 }], settings: s, now: NOW, allowLive: true })
    return bodies[0]
  }
  it('a draft in the Demo Company no longer carries the live theme id (the TEST-009 failure)', async () => {
    expect((await run(true, 'some-demo')).BrandingThemeID).toBeUndefined()
    expect((await run(true, 'demo-org-id')).BrandingThemeID).toBe(DEMO_THEME)
  })
  it('a live draft still gets the live theme', async () => {
    expect((await run(false, 'live-org-id')).BrandingThemeID).toBe(LIVE_THEME)
  })
  it('buildDraftBody takes the theme it is given', () => {
    expect(buildDraftBody({ number: '1', reference: 'r', contactId: 'c', lines: [], terms: 'upfront', now: NOW, settings: { ...DEFAULT_DRAFT_SETTINGS, brandingThemeId: DEMO_THEME } }).BrandingThemeID).toBe(DEMO_THEME)
  })
})

describe('saving the theme from Settings', () => {
  const env = { ...process.env }
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    user.value = 'owner@example.test'
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-theme-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ BrandingThemes: [{ BrandingThemeID: LIVE_THEME, Name: 'Live' }, { BrandingThemeID: DEMO_THEME, Name: 'Demo' }] })))
  })
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }) })
  const tokens = async (tenantId: string | null, isDemo: boolean | null) => { const { getStore } = await import('@/lib/store'); await getStore().set('xero-write:tokens', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, tenantId, tenantName: 'x', isDemo }) }
  const put = async (themeId: string) => { const { PUT } = await import('@/app/api/offers/draft-settings/route'); return PUT(new Request('https://dashboard.example.test/api/offers/draft-settings', { method: 'PUT', headers: { origin: 'https://dashboard.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ taxType: 'NONE', accountCode: '200', brandingThemeId: themeId }) })) }
  const saved = async () => { const { getStore, getJson } = await import('@/lib/store'); return getJson<Record<string, unknown>>(getStore(), 'offers:draft-settings') }
  it('on a live organisation it sets that organisation\'s theme and the live id; on a demo only the demo\'s own', async () => {
    await tokens('LIVE-ORG', false)
    expect((await put(LIVE_THEME)).status).toBe(200)
    expect(await saved()).toMatchObject({ brandingThemeId: LIVE_THEME, brandingThemeIds: { 'live-org': LIVE_THEME } })
    await tokens('demo-org', true)
    expect((await put(DEMO_THEME)).status).toBe(200)
    expect(await saved()).toMatchObject({ brandingThemeId: LIVE_THEME, brandingThemeIds: { 'live-org': LIVE_THEME, 'demo-org': DEMO_THEME } }) // the live one is untouched
  })
  it('clearing it clears it for this organisation only, and a theme needs an organisation to belong to', async () => {
    await tokens('demo-org', true)
    await put(DEMO_THEME)
    await put('')
    expect((await saved())!.brandingThemeIds).toEqual({})
    await tokens(null, null)
    expect((await put(DEMO_THEME)).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Re-check, and a stale address warning
// ---------------------------------------------------------------------------
const WAVE = '1597cc5c-fbed-4817-a4e1-53149bb46d77'
function offer(warnings?: string[]): Offer {
  const f: Fulfilment = { orderRef: 'FN-ORD-016', test: false, startedAt: HOURS(3), reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1, invoiceId: 'inv-1', invoiceNumber: '2026051', org: 'Fonenova Ltd', ...(warnings ? { warnings } : {}) } }
  return { id: 'of_p5', status: 'accepted', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'M <m@x.example>', to: 'i@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }], shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null }, pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(4) }, sends: [{ clientId: 'c_wave', clientName: 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 481_000, shippingCents: 24_000, units: 10, test: false, gmailMessageId: 'g1', outcome: 'accepted', resolvedAt: HOURS(1) }], fulfilment: f, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}
function deps(o: Offer, inv: Partial<XeroInvoiceDetail>, opts: { dirs?: InvoiceDeps['filing']['dirs']; clientFolder?: 'wave' | 'telecom' | 'tradewise' | 'giglobal' | 'other'; uploads?: string[] } = {}) {
  const store = mem()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: ['a@wave.example'], folder: opts.clientFolder ?? c.folder } : c)))
  const state = { inv: { id: 'inv-1', number: '2026051', status: 'DRAFT', reference: 'FN-ORD-016', currency: 'EUR', totalCents: 481_000, contactId: WAVE, contactEmail: 'a@wave.example', hasAddress: true, sentToContact: false, ...inv } as XeroInvoiceDetail, approves: 0 }
  const api: XeroApi = {
    async organisation() { return { name: 'Fonenova Ltd', isDemo: false } }, async invoiceNumbers() { return [] }, async findByReference() { return null }, async createDraft() { throw new Error('n/a') },
    async getInvoice() { return { ...state.inv } }, async approveInvoice() { state.approves++; state.inv.status = 'AUTHORISED' }, async emailInvoice() {}, async invoicePdf() { return new Uint8Array([0x25, 0x50, 0x44, 0x46, ...Array.from({ length: 200 }, () => 1)]) },
  }
  const d: InvoiceDeps = { store, now: NOW, allowReal: true, allowLiveXero: true, allowApprove: true, ownerAddress: 'o@x.example', notify: async () => true, knownOrderIds: async () => [], xero: () => api, reply: async () => ({ id: 'r' }), replied: async () => false,
    filing: { dirs: opts.dirs === undefined ? { wave: 'W', telecom: 'T', other: 'O' } : opts.dirs, upload: async (p) => { opts.uploads?.push(p); return { kind: 'ok' } } }, bills: async () => ({ bills: [], pairs: [] }), savePair: async () => {} }
  return { d, state, get: () => (store.data.get('offers') as Offer[])[0] }
}

describe('re-checking the draft in Xero', () => {
  const STALE = ['Add an address in Xero before approving', 'Wave Phone B.V. already has an invoice in Xero from the last 14 days: 2026047 (2026-11-12, paid)']
  it('clears a stale address warning once the address is there, and keeps the other warnings', async () => {
    const t = deps(offer(STALE), { hasAddress: true })
    expect(await recheckDraft('of_p5', t.d)).toMatchObject({ ok: true, message: expect.stringContaining('has an address') })
    expect(t.get().fulfilment!.draft.warnings).toEqual([STALE[1]])
    expect(t.state.approves).toBe(0) // read-only
  })
  it('raises the warning if the address is missing now, and says when it cannot check', async () => {
    const a = deps(offer(), { hasAddress: false })
    await recheckDraft('of_p5', a.d)
    expect(a.get().fulfilment!.draft.warnings).toEqual(['Add an address in Xero before approving'])
    const b = deps(offer(), { hasAddress: null })
    await recheckDraft('of_p5', b.d)
    expect(b.get().fulfilment!.draft.warnings![0]).toContain('Could not check')
  })
  it('removes the warnings entirely when there are none left, and reports a draft that is gone', async () => {
    const t = deps(offer(['Add an address in Xero before approving']), { hasAddress: true })
    await recheckDraft('of_p5', t.d)
    expect(t.get().fulfilment!.draft.warnings).toBeUndefined()
    const gone = deps(offer(), {})
    const real = gone.d.xero()!
    gone.d.xero = () => ({ ...real, getInvoice: async () => null })
    expect(await recheckDraft('of_p5', gone.d)).toMatchObject({ ok: false, message: expect.stringContaining('not in Xero any more') })
  })
  it('a successful approval clears a stale address note too', async () => {
    const t = deps(offer(['Add an address in Xero before approving']), { hasAddress: true })
    expect(await approveInvoice('of_p5', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(t.get().fulfilment!.draft.warnings).toBeUndefined()
  })
  it('there is a Re-check button until it is approved, and the action is checked', () => {
    const html = renderToString(h(InvoiceSteps, { offer: offer(), setup: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: true, orgIsLive: true } })).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="recheck-button"')
    const done = offer(); done.fulfilment!.approve = { state: 'done', at: HOURS(1) }
    expect(renderToString(h(InvoiceSteps, { offer: done }))).not.toContain('recheck-button')
    expect(checkEdit({ action: 'draft_recheck', id: 'of_p5' })).toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// The Xero email call says what Xero said
// ---------------------------------------------------------------------------
describe('emailing through Xero', () => {
  const env = { ...process.env }
  let dir: string
  const seen: { method: string; path: string; body: string | null; contentType: string | null }[] = []
  const logs: string[] = []
  let answer: () => Response = () => new Response(null, { status: 204 })
  beforeEach(async () => {
    vi.resetModules()
    seen.length = 0; logs.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-mail-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
    const { getStore } = await import('@/lib/store')
    await getStore().set('xero-write:tokens', { accessToken: 'tok-secret', refreshToken: 'ref-secret', expiresAt: Date.now() + 3_600_000, tenantId: 'ten-1', tenantName: 'Demo', isDemo: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { seen.push({ method: init.method ?? 'GET', path: new URL(url).pathname, body: init.body ? String(init.body) : null, contentType: new Headers(init.headers).get('content-type') }); return answer() }))
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
  })
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
  it('posts the documented empty JSON object to the invoice\'s Email endpoint', async () => {
    const { xeroWriteApi } = await import('@/lib/xero/write')
    await xeroWriteApi().emailInvoice!('inv-1')
    expect(seen[0]).toEqual({ method: 'POST', path: '/api.xro/2.0/Invoices/inv-1/Email', body: '{}', contentType: 'application/json' })
  })
  it('a failure carries Xero\'s own message and status, and logs the (scrubbed) body, never a token', async () => {
    answer = () => new Response(JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Contact has no valid email address' }] }] }), { status: 400 })
    const { xeroWriteApi } = await import('@/lib/xero/write')
    await expect(xeroWriteApi().emailInvoice!('inv-1')).rejects.toThrow('Xero would not email it (400): Contact has no valid email address')
    answer = () => new Response('Internal error Bearer abc.def.ghi at line 5', { status: 500 })
    await expect(xeroWriteApi().emailInvoice!('inv-1')).rejects.toThrow(/Xero would not email it \(500\): Internal error \[removed\]/)
    const log = logs.join('\n')
    expect(log).toContain('xero-write-email-failed')
    for (const secret of ['tok-secret', 'ref-secret', 'abc.def.ghi']) expect(log).not.toContain(secret)
    answer = () => new Response('', { status: 403 })
    await expect(xeroWriteApi().emailInvoice!('inv-1')).rejects.toThrow('Reconnect the Xero write connection')
  })
})

// ---------------------------------------------------------------------------
// Filing laid out as Make filed
// ---------------------------------------------------------------------------
describe('filing paths match Make\'s folders', () => {
  const dirs = parseFilingDirs(JSON.stringify({
    wave: 'Desktop\\WAVE-PHONE\\Invoices Sent to Wave Phone By FoneNova\\Sent\\Wave Phone B.V',
    telecom: 'Desktop/EU-TELECOMS/Invoices',
    tradewise: 'Desktop/TRADE-WISE/Invoices Sent To Trade Wise-Holland',
    giglobal: 'Desktop/G&I GLOBAL/Invoices Sent 2 G & I Global Ltd',
    other: 'Desktop/SALES INVOICES - NEW CUSTOMERS',
  }))!
  it('each client folder gets the layout Make used', () => {
    expect(pdfPathFor(dirs, 'wave', '2026051', 'Wave Phone B.V.')).toBe('Desktop/WAVE-PHONE/Invoices Sent to Wave Phone By FoneNova/Sent/Wave Phone B.V/Invoice-2026051/Invoice-2026051.pdf')
    expect(pdfPathFor(dirs, 'telecom', '2026051', 'EU Telecoms BL EOOD')).toBe('Desktop/EU-TELECOMS/Invoices/Invoice-2026051/Invoice-2026051.pdf')
    expect(pdfPathFor(dirs, 'tradewise', '2026051', 'Trade Wise')).toBe('Desktop/TRADE-WISE/Invoices Sent To Trade Wise-Holland/FN-WT-Invoice-2026051/Invoice-2026051.pdf')
    expect(pdfPathFor(dirs, 'giglobal', '2026051', 'G&I Global Ltd')).toBe('Desktop/G&I GLOBAL/Invoices Sent 2 G & I Global Ltd/FN-G&I Global-Inv-2026051/Invoice-2026051.pdf')
    expect(pdfPathFor(dirs, 'other', '2026051', 'Acme / Phones: Ltd')).toBe('Desktop/SALES INVOICES - NEW CUSTOMERS/Acme - Phones- Ltd/Invoice-2026051.pdf')
  })
  it('refuses a bad number, a folder that was not given, and an unusable client name', () => {
    for (const n of ['', '2026', 'INV-1', '../2026051']) expect(pdfPathFor(dirs, 'wave', n, 'x'), n).toBeNull()
    expect(pdfPathFor({ wave: 'a', telecom: 'b', other: 'c' }, 'giglobal', '2026051', 'x')).toBeNull()
    expect(pdfPathFor(dirs, 'other', '2026051', '///')).not.toBeNull() // slashes become dashes, never a path
    expect(pdfPathFor(dirs, 'other', '2026051', '   ')).toBeNull()
  })
  it('wave, telecom and other are required; trade wise and G&I are optional; nothing can climb out of a folder', () => {
    expect(parseFilingDirs(JSON.stringify({ wave: 'a', telecom: 'b', other: 'c' }))).toEqual({ wave: 'a', telecom: 'b', other: 'c' })
    expect(parseFilingDirs(JSON.stringify({ wave: 'a', telecom: 'b' }))).toBeNull()
    expect(parseFilingDirs(JSON.stringify({ wave: 'a/../x', telecom: 'b', other: 'c' }))).toBeNull()
    expect(parseFilingDirs(JSON.stringify({ wave: 'a', telecom: 'b', other: 'c', tradewise: 5 }))).toBeNull()
    expect(parseFilingDirs('nope')).toBeNull()
    expect(parseFilingDirs(undefined)).toBeNull()
  })
  it('only Invoice-<number>.pdf names are filed', () => {
    expect(isInvoicePdfPath('A/Invoice-2026051/Invoice-2026051.pdf')).toBe(true)
    for (const p of ['A/2026051.pdf', 'A/Invoice-2026051.docx', 'A/Invoice-12.pdf', 'Invoice-2026051.pdf']) expect(isInvoicePdfPath(p), p).toBe(false)
    expect(isInvoicePdfPath('A/Invoice-2026051.pdf')).toBe(true)
  })
  it('the invoice flow files into the client\'s own folder, and says when that folder is not in the list', async () => {
    const uploads: string[] = []
    const o = offer(); o.fulfilment!.approve = { state: 'done', at: HOURS(1) }
    const t = deps(o, {}, { uploads })
    expect(await fileInvoice('of_p5', t.d)).toMatchObject({ ok: true })
    expect(uploads).toEqual(['W/Invoice-2026051/Invoice-2026051.pdf'])
    const o2 = offer(); o2.fulfilment!.approve = { state: 'done', at: HOURS(1) }
    const u = deps(o2, {}, { uploads: [], clientFolder: 'giglobal' })
    expect(await fileInvoice('of_p5', u.d)).toMatchObject({ ok: false, message: expect.stringContaining('No filing folder is set for') })
  })
  it('the Clients screen offers the five folders, and a client may be saved with any of them', () => {
    expect(FOLDERS.map((f) => f.key)).toEqual(['wave', 'telecom', 'tradewise', 'giglobal', 'other'])
    const html = renderToString(h(ClientsView, { clients: seedClients(), usedBy: {} }))
    expect(html).toContain('Trade Wise folder')
    expect(html).toContain('G&amp;I Global folder')
    const saved = seedClients()
    expect(checkClients(saved.map((c) => (c.id === 'c_wave' ? { ...c, folder: 'giglobal' } : c)), saved)).toMatchObject({ ok: true })
    expect(checkClients(saved.map((c) => (c.id === 'c_wave' ? { ...c, folder: 'desktop' } : c)), saved)).toMatchObject({ ok: false })
  })
})
