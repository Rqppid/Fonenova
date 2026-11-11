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

/** The service's tracker key, e.g. "wave", "tw", "m1", "giglobal". New customers bring new keys. */
export type Tracker = string

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
  /** The trackers the service keeps, when it lists them. Otherwise taken from the invoices. */
  trackers?: { key: string; label?: string; name?: string }[]
  /** Customer overpayments held, not applied. */
  held_surplus: { party: string; amount_cents: Cents; bank_event_id: string }[]
}

/** What a call to the service came to, in plain words for the page. Never carries the token or URL. */
export type PaymentsResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'not-configured' }
  | { kind: 'error'; message: string }
  | { kind: 'refused'; status: number; error: string }

/** Names for the first trackers, used only when the feed sends no label. */
export const KNOWN_TRACKERS: Record<string, string> = { wave: 'Wave Phone', tw: 'TradeWise', m1: 'Mobile One' }

/**
 * Every tracker to offer for download: the feed's own list when it sends one, otherwise every
 * tracker key found on an invoice. Never a fixed three, so a new customer appears by itself.
 */
export function trackerList(s: Pick<PaymentsState, 'trackers' | 'customer_invoices' | 'supplier_invoices'>): { key: string; label: string }[] {
  const byKey = new Map<string, string>()
  const partyOf = new Map<string, string>()
  for (const i of [...s.customer_invoices, ...s.supplier_invoices]) if (i.tracker && !partyOf.has(i.tracker)) partyOf.set(i.tracker, i.party)
  const keys = s.trackers?.length ? s.trackers.map((t) => t.key) : [...partyOf.keys()]
  for (const key of keys) {
    if (!key || byKey.has(key)) continue
    const fromFeed = s.trackers?.find((t) => t.key === key)
    byKey.set(key, fromFeed?.label || fromFeed?.name || KNOWN_TRACKERS[key] || partyOf.get(key) || key)
  }
  return [...byKey.entries()].map(([key, label]) => ({ key, label }))
}
