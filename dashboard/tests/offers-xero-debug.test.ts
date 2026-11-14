import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { DuplicateInvoiceNumber, raiseDraft, XeroRejected, DEFAULT_DRAFT_SETTINGS, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { fulfilOffer, retryFulfilment, type FulfilDeps } from '@/lib/offers/fulfil'
import { seedClients } from '@/lib/offers/clients'
import type { DraftDebug, Fulfilment, Offer, OfferSend } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const TENANT = '628a758c-1111-2222-3333-444455556666'
const ACCESS = 'access-token-SECRET-aaaa'
const REFRESH = 'refresh-token-SECRET-bbbb'
const XERO_ERR = JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Organisation is not subscribed to currency EUR' }] }] })

// ---------------------------------------------------------------------------
// The real client against a fake Xero: what is sent, which tenant, what is logged
// ---------------------------------------------------------------------------
describe('the Xero write client: request, tenant and log', () => {
  const env = { ...process.env }
  let dir: string
  const seen: { method: string; url: string; tenant: string | null; key: string | null; body: unknown }[] = []
  const logs: string[] = []
  const respond = vi.hoisted(() => ({ fn: (_p: string, _m: string): Response => new Response('unexpected', { status: 500 }) }))
  beforeEach(async () => {
    vi.resetModules()
    seen.length = 0; logs.length = 0
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-xd-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
    const { getStore } = await import('@/lib/store')
    await getStore().set('xero-write:tokens', { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000, tenantId: TENANT, tenantName: 'Demo Company (UK)', isDemo: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const h = new Headers(init.headers)
      seen.push({ method: init.method ?? 'GET', url, tenant: h.get('xero-tenant-id'), key: h.get('idempotency-key'), body: init.body ? JSON.parse(String(init.body)) : null })
      const u = new URL(url)
      return respond.fn(u.pathname.replace('/api.xro/2.0', '') + u.search, init.method ?? 'GET')
    }))
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
  })
  afterEach(() => {
    process.env = { ...env }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const draftBody = (): DraftBody => ({ Type: 'ACCREC', Status: 'DRAFT', InvoiceNumber: '2026001', Reference: 'TEST-001', Contact: { ContactID: '11111111-2222-3333-4444-555555555555' }, Date: '2026-11-15', DueDate: '2026-12-15', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', LineItems: [{ Description: 'x', Quantity: 10, UnitAmount: 412, AccountCode: '200', TaxType: 'NONE' }] })
  const json = (o: unknown, status = 200) => Response.json(o, { status })
  const demoXero = (p: string, m: string) => {
    if (p.startsWith('/Organisation')) return json({ Organisations: [{ OrganisationID: TENANT, Name: 'Demo Company (UK)', IsDemoCompany: true }] })
    if (m === 'POST') return new Response(XERO_ERR, { status: 400 })
    return json({})
  }

  it('records the endpoint, version, tenant, currency fields, key and Xero\'s raw error, and nothing secret', async () => {
    respond.fn = (p, m) => (p === '/connections' ? json([]) : demoXero(p, m))
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = new URL(String(url))
      const h2 = new Headers(init.headers)
      seen.push({ method: init.method ?? 'GET', url: String(url), tenant: h2.get('xero-tenant-id'), key: h2.get('idempotency-key'), body: init.body ? JSON.parse(String(init.body)) : null })
      if (u.hostname === 'api.xero.com' && u.pathname === '/connections') return json([{ tenantId: TENANT, tenantName: 'Demo Company (UK)', tenantType: 'ORGANISATION' }])
      return demoXero(u.pathname.replace('/api.xro/2.0', '') + u.search, init.method ?? 'GET')
    })
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const e = (await xeroWriteApi().createDraft(draftBody(), 'fn-draft-TEST-001-r0-n2026001').catch((x) => x)) as XeroRejected
    expect(e.name).toBe('XeroRejected')
    const d = e.debug as DraftDebug
    expect(d).toMatchObject({ method: 'POST', endpoint: 'https://api.xero.com/api.xro/2.0/Invoices', status: 400, idempotencyKey: 'fn-draft-TEST-001-r0-n2026001', tenant: '628a758c…', organisationId: '628a758c…', connections: ['Demo Company (UK) [628a758c…]'] })
    expect(d.apiVersion).toContain('2.0')
    expect(d.request).toMatchObject({ CurrencyCode: 'EUR', CurrencyRate: 'not sent', LineAmountTypes: 'Exclusive', Type: 'ACCREC', Status: 'DRAFT' })
    expect(JSON.parse(d.rawBody)).toEqual(JSON.parse(XERO_ERR))
    // nothing secret anywhere it can be seen or logged
    const everything = JSON.stringify(d) + logs.join('\n')
    for (const secret of [ACCESS, REFRESH, TENANT, 'Bearer']) expect(everything, secret).not.toContain(secret)
    expect(logs.join('\n')).toContain('xero-write-rejected')
    expect(logs.join('\n')).toContain('"CurrencyCode":"EUR"')
  })

  it('every request, the guard, the checks and the draft, carries the same tenant header', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init: RequestInit = {}) => {
      const u = new URL(String(url))
      const h2 = new Headers(init.headers)
      seen.push({ method: init.method ?? 'GET', url: String(url), tenant: h2.get('xero-tenant-id'), key: h2.get('idempotency-key'), body: null })
      if (u.pathname === '/connections') return json([{ tenantId: TENANT, tenantName: 'Demo Company (UK)', tenantType: 'ORGANISATION' }])
      return demoXero(u.pathname.replace('/api.xro/2.0', '') + u.search, init.method ?? 'GET')
    })
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const api = xeroWriteApi()
    await api.organisation()
    await api.invoiceNumbers()
    await api.findByReference('TEST-001')
    await api.createDraft(draftBody(), 'k').catch(() => {})
    await api.diagnose!(draftBody())
    const apiCalls = seen.filter((s) => s.url.includes('/api.xro/2.0/'))
    expect(apiCalls.length).toBeGreaterThan(6)
    expect(new Set(apiCalls.map((s) => s.tenant))).toEqual(new Set([TENANT]))
  })

  it('the diagnosis flags a tenant that Xero reports as a different organisation', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const u = new URL(String(url))
      if (u.pathname.endsWith('/Organisation')) return json({ Organisations: [{ OrganisationID: 'ffffffff-0000-0000-0000-000000000000', Name: 'Fonenova Ltd', IsDemoCompany: false }] })
      if (u.pathname.endsWith('/Currencies')) return json({ Currencies: [{ Code: 'EUR' }] })
      return json({ TaxRates: [{ TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true }], Accounts: [{ Code: '200', Status: 'ACTIVE', Type: 'REVENUE' }], Contacts: [{ ContactStatus: 'ACTIVE' }] })
    })
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const found = (await xeroWriteApi().diagnose!(draftBody())).join('\n')
    expect(found).toContain('carried tenant 628a758c… but Xero reports that tenant as organisation ffffffff… (Fonenova Ltd)')
  })
})

