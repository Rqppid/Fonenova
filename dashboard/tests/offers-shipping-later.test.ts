import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { checkClients, chargeFor, seedClients, shippingBasisOf } from '@/lib/offers/clients'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { checkEdit } from '@/lib/offers/edit'
import { buildOfferEmail } from '@/lib/offers/email'
import { fulfilOffer, sweepFulfilment, type FulfilDeps, type ReplyMessage } from '@/lib/offers/fulfil'
import { priceOffer } from '@/lib/offers/pricing'
import { figuresFor } from '@/lib/offers/resolve'
import { setOrderShipping } from '@/lib/offers/shipping'
import type { Offer, OfferSend } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

function memStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    name: 'mem', data,
    async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } },
    async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) },
    async del(k: StoreKey) { data.delete(k) },
    async withLock<T>(_n: string, fn: () => Promise<T>) { return fn() },
  }
}

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const HASH = 'a'.repeat(64)
const ITEMS = 457_000 // 10 x 45,700

function offer(o: { clientId?: string; shipping?: Offer['shipping']; later?: boolean } = {}): Offer {
  const clientId = o.clientId ?? 'c_wave'
  const send: OfferSend = { clientId, clientName: clientId === 'c_eutelecoms' ? 'EU Telecoms' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: HASH, tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: ITEMS, units: 10, test: false, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return {
    id: 'o1', status: 'accepted',
    source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<abc@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer 12 Nov', receivedAt: HOURS(5) },
    text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }],
    ...(o.shipping ? { shipping: o.shipping } : {}),
    pricing: { clientId, marginCents: 700, overrides: {}, ackLow: false, ...(o.later === false ? {} : { shippingLater: true as const }), pricedAt: HOURS(3) },
    sends: [send], createdAt: HOURS(6), updatedAt: HOURS(1), audit: [],
  }
}

function setup(o: Offer, now = NOW) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' || c.id === 'c_eutelecoms' ? { ...c, termsConfirmed: true, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  const pings: string[] = []
  const sent: ReplyMessage[] = []
  const created: DraftBody[] = []
  const numbers = ['2026047']
  const api: XeroApi = {
    async organisation() { return { name: 'Fonenova Ltd', isDemo: false } },
    async invoiceNumbers() { return numbers },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b) { if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber(); created.push(b); numbers.push(b.InvoiceNumber); return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' } },
  }
  const d: FulfilDeps = {
    store, now, allowReal: true, allowLiveXero: true, ownerAddress: 'owner@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => ['FN-ORD-014'],
    xero: () => api,
    reply: async (m) => { sent.push(m); return { id: `msg${sent.length}` } },
    replied: async () => false,
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, pings, created, sent, get }
}

describe('pricing without shipping', () => {
  const wave = seedClients().find((c) => c.id === 'c_wave')!
  const lines = offer().lines
  const input = { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false }
  it('is fine for a new order (items only), and still refuses legacy orders with no shipping', () => {
    const later = priceOffer(lines, wave, { ...input, shippingLater: true })
    expect(later.ok).toBe(true)
    if (later.ok) { expect(later.totals.shippingCents).toBe(0); expect(later.totals.grandCents).toBe(ITEMS) }
    expect(priceOffer(lines, wave, { ...input, mobileShipping: { cents: null, none: false } }).ok).toBe(false)
  })
  it('the offer email and page say shipping is added to the invoice, with no amount', () => {
    const e = buildOfferEmail({ clientName: 'Wave', lines: [{ description: 'iPhone 16', qty: 10, unitSaleCents: 45_700 }], units: 10, shippingLater: true, totalCents: ITEMS, expiresAt: '2026-11-16T10:00:00Z', test: false }, 'https://x/o')
    expect(e.text).toContain('Shipping is added to the invoice.')
    expect(e.html).toContain('Shipping is added to the invoice.')
    expect(e.text).not.toMatch(/Shipping: €/)
  })
})

