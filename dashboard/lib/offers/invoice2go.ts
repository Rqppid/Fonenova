/**
 * The hand-kept notes on an accepted order while Invoice2go makes the invoices: goods arrived, our DHL cost, and which
 * invoice it became. Nothing here creates, changes or sends an invoice, in Xero or anywhere else.
 */
import { getJson } from '../store'
import { clientsFrom, type Client } from './clients'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import { isInvoice2goNumber, suggestInvoices, invoiceAmount, acceptedItemsCents, eur } from './order-note'
import type { XeroInvoice } from '../types'
import type { Offer } from './types'

export interface NoteResult { ok: boolean; message: string }
const MAX_DHL_CENTS = 10_000_000

export async function updateOrderNotes(offerId: string, d: FulfilDeps, input: { goodsArrived?: boolean; dhlCostCents?: number | null }): Promise<NoteResult> {
  const at = (d.now ?? new Date()).toISOString()
  if (input.dhlCostCents !== undefined && input.dhlCostCents !== null && (!Number.isSafeInteger(input.dhlCostCents) || input.dhlCostCents < 1 || input.dhlCostCents > MAX_DHL_CENTS)) return { ok: false, message: 'The DHL cost must be between €0.01 and €100,000.00.' }
  const saved = await mutate(d.store, offerId, (o) => {
    const f = o.fulfilment
    if (!f || o.status !== 'accepted') return null
    const cur = f.order ?? {}
    const next = { ...cur }
    const what: string[] = []
    if (input.goodsArrived !== undefined) {
      if (input.goodsArrived) { if (!cur.goodsArrivedAt) { next.goodsArrivedAt = at; what.push('goods arrived in Belfast') } } else if (cur.goodsArrivedAt) { delete next.goodsArrivedAt; what.push('goods arrival cleared') }
    }
    if (input.dhlCostCents !== undefined) {
      if (input.dhlCostCents === null) { if (cur.dhlCostCents !== undefined) { delete next.dhlCostCents; what.push('DHL cost cleared') } } else if (cur.dhlCostCents !== input.dhlCostCents) { next.dhlCostCents = input.dhlCostCents; what.push(`DHL cost ${eur(input.dhlCostCents)}`) }
    }
    if (what.length === 0) return null
    return { ...o, updatedAt: at, fulfilment: { ...f, order: next }, audit: log(o, at, `Order notes: ${what.join(', ')} (a note only; no invoice is made here)`) }
  })
  return saved ? { ok: true, message: 'Saved.' } : { ok: false, message: 'Nothing changed, or this offer is not an accepted order.' }
}

/** Attach an Invoice2go number (and optionally the synced Xero invoice it became). Server-side checks; creates nothing. */
export async function linkInvoice2go(offerId: string, d: FulfilDeps, input: { number: string; xeroInvoiceId: string | null }, invoices: readonly XeroInvoice[]): Promise<NoteResult> {
  const number = input.number.trim()
  if (!isInvoice2goNumber(number)) return { ok: false, message: 'An Invoice2go number is seven digits, like 2026049.' }
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const offer = offers.find((o) => o.id === offerId)
  const f = offer?.fulfilment
  if (!offer || !f || offer.status !== 'accepted') return { ok: false, message: 'This offer has not been accepted.' }
  const other = offers.find((o) => o.id !== offerId && o.fulfilment?.order?.invoice2go?.number === number)
  if (other) return { ok: false, message: `Invoice ${number} is already linked to another order (${other.fulfilment!.orderRef}).` }
  let xeroInvoiceId: string | undefined
  if (input.xeroInvoiceId) {
    const clients = clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))
    const client = clients.find((c) => c.id === offer.pricing?.clientId)
    const items = acceptedItemsCents(offer)
    const dhl = f.order?.dhlCostCents ?? null
    const expected = client && items !== null && dhl !== null ? invoiceAmount(items, client, dhl).totalCents : null
    const taken = offers.flatMap((o) => (o.id !== offerId && o.fulfilment?.order?.invoice2go ? [o.fulfilment.order.invoice2go.number] : []))
    const hit = client ? suggestInvoices(offer, client, expected, invoices, taken).find((m) => m.id === input.xeroInvoiceId) : undefined
    if (!hit) return { ok: false, message: 'That Xero invoice is not a match for this order any more.' }
    if (hit.number !== number) return { ok: false, message: `That Xero invoice is ${hit.number}, not ${number}. Check the number.` }
    xeroInvoiceId = hit.id
  }
  const at = (d.now ?? new Date()).toISOString()
  const saved = await mutate(d.store, offerId, (o) => (o.fulfilment && o.status === 'accepted' ? { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, order: { ...(o.fulfilment.order ?? {}), invoice2go: { number, ...(xeroInvoiceId ? { xeroInvoiceId } : {}), linkedAt: at } } }, audit: log(o, at, `Linked to Invoice2go invoice ${number}${xeroInvoiceId ? ' (matched to its Xero invoice)' : ''}. Nothing was created.`) } : null))
  return saved ? { ok: true, message: `Linked to invoice ${number}.` } : { ok: false, message: 'Could not save. Refresh and try again.' }
}

export { load }
