/**
 * Turning a client's answer (or the passing of the deadline) into the offer's new state. The
 * public site tells the dashboard only that "an answer arrived for this hash"; this module reads
 * the answer from the public store itself, so a forged call can change nothing. The 5-minute
 * check runs the same code, so a missed notice is picked up within minutes.
 */
import { getJson, type Store } from '../store'
import { ukTime } from '../format-uk'
import { getPublicAnswer, type PublicAnswer } from './public-store'
import type { Offer, OfferSend } from './types'

export interface ResolveDeps {
  store: Store
  notify: (text: string, link?: { label: string; url: string }) => Promise<boolean>
  getAnswer?: (hash: string) => Promise<PublicAnswer | null>
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
      accepted ? (s.test ? 'This was a test, so nothing else happens.' : 'Reply to Mobile One and raise the invoice yourself for now.') : 'The offer is unlocked: reprice it and send it to another client.',
    ].join('\n'),
    link(d, offer),
  )
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
        }
      }
    }
  }
  return out
}
