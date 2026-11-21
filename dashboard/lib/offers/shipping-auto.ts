/**
 * Fills in the shipping of an order that is waiting for it, from Mobile One's own invoice, when it is safe to.
 *
 * Only for a real order whose client is charged on Mobile One's shipping (Wave). EU Telecoms is charged our own DHL
 * cost, which no Mobile One invoice states, so it stays typed. The invoice PDF is looked for in the offer's own
 * Mobile One email thread, read once, checked against the offer (checkInvoice), and only then used, through the same
 * `setOrderShipping` the owner's typing uses. A PDF that is read but does not check out is remembered with the reason
 * (shown on the offer, one Telegram message) and left for the owner to type.
 */
import { getJson } from '../store'
import { clientsFrom, shippingBasisOf, type Client } from './clients'
import { load, log, mutate } from './fulfil'
import type { InvoiceDeps } from './invoice-flow'
import { setOrderShipping } from './shipping'
import { invoicingOn } from './invoicing-mode'
import { checkInvoice, type InvoiceReading } from './shipping-check'
import { candidatesIn } from './imei'
import type { Offer } from './types'

export type InvoiceReader = (bytes: Uint8Array) => Promise<InvoiceReading | null>
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const isPdf = (name: string, mime: string) => /\.pdf$/i.test(name) || /pdf/i.test(mime)
const MAX_READS_PER_RUN = 3
const MAX_PDF_BYTES = 8 * 1024 * 1024

/** One order. Returns what happened, for the log and the tests. */
export async function autoShippingFor(offerId: string, d: InvoiceDeps, read: InvoiceReader): Promise<'filled' | 'nothing' | 'unclear' | 'skipped'> {
  if (!invoicingOn(d)) return 'skipped'
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || !f || offer.status !== 'accepted' || f.test || offer.pricing?.shippingLater !== true || f.draft.state !== 'waiting' || f.shipping) return 'skipped'
  const client = (clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))).find((c) => c.id === offer.pricing?.clientId)
  if (!client || shippingBasisOf(client) !== 'mobile_one') return 'skipped'
  const threadId = offer.source.threadId
  if (!d.gmailThread || !threadId || /^test-/.test(threadId)) return 'skipped'
  let messages
  try { messages = await d.gmailThread.messages(threadId) } catch { return 'skipped' }
  const tried = new Set(f.shippingAuto?.tried ?? [])
  const files = candidatesIn(messages.filter((m) => /mobileone/i.test(m.from))).filter((c) => isPdf(c.filename, c.mime) && c.size <= MAX_PDF_BYTES && !tried.has(`${c.messageId}:${c.partId}`)).slice(0, MAX_READS_PER_RUN)
  if (files.length === 0) return 'nothing'
  let note: string | undefined
  for (const c of files) {
    const key = `${c.messageId}:${c.partId}`
    let reading: InvoiceReading | null = null
    try {
      const fresh = (await d.gmailThread.messages(threadId)).flatMap((m) => m.files).find((x) => x.messageId === c.messageId && x.partId === c.partId)
      if (!fresh) continue
      reading = await read(await d.gmailThread.file(c.messageId, fresh.attachmentId))
    } catch { continue } // could not read it this time: try again next pass, do not mark it as tried
    const at = (d.now ?? new Date()).toISOString()
    if (!reading) { await mark(d, offerId, key, undefined); continue } // not an invoice (a label, a sheet)
    const check = checkInvoice(offer, reading)
    if (!check.ok) { note = `${c.filename}: ${check.why}`; await mark(d, offerId, key, note); continue }
    const r = await setOrderShipping(offerId, d, { cents: check.shippingCents, none: false, source: 'invoice' })
    if (r.ok) {
      await mutate(d.store, offerId, (o) => ({ ...o, audit: log(o, at, `Shipping read from Mobile One's invoice ${reading!.invoiceNumber ?? c.filename}: ${eur(check.shippingCents)}`) }))
      await d.notify(`${f.orderRef}: shipping ${eur(check.shippingCents)} read from Mobile One's invoice (charged x${client.shippingMultiplier ?? 2}). The draft invoice is being made.`, d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(offer.id)}` } : undefined)
      return 'filled'
    }
    return 'skipped' // someone entered it first
  }
  if (note) {
    await d.notify(`${f.orderRef}: Mobile One's invoice did not match the offer, so the shipping was not taken from it. ${note} Enter the shipping by hand.`, d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(offer.id)}` } : undefined)
    return 'unclear'
  }
  return 'nothing'
}

async function mark(d: InvoiceDeps, id: string, key: string, note: string | undefined) {
  await mutate(d.store, id, (o: Offer) => (o.fulfilment ? { ...o, fulfilment: { ...o.fulfilment, shippingAuto: { tried: [...(o.fulfilment.shippingAuto?.tried ?? []), key].slice(-20), ...(note ? { note } : o.fulfilment.shippingAuto?.note ? { note: o.fulfilment.shippingAuto.note } : {}) } } } : null))
}

/** The 5-minute pass over orders still waiting. */
export async function sweepShipping(d: InvoiceDeps, read: InvoiceReader): Promise<{ looked: number; filled: number }> {
  const offers = (await getJson<Offer[]>(d.store, 'offers')) ?? []
  const out = { looked: 0, filled: 0 }
  for (const o of offers) {
    if (o.status !== 'accepted' || o.fulfilment?.draft.state !== 'waiting' || o.fulfilment.test) continue
    out.looked++
    if ((await autoShippingFor(o.id, d, read).catch(() => 'skipped')) === 'filled') out.filled++
  }
  return out
}
