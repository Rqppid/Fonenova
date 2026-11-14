/**
 * Order references and invoice numbers for offers that were accepted. Pure, so the rules are
 * unit-tested: no gaps, no reuse, and test offers never use up a real number.
 */
import { nextOrderId } from '../xero/pairing'

const INVOICE_NO = /^\d{7}$/
/** A demo organisation starts here, so a fresh Demo Company can be used for the first test. */
export const DEMO_FIRST_INVOICE = 2026001

export type NumberResult = { ok: true; number: string } | { ok: false; error: string }

/**
 * The next invoice number: one more than the highest 7-digit sales number in Xero (any status, so
 * drafts, voided and deleted numbers are never reused) or the highest this dashboard ever raised,
 * whichever is higher. A live organisation with no numbers at all is refused: a wrong first
 * number would be an invoice-numbering gap nobody can undo.
 */
export function nextInvoiceNumber(existing: readonly string[], highWater: number | null, demo: boolean): NumberResult {
  const nums = existing.map((n) => n.trim()).filter((n) => INVOICE_NO.test(n)).map(Number)
  const top = Math.max(0, ...nums, highWater ?? 0)
  if (top === 0) {
    return demo ? { ok: true, number: String(DEMO_FIRST_INVOICE) } : { ok: false, error: 'No existing 7-digit invoice number was found in Xero, so the next one cannot be worked out safely. Nothing was created.' }
  }
  return { ok: true, number: String(top + 1) }
}

/**
 * The order reference for an accepted offer. Real offers take the next FN-ORD number after every
 * order already known (ledger orders, pairs) and every one reserved on an offer. Test offers use
 * TEST-###, so they can never use up a real order number.
 */
export function nextOrderRef(knownOrderIds: readonly string[], reserved: readonly string[], test: boolean): string {
  if (!test) return nextOrderId([...knownOrderIds, ...reserved])
  const max = reserved.reduce((n, id) => Math.max(n, Number(/^TEST-(\d+)$/.exec(id)?.[1] ?? 0)), 0)
  return `TEST-${String(max + 1).padStart(3, '0')}`
}
