import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { XeroWriteCard } from '@/components/dashboard/xero-write-card'
import { DEFAULT_DRAFT_SETTINGS, DuplicateInvoiceNumber, parseXeroValidation, raiseDraft, XeroRejected, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { fulfilOffer, retryFulfilment, sweepFulfilment, type FulfilDeps } from '@/lib/offers/fulfil'
import { seedClients } from '@/lib/offers/clients'
import type { Fulfilment, Offer, OfferSend } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))

// ---------------------------------------------------------------------------
// Xero's 400 body, reduced to its messages
// ---------------------------------------------------------------------------
const body = (...messages: string[]) => JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }] })

describe('parseXeroValidation', () => {
  it('keeps the validation messages and guesses the field', () => {
    expect(parseXeroValidation(body('The BrandingThemeID is not valid'))).toEqual({ messages: ['The BrandingThemeID is not valid'], field: 'Branding theme' })
    expect(parseXeroValidation(body('Currency EUR is not enabled for this organisation')).field).toBe('Currency')
    expect(parseXeroValidation(body("Account code '200' is not a valid code for this document.")).field).toBe('Account code')
    expect(parseXeroValidation(body('The tax type NONE is not valid')).field).toBe('Tax type')
    expect(parseXeroValidation(body('Contact could not be found')).field).toBe('Contact')
    expect(parseXeroValidation(body('Something we have never seen')).field).toBeNull()
  })
  it('falls back to the top-level message, removes duplicates, caps length and count, strips bearer-like text', () => {
    expect(parseXeroValidation(JSON.stringify({ Message: 'A validation exception occurred', Detail: 'Bad thing' })).messages).toEqual(['Bad thing'])
    expect(parseXeroValidation(JSON.stringify({ Message: 'Only this' })).messages).toEqual(['Only this'])
    expect(parseXeroValidation(body('same', 'same', 'x'.repeat(1000))).messages.map((m) => m.length)).toEqual([4, 240])
    expect(parseXeroValidation(body(...Array.from({ length: 12 }, (_, i) => `m${i}`))).messages).toHaveLength(6)
    expect(parseXeroValidation(body('failed with Bearer abc.def-123 in it')).messages[0]).toBe('failed with [removed] in it')
  })
  it('never passes a body that is not JSON through', () => {
    expect(parseXeroValidation('<html>secret-looking page</html>')).toEqual({ messages: [], field: null })
  })
})

// ---------------------------------------------------------------------------
// The draft step
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
const HOURS = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const HASH = 'a'.repeat(64)

function testOffer(): Offer {
  const send: OfferSend = { clientId: 'c_test', clientName: 'Test client', to: ['x@example.test'], tokenHash: HASH, tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 457_000, units: 10, test: true, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return {
    id: 'of_t1', status: 'accepted',
    source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: null, from: 'TEST <t@example.invalid>', to: 'info@fonenova.com', subject: '[TEST]', receivedAt: HOURS(5) },
    text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }],
    shipping: { mobileOneCents: 0, source: 'none', sourceText: null },
    pricing: { clientId: 'c_test', marginCents: 700, overrides: {}, ackLow: false, pricedAt: HOURS(3) },
    sends: [send], testOnly: true, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [],
  }
}

function harness(opts: { reject?: () => boolean; loseAnswerOnce?: boolean; slow?: boolean } = {}) {
  const store = mutexStore()
  store.data.set('offers', [testOffer()])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_test' ? { ...c, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  const created: DraftBody[] = []
  const pings: string[] = []
  let lose = opts.loseAnswerOnce === true
  const numbers: string[] = []
  const api: XeroApi = {
    async organisation() { return { name: 'Demo Company (UK)', isDemo: true } },
    async invoiceNumbers() { return [...numbers] },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b) {
      if (opts.slow) await new Promise((r) => setTimeout(r, 15))
      if (opts.reject?.()) throw new XeroRejected(['The BrandingThemeID is not valid'], 'Branding theme')
      if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber()
      created.push(b); numbers.push(b.InvoiceNumber)
      if (lose) { lose = false; throw new Error('The connection dropped after Xero saved it') }
      return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' }
    },
    async diagnose() { return ['The saved branding theme id is not a theme in this organisation. Themes here: Standard (aaaaaaaa-0000-0000-0000-000000000000). Pick one in Settings.'] },
  }
  const d: FulfilDeps = {
    store, now: NOW, allowReal: false, ownerAddress: 'owner@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => [], xero: () => api, reply: async () => ({ id: 'm1' }), replied: async () => false,
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, api, created, pings, get }
}

