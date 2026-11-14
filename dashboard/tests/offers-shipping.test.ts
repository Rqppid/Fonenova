import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { XeroWriteCard } from '@/components/dashboard/xero-write-card'
import { ClientsView } from '@/components/offers/clients-view'
import { OfferDetail } from '@/components/offers/offers-view'
import { PricePanel } from '@/components/offers/price-panel'
import { SendPanel } from '@/components/offers/send-panel'
import { buildDraftBody, DEFAULT_DRAFT_SETTINGS, raiseDraft, SHIPPING_DESCRIPTION, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { applyEdit, checkEdit } from '@/lib/offers/edit'
import { buildOfferEmail } from '@/lib/offers/email'
import { checkClients, seedClients, type Client } from '@/lib/offers/clients'
import { fulfilOffer, retryFulfilment, type FulfilDeps } from '@/lib/offers/fulfil'
import { readOffer, RECORD_OFFER } from '@/lib/offers/parse'
import { priceOffer, pricingInputOf, shippingFor } from '@/lib/offers/pricing'
import { applyAnswer } from '@/lib/offers/resolve'
import type { Fulfilment, Offer, OfferLine, OfferSend } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const HASH = 'a'.repeat(64)
const L = (id: string, model: string, qty: number, cost: number): OfferLine => ({ id, model, storage: '128GB', grade: 'A', qty, unitCostCents: cost, sourceText: '', note: null })
const lines = [L('a1a1a1', 'iPhone 16', 10, 45_000)]
const wave = seedClients().find((c) => c.id === 'c_wave')!
const test = seedClients().find((c) => c.id === 'c_test')!
const base = { clientId: 'c_test', marginCents: 700, overrides: {}, ackLow: false }
const mob = (cents: number | null, none = false) => ({ mobileShipping: { cents, none } })

// ---------------------------------------------------------------------------
// A1: shipping is read from the Mobile One email, never guessed
// ---------------------------------------------------------------------------
describe('reading the shipping from the email', () => {
  const fake = (input: Record<string, unknown>) => ({ messages: { create: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_offer', input: { is_offer: true, reason: 'x', lines: [{ model: 'iPhone 16', storage: '128GB', grade: 'A', quantity: 10, unit_cost_eur: 450, source_text: 'iPhone 16 x10', note: null }], ...input } }] }) } }) as never
  it('asks for the shipping amount and its source line, and requires both fields', () => {
    expect(RECORD_OFFER.input_schema.required).toContain('shipping_eur')
    expect(RECORD_OFFER.input_schema.required).toContain('shipping_source_text')
  })
  it('keeps a stated amount in cents with the line it came from', async () => {
    const r = await readOffer('t', 's', fake({ shipping_eur: 120, shipping_source_text: 'Shipping: 120' }))
    expect(r.shipping).toEqual({ mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping: 120' })
  })
  it('an unstated, zero, negative or silly amount is "not stated", never zero', async () => {
    for (const v of [null, 0, -5, Number.NaN, 1_000_000]) expect((await readOffer('t', 's', fake({ shipping_eur: v, shipping_source_text: null }))).shipping, String(v)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A2, A6: the shipping figure, 2x by default, a setting per client, never zero by default
// ---------------------------------------------------------------------------
describe('client shipping = Mobile One x the client multiplier', () => {
  it('defaults to 2x, and the multiplier is a per-client setting', () => {
    expect(shippingFor(test, mob(12_000))).toMatchObject({ mobileOneCents: 12_000, multiplier: 2, defaultClientCents: 24_000, clientCents: 24_000, error: null })
    expect(shippingFor({ ...test, shippingMultiplier: 1.5 }, mob(12_001))).toMatchObject({ multiplier: 1.5, defaultClientCents: 18_002 })
    expect(shippingFor({ ...test, shippingMultiplier: undefined }, mob(5_000)).clientCents).toBe(10_000) // an older saved client still means 2
  })
  it('a figure typed for the client replaces the default', () => {
    expect(shippingFor(test, { shippingCents: 30_000, ...mob(12_000) })).toMatchObject({ defaultClientCents: 24_000, clientCents: 30_000 })
    expect(shippingFor(test, { shippingCents: 0, ...mob(12_000) }).error).toContain('between')
  })
  it('NEVER defaults to zero: no figure is an error that blocks pricing, and so sending', () => {
    for (const m of [mob(null), { mobileShipping: undefined }]) {
      const s = shippingFor(test, m)
      expect(s).toMatchObject({ mobileOneCents: null, clientCents: null })
      expect(s.error).toContain('never assumed to be zero')
    }
    const r = priceOffer(lines, test, { ...base, ...mob(null) })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain("Enter Mobile One's shipping")
    expect(r.totals.grandCents).toBe(r.totals.saleCents) // nothing was invented
  })
  it('"no shipping" has to be confirmed on purpose, and then there is no line', () => {
    const r = priceOffer(lines, test, { ...base, ...mob(0, true) })
    expect(r.ok).toBe(true)
    expect(r.totals).toMatchObject({ shippingCents: 0, grandCents: r.totals.saleCents })
  })
  it('totals add up: items + shipping = what the client pays, and the shipping margin is its own figure', () => {
    const r = priceOffer(lines, test, { ...base, ...mob(12_000) })
    expect(r.ok).toBe(true)
    expect(r.totals).toMatchObject({ saleCents: 457_000, shippingCents: 24_000, grandCents: 481_000, shippingProfitCents: 12_000 })
  })
  it('the multiplier is validated on the Clients screen', () => {
    const c = (m: unknown) => checkClients([{ ...test, shippingMultiplier: m }], seedClients())
    expect(c(2)).toMatchObject({ ok: true })
    expect(c(1.25)).toMatchObject({ ok: true })
    expect(c(undefined)).toMatchObject({ ok: true, value: [expect.objectContaining({ shippingMultiplier: 2 })] })
    for (const bad of [0, 0.4, 11, -1, 'x', 2.555]) expect(c(bad), String(bad)).toMatchObject({ ok: false, error: expect.stringContaining('multiplier') })
  })
})

// ---------------------------------------------------------------------------
// A3: the review screen shows it and lets it be changed
// ---------------------------------------------------------------------------
describe('the review screen and the saved figure', () => {
  const offer = (p: Partial<Offer> = {}): Offer => ({ id: 'of_s1', status: 'ready', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'Mobile One <s@example.test>', to: 'o@example.test', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines, createdAt: '', updatedAt: '', audit: [], ...p })
  const render = (o: Offer) => renderToString(h(OfferDetail, { offer: o, clients: seedClients() })).replace(/<!-- -->/g, '')
  it('shows the figure read from the email with its source line', () => {
    const html = render(offer({ shipping: { mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping: 120' } }))
    expect(html).toContain('data-testid="shipping-review"')
    expect(html).toContain('value="120.00"')
    expect(html).toContain('Read from the email: &quot;Shipping: 120&quot;')
  })
  it('says plainly when there is none, and asks for one', () => {
    const html = render(offer())
    expect(html).toContain('data-testid="shipping-needed"')
    expect(html).toContain('never assumed to be zero')
  })
  it('saving changes it (marking it as entered by hand), clears the price, and "no shipping" is explicit', () => {
    const o = offer({ shipping: { mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping: 120' }, pricing: { ...base, pricedAt: '' } })
    const manual = applyEdit(o, { action: 'save', id: o.id, lines, shipping: { cents: 15_000, none: false } }, NOW.toISOString(), seedClients()) as Offer
    expect(manual.shipping).toEqual({ mobileOneCents: 15_000, source: 'manual', sourceText: 'Shipping: 120' })
    expect(manual.pricing).toBeUndefined()
    expect(manual.audit.at(-1)!.what).toContain('shipping set to €150.00')
    const same = applyEdit(o, { action: 'save', id: o.id, lines, shipping: { cents: 12_000, none: false } }, NOW.toISOString(), seedClients()) as Offer
    expect(same.shipping!.source).toBe('email') // unchanged stays "read from the email"
    const none = applyEdit(o, { action: 'save', id: o.id, lines, shipping: { cents: null, none: true } }, NOW.toISOString(), seedClients()) as Offer
    expect(none.shipping).toEqual({ mobileOneCents: 0, source: 'none', sourceText: null })
    const cleared = applyEdit(o, { action: 'save', id: o.id, lines, shipping: { cents: null, none: false } }, NOW.toISOString(), seedClients()) as Offer
    expect(cleared.shipping!.mobileOneCents).toBeNull()
  })
  it('checks what is typed', () => {
    const ok = (shipping: unknown) => checkEdit({ action: 'save', id: 'of_s1', lines: [{ model: 'x', qty: 1, unitCostCents: 100 }], shipping })
    expect(ok({ cents: 12_000, none: false })).toMatchObject({ ok: true })
    expect(ok({ cents: 0, none: false })).toMatchObject({ ok: false })
    expect(ok({ cents: 1.5, none: false })).toMatchObject({ ok: false })
    expect(ok({ cents: 99_999_999, none: false })).toMatchObject({ ok: false })
    expect(checkEdit({ action: 'save', id: 'of_s1', lines: [{ model: 'x', qty: 1, unitCostCents: 100 }] })).toMatchObject({ ok: true }) // untouched
  })
  it('the price panel shows Mobile One x multiplier = the default, lets it be changed, and refuses without a figure', () => {
    const priced = (o: Offer) => renderToString(h(PricePanel, { offer: { ...o, pricing: { ...base, pricedAt: '' } }, clients: seedClients() })).replace(/<!-- -->/g, '')
    const withShip = priced(offer({ shipping: { mobileOneCents: 12_000, source: 'email', sourceText: null } }))
    expect(withShip).toContain('Mobile One charges €120.00 × 2')
    expect(withShip).toContain('€240.00')
    expect(withShip).toContain('aria-label="Client shipping"')
    expect(withShip).toContain('data-testid="price-grand"')
    expect(priced(offer())).toContain('data-testid="shipping-missing"')
  })
})

// ---------------------------------------------------------------------------
// A4, A5: the same figure on the email, the public page and the Xero draft
// ---------------------------------------------------------------------------
describe('one shipping figure everywhere', () => {
  it('the offer email shows it and a total that includes it', () => {
    const e = buildOfferEmail({ clientName: 'Test', lines: [{ description: 'iPhone 16 128GB A', qty: 10, unitSaleCents: 45_700 }], units: 10, shippingCents: 24_000, totalCents: 481_000, expiresAt: '2026-11-16T10:00:00Z', test: true }, 'https://fonenova.com/offer/T')
    expect(e.text).toContain('Shipping: €240.00')
    expect(e.text).toContain('Total: 10 units, €4,810.00 (including shipping)')
    expect(e.html).toContain('>Shipping<')
    expect(e.html).toContain('€240.00')
    const none = buildOfferEmail({ clientName: 'Test', lines: [], units: 0, totalCents: 0, expiresAt: '2026-11-16T10:00:00Z', test: true }, 'x')
    expect(none.text).not.toContain('Shipping')
  })
  it('the Send panel preview shows the shipping row and the grand total', () => {
    const o: Offer = { id: 'of_s1', status: 'ready', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'x', to: 'y', subject: 's', receivedAt: HOURS(1) }, text: '', lines, shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null }, pricing: { ...base, shippingCents: 24_000, pricedAt: '' }, createdAt: '', updatedAt: '', audit: [] }
    const html = renderToString(h(SendPanel, { offer: o, clients: seedClients().map((c) => (c.test ? { ...c, offerEmails: ['a@example.test'] } : c)), setup: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="send-shipping"')
    expect(html).toContain('€240.00')
    expect(html).toContain('€4,810.00')
  })
  it('the Xero draft has SHIPPING CHARGES as its own line: quantity 1, account 200, tax NONE', () => {
    const b = buildDraftBody({ number: '2026001', reference: 'TEST-001', contactId: '11111111-2222-3333-4444-555555555555', lines: [{ description: 'iPhone 16 128GB A', qty: 10, unitSaleCents: 45_700 }], shippingCents: 24_000, terms: { days: 7 }, now: NOW, settings: DEFAULT_DRAFT_SETTINGS })
    expect(b.LineItems).toHaveLength(2)
    expect(b.LineItems[1]).toEqual({ Description: 'SHIPPING CHARGES', Quantity: 1, UnitAmount: 240, AccountCode: '200', TaxType: 'NONE' })
    expect(SHIPPING_DESCRIPTION).toBe('SHIPPING CHARGES')
    expect(b.LineItems.reduce((n, l) => n + l.Quantity * l.UnitAmount, 0)).toBe(4810) // the lines add up to the total the client accepted
    expect(buildDraftBody({ number: '1', reference: 'r', contactId: 'c', lines: [], shippingCents: 0, terms: 'upfront', now: NOW, settings: DEFAULT_DRAFT_SETTINGS }).LineItems).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The accepted offer end to end, against a fake Xero and fake Gmail
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

function accepted(o: { test?: boolean; shipping?: Offer['shipping']; total?: number } = {}): Offer {
  const isTest = o.test !== false
  const send: OfferSend = { clientId: isTest ? 'c_test' : 'c_wave', clientName: isTest ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: HASH, tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: o.total ?? 481_000, shippingCents: 24_000, units: 10, test: isTest, gmailMessageId: 'g1', outcome: 'pending' }
  return {
    id: 'of_s1', status: 'sent',
    source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<a@mobileone.example>', from: 'Mobile One <bv@mobileone.example>', to: 'info@fonenova.com', subject: 'Offer 12 Nov', receivedAt: HOURS(5) },
    text: '', lines, shipping: o.shipping ?? { mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping: 120' },
    pricing: { clientId: send.clientId, marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(3) },
    sends: [send], createdAt: HOURS(6), updatedAt: HOURS(1), audit: [],
  }
}

interface XeroOpts { isDemo?: boolean; hasAddress?: boolean | null; recent?: { number: string; date: string; status: string; reference: string }[]; existing?: { id: string; number: string; status: string } | null; checkThrows?: boolean }
function fakeXero(o: XeroOpts = {}) {
  const created: DraftBody[] = []
  const numbers: string[] = []
  const calls = { createDraft: 0, contactCheck: 0 }
  const api: XeroApi = {
    async organisation() { return { name: o.isDemo === false ? 'Fonenova Ltd' : 'Demo Company (UK)', isDemo: o.isDemo !== false } },
    async invoiceNumbers() { return o.isDemo === false ? ['2026047', ...numbers] : [...numbers] },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : o.existing ?? null },
    async createDraft(b) { calls.createDraft++; created.push(b); numbers.push(b.InvoiceNumber); return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' } },
    async contactCheck() { calls.contactCheck++; if (o.checkThrows) throw new Error('down'); return { hasAddress: o.hasAddress === undefined ? true : o.hasAddress, recent: o.recent ?? [] } },
  }
  return { api, created, calls }
}

function setup(offer: Offer, x: ReturnType<typeof fakeXero>, opts: { termsConfirmed?: boolean; allowLive?: boolean } = {}) {
  const store = mutexStore()
  store.data.set('offers', [offer])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_test' ? { ...c, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c.id === 'c_wave' ? { ...c, termsConfirmed: opts.termsConfirmed ?? true } : c)))
  const pings: string[] = []
  const emails: { subject: string; text: string; html: string }[] = []
  const d: FulfilDeps = { store, now: NOW, allowReal: true, allowLiveXero: opts.allowLive ?? false, ownerAddress: 'owner@example.test', notify: async (t) => { pings.push(t); return true }, knownOrderIds: async () => [], xero: () => x.api, reply: async () => ({ id: 'r1' }), replied: async () => false }
  const get = () => (store.data.get('offers') as Offer[])[0]
  const answer = () => applyAnswer(HASH, { store, notify: d.notify, email: async (m) => { emails.push(m) }, now: NOW, dashboardUrl: 'https://dashboard.example.test', fulfil: (id) => fulfilOffer(id, d), getAnswer: async () => ({ decision: 'accept', remarks: 'ok', at: HOURS(0), ip: '1.1.1.1', ua: 'x' }) })
  return { d, store, pings, emails, get, answer }
}

describe('A: the shipping line on the accepted draft', () => {
  it('the draft carries items + SHIPPING CHARGES and totals what the client accepted', async () => {
    const x = fakeXero()
    const t = setup(accepted(), x)
    await t.answer()
    expect(x.created).toHaveLength(1)
    const li = x.created[0].LineItems
    expect(li.map((l) => l.Description)).toEqual(['iPhone 16 128GB A', 'SHIPPING CHARGES'])
    expect(li[1]).toMatchObject({ Quantity: 1, UnitAmount: 240, AccountCode: '200', TaxType: 'NONE' })
    expect(li.reduce((n, l) => n + l.Quantity * l.UnitAmount, 0) * 100).toBe(t.get().sends![0].totalCents)
    expect(t.get().fulfilment!.draft.state).toBe('done')
  })
  it('an offer that has lost its shipping figure is blocked with the real reason, not defaulted to zero', async () => {
    const x = fakeXero()
    const o = accepted()
    delete o.shipping
    const t = setup(o, x)
    await t.answer()
    expect(x.created).toHaveLength(0)
    expect(t.get().fulfilment!.draft.state).toBe('blocked')
    expect(t.get().fulfilment!.draft.reason).toContain("Enter Mobile One's shipping")
  })
})

// ---------------------------------------------------------------------------
// B: the acceptance email
// ---------------------------------------------------------------------------
describe('B: one email on acceptance, with everything and the Xero link', () => {
  it('has the client, reference, each line, shipping, total, currency and the link to the draft', async () => {
    const x = fakeXero({ hasAddress: false })
    const t = setup(accepted(), x)
    await t.answer()
    expect(t.emails).toHaveLength(1)
    const m = t.emails[0]
    expect(m.subject).toBe('[TEST] ACCEPTED: Test client accepted the offer (€4,810.00)')
    for (const w of ['Client: Test client', 'Offer reference: TEST-001', 'Offer 12 Nov', 'of_s1', 'Currency: EUR', 'iPhone 16 128GB A: 10 x €457.00 = €4,570.00', 'Shipping: €240.00', 'Total: 10 units, €4,810.00 (including shipping)', 'https://go.xero.com/app/invoicing/view/inv-2026001', 'Check: Add an address in Xero before approving', 'https://dashboard.example.test/offers?id=of_s1']) expect(m.text, w).toContain(w)
    expect(m.html).toContain('href="https://go.xero.com/app/invoicing/view/inv-2026001"')
    // sale prices only
    for (const secret of ['450.00', '45000', 'margin', 'profit']) expect(m.text.toLowerCase(), secret).not.toContain(secret)
  })
  it('says why there is no link when the draft could not be created', async () => {
    const t = setup(accepted(), fakeXero({ isDemo: false }))
    await t.answer()
    expect(t.emails).toHaveLength(1)
    expect(t.emails[0].text).toContain('Xero draft: not created.')
  })
  it('is sent once per acceptance: a retried webhook, simultaneous deliveries and the 5-minute check never send a second', async () => {
    const t = setup(accepted(), fakeXero())
    const results = await Promise.all([t.answer(), t.answer(), t.answer()])
    expect(results.filter((r) => r.changed)).toHaveLength(1)
    await t.answer()
    await retryFulfilment('of_s1', t.d)
    expect(t.emails).toHaveLength(1)
    expect(t.get().sends![0].notifiedAt).toBeTruthy()
  })
  it('a failing Gmail does not lose the acceptance, and is not retried into a duplicate', async () => {
    const t = setup(accepted(), fakeXero())
    let n = 0
    const r = await applyAnswer(HASH, { store: t.store, notify: t.d.notify, email: async () => { n++; throw new Error('gmail down') }, now: NOW, fulfil: (id) => fulfilOffer(id, t.d), getAnswer: async () => ({ decision: 'accept', remarks: '', at: HOURS(0), ip: '1.1.1.1', ua: 'x' }) })
    expect(r.changed).toBe(true)
    expect(t.get().status).toBe('accepted')
    await t.answer()
    expect(n).toBe(1)
    expect(t.get().audit.map((a) => a.what).join(' ')).toContain('Notification email to you was not sent')
  })
})

// ---------------------------------------------------------------------------
// C: draft safety
// ---------------------------------------------------------------------------
describe('C: before creating a draft', () => {
  it('8: an existing invoice with the same reference is linked, and no second draft is created', async () => {
    const x = fakeXero({ existing: { id: 'inv-existing', number: '2026007', status: 'DRAFT' } })
    const t = setup(accepted(), x)
    await t.answer()
    expect(x.calls.createDraft).toBe(0)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceId: 'inv-existing', invoiceNumber: '2026007' })
    expect(t.emails[0].text).toContain('https://go.xero.com/app/invoicing/view/inv-existing')
  })
  it('8: a retry after a timeout adopts what Xero already saved', async () => {
    const x = fakeXero()
    const t = setup(accepted(), x)
    await t.answer()
    // pretend the draft step lost its answer: reset it, as a failed attempt would leave it
    const o = t.get()
    t.store.data.set('offers', [{ ...o, fulfilment: { ...o.fulfilment!, draft: { state: 'failed', attempts: 1, reason: 'timed out' } } }])
    await retryFulfilment('of_s1', t.d)
    await retryFulfilment('of_s1', t.d)
    expect(x.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceId: 'inv-2026001' })
  })
  it('9: a contact with no address still gets the draft, with "Add an address in Xero before approving" next to its link', async () => {
    const x = fakeXero({ hasAddress: false })
    const t = setup(accepted(), x)
    await t.answer()
    expect(x.created).toHaveLength(1)
    const draft = t.get().fulfilment!.draft
    expect(draft.warnings).toEqual(['Add an address in Xero before approving'])
    const html = renderToString(h(AfterAcceptance, { offer: t.get() })).replace(/<!-- -->/g, '')
    expect(html).toContain('Open in Xero')
    expect(html).toContain('data-testid="draft-warning"')
    expect(html).toContain('Add an address in Xero before approving')
  })
  it('9: a contact with an address has no such warning', async () => {
    const t = setup(accepted(), fakeXero({ hasAddress: true }))
    await t.answer()
    expect(t.get().fulfilment!.draft.warnings).toBeUndefined()
  })
  it('10: warns when the same contact was invoiced in the last 14 days, naming the invoices, never counting its own', async () => {
    const x = fakeXero({ recent: [{ number: '2026047', date: '2026-11-12', status: 'PAID', reference: 'FN-ORD-014' }, { number: '2026001', date: '2026-11-15', status: 'DRAFT', reference: 'TEST-001' }] })
    const t = setup(accepted(), x)
    await t.answer()
    const w = t.get().fulfilment!.draft.warnings!
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('Test client (my own inbox) already has an invoice in Xero from the last 14 days: 2026047 (2026-11-12, paid)')
    expect(w[0]).not.toContain('TEST-001')
    expect(t.emails[0].text).toContain('Check: Test client (my own inbox) already has an invoice')
  })
  it('10: the check looks back exactly 14 days, and a Xero hiccup on the check never stops the draft', async () => {
    const seen: string[] = []
    const x = fakeXero()
    x.api.contactCheck = async (_id, since) => { seen.push(since); return { hasAddress: true, recent: [] } }
    await setup(accepted(), x).answer()
    expect(seen).toEqual(['2026-11-01'])
    const y = fakeXero({ checkThrows: true })
    const t = setup(accepted(), y)
    await t.answer()
    expect(y.created).toHaveLength(1)
    expect(t.get().fulfilment!.draft.warnings).toEqual(["Could not check the contact's address and recent invoices in Xero"])
  })
})

describe('C11: payment terms are chosen before a client can stop being a test client', () => {
  const real = (p: Record<string, unknown>) => ({ ...wave, ...p })
  it('refuses a test client becoming real, and a new real client, until the terms are confirmed', () => {
    const saved = seedClients()
    expect(checkClients([real({ id: 'c_test', name: 'Test client (my own inbox)', test: false, termsConfirmed: false })], saved)).toMatchObject({ ok: false, error: expect.stringContaining('choose the payment terms') })
    expect(checkClients([real({ id: 'c_test', name: 'Test client (my own inbox)', test: false, termsConfirmed: true, terms: { days: 14 } })], saved)).toMatchObject({ ok: true })
    expect(checkClients([...saved, real({ id: 'c_newone', name: 'New Co', xeroContactId: null, termsConfirmed: false })], saved)).toMatchObject({ ok: false })
    expect(checkClients([...saved, real({ id: 'c_newone', name: 'New Co', xeroContactId: null, termsConfirmed: true, terms: { days: 7 } })], saved)).toMatchObject({ ok: true })
  })
  it('does not hold up edits to other clients, or a test client, while a saved real client is still unconfirmed', () => {
    const saved = seedClients() // Wave and EU Telecoms are real and unconfirmed
    const edited = saved.map((c) => (c.test ? { ...c, offerEmails: ['me@example.test'] } : c))
    expect(checkClients(edited, saved)).toMatchObject({ ok: true })
  })
  it('a real client with unconfirmed terms gets no draft, and is told why', async () => {
    const x = fakeXero({ isDemo: false })
    const t = setup(accepted({ test: false }), x, { termsConfirmed: false, allowLive: true })
    await t.answer()
    expect(x.created).toHaveLength(0)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'blocked', reason: expect.stringContaining("Confirm Wave Phone B.V.'s payment terms") })
  })
  it('the Clients screen starts unconfirmed and offers 7 or 14 days', () => {
    const html = renderToString(h(ClientsView, { clients: seedClients(), usedBy: {} })).replace(/<!-- -->/g, '')
    expect(html).toContain('payment terms not chosen yet')
    expect(html).toContain('<option value="7">7 days</option>')
    expect(html).toContain('<option value="14">14 days</option>')
    expect(html).toContain('aria-label="Shipping multiplier"')
  })
})

// ---------------------------------------------------------------------------
// D: live Xero and real client sending are separate steps
// ---------------------------------------------------------------------------
describe('D: live Xero is its own step', () => {
  const lines1 = [{ description: 'x', qty: 1, unitSaleCents: 100 }]
  it('a live organisation gets no draft unless live drafts were switched on, whatever else is on', async () => {
    const x = fakeXero({ isDemo: false })
    const store = mutexStore()
    const common = { api: x.api, store, reference: 'FN-ORD-016', client: { ...wave, termsConfirmed: true }, test: false, lines: lines1, settings: DEFAULT_DRAFT_SETTINGS, now: NOW }
    const off = await raiseDraft({ ...common })
    expect(off).toMatchObject({ ok: false, retry: false })
    expect((off as { error: string }).error).toContain('XERO_WRITE_ALLOW_LIVE')
    expect((off as { error: string }).error).toContain('separate from sending offers to real clients')
    expect(x.created).toHaveLength(0)
    expect(await raiseDraft({ ...common, allowLive: true })).toMatchObject({ ok: true })
  })
  it('real client sending alone does not create live drafts: the accepted real offer is blocked, not invoiced', async () => {
    const x = fakeXero({ isDemo: false })
    const t = setup(accepted({ test: false }), x, { allowLive: false }) // allowReal is true in the harness
    await t.answer()
    expect(x.created).toHaveLength(0)
    expect(t.get().fulfilment!.draft.reason).toContain('XERO_WRITE_ALLOW_LIVE')
  })
  it('the demo company never needs the live switch, and a real offer is still refused in a demo', async () => {
    const x = fakeXero()
    const t = setup(accepted(), x)
    await t.answer()
    expect(x.created).toHaveLength(1)
    const store = mutexStore()
    const r = await raiseDraft({ api: x.api, store, reference: 'FN-ORD-016', client: { ...wave, termsConfirmed: true }, test: false, lines: lines1, settings: DEFAULT_DRAFT_SETTINGS, now: NOW, allowLive: true })
    expect(r).toMatchObject({ ok: false })
    expect((r as { error: string }).error).toContain('demo')
  })
  it('Settings says which switch is which', () => {
    const state = { configured: true, connected: true, orgName: 'Fonenova Ltd', isDemo: false, settings: DEFAULT_DRAFT_SETTINGS }
    const off = renderToString(h(XeroWriteCard, { state, notice: null })).replace(/<!-- -->/g, '')
    expect(off).toContain('data-testid="live-gate"')
    expect(off).toContain('live drafts are OFF')
    expect(off).toContain('XERO_WRITE_ALLOW_LIVE')
    expect(off).toContain('OFFERS_ALLOW_REAL_SEND')
    expect(renderToString(h(XeroWriteCard, { state: { ...state, liveAllowed: true }, notice: null })).replace(/<!-- -->/g, '')).toContain('Live drafts are ON')
    expect(renderToString(h(XeroWriteCard, { state: { ...state, orgName: 'Demo Company (UK)', isDemo: true }, notice: null }))).not.toContain('data-testid="live-gate"')
  })
  it('the live gate module needs both a live connection and the switch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-live-'))
    const env = { ...process.env }
    try {
      for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
      Object.assign(process.env, { FN_DATA_DIR: dir, XERO_WRITE_CLIENT_ID: 'id' })
      vi.resetModules()
      const { getStore } = await import('@/lib/store')
      const { liveXeroReady } = await import('@/lib/xero/live-gate')
      const store = getStore()
      await store.set('xero-write:tokens', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, tenantId: 't', tenantName: 'Fonenova Ltd', isDemo: false })
      delete process.env.XERO_WRITE_ALLOW_LIVE
      expect(await liveXeroReady(store)).toBe(false) // connected, switch off
      process.env.XERO_WRITE_ALLOW_LIVE = 'true'
      expect(await liveXeroReady(store)).toBe(true)
      await store.set('xero-write:tokens', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, tenantId: 't', tenantName: 'Demo Company (UK)', isDemo: true })
      expect(await liveXeroReady(store)).toBe(false) // switch on, but only a demo connected
    } finally {
      process.env = env
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

afterEach(() => vi.unstubAllGlobals())
beforeEach(() => vi.resetModules())
