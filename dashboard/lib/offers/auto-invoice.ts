/**
 * The invoice that goes out by itself after a client accepts.
 *
 * Once the Xero draft exists and the client is set to automatic, it is scheduled for 10 minutes later
 * (the owner is told on Telegram and can press Hold). When the time comes it does exactly what the
 * owner's two clicks do, by calling the same `approveInvoice` and `sendInvoice` with their own checks
 * and switches (draft status, euros, the total the client accepted, the same contact, an address,
 * XERO_WRITE_ALLOW_LIVE, OFFERS_ALLOW_APPROVE, OFFERS_ALLOW_REAL_SEND, at-most-once). Nothing is retried
 * by itself after a step refused or ended unclear: the owner is told and the manual buttons stay.
 *
 * A test invoice is never approved in the live organisation, and a real one never in a demo, so
 * automatic invoicing does not apply there.
 */
import { ukTime } from '../format-uk'
import { getJson } from '../store'
import { autoInvoiceOf, seedClients, type Client } from './clients'
import { load, log, mutate, type FulfilDeps } from './fulfil'
import { approveInvoice, sendInvoice, type ActionResult, type InvoiceDeps } from './invoice-flow'
import type { Offer } from './types'

/** How long after acceptance (and the draft) the invoice goes out. The 5-minute check then runs it, so 10 to 15 minutes in practice. */
export const AUTO_DELAY_MS = 10 * 60_000
const STALE_RUNNING_MS = 10 * 60_000

/**
 * Only orders that started after automatic invoicing went live are ever handled by it. Without this, the first
 * run would have invoiced every older accepted offer that still had a draft (it did, in the Demo Company).
 */
export const AUTO_FROM = '2026-11-17T18:00:00Z'
/** The 5-minute pass only looks at orders this recent. */
const SWEEP_WINDOW_MS = 7 * 24 * 3_600_000
/** The start of the reason shown when the dashboard points at a different Xero organisation than the draft was made in. */
export const ORG_MISMATCH = 'Switch the dashboard back to'

const nowOf = (d: FulfilDeps) => d.now ?? new Date()
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const link = (d: FulfilDeps, o: Offer) => (d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(o.id)}` } : undefined)
const clientOf = async (d: FulfilDeps, o: Offer): Promise<Client | undefined> => ((await getJson<Client[]>(d.store, 'offers:clients')) ?? seedClients()).find((c) => c.id === o.pricing?.clientId)
const acceptedTotal = (o: Offer) => (o.sends ?? []).find((s) => s.outcome === 'accepted')?.totalCents ?? null

type Plan = { mode: 'off'; why?: string } | { mode: 'hold'; why: string } | { mode: 'go' }

/** Whether this offer should be invoiced automatically right now, and if not, why not. */
async function plan(o: Offer, d: InvoiceDeps): Promise<Plan> {
  const f = o.fulfilment
  if (d.autoOff) return { mode: 'off' }
  if (!f || o.status !== 'accepted') return { mode: 'off' }
  const client = await clientOf(d, o)
  if (!client || !autoInvoiceOf(client)) return { mode: 'off' }
  // Older orders were started before this existed: they are left to the owner, never invoiced by surprise.
  if (!(Date.parse(f.startedAt) >= Date.parse(AUTO_FROM))) return { mode: 'off', why: 'This order started before automatic invoicing existed, so it is left to you.' }
  // The owner already pressed Approve or Send himself: step aside, never race him.
  if (f.approve || f.send) return { mode: 'off', why: 'You already started the invoice yourself, so it is not done automatically.' }
  if (f.draft.state !== 'done' || !f.draft.invoiceId) return { mode: 'hold', why: 'There is no draft invoice yet.' }
  if (f.draft.warnings?.some((w) => /address/i.test(w))) return { mode: 'hold', why: `${client.name} has no usable address in Xero. Add one, then press Re-check in Xero.` }
  if (!client.test && !client.termsConfirmed) return { mode: 'hold', why: `${client.name}'s payment terms are not confirmed (Offers, Clients).` }
  if (client.invoiceEmails.filter((e) => e.trim()).length === 0) return { mode: 'hold', why: `${client.name} has no invoice email address (Offers, Clients).` }
  const api = d.xero()
  if (!api) return { mode: 'hold', why: 'The Xero write connection is not set up.' }
  try {
    const org = await api.organisation()
    if (org.name !== f.draft.org) return { mode: 'hold', why: `${ORG_MISMATCH} ${f.draft.org ?? 'the organisation the draft was made in'} (Settings, Xero draft invoices), then press Re-check in Xero. It points at ${org.name} right now.` }
    if (!org.isDemo && f.test) return { mode: 'hold', why: 'A test invoice is never approved in the live organisation: it stays a draft there. Delete it in Xero.' }
    if (org.isDemo && !f.test) return { mode: 'hold', why: 'A real order is not approved in a demo organisation.' }
  } catch (e) {
    return { mode: 'hold', why: e instanceof Error ? e.message.slice(0, 160) : 'Xero could not be reached.' }
  }
  return { mode: 'go' }
}