describe('a Xero rejection is shown, not retried', () => {
  it('raiseDraft returns the messages, the field and the diagnosis, and is not retryable', async () => {
    const t = harness({ reject: () => true })
    const r = await raiseDraft({ api: t.api, store: t.store, reference: 'TEST-001', client: { ...seedClients()[2], xeroContactId: '11111111-2222-3333-4444-555555555555' }, test: true, lines: [{ description: 'x', qty: 1, unitSaleCents: 100 }], settings: DEFAULT_DRAFT_SETTINGS, now: NOW })
    expect(r).toMatchObject({ ok: false, retry: false, field: 'Branding theme' })
    expect((r as { error: string }).error).toContain('Xero rejected the draft invoice (Branding theme): The BrandingThemeID is not valid')
    expect((r as { details: string[] }).details).toEqual(['The BrandingThemeID is not valid', expect.stringContaining('Themes here: Standard')])
  })

  it('the offer shows it as blocked, tells you once, and the 5-minute check does not hammer Xero', async () => {
    const t = harness({ reject: () => true })
    const calls = vi.spyOn(t.api, 'createDraft')
    // a contact for the seed test client is saved in the store above; the test client's address is not needed for the draft
    await fulfilOffer('of_t1', t.d)
    const draft = t.get().fulfilment!.draft
    expect(draft).toMatchObject({ state: 'blocked', field: 'Branding theme', attempts: 0 })
    expect(draft.details).toHaveLength(2)
    expect(t.pings.filter((p) => p.includes('refused by Xero'))).toHaveLength(1)
    for (let i = 0; i < 4; i++) await sweepFulfilment(t.d)
    expect(calls).toHaveBeenCalledTimes(1)
    // Pressing Try again with the same problem repeats the check but not the alert.
    await retryFulfilment('of_t1', t.d)
    await retryFulfilment('of_t1', t.d)
    expect(calls).toHaveBeenCalledTimes(3)
    expect(t.pings.filter((p) => p.includes('refused by Xero'))).toHaveLength(1)
    expect(t.created).toHaveLength(0)
  })

  it('once the setting is fixed, Try again creates the draft and clears the messages', async () => {
    let bad = true
    const t = harness({ reject: () => bad })
    await fulfilOffer('of_t1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('blocked')
    bad = false
    await retryFulfilment('of_t1', t.d)
    const draft = t.get().fulfilment!.draft
    expect(draft).toMatchObject({ state: 'done', invoiceNumber: '2026001', details: undefined, field: undefined })
    expect(t.created).toHaveLength(1)
  })
})

describe('"Try again now" can be pressed repeatedly without duplicate drafts', () => {
  it('five presses at once create exactly one draft', async () => {
    const t = harness({ reject: () => false, slow: true })
    // start from a failed state so every press has work to do
    t.store.data.set('offers', [{ ...testOffer(), fulfilment: { orderRef: 'TEST-001', test: true, startedAt: HOURS(1), reply: { state: 'sent', attempts: 1 }, draft: { state: 'failed', attempts: 2, reason: 'Xero could not be reached' } } as Fulfilment }])
    await Promise.all(Array.from({ length: 5 }, () => retryFulfilment('of_t1', t.d)))
    expect(t.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceNumber: '2026001' })
  })

  it('presses after it is done do nothing', async () => {
    const t = harness()
    await fulfilOffer('of_t1', t.d)
    const before = t.get().fulfilment!.draft
    for (let i = 0; i < 3; i++) await retryFulfilment('of_t1', t.d)
    expect(t.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft).toEqual(before)
  })

  it('a first attempt that created the draft but lost the answer is adopted on the next press, not repeated', async () => {
    const t = harness({ loseAnswerOnce: true })
    await fulfilOffer('of_t1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('failed')
    expect(t.created).toHaveLength(1)
    await retryFulfilment('of_t1', t.d)
    await retryFulfilment('of_t1', t.d)
    expect(t.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceNumber: '2026001' })
  })
})

