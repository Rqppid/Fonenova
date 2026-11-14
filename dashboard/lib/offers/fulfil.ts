/**
 * What happens after a client accepts an offer: reserve the order reference, reply to Mobile One in
 * the original thread, and raise a DRAFT invoice in Xero. Nothing here authorises, emails or files
 * an invoice. Every step is idempotent (claimed under the offers lock before anything is sent, the
 * draft adopted by its reference) and is retried by the 5-minute check, so a crash or a Xero outage
 * never means a duplicate reply or a duplicate invoice.
 *
 * Test offers never reach Mobile One and never use up a real order or invoice number: the reply
 * goes to the owner's own inbox, the draft only to the Xero Demo Company.
 */
import { ukTime } from '../format-uk'
import { getJson, type Store } from '../store'
import { loadDraftSettings, raiseDraft, type XeroApi } from './draft'
import { emailAddress } from './clean'
import { seedClients, type Client } from './clients'
import { nextOrderRef } from './numbering'
import { itemsFor } from './resolve'
import type { Fulfilment, Offer, OfferSend } from './types'

export interface ReplyMessage { to: string; subject: string; text: string; threadId?: string; inReplyTo?: string }

export interface FulfilDeps {
  store: Store
  notify: (text: string, link?: { label: string; url: string }) => Promise<boolean>
  now?: Date
  dashboardUrl?: string
  /** OFFERS_ALLOW_REAL_SEND: without it nothing is ever sent to Mobile One. */
  allowReal: boolean
  /** The owner's own inbox: where a test offer's would-be reply goes. */
  ownerAddress: string
  /** Order ids already in the ledger and pairs, so a new reference never collides. */
  knownOrderIds: () => Promise<string[]>
  /** The Xero write connection, or null when it is not set up. */
  xero: () => XeroApi | null
  /** Sends one email from the connected Gmail. Throws when it cannot. */
  reply: (m: ReplyMessage) => Promise<{ id: string }>
  /** Whether the owner already replied in this thread after the given time. Throws when it cannot be checked. */
  replied: (threadId: string, afterIso: string) => Promise<boolean>
}

export const MAX_ATTEMPTS = 12
/** A reply is only sent by itself while Mobile One's offer is this fresh. */
export const MAX_OFFER_AGE_MS = 48 * 3_600_000
const STALE_MS = 10 * 60_000
const ALERT_AT = 3

const log = (o: Offer, now: string, what: string) => [...o.audit, { at: now, what }].slice(-60)
const nowOf = (d: FulfilDeps) => d.now ?? new Date()
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const link = (d: FulfilDeps, o: Offer) => (d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(o.id)}` } : undefined)
const acceptedSend = (o: Offer): OfferSend | undefined => (o.sends ?? []).find((s) => s.outcome === 'accepted')

async function mutate(store: Store, id: string, fn: (o: Offer) => Offer | null): Promise<Offer | null> {
  return store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.id === id)
    if (i < 0) return null
    const next = fn(offers[i])
    if (!next) return null
    offers[i] = next
    await store.set('offers', offers)
    return next
  })
}

async function load(store: Store, id: string): Promise<Offer | null> {
  return ((await getJson<Offer[]>(store, 'offers')) ?? []).find((o) => o.id === id) ?? null
}

/** The reply text. Plain and short; the same words every time. */
export function replyText(): string {
  return 'Hello Mobile One Trade Team,\n\nWe accept the offer. Please proceed with the invoice.\n\nKind regards,\nFoneNova Ltd.'
}

const reSubject = (s: string) => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim() || 'your offer'}`)

export function buildReply(o: Offer, f: Fulfilment, ownerAddress: string): ReplyMessage {
  const target = emailAddress(o.source.from)
  if (f.test) {
    return {
      to: ownerAddress,
      subject: `[TEST] Would-be reply to Mobile One: ${reSubject(o.source.subject)}`,
      text: `TEST: nothing was sent to Mobile One. This is the reply that would go to ${target} in their thread.\n\n---\n${replyText()}`,
    }
  }
  return { to: target, subject: reSubject(o.source.subject), text: replyText(), ...(o.source.threadId ? { threadId: o.source.threadId } : {}), ...(o.source.rfcMessageId ? { inReplyTo: o.source.rfcMessageId } : {}) }
}

