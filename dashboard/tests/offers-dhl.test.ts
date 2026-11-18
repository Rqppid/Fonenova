import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { seedClients } from '@/lib/offers/clients'
import { checkParcel, countryCodeOf, quoteOrderShipping, setOrigin, type DhlDeps, type DhlQuote, type DhlRater } from '@/lib/offers/dhl'
import { myDhlConfig, myDhlRater, parseRates } from '@/lib/offers/dhl-mydhl'
import { checkEdit } from '@/lib/offers/edit'
import type { Offer } from '@/lib/offers/types'
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

const ownClient = seedClients().find((c) => c.shippingBasis === 'own_dhl')!
const otherClient = seedClients().find((c) => c.shippingBasis !== 'own_dhl' && !c.test)!
const parcel = { weightKg: 2.5, lengthCm: 30, widthCm: 20, heightCm: 15 }
const quote = (o: Partial<DhlQuote> = {}): DhlQuote => ({ service: 'EXPRESS WORLDWIDE', productCode: 'P', cents: 3_850, currency: 'EUR', billableWeightKg: 2.5, actualWeightKg: 2.5, volumetricWeightKg: 1.8, ...o })

function offer(clientId: string, state: 'waiting' | 'done' = 'waiting'): Offer {
  return {
    id: 'of_1', status: 'accepted',
    source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<a@b>', from: 'x', to: 'y', subject: 's', receivedAt: '2026-11-10T10:00:00Z' },
    text: '', lines: [], pricing: { clientId, marginCents: 700, overrides: {}, ackLow: false, shippingLater: true, pricedAt: '2026-11-10T10:00:00Z' },
    sends: [], createdAt: '2026-11-10T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z', audit: [],
    fulfilment: { orderRef: 'FN-ORD-1', test: false, startedAt: '2026-11-10T10:00:00Z', reply: { state: 'sent', attempts: 1 }, draft: { state, attempts: 0 } },
  } as unknown as Offer
}

