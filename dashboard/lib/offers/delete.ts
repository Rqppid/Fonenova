/**
 * Deleting an offer for good. Only while no order exists: nothing accepted, no reply to Mobile One, no draft invoice.
 * Anything that has become an order is a money record and is never deleted here. The Mobile One email's id stays in
 * the "already seen" list, so the next inbox check does not bring the offer back.
 */
import type { Store } from '../store'
import { getJson } from '../store'
import type { Offer } from './types'
import { whyNotDeletable } from './deletable'

export interface DeleteResult { ok: boolean; message: string }

export async function deleteOffer(store: Store, id: string, opts: { removePublic?: ((tokenHash: string) => Promise<unknown>) | undefined } = {}): Promise<DeleteResult> {
  const found = await store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const o = offers.find((x) => x.id === id)
    if (!o) return { error: 'That offer no longer exists.' } as const
    const why = whyNotDeletable(o)
    if (why) return { error: why } as const
    await store.set('offers', offers.filter((x) => x.id !== id))
    // Keep the email marked as seen so the inbox check does not add it again.
    const seen = (await getJson<string[]>(store, 'offers:seen')) ?? []
    const mid = o.source.gmailMessageId
    if (mid && !seen.includes(mid)) await store.set('offers:seen', [...seen, mid])
    return { offer: o } as const
  })
  if ('error' in found) return { ok: false, message: String(found.error) }
  // A withdrawn offer's public page goes too, so no link outlives it.
  for (const s of found.offer.sends ?? []) await opts.removePublic?.(s.tokenHash)?.catch(() => {})
  console.log(JSON.stringify({ event: 'offer-deleted', id, status: found.offer.status }))
  return { ok: true, message: 'Deleted.' }
}
