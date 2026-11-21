import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SentGuessBanner } from '@/components/offers/manual-send-panel'
import { seedClients } from '@/lib/offers/clients'
import { checkEdit } from '@/lib/offers/edit'
import type { FulfilDeps } from '@/lib/offers/fulfil'
import type { ParsedOffer } from '@/lib/offers/parse'
import { confirmSentGuess, detectSent, dismissSentGuess, matchSentToOffer } from '@/lib/offers/sent-detect'
import type { MailMessage } from '@/lib/gmail'
import type { Offer, OfferLine } from '@/lib/offers/types'
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
const NOW = new Date('2026-11-22T12:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const L = (id: string, model: string, storage: string, qty: number, cost: number): OfferLine => ({ id, model, storage, grade: 'A', qty, unitCostCents: cost, sourceText: '', note: null })
const LINES = [L('a1', 'iPhone 16', '128GB', 20, 46_500), L('a2', 'iPhone 16 Pro', '256GB', 30, 59_400)]
const sentLines = (m = 500): OfferLine[] => [L('s1', 'iPhone 16', '128GB', 20, 46_500 + m), L('s2', 'iPhone 16 Pro', '256GB', 30, 59_400 + m)]
const TOTAL = 20 * 47_000 + 30 * 59_900

function offer(id: string, over: Partial<Offer> = {}): Offer {
  return { id, status: 'ready', source: { gmailMessageId: `m-${id}`, threadId: 't1', rfcMessageId: null, from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: LINES, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [], ...over }
}
const mail = (id: string, to: string, over: Partial<MailMessage> = {}): MailMessage => ({ id, threadId: 'th', rfcMessageId: null, from: 'info@fonenova.com', to, subject: 'Offer from FoneNova', receivedAt: HOURS(2), labels: ['SENT'], text: 'Hello, our offer:\niPhone 16 128GB x 20 EUR 470\niPhone 16 Pro 256GB x 30 EUR 599\nKind regards\nFoneNova Ltd', attachments: [], ...over })

function setup(offers: Offer[], messages: MailMessage[], parsed: ParsedOffer | ((t: string) => ParsedOffer) = { isOffer: true, reason: '', lines: sentLines() }) {
  const store = memStore()
  store.data.set('offers', offers)
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_eutelecoms' ? { ...c, margin: { type: 'manual' as const }, offerEmails: ['contact@eutelecoms.com'], termsConfirmed: true } : c)))
  const pings: string[] = []
  let reads = 0
  const d = { store, now: NOW, list: async () => messages.map((m) => m.id), get: async (id: string) => messages.find((m) => m.id === id)!, read: async (t: string) => { reads++; return typeof parsed === 'function' ? parsed(t) : parsed }, notify: async (t: string) => { pings.push(t); return true } }
  const fd: FulfilDeps = { store, now: NOW, allowReal: true, invoicing: false, ownerAddress: 'o@example.test', notify: d.notify, knownOrderIds: async () => [], xero: () => null, reply: async () => ({ id: 'r' }), replied: async () => false }
  const get = (i = 0) => (store.data.get('offers') as Offer[])[i]
  return { d, fd, pings, get, store, reads: () => reads }
}

describe('matching a sent email to an offer', () => {
  it('every line must match by model, storage and quantity, quoted above cost, with no extra products', () => {
    expect(matchSentToOffer(LINES, sentLines())).toEqual({ marginCents: 500, overrides: {}, totalCents: TOTAL, units: 50 })
    const mixed = sentLines(); mixed[1].unitCostCents = 59_400 + 800
    expect(matchSentToOffer(LINES, mixed)).toMatchObject({ marginCents: 500, overrides: { a2: 800 } })
    expect(matchSentToOffer(LINES, sentLines().slice(1))).toBeNull() // a line missing
    expect(matchSentToOffer(LINES, [...sentLines(), L('x', 'iPhone 17', '256GB', 1, 90_000)])).toBeNull() // an extra product
    expect(matchSentToOffer(LINES, sentLines().map((l) => ({ ...l, qty: l.qty + 1 })))).toBeNull() // wrong quantities
    expect(matchSentToOffer(LINES, LINES)).toBeNull() // quoted at cost: probably Mobile One's own text
    expect(matchSentToOffer(LINES, sentLines(-100))).toBeNull()
  })
})

describe('finding the sent email', () => {
  it('one match: stores a suggestion on that offer only, and tells you; nothing else changes', async () => {
    const t = setup([offer('o1')], [mail('g1', 'contact@eutelecoms.com')])
    const r = await detectSent(t.d)
    expect(r).toEqual({ examined: 1, guessed: 1 })
    const o = t.get()
    expect(o.status).toBe('ready')
    expect(o.pricing).toBeUndefined()
    expect(o.sentGuess).toMatchObject({ messageId: 'g1', clientId: 'c_eutelecoms', totalCents: TOTAL, marginCents: 500 })
    expect(o.sentGuess!.ambiguousWith).toBeUndefined()
    expect(t.pings).toHaveLength(1)
    expect(t.pings[0]).toContain('Open the offer to confirm')
    // the same email is not examined twice
    await detectSent(t.d)
    expect(t.reads()).toBe(1)
  })
  it('two similar offers match the same email: both are marked ambiguous', async () => {
    const t = setup([offer('o1'), offer('o2')], [mail('g1', 'contact@eutelecoms.com')])
    await detectSent(t.d)
    expect(t.get(0).sentGuess!.ambiguousWith).toEqual(['o2'])
    expect(t.get(1).sentGuess!.ambiguousWith).toEqual(['o1'])
    expect(t.pings[0]).toContain('pick the right one')
  })
  it('ignores: mail to someone who is not a client, mail not sent by us, a non-offer, an offer that arrived after it, test offers, and handled offers', async () => {
    expect((await detectSent(setup([offer('o1')], [mail('g1', 'stranger@example.test')]).d)).examined).toBe(0)
    expect((await detectSent(setup([offer('o1')], [mail('g1', 'contact@eutelecoms.com', { labels: ['INBOX'] })]).d)).examined).toBe(0)
    expect((await detectSent(setup([offer('o1')], [mail('g1', 'contact@eutelecoms.com')], { isOffer: false, reason: '', lines: [] }).d)).guessed).toBe(0)
    expect((await detectSent(setup([offer('o1', { source: { ...offer('o1').source, receivedAt: HOURS(1) } })], [mail('g1', 'contact@eutelecoms.com')]).d)).guessed).toBe(0)
    expect((await detectSent(setup([offer('o1', { testOnly: true })], [mail('g1', 'contact@eutelecoms.com')]).d)).guessed).toBe(0)
    expect((await detectSent(setup([offer('o1', { status: 'sent' })], [mail('g1', 'contact@eutelecoms.com')]).d)).guessed).toBe(0)
    expect((await detectSent(setup([offer('o1', { sentGuessDismissed: ['g1'] })], [mail('g1', 'contact@eutelecoms.com')]).d)).guessed).toBe(0)
  })
  it('a failure leaves the email to be looked at again next time', async () => {
    const t = setup([offer('o1')], [mail('g1', 'contact@eutelecoms.com')])
    t.d.read = async () => { throw new Error('model down') }
    await detectSent(t.d)
    expect(t.store.data.get('offers:sent-seen')).toBeUndefined()
  })
})

describe('confirming or dismissing', () => {
  async function guessed(offers: Offer[]) {
    const t = setup(offers, [mail('g1', 'contact@eutelecoms.com')])
    await detectSent(t.d)
    return t
  }
  it('confirm prices it as quoted, marks it sent by hand, and clears the same suggestion from other offers', async () => {
    const t = await guessed([offer('o1'), offer('o2')])
    const r = await confirmSentGuess('o1', t.fd)
    expect(r.ok).toBe(true)
    const [a, b] = [t.get(0), t.get(1)]
    expect(a.status).toBe('sent')
    expect(a.pricing).toMatchObject({ clientId: 'c_eutelecoms', marginCents: 500, shippingLater: true })
    expect(a.sends![0]).toMatchObject({ tokenHint: 'manual', totalCents: TOTAL, outcome: 'pending' })
    expect(a.sentGuess).toBeUndefined()
    expect(b.sentGuess).toBeUndefined()
    expect(b.sentGuessDismissed).toEqual(['g1'])
    expect(b.status).toBe('ready')
  })
  it('needs the offer reviewed, and refuses when the dashboard would price it differently', async () => {
    const t = await guessed([offer('o1', { status: 'needs_review' })])
    expect((await confirmSentGuess('o1', t.fd)).message).toContain('reviewed first')
    const locked = await guessed([offer('o1')])
    const cs = (locked.store.data.get('offers:clients') as { id: string; margin: unknown }[]).map((c) => (c.id === 'c_eutelecoms' ? { ...c, margin: { type: 'fixed', perUnitCents: 400, locked: true } } : c))
    locked.store.data.set('offers:clients', cs)
    const r = await confirmSentGuess('o1', locked.fd)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Price it by hand')
    expect(locked.get().status).toBe('ready')
  })
  it('dismiss clears it and it is never suggested again', async () => {
    const t = await guessed([offer('o1')])
    expect((await dismissSentGuess('o1', t.fd)).ok).toBe(true)
    expect(t.get().sentGuess).toBeUndefined()
    expect(t.get().sentGuessDismissed).toEqual(['g1'])
    expect((await dismissSentGuess('o1', t.fd)).ok).toBe(false)
  })
})

describe('the screen and requests', () => {
  const text = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
  it('the banner asks, warns when ambiguous, and never confirms by itself', () => {
    const g = { messageId: 'g1', clientId: 'c_eutelecoms', clientName: 'EU Telecoms BL Ltd', to: 'contact@eutelecoms.com', sentAt: HOURS(2), totalCents: TOTAL, units: 50, marginCents: 500, overrides: {}, foundAt: HOURS(1) }
    const html = text(h(SentGuessBanner, { offer: offer('o1', { sentGuess: { ...g, ambiguousWith: ['o2'] } }) }))
    expect(html).toContain('Looks like you emailed this to EU Telecoms BL Ltd')
    expect(html).toContain('matches 2 similar offers')
    expect(html).toContain('sent-guess-confirm')
    expect(html).toContain('Nothing is emailed')
    expect(text(h(SentGuessBanner, { offer: offer('o1') }))).toBe('')
    expect(text(h(SentGuessBanner, { offer: offer('o1', { status: 'needs_review', sentGuess: g }) }))).toContain('Mark the offer reviewed first')
  })
  it('requests are shaped right', () => {
    expect(checkEdit({ action: 'sent_guess_confirm', id: 'of_a1' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'sent_guess_dismiss', id: 'of_a1' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'sent_guess_confirm', id: 'bad' })).toMatchObject({ ok: false })
  })
})
