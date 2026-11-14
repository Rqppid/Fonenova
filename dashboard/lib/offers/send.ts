/**
 * Sending a priced offer to a client, withdrawing it, and unlocking it again. The steps are
 * ordered so a failure part-way can always be undone, and so an offer is never sent twice:
 *
 *  1. under the offers lock: check everything, mark the offer `sent` with a pending send
 *     (this reserves it, so a second click is refused);
 *  2. write the client's snapshot (sale prices only) to the public store;
 *  3. send the email;
 *  4. record that Gmail accepted it. If step 2 or 3 fails, the reservation is undone and the
 *     snapshot removed; a crash in between is rolled back by the 5-minute check.
 *
 * Only the link's hash is kept. The full token exists in memory long enough to build the email.
 */
import { getJson, type Store } from '../store'
import { buildOfferEmail, type OfferEmail } from './email'
import { seedClients, type Client } from './clients'
import { priceOffer, publicLines } from './pricing'
import { deletePublicOffer, hashToken, newToken, OFFER_VALID_MS, publicStoreProblem, putPublicOffer, getPublicAnswer, withdrawPublicOffer, type PublicOffer } from './public-store'
import type { Offer, OfferSend } from './types'

export interface SendDeps {
  store: Store
  mail: (m: { to: string; subject: string; text: string; html: string }) => Promise<{ id: string }>
  /** Real clients stay switched off until the order and invoice steps exist. */
  allowReal: boolean
  baseUrl?: string
  now?: Date
  token?: () => string
}

export type Result = { ok: true; offer: Offer } | { ok: false; error: string }

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const log = (o: Offer, now: string, what: string) => [...o.audit, { at: now, what }].slice(-60)
const clientsOf = async (store: Store) => (await getJson<Client[]>(store, 'offers:clients')) ?? seedClients()

async function mutate(store: Store, id: string, fn: (o: Offer) => Offer | { error: string }): Promise<Result> {
  return store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.id === id)
    if (i < 0) return { ok: false, error: 'That offer no longer exists' } as const
    const next = fn(offers[i])
    if ('error' in next) return { ok: false, error: next.error } as const
    offers[i] = next
    await store.set('offers', offers)
    return { ok: true, offer: next } as const
  })
}