// ---------------------------------------------------------------------------
// A stored refusal must never answer a retry after the setting was fixed
// ---------------------------------------------------------------------------
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
const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
function testOffer(): Offer {
  const send: OfferSend = { clientId: 'c_test', clientName: 'Test client', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 457_000, units: 10, test: true, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return { id: 'of_t1', status: 'accepted', source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: null, from: 'TEST <t@example.invalid>', to: 'info@fonenova.com', subject: '[TEST]', receivedAt: HOURS(5) }, text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }], shipping: { mobileOneCents: 0, source: 'none', sourceText: null }, pricing: { clientId: 'c_test', marginCents: 700, overrides: {}, ackLow: false, pricedAt: HOURS(3) }, sends: [send], testOnly: true, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

/** A fake Xero that, like some APIs, answers a repeated idempotency key with the stored result of the first use. */
function replayingXero(state: { currencyOn: boolean; networkDropOnce?: boolean }) {
  const created: DraftBody[] = []
  const keys: string[] = []
  const stored = new Map<string, { ok: true; id: string } | { ok: false }>()
  const numbers: string[] = []
  const debug: DraftDebug = { at: '', method: 'POST', endpoint: 'e', apiVersion: 'v', tenant: '628a758c…', idempotencyKey: '', request: { CurrencyCode: 'EUR' }, status: 400, rawBody: XERO_ERR }
  const api: XeroApi = {
    async organisation() { return { name: 'Demo Company (UK)', isDemo: true } },
    async invoiceNumbers() { return [...numbers] },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b, key) {
      keys.push(key)
      const prior = stored.get(key)
      if (prior && !prior.ok) throw new XeroRejected(['Organisation is not subscribed to currency EUR'], 'Currency', { ...debug, idempotencyKey: key })
      if (!state.currencyOn) { stored.set(key, { ok: false }); throw new XeroRejected(['Organisation is not subscribed to currency EUR'], 'Currency', { ...debug, idempotencyKey: key }) }
      created.push(b); numbers.push(b.InvoiceNumber); stored.set(key, { ok: true, id: 'x' })
      if (state.networkDropOnce) { state.networkDropOnce = false; throw new Error('connection dropped') }
      return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' }
    },
  }
  return { api, created, keys }
}
function harness(state: { currencyOn: boolean; networkDropOnce?: boolean }) {
  const store = mutexStore()
  store.data.set('offers', [testOffer()])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_test' ? { ...c, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  const x = replayingXero(state)
  const d: FulfilDeps = { store, now: NOW, allowReal: false, ownerAddress: 'owner@example.test', notify: async () => true, knownOrderIds: async () => [], xero: () => x.api, reply: async () => ({ id: 'm1' }), replied: async () => false }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, x, get }
}

