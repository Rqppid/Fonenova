/**
 * Spots an offer that was emailed to a client by hand, by looking at the mailbox's Sent mail.
 *
 * It only ever SUGGESTS: it stores `Offer.sentGuess` and tells the owner. Nothing is recorded as sent, priced or accepted
 * until the owner presses confirm, and confirming goes through the same total check as marking an offer sent by hand.
 * Uses the Gmail connection already set up (no new key). One cheap model call per candidate sent email, a few per run.
 */
import { clientsFrom, type Client } from './clients'
import { emailAddress, cleanOfferText, mayBeOffer } from './clean'
import { modelKey } from './check'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import { markSentManually, type ManualResult } from './manual-send'
import type { ParsedOffer } from './parse'
import { MAX_MARGIN_CENTS, priceOffer, toPricing, type PricingInput } from './pricing'
import { getJson } from '../store'
import type { MailMessage } from '../gmail'
import type { Offer, OfferLine, SentGuess } from './types'
import type { Store } from '../store'

const WINDOW_MS = 7 * 24 * 3600_000
const PER_RUN = 5
const KEEP_SEEN = 1500
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface SentMatch { marginCents: number; overrides: Record<string, number>; totalCents: number; units: number }

const sameStorage = (a: string | null, b: string | null) => !a || !b || a.toLowerCase().replace(/\s+/g, '') === b.toLowerCase().replace(/\s+/g, '')

/**
 * Does this sent email quote this offer? Every offer line must have a sent line with the same model, storage and quantity,
 * quoted above its cost, and the sent email must have no other product lines. Returns the per-unit margin most lines carry
 * (the rest become per-line overrides) and the total quoted. Pure.
 */
export function matchSentToOffer(offerLines: readonly OfferLine[], sentLines: readonly OfferLine[]): SentMatch | null {
  if (offerLines.length === 0 || sentLines.length !== offerLines.length) return null
  const left = [...sentLines]
  const margins: { id: string; margin: number }[] = []
  let total = 0
  let units = 0
  for (const l of offerLines) {
    const i = left.findIndex((s) => modelKey(s.model) === modelKey(l.model) && sameStorage(s.storage, l.storage) && s.qty === l.qty)
    if (i < 0) return null
    const sale = left[i].unitCostCents // the reader calls the price in the email its "unit cost"
    left.splice(i, 1)
    const margin = sale - l.unitCostCents
    if (margin <= 0 || margin > MAX_MARGIN_CENTS) return null
    margins.push({ id: l.id, margin })
    total += l.qty * sale
    units += l.qty
  }
  const counts = new Map<number, number>()
  for (const m of margins) counts.set(m.margin, (counts.get(m.margin) ?? 0) + 1)
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  return { marginCents: common, overrides: Object.fromEntries(margins.filter((m) => m.margin !== common).map((m) => [m.id, m.margin])), totalCents: total, units }
}

export interface SentDetectDeps {
  store: Store
  list: (query: string) => Promise<string[]>
  get: (id: string) => Promise<MailMessage>
  read: (text: string, subject: string) => Promise<ParsedOffer>
  notify: (text: string, link?: { label: string; url: string }) => Promise<boolean>
  now?: Date
  dashboardUrl?: string
}

const addresses = (to: string) => to.split(',').map((x) => emailAddress(x.trim())).filter(Boolean)