/**
 * After the draft exists: schedule the automatic invoice (once), or say why not (once). Safe to call again:
 * a blocked one is re-checked and scheduled as soon as what blocked it clears, without telling you twice.
 */
export async function scheduleAuto(offerId: string, d: InvoiceDeps): Promise<void> {
  const o = await load(d.store, offerId)
  const f = o?.fulfilment
  if (!o || !f || o.status !== 'accepted' || f.draft.state !== 'done') return
  if (f.auto && f.auto.state !== 'blocked') return
  const p = await plan(o, d)
  if (p.mode === 'off') return
  const now = nowOf(d)
  const at = now.toISOString()
  if (p.mode === 'hold') {
    // Tell the owner the first time only; the reason is kept so the panel shows it.
    const first = !f.auto || f.auto.reason !== p.why
    await mutate(d.store, offerId, (cur) => (cur.fulfilment && (!cur.fulfilment.auto || cur.fulfilment.auto.state === 'blocked') ? { ...cur, updatedAt: at, fulfilment: { ...cur.fulfilment, auto: { state: 'blocked', dueAt: at, at, reason: p.why } } } : null))
    if (first) await d.notify(`${f.test ? '[TEST] ' : ''}${f.orderRef}: the invoice will NOT go out by itself.\n${p.why}`, link(d, o))
    return
  }
  const dueAt = new Date(now.getTime() + AUTO_DELAY_MS).toISOString()
  const claimed = await mutate(d.store, offerId, (cur) => (cur.fulfilment && (!cur.fulfilment.auto || cur.fulfilment.auto.state === 'blocked') ? { ...cur, updatedAt: at, fulfilment: { ...cur.fulfilment, auto: { state: 'scheduled', dueAt, at } }, audit: log(cur, at, `Invoice ${f.draft.invoiceNumber} will be approved and emailed automatically at ${ukTime(dueAt)} unless you press Hold`) } : null))
  if (!claimed) return
  const client = await clientOf(d, claimed)
  const total = acceptedTotal(claimed)
  await d.notify(`${f.test ? '[TEST] ' : ''}Invoice ${f.draft.invoiceNumber} for ${client?.name ?? 'the client'}${total !== null ? ` (${eur(total)})` : ''} will be approved and emailed at ${ukTime(dueAt)} unless you press Hold.\nCheck the draft in Xero before then.`, link(d, claimed))
}

/** Run the automatic invoice if it is due: approve, then email. Each step is the same code as the manual button. */
export async function runAuto(offerId: string, d: InvoiceDeps): Promise<ActionResult> {
  const now = nowOf(d)
  const at = now.toISOString()
  const claimed = await mutate(d.store, offerId, (o) => {
    const a = o.fulfilment?.auto
    if (!o.fulfilment || !a || a.state !== 'scheduled' || Date.parse(a.dueAt) > now.getTime()) return null
    return { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, auto: { ...a, state: 'running', at } } }
  })
  if (!claimed?.fulfilment) return { ok: false, message: 'It is not due.' }
  const f = claimed.fulfilment
  const finish = async (state: 'done' | 'blocked' | 'failed', reason: string | undefined, note: string) =>
    mutate(d.store, offerId, (o) => (o.fulfilment?.auto ? { ...o, updatedAt: nowOf(d).toISOString(), fulfilment: { ...o.fulfilment, auto: { ...o.fulfilment.auto, state, at: nowOf(d).toISOString(), reason } }, audit: log(o, nowOf(d).toISOString(), note) } : null))
  const stop = async (state: 'blocked' | 'failed', why: string, what: string): Promise<ActionResult> => {
    await finish(state, why, `Automatic invoice ${state}: ${why}`)
    await d.notify(`${f.test ? '[TEST] ' : ''}${f.orderRef}: ${what}\n${why}\nOpen the offer: the Approve and Send buttons are still there.`, link(d, claimed))
    return { ok: false, message: why }
  }

  // Look again at everything that could have changed in the 10 minutes.
  const p = await plan(claimed, d)
  if (p.mode === 'off') return stop('blocked', p.why ?? 'Automatic invoicing was switched off.', 'the invoice was not sent automatically.')
  if (p.mode === 'hold') return stop('blocked', p.why, 'the invoice was not sent automatically.')

  const a = await approveInvoice(offerId, d, { confirm: true })
  if (!a.ok) return stop('failed', a.message, 'the automatic approval did not go through, so nothing was sent.')
  const s = await sendInvoice(offerId, d, { confirm: true, via: 'gmail' })
  if (!s.ok) return stop('failed', s.message, 'the invoice was approved in Xero but NOT emailed.')
  await finish('done', undefined, `Approved and emailed automatically (${s.message})`)
  return { ok: true, message: s.message }
}

