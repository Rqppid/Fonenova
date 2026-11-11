/**
 * Turn Xero API JSON into dashboard types, and pair Xero invoices with ledger orders.
 * Pure functions: no network, no files, so they are tested with sample Xero responses.
 */
import { toCents } from '../money'
import type { IsoDate, LiveOrderStatus, Order, XeroBankBalance, XeroCreditNote, XeroInvoice, XeroLine } from '../types'

/** Xero sends "/Date(1715558400000+0000)/" or "2026-05-13T00:00:00". */
export function parseXeroDate(v: unknown): IsoDate | null {
  if (typeof v !== 'string' || !v) return null
  const ms = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v)
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10)
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  return iso ? iso[1] : null
}

type Json = Record<string, unknown>

/** Xero's exchange rate, kept only when it sent a usable one (1 for base-currency documents). */
function withRate(v: unknown): { currencyRate?: number } {
  const n = Number(v)
  return v !== undefined && v !== null && Number.isFinite(n) && n > 0 ? { currencyRate: n } : {}
}

export function mapInvoice(j: Json): XeroInvoice | null {
  const type = j.Type
  if (type !== 'ACCREC' && type !== 'ACCPAY') return null
  const payments = Array.isArray(j.Payments) ? (j.Payments as Json[]) : []
  return {
    id: String(j.InvoiceID ?? ''),
    number: String(j.InvoiceNumber ?? ''),
    reference: String(j.Reference ?? ''),
    kind: type === 'ACCREC' ? 'sale' : 'bill',
    status: String(j.Status ?? ''),
    contactName: String((j.Contact as Json | undefined)?.Name ?? ''),
    currency: String(j.CurrencyCode ?? ''),
    date: parseXeroDate(j.DateString ?? j.Date),
    dueDate: parseXeroDate(j.DueDateString ?? j.DueDate),
    totalCents: toCents(j.Total),
    amountDueCents: toCents(j.AmountDue),
    amountPaidCents: toCents(j.AmountPaid),
    payments: payments.map((p) => ({ id: String(p.PaymentID ?? ''), date: parseXeroDate(p.Date), amountCents: toCents(p.Amount), ...withRate(p.CurrencyRate) })),
    ...withRate(j.CurrencyRate),
    ...(Array.isArray(j.LineItems) ? { lines: (j.LineItems as Json[]).map(mapLine) } : {}),
  }
}

function mapLine(l: Json): XeroLine {
  return {
    description: String(l.Description ?? '').trim(),
    quantity: Number(l.Quantity ?? 0) || 0,
    unitCents: toCents(l.UnitAmount ?? 0),
    amountCents: toCents(l.LineAmount ?? 0),
  }
}

/** ACCRECCREDIT is a credit you issued to a customer; ACCPAYCREDIT one a supplier issued to you. */
export function mapCreditNote(j: Json): XeroCreditNote | null {
  const type = j.Type
  if (type !== 'ACCRECCREDIT' && type !== 'ACCPAYCREDIT') return null
  const allocations = Array.isArray(j.Allocations) ? (j.Allocations as Json[]) : []
  return {
    id: String(j.CreditNoteID ?? ''),
    number: String(j.CreditNoteNumber ?? ''),
    reference: String(j.Reference ?? ''),
    kind: type === 'ACCRECCREDIT' ? 'sale' : 'bill',
    status: String(j.Status ?? ''),
    contactName: String((j.Contact as Json | undefined)?.Name ?? ''),
    currency: String(j.CurrencyCode ?? ''),
    date: parseXeroDate(j.DateString ?? j.Date),
    totalCents: toCents(j.Total),
    allocatedTo: allocations.map((a) => String((a.Invoice as Json | undefined)?.InvoiceNumber ?? '')).filter(Boolean),
    allocations: allocations
      .map((a) => ({ invoiceNumber: String((a.Invoice as Json | undefined)?.InvoiceNumber ?? ''), amountCents: toCents(a.Amount ?? 0) }))
      .filter((a) => a.invoiceNumber),
    ...(j.RemainingCredit !== undefined ? { remainingCents: toCents(j.RemainingCredit) } : {}),
  }
}

/**
 * Xero's Bank Summary report: one row per bank account, "Closing Balance" column in the
 * organisation's base currency. Returns null if the layout is not what we expect.
 */
export function mapBankSummary(report: Json): XeroBankBalance[] | null {
  const rows = (report.Rows as Json[] | undefined) ?? []
  const header = rows.find((r) => r.RowType === 'Header') as Json | undefined
  const titles = ((header?.Cells as Json[] | undefined) ?? []).map((c) => String(c.Value ?? ''))
  const col = titles.findIndex((t) => /closing balance/i.test(t))
  if (col < 0) return null
  const out: XeroBankBalance[] = []
  for (const section of rows.filter((r) => r.RowType === 'Section')) {
    for (const row of (section.Rows as Json[] | undefined) ?? []) {
      if (row.RowType !== 'Row') continue
      const cells = (row.Cells as Json[] | undefined) ?? []
      const name = String(cells[0]?.Value ?? '')
      if (!name || /^total/i.test(name)) continue
      out.push({ accountName: name, closingCents: toCents(cells[col]?.Value ?? 0) })
    }
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Pair each ledger order with its Xero sales invoice and bill. A sales invoice matches on the
 * invoice number (or that number with "-R", for one re-created in Xero); a bill on the supplier's
 * invoice number (as Xero number or reference). Either also matches if its Reference is the
 * Order ID. Voided and deleted documents never match.
 */
export function matchOrders(orders: readonly Order[], invoices: readonly XeroInvoice[]): Map<string, LiveOrderStatus> {
  const live = invoices.filter((i) => i.status !== 'VOIDED' && i.status !== 'DELETED')
  const sales = live.filter((i) => i.kind === 'sale')
  const bills = live.filter((i) => i.kind === 'bill')
  const out = new Map<string, LiveOrderStatus>()
  for (const o of orders) {
    const id = norm(o.id)
    const c = norm(o.clientInvoiceNo)
    const s = norm(o.supplierInvoiceNo)
    // Xero won't reuse a voided number, so an invoice re-created there gets "-R" (2026/02/0001-R
    // is the ledger's 2026/02/0001). An exact number still wins.
    const client = sales.find((i) => (c && norm(i.number) === c) || norm(i.reference) === id) ?? (c ? sales.find((i) => /-r$/i.test(i.number.trim()) && norm(i.number.trim().slice(0, -2)) === c) : undefined) ?? null
    const bill = bills.find((i) => (s && (norm(i.number) === s || norm(i.reference) === s)) || norm(i.reference) === id) ?? null
    out.set(o.id, { client, bill })
  }
  return out
}
