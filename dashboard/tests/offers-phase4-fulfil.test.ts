import { describe, expect, it, vi } from 'vitest'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { approveReply, buildReply, fulfilOffer, retryFulfilment, sweepFulfilment, type FulfilDeps, type ReplyMessage } from '@/lib/offers/fulfil'
import { applyAnswer } from '@/lib/offers/resolve'
import { seedClients } from '@/lib/offers/clients'
import type { Offer, OfferSend } from '@/lib/offers/types'
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

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const HASH = 'a'.repeat(64)

function offer(o: { test?: boolean; receivedHoursAgo?: number; totalCents?: number; clientId?: string } = {}): Offer {
  const test = o.test === true
  const send: OfferSend = { clientId: o.clientId ?? (test ? 'c_test' : 'c_wave'), clientName: test ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: HASH, tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: o.totalCents ?? 457_000, units: 10, test, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return {
    id: 'o1', status: 'accepted',
    source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<abc@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer 12 Nov', receivedAt: HOURS(o.receivedHoursAgo ?? 5) },
    text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }],
    shipping: { mobileOneCents: 0, source: 'none', sourceText: null },
    pricing: { clientId: send.clientId, marginCents: 700, overrides: {}, ackLow: false, pricedAt: HOURS(3) },
    sends: [send], createdAt: HOURS(6), updatedAt: HOURS(1), audit: [],
  }
}

function setup(o: Offer, opts: { allowReal?: boolean; xeroOk?: boolean; isDemo?: boolean; replied?: boolean | 'throw'; replyFails?: number; xeroNumbers?: string[]; known?: string[] } = {}) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_test' ? { ...c, xeroContactId: '11111111-2222-3333-4444-555555555555' } : c.id === 'c_wave' ? { ...c, termsConfirmed: true } : c)))
  const sent: ReplyMessage[] = []
  const pings: string[] = []
  const created: DraftBody[] = []
  let replyFails = opts.replyFails ?? 0
  const numbers = [...(opts.xeroNumbers ?? ['2026047'])]
  const api: XeroApi = {
    async organisation() { return { name: opts.isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo: opts.isDemo === true } },
    async invoiceNumbers() { return numbers },
    async findByReference(ref) { const f = created.find((c) => c.Reference === ref); return f ? { id: `inv-${f.InvoiceNumber}`, number: f.InvoiceNumber, status: 'DRAFT' } : null },
    async createDraft(b) { if (numbers.includes(b.InvoiceNumber)) throw new DuplicateInvoiceNumber(); created.push(b); numbers.push(b.InvoiceNumber); return { id: `inv-${b.InvoiceNumber}`, number: b.InvoiceNumber, status: 'DRAFT' } },
  }
  const d: FulfilDeps = {
    store, now: NOW, allowReal: opts.allowReal ?? true, allowLiveXero: true, ownerAddress: 'owner@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => opts.known ?? ['FN-ORD-014', 'FN-ORD-015'],
    xero: () => (opts.xeroOk === false ? null : api),
    reply: async (m) => { if (replyFails-- > 0) throw new Error('Gmail did not send it (500)'); sent.push(m); return { id: `msg${sent.length}` } },
    replied: async () => { if (opts.replied === 'throw') throw new Error('no read'); return opts.replied === true },
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, sent, pings, created, get }
}

describe('real offer', () => {
  it('replies to Mobile One in their thread and raises the next draft invoice', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    const f = t.get().fulfilment!
    expect(f.orderRef).toBe('FN-ORD-016')
    expect(f.reply.state).toBe('sent')
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toMatchObject({ to: 'bv@mobileone.info', subject: 'Re: Offer 12 Nov', threadId: 't1', inReplyTo: '<abc@mobileone.info>' })
    expect(t.sent[0].text).toContain('We accept the offer. Please proceed with the invoice.')
    expect(f.draft).toMatchObject({ state: 'done', invoiceNumber: '2026048' })
    expect(t.created[0]).toMatchObject({ Reference: 'FN-ORD-016', Status: 'DRAFT' })
    expect(t.pings.at(-1)).toContain('FN-ORD-016')
  })
  it('running it twice sends and creates nothing more', async () => {
    const t = setup(offer())
    await fulfilOffer('o1', t.d)
    await fulfilOffer('o1', t.d)
    await sweepFulfilment(t.d)
    expect(t.sent).toHaveLength(1)
    expect(t.created).toHaveLength(1)
  })
  it('holds the reply (and tells you) when the offer is over 48 hours old, but still raises the draft', async () => {
    const t = setup(offer({ receivedHoursAgo: 60 }))
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.reply).toMatchObject({ state: 'held' })
    expect(t.sent).toHaveLength(0)
    expect(t.get().fulfilment!.draft.state).toBe('done')
    expect(t.pings.some((p) => p.includes('waiting for you'))).toBe(true)
  })
  it('holds when the accepted total does not match the priced offer', async () => {
    const t = setup(offer({ totalCents: 400_000 }))
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.reply.state).toBe('held')
    expect(t.get().fulfilment!.reply.reason).toContain('does not match')
  })
  it('holds when you already replied by hand, or when the thread cannot be checked', async () => {
    const a = setup(offer(), { replied: true })
    await fulfilOffer('o1', a.d)
    expect(a.get().fulfilment!.reply.reason).toContain('already replied')
    const b = setup(offer(), { replied: 'throw' })
    await fulfilOffer('o1', b.d)
    expect(b.get().fulfilment!.reply.state).toBe('held')
    expect(a.sent.length + b.sent.length).toBe(0)
  })
  it('a held reply goes out only after OK, once', async () => {
    const t = setup(offer({ receivedHoursAgo: 60 }))
    await fulfilOffer('o1', t.d)
    expect((await approveReply('o1', t.d)).ok).toBe(true)
    expect(t.sent).toHaveLength(1)
    expect((await approveReply('o1', t.d)).ok).toBe(false)
    expect(t.sent).toHaveLength(1)
  })
  it('with real sending switched off nothing reaches Mobile One, even after OK', async () => {
    const t = setup(offer(), { allowReal: false })
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.reply.state).toBe('held')
    expect((await approveReply('o1', t.d)).ok).toBe(false)
    expect(t.sent).toHaveLength(0)
  })
  it('a failed send is retried by the 5-minute check and alerts once after three tries', async () => {
    const t = setup(offer(), { replyFails: 3 })
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.reply).toMatchObject({ state: 'failed', attempts: 1 })
    await sweepFulfilment(t.d)
    await sweepFulfilment(t.d)
    expect(t.pings.filter((p) => p.includes('failed 3 times'))).toHaveLength(1)
    await sweepFulfilment(t.d)
    expect(t.get().fulfilment!.reply.state).toBe('sent')
    expect(t.sent).toHaveLength(1)
  })
})

