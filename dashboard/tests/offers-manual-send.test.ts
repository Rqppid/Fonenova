import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ManualAnswerPanel, ManualSentPanel } from '@/components/offers/manual-send-panel'
import { OfferDetail, OffersView } from '@/components/offers/offers-view'
import { seedClients } from '@/lib/offers/clients'
import { checkEdit } from '@/lib/offers/edit'
import { fulfilOffer, type FulfilDeps } from '@/lib/offers/fulfil'
import { offerLabel, productSummary } from '@/lib/offers/label'
import { answerManualSend, markSentManually, undoManualSend } from '@/lib/offers/manual-send'
import { whyNotDeletable } from '@/lib/offers/deletable'
import { sweepSends } from '@/lib/offers/resolve'
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
const NOW = new Date('2026-11-22T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const ipad = (id: string, qty: number, cost: number, model = 'Apple iPad Pro 13-inch (2025)'): OfferLine => ({ id, model, storage: '1TB', grade: 'A/B Grade Mix', qty, unitCostCents: cost, sourceText: '', note: null })
const LINES = [ipad('a1', 105, 116_000), ipad('a2', 25, 117_800)]
const itemsCents = LINES.reduce((n, l) => n + l.qty * (l.unitCostCents + 500), 0)

function offer(id: string, over: Partial<Offer> = {}): Offer {
  return { id, status: 'ready', source: { gmailMessageId: `m-${id}`, threadId: 't1', rfcMessageId: '<a@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: LINES, pricing: { clientId: 'c_eutelecoms', marginCents: 500, overrides: {}, ackLow: false, shippingLater: true, pricedAt: HOURS(4) }, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [], ...over }
}
function setup(o: Offer) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_eutelecoms' ? { ...c, margin: { type: 'manual' as const }, termsConfirmed: true, xeroContactId: '11111111-2222-3333-4444-555555555555', invoiceEmails: ['a@b.test'] } : c)))
  const pings: string[] = []
  const sent: string[] = []
  const calls = { xero: 0 }
  const base: FulfilDeps = { store, now: NOW, allowReal: true, allowLiveXero: false, invoicing: false, ownerAddress: 'o@example.test', notify: async (t) => { pings.push(t); return true }, knownOrderIds: async () => ['FN-ORD-014'], xero: () => { calls.xero++; return null }, reply: async (m) => { sent.push(m.to); return { id: 'r1' } }, replied: async () => false }
  const d = { ...base, fulfil: (id: string) => fulfilOffer(id, base) }
  return { d, pings, sent, calls, get: () => (store.data.get('offers') as Offer[])[0], store }
}

describe('names that tell offers apart', () => {
  it('summarises the products and shows when it arrived, the client and the order reference', () => {
    expect(productSummary(LINES)).toBe('iPad Pro 13-inch 1TB')
    expect(productSummary([ipad('x', 1, 100, 'iPhone 16'), ipad('y', 1, 100, 'iPhone 17'), ipad('z', 1, 100, 'iPhone 15')])).toBe('iPhone 16 1TB + 2 more models')
    const a = offer('o1', { source: { ...offer('o1').source, receivedAt: '2026-11-18T10:07:00Z' } })
    const b = offer('o2', { source: { ...offer('o2').source, receivedAt: '2026-11-18T10:08:00Z' }, fulfilment: { orderRef: 'FN-ORD-017' } as never })
    const la = offerLabel(a, 'EU Telecoms BL Ltd')
    const lb = offerLabel(b, 'EU Telecoms BL Ltd')
    expect(la.title).toBe('iPad Pro 13-inch 1TB, 130 units')
    expect(la.title).toBe(lb.title)
    expect(la.detail).not.toBe(lb.detail)
    expect(la.detail).toContain('for EU Telecoms BL Ltd')
    expect(lb.detail).toContain('FN-ORD-017')
  })
  it('the list and header show the label, not just "Offer"', () => {
    const html = renderToString(h(OffersView, { offers: [offer('o1'), offer('o2')], clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null }, status: null, setup: { gmail: null, telegram: false, schedule: false }, selected: 'o1', liveTarget: null })).replace(/<!-- -->/g, '')
    expect(html).toContain('iPad Pro 13-inch 1TB, 130 units')
    expect(html).toContain('data-testid="offer-label-detail"')
  })
})

describe('marking an offer sent by email', () => {
  it('needs a reviewed, priced offer and a total equal to the dashboard price; creates nothing anywhere', async () => {
    const t = setup(offer('o1'))
    expect((await markSentManually('o1', t.d, { totalCents: itemsCents + 1, note: '' })).message).toContain('is not the dashboard price')
    expect(t.get().status).toBe('ready')
    const r = await markSentManually('o1', t.d, { totalCents: itemsCents, note: 'by dad', sentAt: HOURS(1) })
    expect(r.ok).toBe(true)
    const o = t.get()
    expect(o.status).toBe('sent')
    expect(o.sends![0]).toMatchObject({ tokenHint: 'manual', gmailMessageId: 'manual', outcome: 'pending', totalCents: itemsCents })
    expect(t.sent).toHaveLength(0)
    expect(t.calls.xero).toBe(0)
    expect((await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })).message).toContain('already marked')
  })
  it('refuses an offer that is not reviewed or priced, a silly date, and a price saved the old way', async () => {
    expect((await markSentManually('o1', setup(offer('o1', { status: 'needs_review' })).d, { totalCents: itemsCents, note: '' })).message).toContain('reviewed')
    expect((await markSentManually('o1', setup(offer('o1', { pricing: undefined })).d, { totalCents: itemsCents, note: '' })).message).toContain('priced')
    expect((await markSentManually('o1', setup(offer('o1')).d, { totalCents: itemsCents, note: '', sentAt: '2027-01-01T00:00:00Z' })).ok).toBe(false)
    expect((await markSentManually('o1', setup(offer('o1')).d, { totalCents: itemsCents, note: '', sentAt: HOURS(48) })).ok).toBe(false)
    const old = offer('o1'); old.pricing = { ...old.pricing!, shippingLater: undefined }
    expect((await markSentManually('o1', setup(old).d, { totalCents: itemsCents, note: '' })).message).toContain('Update price')
  })
  it('undo puts it back to reviewed', async () => {
    const t = setup(offer('o1'))
    await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })
    expect((await undoManualSend('o1', t.d)).ok).toBe(true)
    expect(t.get().status).toBe('ready')
    expect(t.get().sends).toHaveLength(0)
    expect((await undoManualSend('o1', t.d)).ok).toBe(false)
  })
})