/** The checks before a reply goes out by itself. Null when all pass; else why it is held. */
async function gate(o: Offer, s: OfferSend, d: FulfilDeps): Promise<string | null> {
  const age = nowOf(d).getTime() - Date.parse(o.source.receivedAt)
  if (!(age <= MAX_OFFER_AGE_MS)) return `Mobile One's offer is more than 48 hours old (${ukTime(o.source.receivedAt)}).`
  const items = await itemsFor(d.store, o)
  const total = items ? items.reduce((n, l) => n + l.unitSaleCents * l.qty, 0) : null
  if (total === null || total !== s.totalCents) return `The accepted total (${eur(s.totalCents)}) does not match the offer as priced now.`
  try {
    if (await d.replied(o.source.threadId, o.source.receivedAt)) return 'You have already replied in that thread.'
  } catch {
    return 'Could not check the thread for a reply from you (Gmail cannot read mail right now).'
  }
  return null
}

const failText = (e: unknown) => (e instanceof Error && e.message ? e.message.slice(0, 200) : 'It did not work')

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function runReply(id: string, d: FulfilDeps, approved = false): Promise<void> {
  const nowIso = nowOf(d).toISOString()
  const claimed = await mutate(d.store, id, (o) => {
    const f = o.fulfilment
    if (!f || o.status !== 'accepted') return null
    const r = f.reply
    const stale = r.state === 'sending' && nowOf(d).getTime() - Date.parse(r.at ?? nowIso) > STALE_MS
    const can = r.state === 'pending' || (r.state === 'failed' && r.attempts < MAX_ATTEMPTS) || (r.state === 'held' && approved)
    if (stale) return { ...o, updatedAt: nowIso, fulfilment: { ...f, reply: { ...r, state: 'held', reason: 'Could not confirm the reply went out. Check the thread in Gmail: only press OK if there is no reply from you.' } } }
    if (!can) return null
    return { ...o, updatedAt: nowIso, fulfilment: { ...f, reply: { ...r, state: 'sending', attempts: r.attempts + 1, at: nowIso, reason: undefined } } }
  })
  if (!claimed || claimed.fulfilment?.reply.state !== 'sending') return
  const f = claimed.fulfilment
  const s = acceptedSend(claimed)
  const finish = async (reply: Fulfilment['reply'], note: string) => mutate(d.store, id, (o) => (o.fulfilment ? { ...o, updatedAt: nowOf(d).toISOString(), fulfilment: { ...o.fulfilment, reply }, audit: log(o, nowOf(d).toISOString(), note) } : null))
  if (!s) return void (await finish({ ...f.reply, state: 'held', reason: 'The accepted send could not be found.' }, 'Reply to Mobile One held: no accepted send'))

  // A real reply needs the switch; it is held, never silently dropped, so one tap sends it later.
  if (!f.test && !d.allowReal) {
    await finish({ ...f.reply, state: 'held', reason: 'Sending to real clients and Mobile One is switched off (OFFERS_ALLOW_REAL_SEND).' }, 'Reply to Mobile One held: real sending is off')
    return
  }
  if (!f.test && !approved) {
    const why = await gate(claimed, s, d)
    if (why) {
      await finish({ ...f.reply, state: 'held', reason: why }, `Reply to Mobile One held: ${why}`)
      await d.notify(`Reply to Mobile One is waiting for you (${f.orderRef}).\n${why}\nOpen the offer and press OK to send it.`, link(d, claimed))
      return
    }
  }
  const msg = buildReply(claimed, f, d.ownerAddress)
  try {
    const sent = await d.reply(msg)
    await finish({ ...f.reply, state: 'sent', at: nowOf(d).toISOString(), messageId: sent.id, to: msg.to, reason: undefined }, f.test ? `Test reply sent to ${msg.to} (not to Mobile One)` : `Replied to Mobile One (${msg.to}) in their thread${approved ? ', after your OK' : ''}`)
  } catch (e) {
    const attempts = f.reply.attempts
    await finish({ ...f.reply, state: 'failed', reason: failText(e) }, `Reply to Mobile One failed (try ${attempts}): ${failText(e)}`)
    if (attempts === ALERT_AT) await d.notify(`The reply to Mobile One failed ${attempts} times (${f.orderRef}): ${failText(e)}\nIt keeps trying every 5 minutes.`, link(d, claimed))
  }
}

