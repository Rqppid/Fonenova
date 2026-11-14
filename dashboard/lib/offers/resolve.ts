/**
 * Turning a client's answer (or the passing of the deadline) into the offer's new state. The
 * public site tells the dashboard only that "an answer arrived for this hash"; this module reads
 * the answer from the public store itself, so a forged call can change nothing. The 5-minute
 * check runs the same code, so a missed notice is picked up within minutes.
 */
import { getJson, type Store } from '../store'
import { ukTime } from '../format-uk'
import { seedClients, type Client } from './clients'
import { xeroDraftUrl } from './xero-url'
import { buildAnswerEmail, type AnswerOutcome, type DraftInfo, type NotifyEmail } from './notify-email'
import { priceOffer, pricingInputOf, publicLines, type PublicLine } from './pricing'
import { getPublicAnswer, type PublicAnswer } from './public-store'
import type { Offer, OfferSend } from './types'

export interface ResolveDeps {
  store: Store
  notify: (text: string, link?: { label: string; url: string }) => Promise<boolean>
  /** Email the owner about an answer or expiry (best effort: a failure never stops the status update or Telegram). */
  email?: (m: NotifyEmail) => Promise<unknown>
  getAnswer?: (hash: string) => Promise<PublicAnswer | null>
  /** Start the work after an acceptance (reply to Mobile One, draft invoice). Best effort: a failure never undoes the status. */
  fulfil?: (offerId: string) => Promise<unknown>
  now?: Date
  dashboardUrl?: string
}

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const log = (o: Offer, now: string, what: string) => [...o.audit, { at: now, what }].slice(-60)
const short = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s)

async function update(store: Store, hash: string, fn: (o: Offer, s: OfferSend) => Offer | null): Promise<Offer | null> {
  return store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.sends?.some((s) => s.tokenHash === hash))
    if (i < 0) return null
    const send = offers[i].sends!.find((s) => s.tokenHash === hash)!
    const next = fn(offers[i], send)
    if (!next) return null
    offers[i] = next
    await store.set('offers', offers)
    return next
  })
}

export interface Figures { lines: PublicLine[]; shippingCents: number; grandCents: number; itemsCents: number }

/**
 * What the client saw, worked out again from the locked offer: the items at their sale prices, the
 * shipping, and the total. Null if it cannot be (`why` says why when asked).
 */
export async function figuresFor(store: Store, o: Offer): Promise<Figures | null> {
  return (await figuresOrWhy(store, o)).figures
}

export async function figuresOrWhy(store: Store, o: Offer): Promise<{ figures: Figures | null; why: string | null }> {
  try {
    if (!o.pricing) return { figures: null, why: 'The offer has no saved price.' }
    const clients = (await getJson<Client[]>(store, 'offers:clients')) ?? seedClients()
    const client = clients.find((c) => c.id === o.pricing!.clientId)
    if (!client) return { figures: null, why: 'The client this offer was priced for no longer exists.' }
    const r = priceOffer(o.lines, client, pricingInputOf(o))
    if (!r.ok) return { figures: null, why: r.errors[0] ?? 'The offer could not be priced again from its saved settings.' }
    return { figures: { lines: publicLines(o.lines, r), shippingCents: r.totals.shippingCents, grandCents: r.totals.grandCents, itemsCents: r.totals.saleCents }, why: null }
  } catch {
    return { figures: null, why: 'The offer could not be priced again from its saved settings.' }
  }
}

/** The items at the sale prices the client saw. Null if they cannot be worked out. */
export async function itemsFor(store: Store, o: Offer): Promise<PublicLine[] | null> {
  return (await figuresFor(store, o))?.lines ?? null
}

/**
 * Email the owner, after the status is saved and Telegram has been told. Wrapped so that nothing
 * here can throw: a failed email is only noted in the offer's history.
 */
async function emailOwner(d: ResolveDeps, offer: Offer, send: OfferSend, outcome: AnswerOutcome): Promise<void> {
  if (!d.email) return
  try {
    // Claim first: only the call that sets `notifiedAt` sends. A retried webhook, the 5-minute check
    // and a second delivery all find it set and stop, so one answer is emailed once, never twice.
    const claimedAt = (d.now ?? new Date()).toISOString()
    const current = await update(d.store, send.tokenHash, (o, s) => (s.notifiedAt ? null : { ...o, sends: o.sends!.map((x) => (x.tokenHash === send.tokenHash ? { ...x, notifiedAt: claimedAt } : x)) }))
    if (!current) return
    const { figures } = await figuresOrWhy(d.store, current)
    await d.email(buildAnswerEmail({ outcome, offer: current, send, lines: figures?.lines ?? null, ...(figures ? { shippingCents: figures.shippingCents } : {}), dashboardUrl: d.dashboardUrl, orderRef: current.fulfilment?.orderRef ?? null, draft: outcome === 'accepted' ? draftInfo(current) : null }))
  } catch {
    const at = (d.now ?? new Date()).toISOString()
    await update(d.store, send.tokenHash, (o) => ({ ...o, audit: log(o, at, 'Notification email to you was not sent (Telegram was)') })).catch(() => {})
  }
}

