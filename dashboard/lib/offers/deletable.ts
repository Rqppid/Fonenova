/** Pure, so the screen and the server use the same rule. */
import type { Offer } from './types'

/** Why an offer cannot be deleted, or null when it can. Pure. */
export function whyNotDeletable(o: Offer): string | null {
  if (o.status === 'accepted' || o.fulfilment || (o.sends ?? []).some((s) => s.outcome === 'accepted')) return 'This offer was accepted, so an order and its invoice records exist. It is never deleted.'
  if (o.status === 'sent') return 'This offer is out with the client. Withdraw it first, then delete it.'
  return null
}
