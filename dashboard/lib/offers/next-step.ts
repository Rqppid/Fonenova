/**
 * One plain sentence saying what to do next on an offer (pure, shown at the top of every offer).
 * It only describes; it never changes anything.
 */
import { invoiceAmount, acceptedItemsCents, eur } from './order-note'
import type { Client } from './clients'
import type { Offer } from './types'

export function nextStep(o: Offer, client: Client | null, invoicing: boolean): string {
  switch (o.status) {
    case 'needs_review': return 'Check the lines against the email, then press "Mark reviewed". (Already emailed it to the client yourself? Mark it reviewed first, then use "Offer sent manually by email".)'
    case 'dismissed': return 'Hidden from the list. Press "Restore" if it is an offer after all.'
    case 'declined': return 'The client said no. Unlock it to price it for another client, or leave it.'
    case 'expired': return 'No answer before it expired. Unlock it to send it again or to another client.'
    case 'ready': return o.pricing
      ? 'Send it from the Send panel below. If you emailed it to the client yourself, press "Offer sent manually by email" instead.'
      : 'Choose the client in the Price panel and press "Mark priced". If you already emailed it yourself, press "Offer sent manually by email" after pricing.'
    case 'sent': return (o.sends ?? []).some((s) => s.outcome === 'pending' && s.tokenHint === 'manual')
      ? 'Waiting for the client\'s reply by email. When they answer, press "Client accepted by email" or "Client declined" below.'
      : 'Waiting for the client to answer on their link. You get a Telegram message when they do.'
    case 'accepted': break
  }
  const f = o.fulfilment
  if (!f) return 'Accepted. The reply to Mobile One has not started: press "Start reply" below.'
  if (f.reply.state === 'held') return 'Press "OK, send the reply" below to tell Mobile One to proceed.'
  if (f.reply.state === 'failed') return 'The reply to Mobile One is failing. It retries every 5 minutes; check Gmail if it keeps failing.'
  if (invoicing) {
    if (f.draft.state === 'waiting') return 'Enter the shipping in the Shipping box so the draft invoice can be made.'
    if (f.draft.state === 'blocked' || f.draft.state === 'failed') return 'The draft invoice needs you: see the reason below, then press "Try again now".'
    if (f.draft.state === 'done') return f.send?.state === 'done' ? 'Invoice sent. Check the PDF and the IMEI list are filed.' : 'Check the draft invoice in Xero. It is emailed automatically unless you press Hold.'
    return 'The order is being set up. This updates by itself.'
  }
  const n = f.order
  if (n?.invoice2go) return `Done here: linked to Invoice2go invoice ${n.invoice2go.number}. Nothing more to do on this offer.`
  const items = acceptedItemsCents(o)
  const dhl = n?.dhlCostCents ?? null
  if (!n?.goodsArrivedAt) return 'Accepted and Mobile One is told. When the goods arrive in Belfast, tick "Goods arrived", then enter the DHL cost below.'
  if (dhl === null) return `Goods have arrived. Make the DHL label, then enter ${client?.shippingBasis === 'own_dhl' ? 'our DHL cost' : 'the shipping'} below to get the invoice amount.`
  if (items !== null && client) return `Create the invoice in Invoice2go for ${eur(invoiceAmount(items, client, dhl).totalCents)}, then type its number below to link it.`
  return 'Create the invoice in Invoice2go, then type its number below to link it.'
}
