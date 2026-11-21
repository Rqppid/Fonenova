/**
 * What the Payments page's top shows, worked out from the payments service's own data (pure).
 *
 * The service's `remaining_cents` stays the truth for what is owed: nothing here recalculates a balance.
 * The only sums made here are the payments listed in a calendar month (UK time), and a credit note is not cash
 * so it is never counted as money received or paid.
 */
import { exceptionActionsSide, isWaitingPayment } from './payments-side'
import type { ExceptionItem, Invoice, Payment, PaymentsState } from './payments-types'

export interface FeedRow {
  key: string
  date: string | null
  direction: 'in' | 'out'
  party: string
  amountCents: number
  feeCents: number
  method: string | null
  source: string
  remark: string | null
  /** The invoice it was applied to; null for a bank line that is not matched yet. */
  invoice: Invoice | null
  matched: boolean
  creditNote: boolean
}

const isCreditNote = (p: Payment) => /credit/i.test(p.method ?? '')

/** Every payment in and out, newest first, plus the open bank lines the service could not match. */
export function paymentFeed(s: Pick<PaymentsState, 'customer_invoices' | 'supplier_invoices' | 'exceptions'>): FeedRow[] {
  const rows: FeedRow[] = []
  const add = (invoices: readonly Invoice[], direction: 'in' | 'out') => {
    for (const inv of invoices) {
      inv.payments.forEach((p, n) => rows.push({ key: `${inv.number}-${p.bank_event_id ?? 'x'}-${n}`, date: p.date, direction, party: inv.party, amountCents: p.amount_cents, feeCents: p.fee_cents, method: p.method, source: p.source, remark: p.remark, invoice: inv, matched: true, creditNote: isCreditNote(p) }))
    }
  }
  add(s.customer_invoices, 'in')
  add(s.supplier_invoices, 'out')
  for (const e of s.exceptions as readonly ExceptionItem[]) {
    // Only a payment still waiting for an invoice: an overpayment or reversal is already counted, or is not a payment to show.
    if (!e.bank_event || !isWaitingPayment(e.code)) continue
    rows.push({ key: `ex-${e.id}`, date: e.bank_event.date, direction: exceptionActionsSide(e.code) === 'supplier' ? 'out' : 'in', party: 'Not matched yet', amountCents: e.bank_event.amount_cents, feeCents: 0, method: null, source: 'unmatched', remark: e.bank_event.description || e.bank_event.reference || null, invoice: null, matched: false, creditNote: false })
  }
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (a.matched === b.matched ? 0 : a.matched ? 1 : -1))
}

/** "2026-11" for the calendar month a moment falls in, in UK time. */
export const ukMonthKey = (d: Date): string => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' }).formatToParts(d)
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`
}

export interface MonthTotals { monthKey: string; receivedCents: number; paidOutCents: number; receivedCount: number; paidOutCount: number }

/** Matched payments dated in the month of `now`. Credit notes and unmatched bank lines are not counted. */
export function monthTotals(rows: readonly FeedRow[], now: Date): MonthTotals {
  const key = ukMonthKey(now)
  const t: MonthTotals = { monthKey: key, receivedCents: 0, paidOutCents: 0, receivedCount: 0, paidOutCount: 0 }
  for (const r of rows) {
    if (!r.matched || r.creditNote || !r.date || r.date.slice(0, 7) !== key) continue
    if (r.direction === 'in') { t.receivedCents += r.amountCents; t.receivedCount++ } else { t.paidOutCents += r.amountCents; t.paidOutCount++ }
  }
  return t
}

/** The date of the newest payment the page has, YYYY-MM-DD, or null. */
export const newestPaymentDate = (rows: readonly FeedRow[]): string | null => rows.reduce<string | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null)

export type Staleness = 'fresh' | 'late' | 'old'

/** fresh: the service ran in the last 30 minutes. late: up to 6 hours, or last_error. old: over 6 hours, never, or the service says it is failing. */
export function staleness(h: PaymentsState['health']): Staleness {
  if (!h.ok || h.minutes_ago === null || h.minutes_ago > 360) return 'old'
  return h.minutes_ago > 30 || h.last_error ? 'late' : 'fresh'
}

export function agoWords(minutes: number | null): string {
  if (minutes === null) return 'never'
  if (minutes < 1) return 'just now'
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)} hours ago`
  return `${Math.round(minutes / 60 / 24)} days ago`
}
