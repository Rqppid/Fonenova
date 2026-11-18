import { describe, expect, it, vi } from 'vitest'
import { seedClients } from '@/lib/offers/clients'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { fulfilOffer } from '@/lib/offers/fulfil'
import type { InvoiceDeps } from '@/lib/offers/invoice-flow'
import { autoShippingFor, sweepShipping } from '@/lib/offers/shipping-auto'
import { checkInvoice, type InvoiceReading } from '@/lib/offers/shipping-check'
import type { Offer, OfferLine, OfferSend } from '@/lib/offers/types'
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

// The real Mobile One invoice 2026090090: four product lines and SHIPPING CHARGES EUR 125.00, total EUR 54,135.00.
const L = (id: string, model: string, storage: string, qty: number, cost: number): OfferLine => ({ id, model, storage, grade: 'USED', qty, unitCostCents: cost, sourceText: '', note: null })
const LINES = [L('a1', 'iPhone 16', '128GB', 20, 46_500), L('a2', 'iPhone 16', '256GB', 20, 53_300), L('a3', 'iPhone 16 Pro', '128GB', 30, 54_100), L('a4', 'iPhone 16 Pro', '256GB', 30, 59_400)]
const INVOICE: InvoiceReading = {
  supplier: 'Mobile One Trade B.V.', invoiceNumber: '2026090090',
  items: [
    { description: 'IPHONE 16 128GB - USED', quantity: 20, amountCents: 930_000 },
    { description: 'IPHONE 16 256GB - USED', quantity: 20, amountCents: 1_066_000 },
    { description: 'IPHONE 16 PRO 128GB - USED', quantity: 30, amountCents: 1_623_000 },
    { description: 'IPHONE 16 PRO 256GB - USED', quantity: 30, amountCents: 1_782_000 },
  ],
  shippingCents: 12_500, totalCents: 5_413_500,
}

describe('checkInvoice', () => {
  it('accepts the real invoice and returns its shipping', () => {
    expect(checkInvoice({ lines: LINES }, INVOICE)).toEqual({ ok: true, shippingCents: 12_500 })
  })
  it('refuses anything that does not agree with the offer', () => {
    const bad = (inv: Partial<InvoiceReading>, lines = LINES) => checkInvoice({ lines }, { ...INVOICE, ...inv })
    expect(bad({ supplier: 'Someone Else Ltd' }).ok).toBe(false)
    expect(bad({ shippingCents: null }).ok).toBe(false)
    expect(bad({ shippingCents: 0 }).ok).toBe(false)
    expect(bad({ shippingCents: 2_000_000, totalCents: 5_413_500 + 1_987_500 }).ok).toBe(false) // above the automatic cap
    expect(bad({ items: INVOICE.items.slice(1) }).ok).toBe(false) // a line missing
    expect(bad({ items: [...INVOICE.items, { description: 'Extra', quantity: 1, amountCents: 100 }] }).ok).toBe(false) // an extra product
    expect(bad({ items: [{ ...INVOICE.items[0], quantity: 19 }, ...INVOICE.items.slice(1)] }).ok).toBe(false) // wrong quantity
    expect(bad({ items: [{ ...INVOICE.items[0], amountCents: 900_000 }, ...INVOICE.items.slice(1)] }).ok).toBe(false) // wrong price
    expect(bad({ totalCents: 5_500_000 }).ok).toBe(false) // total is not items + shipping
    expect(bad({ totalCents: null }).ok).toBe(false)
  })
})

