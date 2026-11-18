/**
 * An offer that was sent to the client by email, outside the dashboard, and accepted by email.
 *
 * The dashboard only starts the order flow from a client's click on its own link, so a hand-sent offer would
 * otherwise sit at "reviewed" forever. This records the acceptance by hand and then runs the very same flow
 * (reply to Mobile One, draft waits for shipping, automatic invoice).
 *
 * What stops a wrong price reaching an invoice: the person types the total the client agreed, and it must equal
 * the dashboard's saved price to the cent. Otherwise nothing is recorded and the dashboard's figure is shown.
 * An email reply is never taken as an acceptance by itself: a person ticks the box.
 */
import crypto from 'node:crypto'
import { getJson } from '../store'
import { seedClients, type Client } from './clients'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import { priceOffer, pricingInputOf } from './pricing'
import type { Offer, OfferSend } from './types'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export interface ManualAcceptResult { ok: boolean; message: string }

export async function acceptByEmail(offerId: string, d: FulfilDeps & { fulfil: (id: string) => Promise<unknown> }, input: { totalCents: number; note: string; confirm: boolean }): Promise<ManualAcceptResult> {
  if (input.confirm !== true) return { ok: false, message: 'Tick the box to confirm the client accepted this by email.' }
  const now = (d.now ?? new Date()).toISOString()
  const offer = await load(d.store, offerId)
  if (!offer) return { ok: false, message: 'That offer no longer exists.' }
  if (offer.status === 'accepted') return { ok: false, message: 'This offer is already accepted.' }
  if (offer.status !== 'ready') return { ok: false, message: offer.status === 'sent' ? 'This offer was sent from the dashboard. Withdraw it first if the client answered by email instead.' : 'Mark the offer reviewed and priced first.' }
  if (!offer.pricing) return { ok: false, message: 'Price the offer for the client first.' }
  if (offer.pricing.shippingLater !== true) return { ok: false, message: 'This price was saved before shipping moved to the invoice. Press "Update price" in the Price panel, then try again.' }
  const clients = (await getJson<Client[]>(d.store, 'offers:clients')) ?? seedClients()
  const client = clients.find((c) => c.id === offer.pricing!.clientId)
  if (!client) return { ok: false, message: 'The client this offer is priced for no longer exists.' }
  if (offer.testOnly && !client.test) return { ok: false, message: 'This is a test offer: it can only be recorded for a test client.' }
  if (!client.test && !d.allowReal) return { ok: false, message: 'Real orders are switched off (OFFERS_ALLOW_REAL_SEND). Price it for the test client to try it.' }
  if (!client.test && !d.allowLiveXero) return { ok: false, message: 'Real orders also need live Xero drafts switched on (XERO_WRITE_ALLOW_LIVE).' }
  const r = priceOffer(offer.lines, client, pricingInputOf(offer))
  if (!r.ok) return { ok: false, message: r.errors[0] ?? 'The price is no longer valid. Update it above.' }
  const items = r.totals.saleCents
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents !== items) {
    return { ok: false, message: `That total (${Number.isSafeInteger(input.totalCents) ? eur(input.totalCents) : 'not a number'}) is not the dashboard price (${eur(items)}, items only). Change the margin in the Price panel until it matches what was agreed, or check the figure.` }
  }
  const note = input.note.trim().slice(0, 400)
  const send: OfferSend = {
    clientId: client.id, clientName: client.name, to: client.offerEmails,
    tokenHash: crypto.randomBytes(32).toString('hex'), tokenHint: 'manual',
    sentAt: now, expiresAt: now, totalCents: items, units: r.totals.units, test: client.test, gmailMessageId: 'manual', outcome: 'accepted',
    answer: { decision: 'accept', remarks: `Accepted by email, outside the dashboard.${note ? ` ${note}` : ''}`, at: now, ip: 'manual', ua: 'recorded by hand' },
    resolvedAt: now, notifiedAt: now,
  }
  const saved = await mutate(d.store, offerId, (o: Offer) => (o.status !== 'ready' || !o.pricing ? null : { ...o, status: 'accepted', sends: [...(o.sends ?? []), send], updatedAt: now, audit: log(o, now, `${client.name} accepted by email outside the dashboard (recorded by hand): ${r.totals.units} units, ${eur(items)}.${note ? ` Note: ${note}` : ''}`) }))
  if (!saved) return { ok: false, message: 'The offer changed while this was being saved. Refresh and try again.' }
  await d.notify(`${client.test ? '[TEST] ' : ''}${client.name} accepted by email (recorded by hand): ${r.totals.units} units, ${eur(items)}. Replying to Mobile One and starting the invoice flow; the draft waits for the shipping.`, d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(offerId)}` } : undefined)
  try { await d.fulfil(offerId) } catch { /* the 5-minute check picks it up: the offer already says accepted */ }
  return { ok: true, message: 'Recorded as accepted. The reply to Mobile One and the draft invoice are starting; enter the shipping when it waits for it.' }
}
