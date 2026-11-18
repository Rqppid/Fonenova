import { describe, expect, it, vi } from 'vitest'
import { checkEdit } from '@/lib/offers/edit'
import { seedClients } from '@/lib/offers/clients'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { fulfilOffer, type FulfilDeps } from '@/lib/offers/fulfil'
import { acceptByEmail } from '@/lib/offers/manual-accept'
import type { Offer, OfferLine } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))

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
const NOW = new Date('2026-11-18T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const lines: OfferLine[] = [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: '', note: null }]
const ITEMS = 457_000 // 10 x (450 + 7)

function offer(over: Partial<Offer> = {}): Offer {
  return { id: 'o1', status: 'ready', source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<a@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines, pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingLater: true, pricedAt: HOURS(3) }, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [], ...over }
}

function setup(o: Offer, opts: { allowReal?: boolean } = {}) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  const pings: string[] = []
  const created: DraftBody[] = []
  const replies: string[] = []
  const numbers = ['2026047']
  const api: XeroApi = {
    async organisation() { return { name: 'Fonenova Ltd', isDemo: false } },
    async invoiceNumbers() { return numbers },
    async findByReference() { return null },
    async createDraft(b) { if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber(); created.push(b); return { id: 'inv', number: b.InvoiceNumber, status: 'DRAFT' } },
  }
  const base: FulfilDeps = {
    store, now: NOW, allowReal: opts.allowReal ?? true, allowLiveXero: true, ownerAddress: 'o@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => ['FN-ORD-014'],
    xero: () => api,
    reply: async (m) => { replies.push(m.to); return { id: 'r1' } },
    replied: async () => false,
  }
  const d = { ...base, fulfil: (id: string) => fulfilOffer(id, base) }
  return { d, pings, created, replies, get: () => (store.data.get('offers') as Offer[])[0] }
}
const ok = { totalCents: ITEMS, note: 'Hamza: "okay thanks" 18 Nov', confirm: true }

describe('accepted by email outside the dashboard', () => {
  it('records the acceptance and starts the normal flow: reply to Mobile One, draft waits for shipping', async () => {
    const t = setup(offer())
    const r = await acceptByEmail('o1', t.d, ok)
    expect(r.ok).toBe(true)
    const o = t.get()
    expect(o.status).toBe('accepted')
    expect(o.sends).toHaveLength(1)
    expect(o.sends![0]).toMatchObject({ outcome: 'accepted', totalCents: ITEMS, gmailMessageId: 'manual', tokenHint: 'manual' })
    expect(o.sends![0].answer!.remarks).toContain('outside the dashboard')
    expect(o.audit.some((a) => a.what.includes('outside the dashboard'))).toBe(true)
    expect(o.fulfilment!.reply.state).toBe('sent')
    expect(o.fulfilment!.draft.state).toBe('waiting')
    expect(t.created).toHaveLength(0)
    expect(t.pings[0]).toContain('recorded by hand')
  })
  it('refuses a total that is not the dashboard price, and shows the dashboard figure', async () => {
    const t = setup(offer())
    const r = await acceptByEmail('o1', t.d, { ...ok, totalCents: ITEMS + 100 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('€4,570.00')
    expect(t.get().status).toBe('ready')
    expect(t.replies).toHaveLength(0)
  })
  it('needs the tick, a reviewed and priced offer, and an offer not already answered', async () => {
    expect((await acceptByEmail('o1', setup(offer()).d, { ...ok, confirm: false })).ok).toBe(false)
    expect((await acceptByEmail('o1', setup(offer({ status: 'needs_review' })).d, ok)).ok).toBe(false)
    expect((await acceptByEmail('o1', setup(offer({ pricing: undefined })).d, ok)).ok).toBe(false)
    expect((await acceptByEmail('o1', setup(offer({ status: 'sent' })).d, ok)).ok).toBe(false)
    const done = setup(offer())
    expect((await acceptByEmail('o1', done.d, ok)).ok).toBe(true)
    expect((await acceptByEmail('o1', done.d, ok)).message).toContain('already accepted')
  })
  it('refuses a price saved the old way, and real orders when real sending is off', async () => {
    const old = offer({ pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, pricedAt: HOURS(3) } })
    expect((await acceptByEmail('o1', setup(old).d, ok)).message).toContain('Update price')
    const off = setup(offer(), { allowReal: false })
    expect((await acceptByEmail('o1', off.d, ok)).ok).toBe(false)
    expect(off.get().status).toBe('ready')
  })
  it('checks the request shape', () => {
    expect(checkEdit({ action: 'accept_manual', id: 'of_a1', totalCents: 457_000, note: 'x', confirm: true })).toMatchObject({ ok: true })
    for (const totalCents of [0, 1.5, -1, '5', undefined]) expect(checkEdit({ action: 'accept_manual', id: 'of_a1', totalCents, confirm: true })).toMatchObject({ ok: false })
  })
})