export async function detectSent(d: SentDetectDeps): Promise<{ examined: number; guessed: number }> {
  const now = d.now ?? new Date()
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const candidates = offers.filter((o) => !o.testOnly && (o.status === 'needs_review' || o.status === 'ready') && now.getTime() - Date.parse(o.source.receivedAt) <= WINDOW_MS)
  const out = { examined: 0, guessed: 0 }
  if (candidates.length === 0) return out
  const clients = clientsFrom(await getJson<Client[]>(d.store, 'offers:clients')).filter((c) => !c.test && c.offerEmails.length > 0)
  const addrs = [...new Set(clients.flatMap((c) => c.offerEmails))]
  if (addrs.length === 0) return out
  const seen = new Set((await getJson<string[]>(d.store, 'offers:sent-seen')) ?? [])
  const ids = (await d.list(`in:sent to:(${addrs.join(' OR ')}) newer_than:7d`)).filter((id) => !seen.has(id)).reverse().slice(0, PER_RUN)
  const done: string[] = []
  for (const id of ids) {
    try {
      const m = await d.get(id)
      done.push(id)
      if (!m.labels.includes('SENT')) continue
      const client = clients.find((c) => addresses(m.to).some((a) => c.offerEmails.includes(a)))
      const text = cleanOfferText(m.text)
      if (!client || !mayBeOffer(text)) continue
      out.examined++
      const parsed = await d.read(text, m.subject)
      if (!parsed.isOffer) continue
      const found: { offer: Offer; match: SentMatch }[] = []
      for (const o of candidates) {
        if (Date.parse(o.source.receivedAt) > Date.parse(m.receivedAt) || o.sentGuessDismissed?.includes(id)) continue
        const match = matchSentToOffer(o.lines, parsed.lines)
        if (match) found.push({ offer: o, match })
      }
      for (const { offer, match } of found) {
        const guess: SentGuess = { messageId: id, clientId: client.id, clientName: client.name, to: m.to, sentAt: m.receivedAt, totalCents: match.totalCents, units: match.units, marginCents: match.marginCents, overrides: match.overrides, ...(found.length > 1 ? { ambiguousWith: found.filter((f) => f.offer.id !== offer.id).map((f) => f.offer.id) } : {}), foundAt: now.toISOString() }
        const saved = await mutate(d.store, offer.id, (cur) => (cur.status === 'needs_review' || cur.status === 'ready') && cur.sentGuess?.messageId !== id ? { ...cur, sentGuess: guess, audit: log(cur, now.toISOString(), `Looks emailed to ${client.name} by hand (${eur(match.totalCents)}): waiting for your confirmation`) } : null)
        if (saved) out.guessed++
      }
      if (found.length > 0) await d.notify(`Looks like you emailed ${client.name} an offer by hand (${eur(found[0].match.totalCents)}${found.length > 1 ? `, it matches ${found.length} similar offers: pick the right one` : ''}). Open the offer to confirm.`, d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(found[0].offer.id)}` } : undefined)
    } catch {
      // Not marked as seen: it is looked at again next time.
      done.pop()
    }
  }
  if (done.length > 0) await d.store.set('offers:sent-seen', [...new Set([...seen, ...done])].slice(-KEEP_SEEN))
  return out
}

/** The owner confirms: price the offer as the email quoted it, then mark it sent by hand. Goes through the same total check. */
export async function confirmSentGuess(offerId: string, d: FulfilDeps): Promise<ManualResult> {
  const now = (d.now ?? new Date()).toISOString()
  const offer = await load(d.store, offerId)
  const g = offer?.sentGuess
  if (!offer || !g) return { ok: false, message: 'There is no suggestion on this offer.' }
  if (offer.status !== 'ready') return { ok: false, message: offer.status === 'needs_review' ? 'Mark the offer reviewed first, then confirm.' : 'This offer cannot be marked as sent now.' }
  const client = clientsFrom(await getJson<Client[]>(d.store, 'offers:clients')).find((c) => c.id === g.clientId)
  if (!client) return { ok: false, message: 'That client no longer exists.' }
  const input: PricingInput = { clientId: client.id, marginCents: client.margin.type === 'manual' ? g.marginCents : null, overrides: client.margin.type === 'fixed' && client.margin.locked ? {} : { ...g.overrides }, ackLow: false, shippingCents: null, shippingLater: true, mobileShipping: { cents: null, none: false } }
  const r = priceOffer(offer.lines, client, input)
  if (!r.ok) return { ok: false, message: `${r.errors[0] ?? 'The price is not valid.'} Price it by hand in the Price panel to match the email (${eur(g.totalCents)}), then use "Offer sent manually by email".` }
  if (r.totals.saleCents !== g.totalCents) return { ok: false, message: `The dashboard would price it at ${eur(r.totals.saleCents)} but the email quoted ${eur(g.totalCents)}. Price it by hand to match, then use "Offer sent manually by email".` }
  await mutate(d.store, offerId, (o) => (o.status === 'ready' ? { ...o, pricing: toPricing(input, client, now), updatedAt: now, audit: log(o, now, `Priced for ${client.name} as the sent email quoted it (${eur(g.totalCents)})`) } : null))
  const res = await markSentManually(offerId, d, { totalCents: g.totalCents, sentAt: g.sentAt, note: 'Found in your sent email' })
  if (!res.ok) return res
  // The email is accounted for: no other offer keeps suggesting it.
  await d.store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
    await d.store.set('offers', offers.map((o) => (o.id === offerId ? { ...o, sentGuess: undefined } : o.sentGuess?.messageId === g.messageId ? { ...o, sentGuess: undefined, sentGuessDismissed: [...(o.sentGuessDismissed ?? []), g.messageId] } : o)))
  })
  return res
}

export async function dismissSentGuess(offerId: string, d: FulfilDeps): Promise<ManualResult> {
  const now = (d.now ?? new Date()).toISOString()
  const saved = await mutate(d.store, offerId, (o) => (o.sentGuess ? { ...o, sentGuess: undefined, sentGuessDismissed: [...(o.sentGuessDismissed ?? []), o.sentGuess.messageId], updatedAt: now, audit: log(o, now, 'You said the suggested sent email is not this offer') } : null))
  return saved ? { ok: true, message: 'Dismissed. It will not be suggested again.' } : { ok: false, message: 'There is no suggestion on this offer.' }
}
