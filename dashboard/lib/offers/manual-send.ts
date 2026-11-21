/**
 * An offer emailed to the client by hand (copied from Mobile One's offer into an ordinary email), outside the dashboard.
 *
 * Three steps, each by a person: mark it sent (the total sent must equal the dashboard's price to the cent, so a wrong
 * price can never reach an order), then record the client's answer by email: accepted (the normal order flow starts) or
 * declined, or undo it. A manual send has no public page, never expires by itself, and nothing here emails anyone.
 */
import crypto from 'node:crypto'
import { clientsFrom, type Client } from './clients'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import { priceOffer, pricingInputOf } from './pricing'
import { getJson } from '../store'
import type { Offer, OfferSend } from './types'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export interface ManualResult { ok: boolean; message: string }
export const isManualSend = (s: Pick<OfferSend, 'tokenHint'>) => s.tokenHint === 'manual'
const manualPending = (o: Offer) => (o.sends ?? []).find((s) => isManualSend(s) && s.outcome === 'pending')

export async function markSentManually(offerId: string, d: FulfilDeps, input: { totalCents: number; sentAt?: string | null; note: string }): Promise<ManualResult> {
  const now = (d.now ?? new Date()).toISOString()
  const offer = await load(d.store, offerId)
  if (!offer) return { ok: false, message: 'That offer no longer exists.' }
  if (offer.status === 'sent') return { ok: false, message: 'This offer is already marked as sent.' }
  if (offer.status !== 'ready') return { ok: false, message: offer.status === 'needs_review' ? 'Mark the offer reviewed and priced first.' : 'This offer cannot be marked as sent now.' }
  if (!offer.pricing) return { ok: false, message: 'Choose the client and mark it priced first (the Price panel).' }
  if (offer.pricing.shippingLater !== true) return { ok: false, message: 'This price was saved before shipping moved to the invoice. Press "Update price" in the Price panel, then try again.' }
  const clients = clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))
  const client = clients.find((c) => c.id === offer.pricing!.clientId)
  if (!client) return { ok: false, message: 'The client this offer is priced for no longer exists.' }
  if (offer.testOnly && !client.test) return { ok: false, message: 'This is a test offer: it can only be recorded for a test client.' }
  const r = priceOffer(offer.lines, client, pricingInputOf(offer))
  if (!r.ok) return { ok: false, message: r.errors[0] ?? 'The price is no longer valid. Update it above.' }
  const items = r.totals.saleCents
  if (!Number.isSafeInteger(input.totalCents) || input.totalCents !== items) {
    return { ok: false, message: `That total (${Number.isSafeInteger(input.totalCents) ? eur(input.totalCents) : 'not a number'}) is not the dashboard price (${eur(items)}, items only). Change the margin in the Price panel until it matches what you sent, or check the figure.` }
  }
  const sentAtMs = input.sentAt ? Date.parse(input.sentAt) : Date.parse(now)
  if (!Number.isFinite(sentAtMs) || sentAtMs > Date.parse(now) + 5 * 60_000 || sentAtMs < Date.parse(offer.source.receivedAt) - 60_000) return { ok: false, message: 'The date sent must be after Mobile One\'s offer arrived and not in the future.' }
  const sentAt = new Date(sentAtMs).toISOString()
  const note = input.note.trim().slice(0, 400)
  const send: OfferSend = { clientId: client.id, clientName: client.name, to: client.offerEmails, tokenHash: crypto.randomBytes(32).toString('hex'), tokenHint: 'manual', sentAt, expiresAt: new Date(sentAtMs + 365 * 24 * 3600_000).toISOString(), totalCents: items, units: r.totals.units, test: client.test, gmailMessageId: 'manual', outcome: 'pending' }
  const saved = await mutate(d.store, offerId, (o) => (o.status !== 'ready' || !o.pricing ? null : { ...o, status: 'sent', sends: [...(o.sends ?? []), send], updatedAt: now, audit: log(o, now, `Marked as sent to ${client.name} by email, outside the dashboard: ${r.totals.units} units, ${eur(items)}.${note ? ` Note: ${note}` : ''}`) }))
  return saved ? { ok: true, message: `Marked as sent to ${client.name}. Record their answer here when it comes.` } : { ok: false, message: 'The offer changed while this was being saved. Refresh and try again.' }
}

export async function undoManualSend(offerId: string, d: FulfilDeps): Promise<ManualResult> {
  const now = (d.now ?? new Date()).toISOString()
  const saved = await mutate(d.store, offerId, (o) => {
    const s = manualPending(o)
    if (o.status !== 'sent' || !s) return null
    return { ...o, status: 'ready', sends: (o.sends ?? []).filter((x) => x !== s && x.tokenHash !== s.tokenHash), updatedAt: now, audit: log(o, now, 'Undone: the offer was not sent by email after all') }
  })
  return saved ? { ok: true, message: 'Undone. The offer is back to reviewed.' } : { ok: false, message: 'There is no manually sent offer to undo (it may already have an answer).' }
}

/** The client's answer, as the owner read it in the email. Accepting starts the normal order flow. */
export async function answerManualSend(offerId: string, d: FulfilDeps & { fulfil: (id: string) => Promise<unknown> }, input: { decision: 'accept' | 'decline'; note: string }): Promise<ManualResult> {
  const now = (d.now ?? new Date()).toISOString()
  const note = input.note.trim().slice(0, 400)
  let sent: OfferSend | null = null
  const saved = await mutate(d.store, offerId, (o) => {
    const s = manualPending(o)
    if (o.status !== 'sent' || !s) return null
    const accepted = input.decision === 'accept'
    sent = { ...s, outcome: accepted ? 'accepted' : 'declined', answer: { decision: input.decision, remarks: `${accepted ? 'Accepted' : 'Declined'} by email, outside the dashboard.${note ? ` ${note}` : ''}`, at: now, ip: 'manual', ua: 'recorded by hand' }, resolvedAt: now, notifiedAt: now }
    return { ...o, status: accepted ? 'accepted' : 'declined', sends: (o.sends ?? []).map((x) => (x.tokenHash === s.tokenHash ? sent! : x)), updatedAt: now, audit: log(o, now, `${s.clientName} ${accepted ? 'ACCEPTED' : 'DECLINED'} by email (recorded by hand): ${s.units} units, ${eur(s.totalCents)}.${note ? ` Note: ${note}` : ''}`) }
  })
  if (!saved || !sent) return { ok: false, message: 'There is no manually sent offer waiting for an answer.' }
  const s = sent as OfferSend
  const link = d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(offerId)}` } : undefined
  if (input.decision === 'accept') {
    await d.notify(`${s.test ? '[TEST] ' : ''}${s.clientName} accepted by email (recorded by hand): ${s.units} units, ${eur(s.totalCents)}. Replying to Mobile One and starting the order flow.`, link)
    try { await d.fulfil(offerId) } catch { /* the 5-minute check picks it up: the offer already says accepted */ }
    return { ok: true, message: 'Recorded as accepted. The reply to Mobile One is going out.' }
  }
  await d.notify(`${s.test ? '[TEST] ' : ''}${s.clientName} declined by email (recorded by hand): ${s.units} units, ${eur(s.totalCents)}. The offer is unlocked.`, link)
  return { ok: true, message: 'Recorded as declined. You can unlock the offer to price it for another client.' }
}
