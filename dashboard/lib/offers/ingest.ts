/**
 * Picks up Mobile One's offer emails: every few minutes (QStash), new mail from Mobile One in the
 * last 3 days is read, each offer is stored as NEEDS REVIEW and Hamza gets a Telegram ping.
 * Invoices, IMEI lists, tracking and replies are recognised and skipped. Nothing is sent to
 * anyone. Reading and the AI happen outside the store lock; the save re-checks under it, so two
 * runs at once never store an offer twice.
 */
import { getJson, type Store } from '../store'
import { offerCostCents, offerFlags, offerUnits } from './check'
import { cleanOfferText, emailAddress, mayBeOffer } from './clean'
import type { Offer, OffersStatus } from './types'
import type { MailMessage } from '../gmail'
import type { ParsedOffer } from './parse'

export const SUPPLIER = 'bv@mobileone.info'
export const QUERY = `from:${SUPPLIER} newer_than:3d`
/** Messages read per run: keeps each run short, the rest wait 5 minutes. */
const PER_RUN = 6
const KEEP_OFFERS = 500
const KEEP_SEEN = 3000

export interface IngestDeps {
  store: Store
  list: (query: string) => Promise<string[]>
  get: (id: string) => Promise<MailMessage>
  read: (text: string, subject: string) => Promise<ParsedOffer>
  notify: (text: string, link?: { label: string; url: string }) => Promise<boolean>
  now?: Date
  dashboardUrl?: string
}

export interface IngestResult {
  checked: number
  added: Offer[]
  skipped: number
  errors: string[]
}

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export async function ingestOffers(d: IngestDeps): Promise<IngestResult> {
  const now = (d.now ?? new Date()).toISOString()
  const seen = new Set((await getJson<string[]>(d.store, 'offers:seen')) ?? [])
  const ids = (await d.list(QUERY)).filter((id) => !seen.has(id)).reverse().slice(0, PER_RUN) // oldest first
  const found: Offer[] = []
  const done: string[] = []
  const errors: string[] = []

  for (const id of ids) {
    try {
      const m = await d.get(id)
      // Only Mobile One's own incoming mail; our replies and anything else are just marked read.
      if (emailAddress(m.from) !== SUPPLIER || m.labels.includes('SENT') || m.labels.includes('DRAFT')) { done.push(id); continue }
      const text = cleanOfferText(m.text)
      if (!mayBeOffer(text)) { done.push(id); continue }
      const parsed = await d.read(text, m.subject)
      done.push(id)
      if (!parsed.isOffer) continue
      found.push({
        id: `of_${m.id}`,
        status: 'needs_review',
        source: { gmailMessageId: m.id, threadId: m.threadId, rfcMessageId: m.rfcMessageId, from: m.from, to: m.to, subject: m.subject, receivedAt: m.receivedAt },
        text: text.slice(0, 4000),
        lines: parsed.lines,
        createdAt: now,
        updatedAt: now,
        audit: [{ at: now, what: `Read from email: ${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'}` }],
      })
    } catch (e) {
      // Not marked read: tried again next run (and dropped after 3 days by the search itself).
      errors.push(e instanceof Error ? e.message.slice(0, 200) : 'Could not read a message')
    }
  }

  const added = await d.store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
    const have = new Set(offers.map((o) => o.source.gmailMessageId))
    const fresh = found.filter((o) => !have.has(o.source.gmailMessageId))
    if (fresh.length) await d.store.set('offers', [...[...fresh].reverse(), ...offers].slice(0, KEEP_OFFERS)) // newest first
    const allSeen = [...((await getJson<string[]>(d.store, 'offers:seen')) ?? []), ...done]
    await d.store.set('offers:seen', [...new Set(allSeen)].slice(-KEEP_SEEN))
    return fresh
  })

  await d.store.set('offers:status', { lastRunAt: now, ok: errors.length === 0, checked: ids.length, added: added.length, error: errors[0] ?? null } satisfies OffersStatus)

  for (const o of added) {
    const flagged = [...offerFlags(o.lines).values()].filter((f) => f.length).length
    const text = [
      `New Mobile One offer: ${o.lines.length} line${o.lines.length === 1 ? '' : 's'}, ${offerUnits(o.lines)} units, cost ${eur(offerCostCents(o.lines))}.`,
      ...o.lines.slice(0, 8).map((l) => `• ${l.model}${l.storage ? ` ${l.storage}` : ''}${l.grade ? ` ${l.grade}` : ''}: ${l.qty} × ${eur(l.unitCostCents)}`),
      ...(o.lines.length > 8 ? [`… and ${o.lines.length - 8} more`] : []),
      flagged ? `⚠ ${flagged} line${flagged === 1 ? '' : 's'} need a check.` : 'Needs your review before it can be priced.',
    ].join('\n')
    await d.notify(text, d.dashboardUrl ? { label: 'Review offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(o.id)}` } : undefined)
  }
  return { checked: ids.length, added, skipped: done.length - found.length, errors }
}
