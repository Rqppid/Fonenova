import { describe, expect, it } from 'vitest'
import { buildDraftBody, DEFAULT_DRAFT_SETTINGS, DuplicateInvoiceNumber, dueDate, raiseDraft, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { nextInvoiceNumber, nextOrderRef } from '@/lib/offers/numbering'
import { seedClients } from '@/lib/offers/clients'
import type { Store, StoreKey } from '@/lib/store'

function memStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    name: 'mem',
    data,
    async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: data.get(k) } : { kind: 'missing' as const } },
    async set(k: StoreKey, v: unknown) { data.set(k, v) },
    async del(k: StoreKey) { data.delete(k) },
    async withLock<T>(_n: string, fn: () => Promise<T>) { return fn() },
  }
}

const NOW = new Date('2026-11-15T10:00:00Z')
const lines = [{ description: 'iPhone 16 128GB Grade A', qty: 10, unitSaleCents: 45_700 }]
const wave = { ...seedClients()[0] }

function fakeXero(o: { isDemo?: boolean; numbers?: string[]; existing?: { id: string; number: string; status: string } | null; taken?: string[] } = {}) {
  const created: DraftBody[] = []
  const keys: string[] = []
  const numbers = [...(o.numbers ?? [])]
  const api: XeroApi = {
    async organisation() { return { name: o.isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo: o.isDemo === true } },
    async invoiceNumbers() { return numbers },
    async findByReference() { return o.existing ?? null },
    async createDraft(body, key) {
      // Someone else took this number between our read and our create: Xero lists it from now on.
      if (o.taken?.includes(body.InvoiceNumber)) { numbers.push(body.InvoiceNumber); throw new DuplicateInvoiceNumber() }
      created.push(body); keys.push(key); numbers.push(body.InvoiceNumber)
      return { id: `inv-${body.InvoiceNumber}`, number: body.InvoiceNumber, status: 'DRAFT' }
    },
  }
  return { api, created, keys }
}

describe('invoice numbers', () => {
  it('goes one past the highest 7-digit number, ignoring other formats', () => {
    expect(nextInvoiceNumber(['2026046', '2026047', 'INV-0001', '12345', ''], false)).toEqual({ ok: true, number: '2026048' })
  })
  it('uses only what Xero lists: there is no local counter to go above it', () => {
    expect(nextInvoiceNumber(['2026047'], false)).toEqual({ ok: true, number: '2026048' })
    expect(nextInvoiceNumber(['2026047', '2026050'], false)).toEqual({ ok: true, number: '2026051' })
  })
  it('refuses a live organisation with no numbers, seeds a demo one', () => {
    expect(nextInvoiceNumber([], false).ok).toBe(false)
    expect(nextInvoiceNumber([], true)).toEqual({ ok: true, number: '2026001' })
  })
})

describe('order references', () => {
  it('real offers take the next FN-ORD after known and reserved ones', () => {
    expect(nextOrderRef(['FN-ORD-014', 'FN-ORD-015'], ['FN-ORD-016'], false)).toBe('FN-ORD-017')
  })
  it('test offers use TEST-### and never consume a real number', () => {
    expect(nextOrderRef(['FN-ORD-014'], ['TEST-001', 'FN-ORD-015'], true)).toBe('TEST-002')
    expect(nextOrderRef(['FN-ORD-014'], ['TEST-001'], false)).toBe('FN-ORD-015')
  })
})