/** You pressed Hold: it will not run. The manual buttons are unaffected. */
export async function holdAuto(offerId: string, d: FulfilDeps): Promise<ActionResult> {
  const at = nowOf(d).toISOString()
  const done = await mutate(d.store, offerId, (o) => {
    const a = o.fulfilment?.auto
    if (!o.fulfilment || !a || (a.state !== 'scheduled' && a.state !== 'blocked')) return null
    return { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, auto: { ...a, state: 'held', at, reason: 'Held by you' } }, audit: log(o, at, 'You held the automatic invoice') }
  })
  if (done) return { ok: true, message: 'Held. Nothing will be sent automatically. You can still approve and send it yourself.' }
  const cur = (await load(d.store, offerId))?.fulfilment?.auto
  return { ok: false, message: cur?.state === 'running' ? 'It is being sent right now.' : cur?.state === 'done' ? 'It was already sent.' : cur?.state === 'held' ? 'It is already held.' : 'There is no automatic invoice to hold.' }
}

/** Let a held one run again, 10 minutes from now. */
export async function resumeAuto(offerId: string, d: FulfilDeps): Promise<ActionResult> {
  const now = nowOf(d)
  const dueAt = new Date(now.getTime() + AUTO_DELAY_MS).toISOString()
  const done = await mutate(d.store, offerId, (o) => {
    const a = o.fulfilment?.auto
    if (!o.fulfilment || !a || a.state !== 'held') return null
    return { ...o, updatedAt: now.toISOString(), fulfilment: { ...o.fulfilment, auto: { state: 'scheduled', dueAt, at: now.toISOString() } }, audit: log(o, now.toISOString(), `You released the hold: automatic invoice at ${ukTime(dueAt)}`) }
  })
  return done ? { ok: true, message: `It will be approved and emailed at ${ukTime(dueAt)}.` } : { ok: false, message: 'There is no held automatic invoice.' }
}

/** The 5-minute pass: schedule what is newly ready, run what is due, and flag one that ended unclear. */
export async function sweepAuto(d: InvoiceDeps): Promise<{ scheduled: number; ran: number }> {
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const out = { scheduled: 0, ran: 0 }
  for (const o of offers) {
    const f = o.fulfilment
    if (!f || o.status !== 'accepted') continue
    // Only recent orders, so a stale one is never looked at (or sent to Xero about) again and again.
    if (nowOf(d).getTime() - Date.parse(f.startedAt) > SWEEP_WINDOW_MS) continue
    const a = f.auto
    // A test offer stuck on "wrong Xero organisation" waits for the owner (Re-check in Xero); a real one is re-checked every pass,
    // so switching the dashboard back to live lets it go ahead by itself.
    if (f.test && a?.state === 'blocked' && a.reason?.startsWith(ORG_MISMATCH)) continue
    if (f.draft.state === 'done' && (!a || a.state === 'blocked')) {
      await scheduleAuto(o.id, d)
      if ((await load(d.store, o.id))?.fulfilment?.auto?.state === 'scheduled') out.scheduled++
      continue
    }
    if (a?.state === 'scheduled' && Date.parse(a.dueAt) <= nowOf(d).getTime()) {
      out.ran++
      await runAuto(o.id, d)
      continue
    }
    if (a?.state === 'running' && nowOf(d).getTime() - Date.parse(a.at ?? a.dueAt) > STALE_RUNNING_MS) {
      const why = 'It ended unclear (the server stopped part way). Check the invoice in Xero and the Sent folder of info@fonenova.com before pressing anything.'
      await mutate(d.store, o.id, (cur) => (cur.fulfilment?.auto?.state === 'running' ? { ...cur, fulfilment: { ...cur.fulfilment, auto: { ...cur.fulfilment.auto, state: 'failed', reason: why } }, audit: log(cur, nowOf(d).toISOString(), `Automatic invoice failed: ${why}`) } : null))
      await d.notify(`${f.test ? '[TEST] ' : ''}${f.orderRef}: the automatic invoice ended unclear.\n${why}`, link(d, o))
    }
  }
  return out
}
