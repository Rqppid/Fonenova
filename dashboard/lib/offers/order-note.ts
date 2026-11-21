/**
 * The order card while Invoice2go makes the invoices (pure, used by the screen and the server).
 *
 * Nothing here creates an invoice. It works out the figure to type into Invoice2go (items plus the shipping charged),
 * checks an Invoice2go number, and suggests which synced Xero invoice an accepted offer became.
 */
import type { XeroInvoice } from '../types'
import { chargeFor, type Client } from './clients'
import type { Offer } from './types'

export const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const acceptedItemsCents = (o: Pick<Offer, 'sends'>): number | null => (o.sends ?? []).find((s) => s.outcome === 'accepted')?.totalCents ?? null

export interface InvoiceAmount { itemsCents: number; typedCents: number; shippingCents: number; totalCents: number; working: string }

/** The amount for Invoice2go: the accepted items plus the shipping charged, from the client's own shipping setting. */
export function invoiceAmount(itemsCents: number, client: Pick<Client, 'shippingBasis' | 'shippingMultiplier'>, typedShippingCents: number | null): InvoiceAmount {
  const typed = typedShippingCents ?? 0
  const shipping = typedShippingCents === null ? 0 : chargeFor(client, typed)
  const mult = client.shippingBasis === 'own_dhl' ? null : (client.shippingMultiplier ?? 2)
  const working = typedShippingCents === null
    ? `Items ${eur(itemsCents)}. Enter the DHL cost to see the total.`
    : `Items ${eur(itemsCents)} + shipping ${eur(shipping)}${mult !== null && mult !== 1 ? ` (${eur(typed)} x ${mult})` : ' (our own DHL cost, no mark-up)'} = ${eur(itemsCents + shipping)}`
  return { itemsCents, typedCents: typed, shippingCents: shipping, totalCents: itemsCents + shipping, working }
}

/** Invoice2go numbers look like 2026049: seven digits. */
export const isInvoice2goNumber = (n: string) => /^\d{7}$/.test(n.trim())

export interface InvoiceMatch { id: string; number: string; contactName: string; status: string; totalCents: number; date: string | null; exact: boolean }

const norm = (s: string) => s.toLowerCase().replace(/\b(b\.?v\.?|ltd|limited|eood|gmbh|llc|inc)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Synced Xero sales invoices that could be this order's: the client's contact, not voided or deleted, not linked to another
 * order. With a DHL cost entered, a match must equal items + shipping to the cent; without one, any invoice at or above the
 * items total is offered, marked as not exact. At most three, exact first. Pure.
 */
export function suggestInvoices(o: Pick<Offer, 'sends'>, client: Pick<Client, 'name' | 'shippingBasis' | 'shippingMultiplier'>, expectedTotalCents: number | null, invoices: readonly XeroInvoice[], takenNumbers: readonly string[] = []): InvoiceMatch[] {
  const items = acceptedItemsCents(o)
  if (items === null) return []
  const want = norm(client.name)
  return invoices
    .filter((i) => i.kind === 'sale' && i.currency === 'EUR' && !['VOIDED', 'DELETED'].includes(i.status) && !takenNumbers.includes(i.number))
    .filter((i) => { const n = norm(i.contactName); return !!n && !!want && (n === want || n.includes(want) || want.includes(n)) })
    .map((i) => ({ id: i.id, number: i.number, contactName: i.contactName, status: i.status, totalCents: i.totalCents, date: i.date, exact: expectedTotalCents !== null && Math.abs(i.totalCents - expectedTotalCents) <= 1 }))
    .filter((m) => (expectedTotalCents !== null ? m.exact : m.totalCents >= items))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, 3)
}