describe('client shipping basis', () => {
  const [wave, eu] = ['c_wave', 'c_eutelecoms'].map((id) => seedClients().find((c) => c.id === id)!)
  it('Wave is Mobile One x 2, EU Telecoms is our own DHL cost as typed', () => {
    expect(shippingBasisOf(wave)).toBe('mobile_one')
    expect(chargeFor(wave, 12_000)).toBe(24_000)
    expect(shippingBasisOf(eu)).toBe('own_dhl')
    expect(chargeFor(eu, 8_550)).toBe(8_550)
  })
  it('checkClients keeps and validates the setting', () => {
    const base = seedClients().map((c) => ({ ...c, termsConfirmed: true }))
    const r = checkClients(base.map((c) => (c.id === 'c_wave' ? { ...c, shippingBasis: 'own_dhl' } : c)))
    expect(r.ok && r.value.find((c) => c.id === 'c_wave')!.shippingBasis).toBe('own_dhl')
    expect(checkClients(base.map((c) => (c.id === 'c_wave' ? { ...c, shippingBasis: 'nonsense' } : c))).ok).toBe(false)
  })
})

describe('acceptance with no shipping yet', () => {
  it('replies to Mobile One but makes no draft: it waits, and says so', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    const f = t.get().fulfilment!
    expect(f.reply.state).toBe('sent')
    expect(f.draft.state).toBe('waiting')
    expect(t.created).toHaveLength(0)
    expect(t.pings.join(' ')).toContain('waiting for the shipping cost')
    expect(await figuresFor(t.store, t.get())).toMatchObject({ itemsCents: ITEMS, shippingPending: true })
  })
  it('a shipping figure stated on the offer fills in at once for Wave (x2)', async () => {
    const t = setup(offer({ shipping: { mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping 120' } }))
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.shipping).toMatchObject({ cents: 24_000, source: 'email' })
    expect(t.get().fulfilment!.draft.state).toBe('done')
    expect(t.created[0].LineItems.some((l) => l.UnitAmount === 240)).toBe(true)
  })
  it('but never for EU Telecoms: their cost is our own DHL label', async () => {
    const t = setup(offer({ clientId: 'c_eutelecoms', shipping: { mobileOneCents: 12_000, source: 'email', sourceText: 'Shipping 120' } }))
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('waiting')
    expect(t.created).toHaveLength(0)
  })
})

describe('entering the shipping', () => {
  it('Wave: Mobile One x 2, then the draft is raised with the shipping line and the total is items + shipping', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    const r = await setOrderShipping('o1', t.d, { cents: 12_000, none: false })
    expect(r.ok).toBe(true)
    const f = t.get().fulfilment!
    expect(f.shipping).toMatchObject({ cents: 24_000, mobileOneCents: 12_000, source: 'manual' })
    expect(f.draft.state).toBe('done')
    expect(t.created).toHaveLength(1)
    expect(JSON.stringify(t.created[0])).toContain('SHIPPING')
    expect(await figuresFor(t.store, t.get())).toMatchObject({ shippingCents: 24_000, grandCents: ITEMS + 24_000, shippingPending: false })
  })
  it('EU Telecoms: the figure as typed, no multiplier, no Mobile One cost recorded', async () => {
    const t = setup(offer({ clientId: 'c_eutelecoms' }))
    await fulfilOffer('o1', t.d)
    await setOrderShipping('o1', t.d, { cents: 8_550, none: false })
    expect(t.get().fulfilment!.shipping).toMatchObject({ cents: 8_550, source: 'manual' })
    expect(t.get().fulfilment!.shipping!.mobileOneCents).toBeUndefined()
    expect(t.get().fulfilment!.draft.state).toBe('done')
  })
  it('"no shipping" is explicit and makes the draft with no shipping line', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    expect((await setOrderShipping('o1', t.d, { cents: null, none: true })).ok).toBe(true)
    expect(t.get().fulfilment!.shipping).toMatchObject({ cents: 0, source: 'none' })
    expect(JSON.stringify(t.created[0])).not.toContain('SHIPPING')
  })
  it('refuses when out of range, not waiting, not accepted, or a draft already exists', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    expect((await setOrderShipping('o1', t.d, { cents: 0, none: false })).ok).toBe(false)
    expect((await setOrderShipping('o1', t.d, { cents: 10_000_001, none: false })).ok).toBe(false)
    expect((await setOrderShipping('nope', t.d, { cents: 100, none: false })).ok).toBe(false)
    await setOrderShipping('o1', t.d, { cents: 12_000, none: false })
    const again = await setOrderShipping('o1', t.d, { cents: 99_000, none: false })
    expect(again.ok).toBe(false)
    expect(again.message).toContain('Xero by hand')
    expect(t.get().fulfilment!.shipping!.cents).toBe(24_000)
  })
  it('an order priced the old way is not touched', async () => {
    const t = setup(offer({ later: false, shipping: { mobileOneCents: 0, source: 'none', sourceText: null } }))
    await fulfilOffer('o1', t.d)
    expect((await setOrderShipping('o1', t.d, { cents: 100, none: false })).ok).toBe(false)
  })
  it('checkEdit validates the action', () => {
    expect(checkEdit({ action: 'shipping_set', id: 'of_o1', cents: 12_000 })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'shipping_set', id: 'of_o1', none: true })).toMatchObject({ ok: true })
    for (const cents of [0, 1.5, -1, 10_000_001, '5']) expect(checkEdit({ action: 'shipping_set', id: 'of_o1', cents })).toMatchObject({ ok: false })
  })
})