describe('the client answered by email', () => {
  it('accepted: replies to Mobile One, starts the order, creates nothing in Xero', async () => {
    const t = setup(offer('o1'))
    await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })
    const r = await answerManualSend('o1', t.d, { decision: 'accept', note: 'ok thanks' })
    expect(r.ok).toBe(true)
    const o = t.get()
    expect(o.status).toBe('accepted')
    expect(o.sends![0]).toMatchObject({ outcome: 'accepted' })
    expect(o.sends![0].answer!.remarks).toContain('ok thanks')
    expect(o.fulfilment!.reply.state).toBe('sent')
    expect(t.sent).toEqual(['bv@mobileone.info'])
    expect(t.calls.xero).toBe(0)
    expect((await answerManualSend('o1', t.d, { decision: 'accept', note: '' })).ok).toBe(false)
  })
  it('declined: the offer is declined and unlocked, no reply to Mobile One', async () => {
    const t = setup(offer('o1'))
    await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })
    expect((await answerManualSend('o1', t.d, { decision: 'decline', note: '' })).ok).toBe(true)
    expect(t.get().status).toBe('declined')
    expect(t.sent).toHaveLength(0)
  })
  it('the 5-minute check leaves a manual send alone, even a year on', async () => {
    const t = setup(offer('o1'))
    await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })
    const later = new Date(NOW.getTime() + 300 * 24 * 3600_000)
    const out = await sweepSends({ store: t.store, notify: async () => true, email: null as never, now: later, getAnswer: async () => null, fulfil: async () => {} } as never)
    expect(out).toEqual({ answered: 0, expired: 0, rolledBack: 0 })
    expect(t.get().status).toBe('sent')
  })
  it('a manually sent offer cannot be deleted until it is undone', async () => {
    const t = setup(offer('o1'))
    await markSentManually('o1', t.d, { totalCents: itemsCents, note: '' })
    expect(whyNotDeletable(t.get())).toContain('Withdraw')
    await undoManualSend('o1', t.d)
    expect(whyNotDeletable(t.get())).toBeNull()
  })
})

describe('the screen', () => {
  const c = seedClients().find((x) => x.id === 'c_eutelecoms')!
  const text = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
  it('the button is on every reviewed offer, and the panel says what is missing', () => {
    for (const status of ['needs_review', 'ready'] as const) expect(text(h(OfferDetail, { offer: offer('o1', { status }), clients: seedClients() }))).toContain('data-testid="manual-sent-button"')
    expect(text(h(OfferDetail, { offer: offer('o1', { status: 'accepted' }), clients: seedClients() }))).not.toContain('data-testid="manual-sent-button"')
    expect(text(h(ManualSentPanel, { offer: offer('o1', { status: 'needs_review' }), client: null }))).toContain('reviewed first')
    expect(text(h(ManualSentPanel, { offer: offer('o1', { pricing: undefined }), client: null }))).toContain('mark it priced')
    const ok = text(h(ManualSentPanel, { offer: offer('o1'), client: c }))
    expect(ok).toContain('Total you sent')
    expect(ok).toContain('€')
  })
  it('a manually sent offer shows its own answer panel and badge', () => {
    const sent = offer('o1', { status: 'sent', sends: [{ clientId: 'c_eutelecoms', clientName: 'EU Telecoms BL Ltd', to: [], tokenHash: 'a'.repeat(64), tokenHint: 'manual', sentAt: HOURS(2), expiresAt: HOURS(-9000), totalCents: itemsCents, units: 130, test: false, gmailMessageId: 'manual', outcome: 'pending' }] })
    const panel = text(h(ManualAnswerPanel, { offer: sent, send: sent.sends![0] }))
    for (const id of ['manual-accept-button', 'manual-decline-button', 'manual-undo-button']) expect(panel).toContain(id)
    const detail = text(h(OfferDetail, { offer: sent, clients: seedClients() }))
    expect(detail).toContain('Sent by email')
    expect(detail).toContain('manual-answer-panel')
    expect(detail).not.toContain('Withdraw this offer')
  })
  it('requests are shaped right', () => {
    expect(checkEdit({ action: 'sent_manual', id: 'of_a1', totalCents: 100, note: 'x' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'sent_manual', id: 'of_a1', totalCents: 0 })).toMatchObject({ ok: false })
    expect(checkEdit({ action: 'manual_answer', id: 'of_a1', decision: 'accept' })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'manual_answer', id: 'of_a1', decision: 'maybe' })).toMatchObject({ ok: false })
    expect(checkEdit({ action: 'manual_undo', id: 'of_a1' })).toMatchObject({ ok: true })
  })
})