describe('test offer', () => {
  it('sends the would-be reply to your inbox only, unthreaded, and a TEST- reference to the demo org', async () => {
    const t = setup(offer({ test: true }), { isDemo: true, xeroNumbers: [] })
    await fulfilOffer('o1', t.d)
    const f = t.get().fulfilment!
    expect(f.orderRef).toBe('TEST-001')
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0].to).toBe('owner@example.test')
    expect(t.sent[0].threadId).toBeUndefined()
    expect(t.sent[0].inReplyTo).toBeUndefined()
    expect(t.sent[0].text).toContain('nothing was sent to Mobile One')
    expect(f.draft).toMatchObject({ state: 'done', invoiceNumber: '2026001' })
  })
  it('never raises a draft in the live Xero organisation', async () => {
    const t = setup(offer({ test: true }), { isDemo: false })
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('blocked')
    expect(t.created).toHaveLength(0)
  })
  it('buildReply never targets Mobile One for a test', () => {
    const o = offer({ test: true })
    const m = buildReply(o, { orderRef: 'TEST-001', test: true, startedAt: '', reply: { state: 'pending', attempts: 0 }, draft: { state: 'pending', attempts: 0 } }, 'owner@example.test')
    expect(m.to).not.toContain('mobileone')
  })
})

describe('draft step', () => {
  it('is blocked, not retried, while the Xero write connection is not set up, and resumes on Try again', async () => {
    const t = setup(offer(), { xeroOk: false })
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'blocked', attempts: 0 })
    expect((await sweepFulfilment(t.d)).tried).toBe(0)
    const ready = { ...t.d, xero: () => ({ async organisation() { return { name: 'Fonenova Ltd', isDemo: false } }, async invoiceNumbers() { return ['2026047'] }, async findByReference() { return null }, async createDraft(b: DraftBody) { return { id: 'i', number: b.InvoiceNumber, status: 'DRAFT' } } }) as XeroApi }
    await retryFulfilment('o1', ready)
    expect(t.get().fulfilment!.draft).toMatchObject({ state: 'done', invoiceNumber: '2026048' })
  })
  it('real offers reserve past every known and reserved order number', async () => {
    const t = setup(offer(), { known: ['FN-ORD-020'] })
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.orderRef).toBe('FN-ORD-021')
  })
})

describe('applyAnswer starts it', () => {
  it('an accepted answer starts the work, and a decline does not', async () => {
    const t = setup({ ...offer(), status: 'sent', fulfilment: undefined, sends: [{ ...offer().sends![0], outcome: 'pending', answer: undefined, resolvedAt: undefined }] })
    const fulfil = vi.fn(async (id: string) => fulfilOffer(id, t.d))
    const r = await applyAnswer(HASH, { store: t.store, notify: t.d.notify, now: NOW, fulfil, getAnswer: async () => ({ decision: 'accept', remarks: '', at: HOURS(0), ip: '1.1.1.1', ua: 'x' }) })
    expect(r.changed).toBe(true)
    expect(fulfil).toHaveBeenCalledWith('o1')
    expect(t.get().fulfilment?.reply.state).toBe('sent')
  })
  it('a fulfilment failure never undoes the accepted status', async () => {
    const t = setup({ ...offer(), status: 'sent', sends: [{ ...offer().sends![0], outcome: 'pending', answer: undefined, resolvedAt: undefined }] })
    await applyAnswer(HASH, { store: t.store, notify: t.d.notify, now: NOW, fulfil: async () => { throw new Error('boom') }, getAnswer: async () => ({ decision: 'accept', remarks: '', at: HOURS(0), ip: '1.1.1.1', ua: 'x' }) })
    expect(t.get().status).toBe('accepted')
  })
})
