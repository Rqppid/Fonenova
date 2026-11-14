import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DRAFT_SETTINGS, DuplicateInvoiceNumber, raiseDraft, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { seedClients } from '@/lib/offers/clients'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))

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
const wave = { ...seedClients()[0], termsConfirmed: true }
const lines = [{ description: 'iPhone 16 128GB A', qty: 10, unitSaleCents: 45_700 }]
const base = (store: Store, api: XeroApi, reference = 'FN-ORD-016') => ({ api, store, reference, client: wave, test: false, lines, settings: DEFAULT_DRAFT_SETTINGS, now: NOW, allowLive: true })

/** A fake Xero organisation: the sales numbers it lists, drafts it holds, and optional races. */
function xero(o: { numbers?: string[]; isDemo?: boolean; dupFirst?: string[]; dupAlways?: boolean; slowCreate?: boolean } = {}) {
  const numbers = [...(o.numbers ?? [])]
  const drafts: DraftBody[] = []
  const calls = { reads: 0, creates: 0 }
  const dups = new Set(o.dupFirst ?? [])
  const api: XeroApi = {
    async organisation() { return { name: o.isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo: o.isDemo === true } },
    async invoiceNumbers() { calls.reads++; return [...numbers] },
    async findByReference(ref) { const f = drafts.find((d) => d.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b) {
      calls.creates++
      if (o.slowCreate) await new Promise((r) => setTimeout(r, 10))
      if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber() // Xero enforces unique numbers
      if (o.dupAlways || dups.has(b.InvoiceNumber)) { dups.delete(b.InvoiceNumber); numbers.push(b.InvoiceNumber); throw new DuplicateInvoiceNumber() } // someone else holds it: Xero lists it from now on
      drafts.push(b); numbers.push(b.InvoiceNumber)
      return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' }
    },
  }
  return { api, numbers, drafts, calls }
}

describe('the invoice number comes from Xero, at draft time', () => {
  it('continues the live sequence: 2026047 is the highest, so the draft gets 2026048', async () => {
    const x = xero({ numbers: ['2026045', '2026046', '2026047', 'INV-0001'] })
    const r = await raiseDraft(base(mutexStore(), x.api))
    expect(r).toMatchObject({ ok: true, number: '2026048', adopted: false })
    expect(x.drafts[0].InvoiceNumber).toBe('2026048')
  })
  it('the next draft continues from what Xero now lists, with no local counter involved', async () => {
    const x = xero({ numbers: ['2026047'] })
    const store = mutexStore()
    expect(await raiseDraft(base(store, x.api, 'FN-ORD-016'))).toMatchObject({ number: '2026048' })
    expect(await raiseDraft(base(store, x.api, 'FN-ORD-017'))).toMatchObject({ number: '2026049' })
    expect(x.calls.reads).toBe(2) // read from Xero each time
    expect([...store.data.keys()]).toEqual([]) // and nothing is remembered locally
  })
  it('an invoice raised in Xero or Invoice2go in between is respected: the highest number read at draft time wins', async () => {
    const x = xero({ numbers: ['2026047'] })
    const store = mutexStore()
    expect(await raiseDraft(base(store, x.api, 'FN-ORD-016'))).toMatchObject({ number: '2026048' })
    x.numbers.push('2026055') // raised by hand in Xero afterwards
    expect(await raiseDraft(base(store, x.api, 'FN-ORD-017'))).toMatchObject({ number: '2026056' })
  })
  it('an old local value of any kind has no say', async () => {
    const x = xero({ numbers: ['2026047'] })
    const store = mutexStore()
    store.data.set('offers:invoice-hwm', 2026099) // what an older version might have left behind
    expect(await raiseDraft(base(store, x.api))).toMatchObject({ number: '2026048' })
    expect(store.data.get('offers:invoice-hwm')).toBe(2026099) // untouched
  })
  it('never sets a number it did not read: a live organisation with no numbers is refused, nothing created', async () => {
    const x = xero({ numbers: ['INV-0001'] })
    const r = await raiseDraft(base(mutexStore(), x.api))
    expect(r).toMatchObject({ ok: false })
    expect(x.drafts).toHaveLength(0)
  })
  it('the Demo Company starts at 2026001 and then continues from Xero: 2026002', async () => {
    const x = xero({ isDemo: true })
    const store = mutexStore()
    const t = (ref: string) => raiseDraft({ ...base(store, x.api, ref), test: true })
    expect(await t('TEST-001')).toMatchObject({ ok: true, number: '2026001' })
    expect(await t('TEST-002')).toMatchObject({ ok: true, number: '2026002' })
  })
})

describe('a duplicate number: read again, retry once, never two drafts', () => {
  it('re-reads Xero and creates exactly one draft with the next free number', async () => {
    const x = xero({ numbers: ['2026047'], dupFirst: ['2026048'] })
    const r = await raiseDraft(base(mutexStore(), x.api))
    expect(r).toMatchObject({ ok: true, number: '2026049', adopted: false })
    expect(x.drafts).toHaveLength(1)
    expect(x.calls).toEqual({ reads: 2, creates: 2 }) // one failed create, one that worked
  })
  it('a second duplicate in a row stops: nothing created, retryable, and not a third try', async () => {
    const x = xero({ numbers: ['2026047'], dupAlways: true })
    const r = await raiseDraft(base(mutexStore(), x.api))
    expect(r).toMatchObject({ ok: false, retry: true })
    expect(x.drafts).toHaveLength(0)
    expect(x.calls).toEqual({ reads: 2, creates: 2 })
  })
  it('if a draft for this order appeared while retrying, it is linked, not duplicated', async () => {
    const x = xero({ numbers: ['2026047'] })
    const real = x.api.createDraft
    let first = true
    x.api.createDraft = async (b, k) => {
      if (first) { first = false; x.drafts.push({ ...b, InvoiceNumber: '2026048' }); x.numbers.push('2026048'); throw new DuplicateInvoiceNumber() } // a parallel run saved it
      return real(b, k)
    }
    const r = await raiseDraft(base(mutexStore(), x.api))
    expect(r).toMatchObject({ ok: true, number: '2026048', adopted: true })
    expect(x.drafts).toHaveLength(1)
  })
  it('the same order raised twice at once gives one draft; two different orders get two different numbers', async () => {
    const x = xero({ numbers: ['2026047'], slowCreate: true })
    const store = mutexStore()
    const same = await Promise.all([raiseDraft(base(store, x.api, 'FN-ORD-016')), raiseDraft(base(store, x.api, 'FN-ORD-016'))])
    expect(same.every((r) => r.ok)).toBe(true)
    expect(x.drafts.filter((d) => d.Reference === 'FN-ORD-016')).toHaveLength(1)
    const y = xero({ numbers: ['2026047'], slowCreate: true })
    const two = await Promise.all([raiseDraft(base(mutexStore(), y.api, 'FN-ORD-016')), raiseDraft(base(mutexStore(), y.api, 'FN-ORD-017'))])
    // Separate stores model two servers: the loser gets a duplicate from Xero, re-reads, and takes the next number.
    const nums = two.map((r) => (r.ok ? r.number : 'x')).sort()
    expect(new Set(nums).size).toBe(2)
    expect(y.drafts).toHaveLength(2)
  })
})

describe('how the real client recognises a duplicate number', () => {
  const env = { ...process.env }
  let dir: string
  const respond = vi.hoisted(() => ({ fn: (_p: string, _m: string): Response => new Response('', { status: 500 }) }))
  beforeEach(async () => {
    vi.resetModules()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-num-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
    const { getStore } = await import('@/lib/store')
    await getStore().set('xero-write:tokens', { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, tenantId: 'ten-1234-5678', tenantName: 'Demo Company (UK)', isDemo: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => { const u = new URL(url); return respond.fn(u.pathname.replace('/api.xro/2.0', '') + u.search, init.method ?? 'GET') }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })
  const body: DraftBody = { Type: 'ACCREC', Status: 'DRAFT', InvoiceNumber: '2026048', Reference: 'FN-ORD-016', Contact: { ContactID: '11111111-2222-3333-4444-555555555555' }, Date: '2026-11-15', DueDate: '2026-11-22', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', LineItems: [{ Description: 'x', Quantity: 1, UnitAmount: 1, AccountCode: '200', TaxType: 'NONE' }] }
  const err = (...m: string[]) => JSON.stringify({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: m.map((Message) => ({ Message })) }] })

  it('"Invoice # must be unique" and "already exists" are duplicates', async () => {
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const { DuplicateInvoiceNumber: Dup } = await import('@/lib/offers/draft')
    for (const m of ['Invoice # must be unique.', 'Invoice not saved due to validation error: Invoice number already exists', 'InvoiceNumber must be unique']) {
      respond.fn = (_p, method) => (method === 'POST' ? new Response(err(m), { status: 400 }) : Response.json({}))
      await expect(xeroWriteApi().createDraft(body, 'k'), m).rejects.toBeInstanceOf(Dup)
    }
  })
  it('a contact-name uniqueness message, or any other refusal, is not mistaken for a duplicate number', async () => {
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const { XeroRejected: Rej } = await import('@/lib/offers/draft')
    for (const m of ['Contact name must be unique', 'Organisation is not subscribed to currency EUR']) {
      respond.fn = (_p, method) => (method === 'POST' ? new Response(err(m), { status: 400 }) : Response.json({}))
      await expect(xeroWriteApi().createDraft(body, 'k'), m).rejects.toBeInstanceOf(Rej)
    }
  })
  it('lists every sales invoice number across pages, all statuses, so the highest is the real highest', async () => {
    const seen: string[] = []
    const page = (n: number) => Array.from({ length: 1000 }, (_, i) => ({ InvoiceNumber: n === 1 && i === 999 ? '2026047' : `INV-${n}-${i}` }))
    respond.fn = (p) => {
      seen.push(p)
      const pg = Number(/page=(\d+)/.exec(p)?.[1] ?? 1)
      return Response.json({ Invoices: pg === 1 ? page(1) : pg === 2 ? [{ InvoiceNumber: '2026052' }] : [] })
    }
    const { xeroWriteApi } = await import('@/lib/xero/write')
    const nums = await xeroWriteApi().invoiceNumbers()
    expect(nums).toContain('2026047')
    expect(nums).toContain('2026052')
    expect(seen.every((s) => /Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED/.test(decodeURIComponent(s)) || s.includes('Statuses=DRAFT'))).toBe(true)
    expect(decodeURIComponent(seen[0])).toContain('Type=="ACCREC"')
    expect(seen).toHaveLength(2)
  })
})