async function runDraft(id: string, d: FulfilDeps): Promise<void> {
  const nowIso = nowOf(d).toISOString()
  const claimed = await mutate(d.store, id, (o) => {
    const f = o.fulfilment
    if (!f || o.status !== 'accepted') return null
    const dr = f.draft
    const stale = dr.state === 'working' && nowOf(d).getTime() - Date.parse(dr.at ?? nowIso) > STALE_MS
    const can = dr.state === 'pending' || stale || (dr.state === 'failed' && dr.attempts < MAX_ATTEMPTS)
    if (!can) return null
    return { ...o, updatedAt: nowIso, fulfilment: { ...f, draft: { ...dr, state: 'working', attempts: dr.attempts + 1, at: nowIso } } }
  })
  if (!claimed?.fulfilment || claimed.fulfilment.draft.state !== 'working') return
  const f = claimed.fulfilment
  const finish = async (draft: Fulfilment['draft'], note: string) => mutate(d.store, id, (o) => (o.fulfilment ? { ...o, updatedAt: nowOf(d).toISOString(), fulfilment: { ...o.fulfilment, draft }, audit: log(o, nowOf(d).toISOString(), note) } : null))
  const block = async (reason: string, extra: { details?: string[]; field?: string } = {}) => {
    await finish({ ...f.draft, state: 'blocked', attempts: Math.max(0, f.draft.attempts - 1), reason, details: extra.details, field: extra.field }, `Draft invoice blocked: ${reason}`)
    // Tell the owner once per distinct reason (pressing Try again must not repeat the same message).
    if (extra.details && f.draft.reason !== reason) await d.notify(`The draft invoice for ${f.orderRef} was refused by Xero.\n${reason}\nOpen the offer for the full detail.`, link(d, claimed))
  }

  const api = d.xero()
  if (!api) return void (await block('The Xero write connection is not set up. Connect it in Settings, then press Try again.'))
  const clients = (await getJson<Client[]>(d.store, 'offers:clients')) ?? seedClients()
  const client = claimed.pricing ? clients.find((c) => c.id === claimed.pricing!.clientId) : undefined
  const lines = await itemsFor(d.store, claimed)
  if (!client || !lines) return void (await block('The offer could not be priced again from its saved settings.'))

  const r = await raiseDraft({ api, store: d.store, reference: f.orderRef, client, test: f.test, lines, settings: await loadDraftSettings(d.store), now: nowOf(d) })
  if (r.ok) {
    await finish({ ...f.draft, state: 'done', invoiceId: r.id, invoiceNumber: r.number, org: r.org, at: nowOf(d).toISOString(), reason: undefined, details: undefined, field: undefined }, `${r.adopted ? 'Found the existing' : 'Created'} DRAFT invoice ${r.number} in Xero (${r.org}) for ${f.orderRef}`)
    return
  }
  if (!r.retry) return void (await block(r.error, { details: r.details, field: r.field }))
  await finish({ ...f.draft, state: 'failed', reason: r.error, details: undefined, field: undefined }, `Draft invoice failed (try ${f.draft.attempts}): ${r.error}`)
  if (f.draft.attempts === ALERT_AT) await d.notify(`The draft invoice for ${f.orderRef} failed ${f.draft.attempts} times: ${r.error}\nIt keeps trying every 5 minutes.`, link(d, claimed))
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function summary(o: Offer): string {
  const f = o.fulfilment!
  const reply = { sent: f.test ? 'test reply sent to your inbox' : 'replied to Mobile One', held: 'reply to Mobile One is waiting for your OK', failed: 'reply to Mobile One failed (retrying)', pending: 'reply pending', sending: 'reply sending' }[f.reply.state]
  const draft = f.draft.state === 'done' ? `draft invoice ${f.draft.invoiceNumber} is in Xero${f.draft.org ? ` (${f.draft.org})` : ''}` : f.draft.state === 'blocked' ? `draft invoice is blocked: ${f.draft.reason}` : f.draft.state === 'failed' ? 'draft invoice failed (retrying)' : 'draft invoice pending'
  return `${f.test ? '[TEST] ' : ''}${f.orderRef}: ${reply}; ${draft}.`
}

/** Start (or resume) the work for an accepted offer. Safe to call twice. */
export async function fulfilOffer(offerId: string, d: FulfilDeps): Promise<void> {
  const nowIso = nowOf(d).toISOString()
  const known = await d.knownOrderIds().catch(() => [] as string[])
  const started = await d.store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.id === offerId)
    const o = offers[i]
    const s = o && acceptedSend(o)
    if (!o || o.status !== 'accepted' || !s || o.fulfilment) return false
    const test = s.test
    const ref = nextOrderRef(known, offers.flatMap((x) => (x.fulfilment ? [x.fulfilment.orderRef] : [])), test)
    offers[i] = { ...o, updatedAt: nowIso, fulfilment: { orderRef: ref, test, startedAt: nowIso, reply: { state: 'pending', attempts: 0 }, draft: { state: 'pending', attempts: 0 } }, audit: log(o, nowIso, `Order reference ${ref} reserved`) }
    await d.store.set('offers', offers)
    return true
  })
  const before = await load(d.store, offerId)
  if (!before?.fulfilment) return
  await runReply(offerId, d)
  await runDraft(offerId, d)
  const after = await load(d.store, offerId)
  if (after?.fulfilment && started) await d.notify(summary(after), link(d, after))
}