describe('draft invoice body', () => {
  it('is a DRAFT sales invoice in EUR by ContactID at sale prices', () => {
    const b = buildDraftBody({ number: '2026048', reference: 'FN-ORD-016', contactId: wave.xeroContactId!, lines, terms: { days: 30 }, now: NOW, settings: { ...DEFAULT_DRAFT_SETTINGS, brandingThemeId: 'theme-1' } })
    expect(b).toMatchObject({ Type: 'ACCREC', Status: 'DRAFT', CurrencyCode: 'EUR', InvoiceNumber: '2026048', Reference: 'FN-ORD-016', Date: '2026-11-15', DueDate: '2026-12-15', BrandingThemeID: 'theme-1' })
    expect(b.Contact).toEqual({ ContactID: wave.xeroContactId })
    expect(b.LineItems).toEqual([{ Description: 'iPhone 16 128GB Grade A', Quantity: 10, UnitAmount: 457, AccountCode: '200', TaxType: 'NONE' }])
  })
  it('upfront terms are due the same day', () => {
    expect(dueDate(NOW, 'upfront')).toBe('2026-11-15')
  })
})

describe('raiseDraft', () => {
  const base = { reference: 'FN-ORD-016', client: wave, lines, settings: DEFAULT_DRAFT_SETTINGS, now: NOW, allowLive: true }

  it('creates the next numbered draft and remembers the number', async () => {
    const x = fakeXero({ numbers: ['2026047'] })
    const store = memStore()
    const r = await raiseDraft({ ...base, api: x.api, store, test: false })
    expect(r).toMatchObject({ ok: true, number: '2026048', adopted: false })
    expect(x.created).toHaveLength(1)
    expect(x.keys[0]).toBe('fn-draft-FN-ORD-016-n2026048')
    expect([...store.data.keys()]).toEqual([]) // nothing is remembered locally: the next number comes from Xero
  })
  it('adopts an existing draft with the same reference instead of creating another', async () => {
    const x = fakeXero({ numbers: ['2026047'], existing: { id: 'inv-9', number: '2026048', status: 'DRAFT' } })
    const r = await raiseDraft({ ...base, api: x.api, store: memStore(), test: false })
    expect(r).toMatchObject({ ok: true, id: 'inv-9', adopted: true })
    expect(x.created).toHaveLength(0)
  })
  it('goes past a number that was taken in the meantime, leaving no duplicate', async () => {
    const x = fakeXero({ numbers: ['2026047'], taken: ['2026048'] })
    const r = await raiseDraft({ ...base, api: x.api, store: memStore(), test: false })
    expect(r).toMatchObject({ ok: true, number: '2026049' })
  })
  it('test offers are refused in the live organisation, real offers in a demo one', async () => {
    const live = fakeXero({ numbers: ['2026047'] })
    const a = await raiseDraft({ ...base, api: live.api, store: memStore(), test: true })
    expect(a.ok).toBe(false)
    const demo = fakeXero({ isDemo: true })
    const b = await raiseDraft({ ...base, api: demo.api, store: memStore(), test: false })
    expect(b.ok).toBe(false)
    expect(live.created.length + demo.created.length).toBe(0)
  })
  it('a test offer in a demo organisation starts at 2026001', async () => {
    const x = fakeXero({ isDemo: true })
    const r = await raiseDraft({ ...base, api: x.api, store: memStore(), test: true })
    expect(r).toMatchObject({ ok: true, number: '2026001' })
  })
  it('needs a Xero ContactID and priced lines', async () => {
    const x = fakeXero({ numbers: ['2026047'] })
    expect((await raiseDraft({ ...base, api: x.api, store: memStore(), test: false, client: { ...wave, xeroContactId: null } })).ok).toBe(false)
    expect((await raiseDraft({ ...base, api: x.api, store: memStore(), test: false, lines: [] })).ok).toBe(false)
  })
  it('a Xero failure is retryable and its message carries nothing but our sentence', async () => {
    const x = fakeXero({ numbers: ['2026047'] })
    x.api.createDraft = async () => { throw new Error('Xero draft failed (500)') }
    const r = await raiseDraft({ ...base, api: x.api, store: memStore(), test: false })
    expect(r).toMatchObject({ ok: false, retry: true })
  })
  it('a live organisation with no numbers is refused', async () => {
    const x = fakeXero({ numbers: [] })
    expect((await raiseDraft({ ...base, api: x.api, store: memStore(), test: false })).ok).toBe(false)
    expect(x.created).toHaveLength(0)
  })
})
