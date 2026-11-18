/**
 * Mobile One's invoice, checked against the offer before its shipping is trusted. Pure.
 *
 * The shipping on their invoice is only used when everything else on it agrees with what we accepted: it is
 * Mobile One's, every item line matches an offer line (quantity and unit price), there are no other
 * products, and the total is items plus shipping. Anything else and a person types it.
 */
import type { Offer } from './types'

export interface InvoiceReading {
  supplier: string
  invoiceNumber: string | null
  /** Product lines only. */
  items: { description: string; quantity: number; amountCents: number }[]
  shippingCents: number | null
  totalCents: number | null
}

export type InvoiceCheck = { ok: true; shippingCents: number } | { ok: false; why: string }
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const MAX_AUTO_SHIPPING_CENTS = 1_000_000

export function checkInvoice(o: Pick<Offer, 'lines'>, inv: InvoiceReading): InvoiceCheck {
  if (!/mobile\s*one/i.test(inv.supplier)) return { ok: false, why: `The invoice is not from Mobile One (${inv.supplier || 'unknown'}).` }
  if (inv.shippingCents === null || !Number.isSafeInteger(inv.shippingCents) || inv.shippingCents < 1) return { ok: false, why: 'No shipping charge found on the invoice.' }
  if (inv.shippingCents > MAX_AUTO_SHIPPING_CENTS) return { ok: false, why: `The shipping on the invoice (${eur(inv.shippingCents)}) is above the automatic limit of ${eur(MAX_AUTO_SHIPPING_CENTS)}.` }
  if (inv.items.length !== o.lines.length) return { ok: false, why: `The invoice has ${inv.items.length} product lines but the offer had ${o.lines.length}.` }
  const left = [...inv.items]
  for (const l of o.lines) {
    const want = l.qty * l.unitCostCents
    const i = left.findIndex((x) => x.quantity === l.qty && Math.abs(x.amountCents - want) <= 100)
    if (i < 0) return { ok: false, why: `No invoice line matches ${l.model} ${l.storage ?? ''} x ${l.qty} at ${eur(l.unitCostCents)} each.`.replace(/\s+/g, ' ') }
    left.splice(i, 1)
  }
  const items = inv.items.reduce((n, x) => n + x.amountCents, 0)
  if (inv.totalCents === null || Math.abs(inv.totalCents - (items + inv.shippingCents)) > 100) return { ok: false, why: `The invoice total (${inv.totalCents === null ? 'not found' : eur(inv.totalCents)}) is not the items plus the shipping (${eur(items + inv.shippingCents)}).` }
  return { ok: true, shippingCents: inv.shippingCents }
}
