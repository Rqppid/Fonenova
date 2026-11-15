/**
 * The orders as the dashboard shows them, worked out the same way everywhere (the page, the
 * AI bar): ledger orders with Xero's live statuses, plus orders from confirmed
 * Xero pairs, plus the live Xero checks. Pure, so all three can never disagree.
 */
import { applyLiveStatus, type LiveSummary } from './metrics'
import type { IsoDate, Ledger, XeroPair, XeroSnapshot } from './types'
import { xeroChecks, type XeroChecks } from './xero/checks'
import { matchOrders } from './xero/map'
import { withXero, type Matching } from './xero/pairing'

export interface LiveView {
  /** The untouched ledger: reconcile against this. */
  raw: Ledger
  /** Ledger plus Xero: every page uses this. */
  ledger: Ledger
  matching: Matching | null
  checks: XeroChecks
  summary: LiveSummary | null
}

export function liveView(raw: Ledger, snapshot: XeroSnapshot | null, pairs: readonly XeroPair[], today: IsoDate): LiveView {
  const live = snapshot ? applyLiveStatus(raw.orders, matchOrders(raw.orders, snapshot.invoices)) : null
  const merged = withXero(live ? { ...raw, orders: live.orders } : raw, snapshot, pairs, today)
  return {
    raw,
    ledger: merged.ledger,
    matching: merged.matching,
    checks: xeroChecks({ ledger: raw, orders: merged.ledger.orders, snapshot, today }),
    summary: live?.summary ?? null,
  }
}