/** What the acceptance email says about the Xero draft: the link and checks, or why there is none yet. */
function draftInfo(o: Offer): DraftInfo | null {
  const dr = o.fulfilment?.draft
  if (!dr) return null
  if (dr.state === 'done') return { url: dr.invoiceId ? xeroDraftUrl(dr.invoiceId) : null, number: dr.invoiceNumber ?? null, org: dr.org ?? null, warnings: dr.warnings ?? [] }
  if (dr.state === 'blocked' || dr.state === 'failed') return { note: dr.reason ?? 'It needs your attention (see the offer).' }
  return { note: 'It is still being created; you will get a message when it is done.' }
}

const link = (d: ResolveDeps, o: Offer) => (d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(o.id)}` } : undefined)

/** Read the answer for this hash and apply it, once. `changed` is false if there was nothing new to apply. */
export async function applyAnswer(hash: string, d: ResolveDeps): Promise<{ changed: boolean }> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return { changed: false }
  const answer = await (d.getAnswer ?? getPublicAnswer)(hash)
  if (!answer) return { changed: false }
  const now = (d.now ?? new Date()).toISOString()
  let sent: OfferSend | null = null
  const offer = await update(d.store, hash, (o, s) => {
    if (s.outcome !== 'pending' || o.status !== 'sent') return null // already dealt with, or withdrawn
    const accepted = answer.decision === 'accept'
    sent = { ...s, outcome: accepted ? 'accepted' : 'declined', answer, resolvedAt: now }
    return {
      ...o,
      status: accepted ? 'accepted' : 'declined',
      sends: o.sends!.map((x) => (x.tokenHash === hash ? sent! : x)),
      updatedAt: now,
      audit: log(o, now, `${s.clientName} ${accepted ? 'ACCEPTED' : 'DECLINED'} at ${answer.at} (IP ${answer.ip}, ${short(answer.ua, 80)})${answer.remarks ? `. Remarks: ${short(answer.remarks)}` : ''}`),
    }
  })
  if (!offer || !sent) return { changed: false }
  const s = sent as OfferSend
  const accepted = s.outcome === 'accepted'
  await d.notify(
    [
      `${s.test ? '[TEST] ' : ''}${s.clientName} ${accepted ? 'ACCEPTED' : 'DECLINED'} the offer: ${s.units} units, ${eur(s.totalCents)}.`,
      s.answer?.remarks ? `Remarks: ${short(s.answer.remarks, 400)}` : 'No remarks.',
      accepted ? (s.test ? 'This was a test: the would-be reply to Mobile One goes to your inbox, and the draft invoice goes to the Xero Demo Company.' : 'Quay Pilot is now replying to Mobile One and raising a draft invoice in Xero. You will get a message with the result.') : 'The offer is unlocked: reprice it and send it to another client.',
    ].join('\n'),
    link(d, offer),
  )
  // An acceptance first starts the reply and the draft invoice, so the one email can carry the Xero link.
  if (accepted && d.fulfil) {
    try {
      await d.fulfil(offer.id)
    } catch {
      // The 5-minute check picks it up: the offer already says accepted.
    }
  }
  await emailOwner(d, offer, s, accepted ? 'accepted' : 'declined')
  return { changed: true }
}

/**
 * The 5-minute pass over sent offers: pick up answers the public site's notice missed, mark
 * offers past their deadline expired, and roll back a send that never completed.
 */
export async function sweepSends(d: ResolveDeps): Promise<{ answered: number; expired: number; rolledBack: number }> {
  const now = d.now ?? new Date()
  const nowIso = now.toISOString()
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const out = { answered: 0, expired: 0, rolledBack: 0 }
  for (const o of offers) {
    if (o.status !== 'sent') continue
    for (const s of (o.sends ?? []).filter((x) => x.outcome === 'pending')) {
      if (!s.gmailMessageId && now.getTime() - Date.parse(s.sentAt) > 10 * 60_000) {
        // Reserved but never confirmed: the send did not complete, so nothing reached the client.
        const back = await update(d.store, s.tokenHash, (cur, cs) => (cs.outcome === 'pending' && !cs.gmailMessageId ? { ...cur, status: 'ready', sends: cur.sends!.filter((x) => x.tokenHash !== s.tokenHash), updatedAt: nowIso, audit: log(cur, nowIso, `The send to ${s.clientName} did not complete and was rolled back`) } : null))
        if (back) out.rolledBack++
        continue
      }
      if ((await applyAnswer(s.tokenHash, d)).changed) {
        out.answered++
        continue
      }
      if (now.getTime() >= Date.parse(s.expiresAt) && !(await (d.getAnswer ?? getPublicAnswer)(s.tokenHash))) {
        let expired = false
        const next = await update(d.store, s.tokenHash, (cur, cs) => {
          if (cs.outcome !== 'pending' || cur.status !== 'sent') return null
          expired = true
          return { ...cur, status: 'expired', sends: cur.sends!.map((x) => (x.tokenHash === s.tokenHash ? { ...x, outcome: 'expired' as const, resolvedAt: nowIso } : x)), updatedAt: nowIso, audit: log(cur, nowIso, `No answer from ${s.clientName} by ${ukTime(s.expiresAt)}: expired`) }
        })
        if (next && expired) {
          out.expired++
          await d.notify(`${s.test ? '[TEST] ' : ''}${s.clientName} did not answer the offer (${s.units} units, ${eur(s.totalCents)}) before it expired at ${ukTime(s.expiresAt)}.\nThe offer is unlocked: reprice it and send it to another client.`, link(d, next))
          await emailOwner(d, next, { ...s, outcome: 'expired', resolvedAt: nowIso }, 'expired')
        }
      }
    }
  }
  return out
}