describe('retrying after a refusal uses a fresh idempotency key', () => {
  it('a stored refusal does not answer the retry once the currency is switched on', async () => {
    const state = { currencyOn: false }
    const t = harness(state)
    await fulfilOffer('of_t1', t.d)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'blocked', field: 'Currency', rejections: 1 })
    expect(t.get().fulfilment!.draft.debug).toMatchObject({ idempotencyKey: 'fn-draft-TEST-001-r0-n2026001', status: 400 })
    state.currencyOn = true
    await retryFulfilment('of_t1', t.d)
    expect(t.x.keys).toEqual(['fn-draft-TEST-001-r0-n2026001', 'fn-draft-TEST-001-r1-n2026001'])
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceNumber: '2026001', debug: undefined })
    expect(t.x.created).toHaveLength(1)
  })

  it('pressing again while still refused moves the key on each time, and never creates a draft', async () => {
    const t = harness({ currencyOn: false })
    await fulfilOffer('of_t1', t.d)
    await retryFulfilment('of_t1', t.d)
    await retryFulfilment('of_t1', t.d)
    expect(t.x.keys).toEqual(['fn-draft-TEST-001-r0-n2026001', 'fn-draft-TEST-001-r1-n2026001', 'fn-draft-TEST-001-r2-n2026001'])
    expect(t.x.created).toHaveLength(0)
  })

  it('an unknown outcome (a dropped connection after Xero saved it) keeps the key and adopts the draft, so there is never a second one', async () => {
    const t = harness({ currencyOn: true, networkDropOnce: true })
    await fulfilOffer('of_t1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('failed')
    await retryFulfilment('of_t1', t.d)
    await retryFulfilment('of_t1', t.d)
    expect(t.x.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceNumber: '2026001' })
    expect(t.get().fulfilment!.draft.rejections ?? 0).toBe(0)
  })

  it('five simultaneous presses after a fix still create exactly one draft', async () => {
    const state = { currencyOn: false }
    const t = harness(state)
    await fulfilOffer('of_t1', t.d)
    state.currencyOn = true
    await Promise.all(Array.from({ length: 5 }, () => retryFulfilment('of_t1', t.d)))
    expect(t.x.created).toHaveLength(1)
  })

  it('a taken invoice number uses a different key for the next number', async () => {
    const created: string[] = []
    const keys: string[] = []
    const api: XeroApi = {
      async organisation() { return { name: 'Fonenova Ltd', isDemo: false } },
      async invoiceNumbers() { return ['2026047'] },
      async findByReference() { return null },
      async createDraft(b, key) { keys.push(key); if (b.InvoiceNumber === '2026048') throw new DuplicateInvoiceNumber(); created.push(b.InvoiceNumber); return { id: 'i', number: b.InvoiceNumber, status: 'DRAFT' } },
    }
    const r = await raiseDraft({ api, store: mutexStore(), reference: 'FN-ORD-016', client: { ...seedClients()[0] }, test: false, lines: [{ description: 'x', qty: 1, unitSaleCents: 100 }], settings: DEFAULT_DRAFT_SETTINGS, now: NOW, allowLive: true })
    expect(r).toMatchObject({ ok: true, number: '2026049' })
    expect(keys).toEqual(['fn-draft-FN-ORD-016-n2026048', 'fn-draft-FN-ORD-016-n2026049'])
  })
})

describe('the panel shows the technical detail', () => {
  it('a collapsible block with the request and Xero\'s raw error', () => {
    const f: Fulfilment = { orderRef: 'TEST-001', test: true, startedAt: '', reply: { state: 'sent', attempts: 1 }, draft: { state: 'blocked', attempts: 0, reason: 'Xero rejected the draft invoice (Currency): Organisation is not subscribed to currency EUR', field: 'Currency', debug: { at: '', method: 'POST', endpoint: 'https://api.xero.com/api.xro/2.0/Invoices', apiVersion: 'Xero Accounting API 2.0', tenant: '628a758c…', idempotencyKey: 'k', request: { CurrencyCode: 'EUR', CurrencyRate: 'not sent' }, status: 400, rawBody: XERO_ERR } } }
    const html = renderToString(h(AfterAcceptance, { offer: { ...testOffer(), fulfilment: f } })).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="draft-debug"')
    expect(html).toContain('https://api.xero.com/api.xro/2.0/Invoices')
    expect(html).toContain('CurrencyRate')
    expect(html).toContain('not subscribed to currency EUR')
  })
})