const NOW = new Date('2026-11-18T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
function offer(clientId = 'c_wave', test = false): Offer {
  const send: OfferSend = { clientId, clientName: 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: LINES.reduce((n, l) => n + l.qty * (l.unitCostCents + 700), 0), units: 100, test, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return { id: 'o1', status: 'accepted', source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<abc@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: LINES, pricing: { clientId, marginCents: 700, overrides: {}, ackLow: false, shippingLater: true, pricedAt: HOURS(3) }, sends: [send], createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

function setup(o: Offer, files: { name: string; mime?: string; from?: string }[], reading: InvoiceReading | null) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' || c.id === 'c_eutelecoms' ? { ...c, termsConfirmed: true, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c)))
  const pings: string[] = []
  const created: DraftBody[] = []
  const numbers = ['2026047']
  const api: XeroApi = {
    async organisation() { return { name: 'Fonenova Ltd', isDemo: false } },
    async invoiceNumbers() { return numbers },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b) { if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber(); created.push(b); numbers.push(b.InvoiceNumber); return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' } },
  }
  const reads: number[] = []
  const d: InvoiceDeps = {
    store, now: NOW, allowReal: true, allowLiveXero: true, allowApprove: true, ownerAddress: 'owner@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => ['FN-ORD-014'],
    xero: () => api,
    reply: async () => ({ id: 'r1' }),
    replied: async () => false,
    filing: { dirs: null, upload: async () => ({ kind: 'unavailable' as const }) },
    bills: async () => ({ bills: [], pairs: [] }),
    savePair: async () => {},
    gmailThread: {
      messages: async () => [{ id: 'm1', from: 'Mobile One Trade <bv@mobileone.info>', subject: 'Offer', receivedAt: HOURS(5), labels: [], files: files.map((f, i) => ({ messageId: 'm2', partId: `${i + 1}`, attachmentId: `att${i}`, filename: f.name, mime: f.mime ?? 'application/pdf', size: 90_000 })) }].map((m) => ({ ...m, from: files[0]?.from ?? m.from })),
      file: async () => { reads.push(1); return new Uint8Array([1, 2, 3]) },
      rfcId: async () => null,
    },
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, pings, created, get, reads, read: async () => reading }
}

describe('shipping from Mobile One\'s invoice', () => {
  it('fills Wave in (x2) and the draft is raised with the shipping line', async () => {
    const t = setup(offer(), [{ name: 'Factuur 2026090090.pdf' }], INVOICE)
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('waiting')
    expect(await autoShippingFor('o1', t.d, t.read)).toBe('filled')
    const f = t.get().fulfilment!
    expect(f.shipping).toMatchObject({ cents: 25_000, mobileOneCents: 12_500, source: 'invoice' })
    expect(f.draft.state).toBe('done')
    expect(JSON.stringify(t.created[0])).toContain('SHIPPING')
    expect(t.pings.at(-1)).toContain('read from Mobile One')
  })
  it('a mismatch leaves it waiting, says why once, and does not read the same file again', async () => {
    const t = setup(offer(), [{ name: 'Factuur.pdf' }], { ...INVOICE, totalCents: 1 })
    await fulfilOffer('o1', t.d)
    t.pings.length = 0
    expect(await autoShippingFor('o1', t.d, t.read)).toBe('unclear')
    expect(t.get().fulfilment!.draft.state).toBe('waiting')
    expect(t.pings).toHaveLength(1)
    expect(await autoShippingFor('o1', t.d, t.read)).toBe('nothing')
    expect(t.pings).toHaveLength(1)
    expect(t.reads).toHaveLength(1)
  })
  it('leaves EU Telecoms, test orders and anything not Mobile One alone', async () => {
    const eu = setup(offer('c_eutelecoms'), [{ name: 'f.pdf' }], INVOICE)
    await fulfilOffer('o1', eu.d)
    expect(await autoShippingFor('o1', eu.d, eu.read)).toBe('skipped')
    const other = setup(offer(), [{ name: 'f.pdf', from: 'Spam <x@example.test>' }], INVOICE)
    await fulfilOffer('o1', other.d)
    expect(await autoShippingFor('o1', other.d, other.read)).toBe('nothing')
    expect(other.reads).toHaveLength(0)
    const sheet = setup(offer(), [{ name: 'imei.xlsx', mime: 'application/vnd.ms-excel' }], INVOICE)
    await fulfilOffer('o1', sheet.d)
    expect(await autoShippingFor('o1', sheet.d, sheet.read)).toBe('nothing') // only PDFs are read
  })
  it('a document that is not an invoice is skipped quietly, and the sweep counts what it filled', async () => {
    const t = setup(offer(), [{ name: 'label.pdf' }], null)
    await fulfilOffer('o1', t.d)
    t.pings.length = 0
    expect(await autoShippingFor('o1', t.d, t.read)).toBe('nothing')
    expect(t.pings).toHaveLength(0)
    const ok = setup(offer(), [{ name: 'Factuur.pdf' }], INVOICE)
    await fulfilOffer('o1', ok.d)
    expect(await sweepShipping(ok.d, ok.read)).toEqual({ looked: 1, filled: 1 })
  })
})