/** The owner pressed OK on a held reply. */
export async function approveReply(offerId: string, d: FulfilDeps): Promise<{ ok: boolean; message: string }> {
  const o = await load(d.store, offerId)
  if (!o?.fulfilment || o.fulfilment.reply.state !== 'held') return { ok: false, message: 'There is no held reply on this offer.' }
  await runReply(offerId, d, true)
  const after = await load(d.store, offerId)
  const r = after?.fulfilment?.reply
  return r?.state === 'sent' ? { ok: true, message: 'The reply was sent.' } : { ok: false, message: r?.reason ?? 'The reply could not be sent.' }
}

/** Try again: start offers accepted before this existed, and reset a step that gave up or is blocked. */
export async function retryFulfilment(offerId: string, d: FulfilDeps): Promise<void> {
  const o = await load(d.store, offerId)
  if (!o) return
  if (!o.fulfilment) return fulfilOffer(offerId, d)
  const nowIso = nowOf(d).toISOString()
  await mutate(d.store, offerId, (cur) => {
    const f = cur.fulfilment
    if (!f) return null
    const reply = f.reply.state === 'failed' ? { ...f.reply, state: 'pending' as const, attempts: 0 } : f.reply
    const draft = f.draft.state === 'failed' || f.draft.state === 'blocked' ? { ...f.draft, state: 'pending' as const, attempts: 0 } : f.draft
    return { ...cur, updatedAt: nowIso, fulfilment: { ...f, alerted: false, reply, draft }, audit: log(cur, nowIso, 'You asked for the steps after acceptance to be tried again') }
  })
  await runReply(offerId, d)
  await runDraft(offerId, d)
}

/** The 5-minute pass: retry what is pending or failed, and notice a step that completed. */
export async function sweepFulfilment(d: FulfilDeps): Promise<{ tried: number; completed: number }> {
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const out = { tried: 0, completed: 0 }
  for (const o of offers) {
    const f = o.fulfilment
    if (!f || o.status !== 'accepted') continue
    const stale = (at?: string) => nowOf(d).getTime() - Date.parse(at ?? '') > STALE_MS
    const replyWork = f.reply.state === 'pending' || (f.reply.state === 'failed' && f.reply.attempts < MAX_ATTEMPTS) || (f.reply.state === 'sending' && stale(f.reply.at))
    const draftWork = f.draft.state === 'pending' || (f.draft.state === 'failed' && f.draft.attempts < MAX_ATTEMPTS) || (f.draft.state === 'working' && stale(f.draft.at))
    if (!replyWork && !draftWork) continue
    out.tried++
    if (replyWork) await runReply(o.id, d)
    if (draftWork) await runDraft(o.id, d)
    const after = await load(d.store, o.id)
    const nf = after?.fulfilment
    if (nf && ((f.reply.state !== 'sent' && nf.reply.state === 'sent') || (f.draft.state !== 'done' && nf.draft.state === 'done'))) {
      out.completed++
      await d.notify(summary(after!), link(d, after!))
    }
  }
  return out
}