describe('waiting too long', () => {
  it('reminds once a day, not before', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    t.pings.length = 0
    await sweepFulfilment({ ...t.d, now: new Date(NOW.getTime() + 3_600_000) })
    expect(t.pings).toHaveLength(0)
    const later = { ...t.d, now: new Date(NOW.getTime() + 25 * 3_600_000) }
    await sweepFulfilment(later)
    expect(t.pings.filter((p) => p.includes('still waiting for the shipping cost'))).toHaveLength(1)
    await sweepFulfilment({ ...t.d, now: new Date(NOW.getTime() + 26 * 3_600_000) })
    expect(t.pings.filter((p) => p.includes('still waiting for the shipping cost'))).toHaveLength(1)
  })
})

describe('the screen', () => {
  const render = (o: Offer, client = seedClients().find((c) => c.id === o.pricing!.clientId)!) => renderToString(h(AfterAcceptance, { offer: o, client })).replace(/<!-- -->/g, '')
  it('shows the entry box with the right label per client, and the result afterwards', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    expect(render(t.get())).toContain("Mobile One&#x27;s shipping, euros")
    const e = setup(offer({ clientId: 'c_eutelecoms' }))
    await fulfilOffer('o1', e.d)
    expect(render(e.get())).toContain('Our DHL cost, euros')
    await setOrderShipping('o1', t.d, { cents: 12_000, none: false })
    const html = render(t.get())
    expect(html).toContain('data-testid="shipping-done"')
    expect(html).toContain('Mobile One €120.00 × 2')
  })
})

describe('models the list does not know, and a stale "no shipping"', () => {
  it('iPads and other Apple products are recognised, and an unknown model only warns', async () => {
    const { knownModel, lineFlags } = await import('@/lib/offers/check')
    for (const m of ['Apple iPad Pro 13-inch (2025)', 'iPad Air 11-inch', 'iPad 10th gen', 'iPad mini', 'MacBook Air 13-inch M3', 'AirPods Pro 2', 'Apple Watch Series 10']) expect(knownModel(m), m).toBe(true)
    const odd = { id: 'x', model: 'Fairphone 5', storage: '256GB', grade: 'A', qty: 5, unitCostCents: 45_000, sourceText: '', note: null }
    const flags = lineFlags(odd)
    expect(flags.some((f) => f.code === 'model')).toBe(true)
    expect(flags.some((f) => f.level === 'error')).toBe(false)
    const wave = seedClients().find((c) => c.id === 'c_wave')!
    expect(priceOffer([odd], wave, { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingLater: true }).ok).toBe(true)
    // Real errors still block.
    expect(lineFlags({ ...odd, qty: 0 }).some((f) => f.level === 'error')).toBe(true)
    expect(lineFlags({ ...odd, unitCostCents: 500 }).some((f) => f.level === 'error')).toBe(true)
  })
  it('a "no shipping" left on the offer no longer makes a Wave draft with no shipping: it waits', async () => {
    const t = setup(offer())
    ;(t.store.data.get('offers') as Offer[])[0].shipping = { mobileOneCents: 0, source: 'none', sourceText: null }
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('waiting')
    expect(t.created).toHaveLength(0)
  })
})