export async function sendOffer(id: string, d: SendDeps): Promise<Result> {
  const storeProblem = publicStoreProblem()
  if (storeProblem) return { ok: false, error: storeProblem }
  const nowDate = d.now ?? new Date()
  const now = nowDate.toISOString()
  const token = (d.token ?? newToken)()
  const hash = hashToken(token)
  const clients = await clientsOf(d.store)
  const snapshot: { value?: PublicOffer; client?: Client; send?: OfferSend } = {}

  // 1. Reserve.
  const reserved = await mutate(d.store, id, (o) => {
    if (o.status !== 'ready') return { error: o.status === 'sent' ? 'This offer has already been sent. Withdraw it first to send it again.' : 'Only a reviewed offer can be sent.' }
    if (!o.pricing) return { error: 'Price the offer for a client first.' }
    const client = clients.find((c) => c.id === o.pricing!.clientId)
    if (!client) return { error: 'The client this offer is priced for no longer exists.' }
    if (!client.test && !d.allowReal) return { error: 'Offers to real clients are switched on with the next phase (order and invoice). For now, price it for the test client and send it to yourself.' }
    if (!client.offerEmails.length) return { error: client.test ? 'Add your own email address to the test client first (Offers, Clients).' : `${client.name} has no offer email address (Offers, Clients).` }
    const r = priceOffer(o.lines, client, { clientId: client.id, marginCents: o.pricing.marginCents, overrides: o.pricing.overrides, ackLow: o.pricing.ackLow })
    if (!r.ok) return { error: r.errors[0] ?? 'The price is no longer valid. Price it again.' }
    const expiresAt = new Date(nowDate.getTime() + OFFER_VALID_MS).toISOString()
    snapshot.client = client
    snapshot.value = { clientName: client.name, lines: publicLines(o.lines, r), units: r.totals.units, totalCents: r.totals.saleCents, issuedAt: now, expiresAt, test: client.test, status: 'open' }
    snapshot.send = { clientId: client.id, clientName: client.name, to: client.offerEmails, tokenHash: hash, tokenHint: token.slice(0, 6), sentAt: now, expiresAt, totalCents: r.totals.saleCents, units: r.totals.units, test: client.test, gmailMessageId: null, outcome: 'pending' }
    return { ...o, status: 'sent', sends: [...(o.sends ?? []), snapshot.send], updatedAt: now, audit: log(o, now, `Sending to ${client.name}`) }
  })
  if (!reserved.ok) return reserved
  const { value: pub, client, send } = snapshot as Required<typeof snapshot>

  // Undo the reservation if anything below fails.
  const rollback = async (why: string): Promise<Result> => {
    await deletePublicOffer(hash).catch(() => {})
    await mutate(d.store, id, (o) => ({ ...o, status: 'ready', sends: (o.sends ?? []).filter((s) => s.tokenHash !== hash), updatedAt: now, audit: log(o, now, `Send to ${client.name} failed, nothing was sent: ${why}`) }))
    return { ok: false, error: `Not sent: ${why}` }
  }

  // 2. The client's snapshot, 3. the email.
  try {
    await putPublicOffer(hash, pub)
  } catch (e) {
    return rollback(e instanceof Error ? e.message.slice(0, 200) : 'the public store failed')
  }
  const link = `${d.baseUrl ?? 'https://fonenova.com'}/offer/${token}`
  const email: OfferEmail = buildOfferEmail(pub, link)
  let gmailId: string
  try {
    gmailId = (await d.mail({ to: client.offerEmails.join(', '), ...email })).id
  } catch (e) {
    return rollback(e instanceof Error ? e.message.slice(0, 200) : 'Gmail failed')
  }

  // 4. Record it.
  const done = await mutate(d.store, id, (o) => ({
    ...o,
    sends: (o.sends ?? []).map((s) => (s.tokenHash === hash ? { ...s, gmailMessageId: gmailId || 'sent' } : s)),
    updatedAt: now,
    audit: log(o, now, `Sent to ${client.name} (${client.offerEmails.join(', ')}): ${send.units} units, ${eur(send.totalCents)}${client.test ? ' [test]' : ''}. Valid until ${send.expiresAt}`),
  }))
  return done
}

/** Stop a sent offer being answered. If the client answered first, that answer stands (see resolve.ts). */
export async function withdrawOffer(id: string, d: Pick<SendDeps, 'store' | 'now'>, applyAnswer: (hash: string) => Promise<{ changed: boolean }>): Promise<Result> {
  const now = (d.now ?? new Date()).toISOString()
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const offer = offers.find((o) => o.id === id)
  const send = offer?.sends?.find((s) => s.outcome === 'pending')
  if (!offer || offer.status !== 'sent' || !send) return { ok: false, error: 'This offer is not waiting for an answer.' }
  if (await getPublicAnswer(send.tokenHash)) {
    await applyAnswer(send.tokenHash)
    return { ok: false, error: 'The client has already answered. See the offer for their answer.' }
  }
  await withdrawPublicOffer(send.tokenHash)
  // The answer could have landed in the instant between those two steps: if so it stands.
  if (await getPublicAnswer(send.tokenHash)) {
    await applyAnswer(send.tokenHash)
    return { ok: false, error: 'The client answered at the same moment. See the offer for their answer.' }
  }
  return mutate(d.store, id, (o) => {
    if (o.status !== 'sent') return { error: 'This offer is no longer waiting for an answer.' }
    return { ...o, status: 'ready', sends: (o.sends ?? []).map((s) => (s.tokenHash === send.tokenHash ? { ...s, outcome: 'withdrawn' as const, resolvedAt: now } : s)), updatedAt: now, audit: log(o, now, `Withdrawn from ${send.clientName}`) }
  })
}

/** After a decline or expiry: back to reviewed, price kept, so it can be repriced and sent to another client. */
export async function unlockOffer(id: string, d: Pick<SendDeps, 'store' | 'now'>): Promise<Result> {
  const now = (d.now ?? new Date()).toISOString()
  return mutate(d.store, id, (o) => {
    if (o.status !== 'declined' && o.status !== 'expired') return { error: 'Only a declined or expired offer can be unlocked.' }
    return { ...o, status: 'ready', updatedAt: now, audit: log(o, now, 'Unlocked to reprice') }
  })
}
