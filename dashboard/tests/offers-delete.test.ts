import { describe, expect, it, vi } from 'vitest'
import { checkEdit } from '@/lib/offers/edit'
import { deleteOffer } from '@/lib/offers/delete'
import { whyNotDeletable } from '@/lib/offers/deletable'
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
const send = (outcome: OfferSend['outcome']): OfferSend => ({ clientId: 'c_wave', clientName: 'W', to: ['a@b.test'], tokenHash: 'h'.repeat(64), tokenHint: 'abc', sentAt: '2026-11-18T10:00:00Z', expiresAt: '2026-11-19T10:00:00Z', totalCents: 1, units: 1, test: false, gmailMessageId: 'g', outcome })
const offer = (id: string, over: Partial<Offer> = {}): Offer => ({ id, status: 'needs_review', source: { gmailMessageId: `m-${id}`, threadId: 't', rfcMessageId: null, from: 'x', to: 'y', subject: 's', receivedAt: '2026-11-18T09:00:00Z' }, text: '', lines: [], createdAt: '', updatedAt: '', audit: [], ...over }) as Offer

describe('deleting an offer', () => {
  it('deletes one that has no order, keeps the others, and keeps its email marked as seen', async () => {
    const store = memStore()
    store.data.set('offers', [offer('of_a'), offer('of_b')])
    store.data.set('offers:seen', ['m-old'])
    expect(await deleteOffer(store, 'of_a')).toMatchObject({ ok: true })
    expect((store.data.get('offers') as Offer[]).map((o) => o.id)).toEqual(['of_b'])
    expect(store.data.get('offers:seen')).toEqual(['m-old', 'm-of_a'])
  })
  it('allowed for reviewed, dismissed, declined, expired and withdrawn-then-ready offers; removes the public page of any send', async () => {
    for (const status of ['needs_review', 'ready', 'dismissed', 'declined', 'expired'] as const) expect(whyNotDeletable(offer('of_x', { status })), status).toBeNull()
    const store = memStore()
    store.data.set('offers', [offer('of_w', { status: 'ready', sends: [send('withdrawn')] })])
    const removed: string[] = []
    expect((await deleteOffer(store, 'of_w', { removePublic: async (h) => { removed.push(h) } })).ok).toBe(true)
    expect(removed).toEqual(['h'.repeat(64)])
  })
  it('refuses anything that is out with the client or has become an order', async () => {
    const store = memStore()
    const accepted = offer('of_acc', { status: 'accepted', fulfilment: { orderRef: 'FN-ORD-016', test: false, startedAt: '', reply: { state: 'sent', attempts: 1 }, draft: { state: 'waiting', attempts: 0 } } as never, sends: [send('accepted')] })
    store.data.set('offers', [offer('of_sent', { status: 'sent', sends: [send('pending')] }), accepted])
    expect((await deleteOffer(store, 'of_sent')).message).toContain('Withdraw')
    expect((await deleteOffer(store, 'of_acc')).message).toContain('never deleted')
    expect((store.data.get('offers') as Offer[])).toHaveLength(2)
    expect((await deleteOffer(store, 'of_missing')).ok).toBe(false)
  })
  it('the request must be shaped right', () => {
    expect(checkEdit({ action: 'delete_offer', id: 'of_a1', confirm: true })).toMatchObject({ ok: true, value: { confirm: true } })
    expect(checkEdit({ action: 'delete_offer', id: 'of_a1' })).toMatchObject({ ok: true, value: { confirm: false } })
    expect(checkEdit({ action: 'delete_offer', id: 'nope' })).toMatchObject({ ok: false })
  })
})