function setup(o: { client?: typeof ownClient; state?: 'waiting' | 'done'; origin?: boolean; rater?: DhlRater | null; address?: { lines: string[]; city: string; postalCode: string; country: string } | null | 'throw' } = {}) {
  const store = memStore()
  const client = o.client ?? ownClient
  store.data.set('offers', [offer(client.id, o.state)])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === client.id ? { ...c, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  if (o.origin !== false) store.data.set('offers:dhl-origin', { countryCode: 'BG', postalCode: '1000', city: 'Sofia' })
  const calls: Parameters<DhlRater>[0][] = []
  const rater: DhlRater | null = o.rater === undefined ? async (q) => { calls.push(q); return [quote()] } : o.rater
  const addr = o.address === undefined ? { lines: ['1 Main St'], city: 'Plovdiv', postalCode: '4000', country: 'Bulgaria' } : o.address
  const d: DhlDeps = {
    store, now: new Date('2026-11-18T09:00:00Z'), rater,
    xero: () => ({ async organisation() { return { name: 'Fonenova Ltd', isDemo: false } }, async contactAddress() { if (addr === 'throw') throw new Error('down'); return addr } }),
  }
  return { store, d, calls }
}

describe('parcel checks', () => {
  it('accepts a sensible parcel and refuses zero, absurd and missing values', () => {
    expect(checkParcel(parcel).ok).toBe(true)
    expect(checkParcel({ ...parcel, weightKg: 0 }).ok).toBe(false)
    expect(checkParcel({ ...parcel, weightKg: 71 }).ok).toBe(false)
    expect(checkParcel({ ...parcel, lengthCm: 301 }).ok).toBe(false)
    expect(checkParcel({ ...parcel, heightCm: -1 }).ok).toBe(false)
    expect(checkParcel({ ...parcel, widthCm: 20.123 }).ok).toBe(false)
    expect(checkParcel({}).ok).toBe(false)
  })
  it('turns a Xero country into a DHL code only when sure', () => {
    expect(countryCodeOf('Bulgaria')).toBe('BG')
    expect(countryCodeOf('bg')).toBe('BG')
    expect(countryCodeOf('Narnia')).toBeNull()
    expect(countryCodeOf('')).toBeNull()
  })
})

describe('quoting an order', () => {
  it('returns the quote with service and weights, and saves nothing', async () => {
    const t = setup()
    const before = JSON.stringify([...t.store.data])
    const r = await quoteOrderShipping('of_1', t.d, parcel)
    expect(r.ok && r.quotes[0]).toMatchObject({ service: 'EXPRESS WORLDWIDE', cents: 3_850, currency: 'EUR', billableWeightKg: 2.5 })
    expect(t.calls[0]).toMatchObject({ origin: { countryCode: 'BG', city: 'Sofia' }, destination: { countryCode: 'BG', postalCode: '4000', city: 'Plovdiv' }, plannedDate: '2026-11-18' })
    expect(JSON.stringify([...t.store.data])).toBe(before)
  })
  it('lists cheapest first', async () => {
    const t = setup({ rater: async () => [quote({ cents: 9_000, service: 'A' }), quote({ cents: 4_000, service: 'B' })] })
    const r = await quoteOrderShipping('of_1', t.d, parcel)
    expect(r.ok && r.quotes.map((q) => q.service)).toEqual(['B', 'A'])
  })
  it('only works for a client charged our own DHL cost', async () => {
    const t = setup({ client: otherClient })
    const r = await quoteOrderShipping('of_1', t.d, parcel)
    expect(r.ok).toBe(false)
    expect(t.calls).toHaveLength(0)
  })
  it('refuses once the draft is no longer waiting', async () => {
    const t = setup({ state: 'done' })
    expect((await quoteOrderShipping('of_1', t.d, parcel)).ok).toBe(false)
  })
  it('says what is missing and never calls DHL when it cannot', async () => {
    for (const [label, t, text] of [
      ['no origin', setup({ origin: false }), 'collected from'],
      ['no DHL', setup({ rater: null }), 'not set up'],
      ['no address', setup({ address: null }), 'no full address'],
      ['bad country', setup({ address: { lines: [], city: 'X', postalCode: '1', country: 'Narnia' } }), 'DHL country'],
      ['xero down', setup({ address: 'throw' }), 'could not be read'],
    ] as const) {
      const r = await quoteOrderShipping('of_1', t.d, parcel)
      expect(r.ok, label).toBe(false)
      expect(r.message, label).toContain(text)
      expect(t.calls, label).toHaveLength(0)
    }
    expect((await quoteOrderShipping('of_1', setup({ origin: false }).d, parcel))).toMatchObject({ needsOrigin: true })
  })
  it('turns a DHL error, no service, a non-euro or absurd price into a plain message', async () => {
    const msgs = await Promise.all([
      async () => { throw new Error('DHL answered 401') },
      async () => [],
      async () => [quote({ currency: 'USD' })],
      async () => [quote({ cents: 900_000 })],
      async () => [quote({ cents: 0 })],
    ].map(async (rater) => quoteOrderShipping('of_1', setup({ rater }).d, parcel)))
    for (const m of msgs) { expect(m.ok).toBe(false); expect(m.message.length).toBeGreaterThan(10) }
    expect(msgs[0].message).toContain('401')
    expect(msgs[2].message).toContain('USD')
  })
  it('refuses a zero weight before doing anything', async () => {
    const t = setup()
    expect((await quoteOrderShipping('of_1', t.d, { ...parcel, weightKg: 0 })).ok).toBe(false)
    expect(t.calls).toHaveLength(0)
  })
  it('saves the origin once, and checks it', async () => {
    const s = memStore()
    expect((await setOrigin(s, { countryCode: 'bg', postalCode: '1000', city: 'Sofia' })).ok).toBe(true)
    expect(s.data.get('offers:dhl-origin')).toEqual({ countryCode: 'BG', postalCode: '1000', city: 'Sofia' })
    expect((await setOrigin(s, { countryCode: 'Bulgaria', postalCode: '1', city: 'x' })).ok).toBe(false)
  })
})

describe('the MyDHL client', () => {
  const body = { products: [{ productName: 'EXPRESS WORLDWIDE', productCode: 'P', totalPrice: [{ currencyType: 'PULCL', priceCurrency: 'GBP', price: 1 }, { currencyType: 'BILLC', priceCurrency: 'EUR', price: 38.5 }], weight: { provided: 2.5, volumetric: 3 } }] }
  it('reads a billed price into cents and the larger weight as billable', () => {
    expect(parseRates(body)).toEqual([{ service: 'EXPRESS WORLDWIDE', productCode: 'P', cents: 3_850, currency: 'EUR', billableWeightKg: 3, actualWeightKg: 2.5, volumetricWeightKg: 3 }])
  })
  it('skips a price it cannot read exactly and rejects an unexpected answer', () => {
    expect(parseRates({ products: [{ productName: 'X', totalPrice: [{ currencyType: 'BILLC', priceCurrency: 'EUR', price: 1.234 }] }] })).toEqual([])
    expect(() => parseRates({ nope: 1 })).toThrow()
  })
  it('needs all three credentials and sends them as Basic auth', async () => {
    expect(myDhlConfig({ DHL_ACCOUNT_NUMBER: '1', DHL_API_KEY: 'k' })).toBeNull()
    const cfg = myDhlConfig({ DHL_ACCOUNT_NUMBER: '123', DHL_API_KEY: 'k', DHL_API_SECRET: 's', DHL_API_ENV: 'test' })!
    const f = vi.fn(async () => new Response(JSON.stringify(body)))
    await myDhlRater(cfg, f as unknown as typeof fetch)({ parcel, origin: { countryCode: 'BG', postalCode: '1000', city: 'Sofia' }, destination: { countryCode: 'BG', postalCode: '4000', city: 'Plovdiv' }, plannedDate: '2026-11-18' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/mydhlapi/test/rates?')
    expect(url).toContain('accountNumber=123')
    expect(url).toContain('isCustomsDeclarable=false')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('k:s').toString('base64')}`)
  })
  it('turns a DHL error status into an error', async () => {
    const cfg = myDhlConfig({ DHL_ACCOUNT_NUMBER: '1', DHL_API_KEY: 'k', DHL_API_SECRET: 's' })!
    const f = vi.fn(async () => new Response(JSON.stringify({ detail: 'bad account' }), { status: 401 }))
    await expect(myDhlRater(cfg, f as unknown as typeof fetch)({ parcel, origin: { countryCode: 'BG', postalCode: '1', city: 'a' }, destination: { countryCode: 'BG', postalCode: '1', city: 'b' }, plannedDate: '2026-11-18' })).rejects.toThrow(/401.*bad account/)
  })
})

describe('the action and the screen', () => {
  it('accepts the two DHL actions', () => {
    expect(checkEdit({ action: 'dhl_quote', id: 'of_1', parcel })).toMatchObject({ ok: true, value: { action: 'dhl_quote' } })
    expect(checkEdit({ action: 'dhl_origin_set', origin: {} }).ok).toBe(true)
    expect(checkEdit({ action: 'dhl_quote', id: 'bad', parcel }).ok).toBe(false)
  })
  const render = (client: typeof ownClient) => renderToString(h(AfterAcceptance, { offer: offer(client.id), client })).replace(/<!-- -->/g, '')
  it('shows the DHL panel only for a client charged our own DHL cost, and keeps the manual box', () => {
    const own = render(ownClient)
    expect(own).toContain('data-testid="dhl-price"')
    expect(own).toContain('Our DHL cost, euros')
    expect(own).toContain('data-testid="shipping-save"')
    expect(render(otherClient)).not.toContain('data-testid="dhl-price"')
  })
})
