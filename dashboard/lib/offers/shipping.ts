/**
 * The shipping cost of an order that was priced without any: entered after the client accepts, when it is
 * known (Wave: Mobile One's shipping from their invoice, charged at the client's multiple; EU Telecoms: the
 * cost of our own DHL label, no mark-up). Until then the Xero draft waits, so no invoice number is used and
 * nothing can go out with a missing or guessed figure.
 *
 * Only while the draft is still waiting: once a draft exists it is not changed from here (add the line in
 * Xero by hand). Entering it flips the draft back to pending and raises it with the SHIPPING CHARGES line
 * through the same code as before; the caller then schedules the automatic invoice.
 */
import { getJson } from '../store'
import { invoicingOn } from './invoicing-mode'
import { chargeFor, clientsFrom, shippingBasisOf, type Client } from './clients'
import { load, log, mutate, retryFulfilment, type FulfilDeps } from './fulfil'
import type { Offer } from './types'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const MAX_SHIPPING_CENTS = 10_000_000

export interface ShippingResult { ok: boolean; message: string }

export async function setOrderShipping(offerId: string, d: FulfilDeps, input: { cents: number | null; none: boolean; source?: 'manual' | 'invoice' }): Promise<ShippingResult> {
  if (!invoicingOn(d)) return { ok: false, message: 'No draft invoice is made while Invoice2go makes the invoices. Enter the DHL cost in the order checklist instead.' }
  const at = (d.now ?? new Date()).toISOString()
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || offer.status !== 'accepted' || !f) return { ok: false, message: 'This offer has not been accepted.' }
  if (offer.pricing?.shippingLater !== true) return { ok: false, message: 'This offer was priced with its shipping included, so there is nothing to enter.' }
  if (f.draft.state === 'done') return { ok: false, message: 'The draft invoice already exists, so its shipping is not changed from here. Add the shipping line to the draft in Xero by hand.' }
  if (f.draft.state !== 'waiting') return { ok: false, message: f.shipping ? `The shipping is already set (${eur(f.shipping.cents)}).` : 'The draft invoice is not waiting for shipping.' }
  const client = (clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))).find((c) => c.id === offer.pricing?.clientId)
  if (!client) return { ok: false, message: 'The client this offer was priced for no longer exists.' }
  if (!input.none && (input.cents === null || !Number.isSafeInteger(input.cents) || input.cents < 1 || input.cents > MAX_SHIPPING_CENTS)) return { ok: false, message: 'The shipping must be an amount between €0.01 and €100,000.00.' }

  const basis = shippingBasisOf(client)
  const typed = input.none ? 0 : input.cents!
  const charge = input.none ? 0 : chargeFor(client, typed)
  const how = input.none ? 'none' : basis === 'own_dhl' ? `our DHL cost ${eur(typed)}, no mark-up` : `Mobile One's ${eur(typed)} x ${client.shippingMultiplier ?? 2}`
  const saved = await mutate(d.store, offerId, (o: Offer) => {
    const cur = o.fulfilment
    if (!cur || cur.draft.state !== 'waiting') return null // someone else got there first
    return { ...o, updatedAt: at, fulfilment: { ...cur, shipping: { cents: charge, ...(basis === 'mobile_one' && !input.none ? { mobileOneCents: typed } : {}), source: input.none ? 'none' : (input.source ?? 'manual'), at }, draft: { ...cur.draft, state: 'pending', attempts: 0, reason: undefined } }, audit: log(o, at, input.none ? 'Shipping: none, you confirmed' : `Shipping entered: ${eur(charge)} (${how})`) }
  })
  if (!saved) return { ok: false, message: 'The shipping was already set, or the draft moved on. Refresh the offer.' }
  // Raise the draft now, with the shipping line in place.
  await retryFulfilment(offerId, d)
  return { ok: true, message: input.none ? 'No shipping on this order. The draft invoice is being made.' : `Shipping ${eur(charge)} (${how}). The draft invoice is being made.` }
}