// ---------------------------------------------------------------------------
// The real client: 400 handling and the diagnosis, against a fake Xero
// ---------------------------------------------------------------------------
describe('the Xero write client', () => {
  const env = { ...process.env }
  let dir: string
  const respond = vi.hoisted(() => ({ fn: (_path: string, _method: string): Response => new Response('unexpected', { status: 500 }) }))
  beforeEach(async () => {
    vi.resetModules()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-xw-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
    const { getStore } = await import('@/lib/store')
    await getStore().set('xero-write:tokens', { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, tenantId: 'ten', tenantName: 'Demo Company (UK)', isDemo: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => respond.fn(new URL(url).pathname.replace('/api.xro/2.0', '') + new URL(url).search, init.method ?? 'GET')))
  })
  afterEach(() => {
    process.env = { ...env }
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const draftBody = (over: Partial<DraftBody> = {}): DraftBody => ({ Type: 'ACCREC', Status: 'DRAFT', InvoiceNumber: '2026001', Reference: 'TEST-001', Contact: { ContactID: '11111111-2222-3333-4444-555555555555' }, Date: '2026-11-15', DueDate: '2026-12-15', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', BrandingThemeID: 'bbbbbbbb-0000-0000-0000-000000000000', LineItems: [{ Description: 'x', Quantity: 1, UnitAmount: 1, AccountCode: '200', TaxType: 'NONE' }], ...over })
  const json = (o: unknown, status = 200) => Response.json(o, { status })

  it('turns a 400 into XeroRejected with the messages and field, never the raw body', async () => {
    respond.fn = (p, m) => (m === 'POST' && p.startsWith('/Invoices') ? new Response(body('The BrandingThemeID is not valid') + ' secret-trailer', { status: 400 }) : json({}))
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const { XeroRejected: Rejected } = await import('@/lib/offers/draft') // same module instance the client uses
    const e = await xeroWriteApi().createDraft(draftBody(), 'k').catch((x) => x)
    expect(e).toBeInstanceOf(Rejected)
    expect(e.messages).toEqual([])
    respond.fn = (p, m) => (m === 'POST' ? new Response(body('The BrandingThemeID is not valid'), { status: 400 }) : json({}))
    const e2 = await xeroWriteApi().createDraft(draftBody(), 'k').catch((x) => x)
    expect(e2).toMatchObject({ messages: ['The BrandingThemeID is not valid'], field: 'Branding theme' })
    expect(JSON.stringify(e2)).not.toContain('secret-trailer')
  })

  it('a taken invoice number is still the retry-with-the-next-number case', async () => {
    respond.fn = () => new Response(body('Invoice not saved: InvoiceNumber must be unique.'), { status: 400 })
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const { DuplicateInvoiceNumber: Dup } = await import('@/lib/offers/draft')
    await expect(xeroWriteApi().createDraft(draftBody(), 'k')).rejects.toBeInstanceOf(Dup)
  })

  it('diagnoses each candidate cause and names the real themes', async () => {
    respond.fn = (p) => {
      if (p.startsWith('/Currencies')) return json({ Currencies: [{ Code: 'GBP' }, { Code: 'USD' }] })
      if (p.startsWith('/TaxRates')) return json({ TaxRates: [{ Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', Status: 'ACTIVE', CanApplyToRevenue: true }] })
      if (p.startsWith('/Accounts')) return json({ Accounts: [] })
      if (p.startsWith('/Contacts/')) return new Response('', { status: 404 })
      if (p.startsWith('/BrandingThemes')) return json({ BrandingThemes: [{ BrandingThemeID: 'aaaaaaaa-0000-0000-0000-000000000000', Name: 'Standard' }] })
      return json({})
    }
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const found = await xeroWriteApi().diagnose!(draftBody())
    const all = found.join('\n')
    expect(all).toContain('Currency EUR is not switched on')
    expect(all).toContain('Tax type NONE does not exist')
    expect(all).toContain('20% (VAT on Income) (OUTPUT2)')
    expect(all).toContain('Account code 200 does not exist')
    expect(all).toContain('The contact was not found in this organisation')
    expect(all).toContain('branding theme id is not a theme in this organisation')
    expect(all).toContain('Standard (aaaaaaaa-0000-0000-0000-000000000000)')
    expect(all).not.toContain('tok') // no token anywhere
  })

  it('says everything exists when it does, and says when it could not check', async () => {
    respond.fn = (p) => {
      if (p.startsWith('/Currencies')) return json({ Currencies: [{ Code: 'EUR' }] })
      if (p.startsWith('/TaxRates')) return json({ TaxRates: [{ Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true }] })
      if (p.startsWith('/Accounts')) return json({ Accounts: [{ Code: '200', Name: 'Sales', Status: 'ACTIVE', Type: 'REVENUE' }] })
      if (p.startsWith('/Contacts/')) return json({ Contacts: [{ ContactStatus: 'ACTIVE' }] })
      if (p.startsWith('/BrandingThemes')) return json({ BrandingThemes: [{ BrandingThemeID: 'BBBBBBBB-0000-0000-0000-000000000000', Name: 'Margin' }] })
      return json({})
    }
    const { xeroWriteApi } = await import('@/lib/xero/write')
    expect(await xeroWriteApi().diagnose!(draftBody())).toEqual(['Checked the currency, tax type, account, contact and branding theme: all exist. The message from Xero above is the cause.'])
    respond.fn = (p) => (p.startsWith('/Currencies') ? new Response('', { status: 403 }) : json({ TaxRates: [{ TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true }], Accounts: [{ Code: '200', Status: 'ACTIVE', Type: 'REVENUE' }], Contacts: [{ ContactStatus: 'ACTIVE' }], BrandingThemes: [{ BrandingThemeID: 'bbbbbbbb-0000-0000-0000-000000000000' }] }))
    expect((await xeroWriteApi().diagnose!(draftBody())).join(' ')).toContain('Could not check the currency (Xero answered 403)')
  })

  it('the themes route lists them, and saving refuses an id that is not one of them', async () => {
    respond.fn = (p) => (p.startsWith('/BrandingThemes') ? json({ BrandingThemes: [{ BrandingThemeID: 'aaaaaaaa-0000-0000-0000-000000000000', Name: 'Standard' }, { BrandingThemeID: 'cccccccc-0000-0000-0000-000000000000', Name: 'Margin scheme' }] }) : json({}))
    const { GET } = await import('@/app/api/offers/branding-themes/route')
    const r = await GET(new Request('https://dashboard.example.test/api/offers/branding-themes'))
    expect(await r.json()).toEqual({ ok: true, themes: [{ id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Standard' }, { id: 'cccccccc-0000-0000-0000-000000000000', name: 'Margin scheme' }] })
    const { PUT } = await import('@/app/api/offers/draft-settings/route')
    const put = (themeId: string) => PUT(new Request('https://dashboard.example.test/api/offers/draft-settings', { method: 'PUT', headers: { origin: 'https://dashboard.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ taxType: 'NONE', accountCode: '200', brandingThemeId: themeId }) }))
    const bad = await put('bbbbbbbb-0000-0000-0000-000000000000')
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toContain('Standard, Margin scheme')
    expect((await put('CCCCCCCC-0000-0000-0000-000000000000')).status).toBe(200)
    const { getStore, getJson } = await import('@/lib/store')
    // The selected organisation here is a demo: the theme is saved for that organisation only, never as the live one's id.
    expect(await getJson(getStore(), 'offers:draft-settings')).toMatchObject({ brandingThemeId: null, brandingThemeIds: { 'ten': 'CCCCCCCC-0000-0000-0000-000000000000' } })
  })
})

// ---------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------
describe('the panel and the card', () => {
  const f = (draft: Fulfilment['draft']): Fulfilment => ({ orderRef: 'TEST-001', test: true, startedAt: '', reply: { state: 'sent', attempts: 1 }, draft })
  const render = (fulfilment: Fulfilment) => renderToString(h(AfterAcceptance, { offer: { ...testOffer(), fulfilment } })).replace(/<!-- -->/g, '')

  it('shows the field and every message Xero and the checks gave', () => {
    const html = render(f({ state: 'blocked', attempts: 0, reason: 'Xero rejected the draft invoice (Branding theme): The BrandingThemeID is not valid', field: 'Branding theme', details: ['The BrandingThemeID is not valid', 'Currency EUR is not switched on in this organisation.'] }))
    expect(html).toContain('data-testid="draft-field"')
    expect(html).toContain('Branding theme')
    expect(html).toContain('The BrandingThemeID is not valid')
    expect(html).toContain('Currency EUR is not switched on')
    expect(html).toContain('Try again now')
  })
  it('the Settings card offers Load themes when connected, and not when it is not', () => {
    const state = { configured: true, connected: true, orgName: 'Demo Company (UK)', isDemo: true, settings: DEFAULT_DRAFT_SETTINGS }
    expect(renderToString(h(XeroWriteCard, { state, notice: null }))).toContain('data-testid="load-themes"')
    expect(renderToString(h(XeroWriteCard, { state: { ...state, connected: false, orgName: null, isDemo: null }, notice: null }))).not.toContain('data-testid="load-themes"')
  })
})
