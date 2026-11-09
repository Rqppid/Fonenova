/**
 * The fonenova-payments service's read-only JSON, as it sends it. Money is integer euro cents,
 * EUR only. Shared by the server (lib/payments-source.ts) and the Payments page; types only.
 */

export type Cents = number

export interface Payment {
  /** YYYY-MM-DD, the Revolut statement date. */
  date: string | null
  /** The principal. The bank fee is separate. */
  amount_cents: Cents
  fee_cents: Cents
  /** "Bank Transfer", "Credit Note", … */
  method: string | null
  source: 'historic' | 'auto' | 'approved'
  remark: string | null
  /** Revolut transaction id; null for credit notes and old untraceable rows. */
  bank_event_id: string | null
}

export type Tracker = 'wave' | 'tw' | 'm1'

export interface Invoice {
  /** Always a string, e.g. "2026/02/0001". */
  number: string
  party: string
  tracker: Tracker
  date: string | null
  total_cents: Cents
  paid_cents: Cents
  /** Supplier credit notes applied. */
  credits_cents: Cents
  /** total − paid − credits; negative when overpaid or credited. The truth: never recomputed here. */
  remaining_cents: Cents
  state: 'not_paid' | 'partly_paid' | 'fully_paid' | 'cancelled'
  /** Each payment is its own entry. */
  payments: Payment[]
}

export interface Suggestion {
  invoice: string
  invoice_id: number
  remaining_cents: Cents
  why: string
  distance?: number
}

export interface ExceptionItem {
  id: number
  code: string
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  detail: string
  created_at: string
  /** Ranked, best first. Never applied automatically. */
  suggestions: Suggestion[]
  bank_event: { date: string | null; amount_cents: Cents; reference: string; description: string } | null
}

export interface PaymentsHealth {
  ok: boolean
  last_run: string | null
  minutes_ago: number | null
  last_error: string | null
}

export interface PaymentsState {
  generated_at: string
  currency: 'EUR'
  health: PaymentsHealth
  /** Trackers "wave" (Wave Phone) and "tw" (TradeWise). */
  customer_invoices: Invoice[]
  /** Tracker "m1" (Mobile One). */
  supplier_invoices: Invoice[]
  /** Open items only. */
  exceptions: ExceptionItem[]
  /** Customer overpayments held, not applied. */
  held_surplus: { party: string; amount_cents: Cents; bank_event_id: string }[]
}

/** What a call to the service came to, in plain words for the page. Never carries the token or URL. */
export type PaymentsResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not-configured' }
  | { kind: 'error'; message: string }
  | { kind: 'refused'; status: number; error: string }

export const TRACKERS: { key: Tracker; label: string }[] = [
  { key: 'wave', label: 'Wave Phone' },
  { key: 'tw', label: 'TradeWise' },
  { key: 'm1', label: 'Mobile One' },
]
