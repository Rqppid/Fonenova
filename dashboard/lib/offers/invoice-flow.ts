/**
 * After the draft exists: match the supplier's bill, approve, send, file the PDF.
 *
 * Every one of these needs an explicit click on the offer (a `confirm` the server checks) and
 * nothing here ever runs by itself. Gates, each its own step:
 * - approving in a LIVE organisation needs XERO_WRITE_ALLOW_LIVE and OFFERS_ALLOW_APPROVE;
 * - emailing the client needs OFFERS_ALLOW_REAL_SEND (and XERO_WRITE_ALLOW_LIVE) for a real client;
 * - a test invoice is only ever approved or sent in the Demo Company, and only to the owner's own address;
 * - the draft must still be what was accepted (same organisation, contact, currency and total).
 * Approving and sending are claimed before they happen (at most once); an unknown outcome is
 * never retried by itself.
 */
import { ukTime } from '../format-uk'
import { getJson } from '../store'
import type { XeroInvoice, XeroPair } from '../types'
import type { Client } from './clients'
import { clientsFrom } from './clients'
import { xeroDraftUrl } from './xero-url'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import { figuresOrWhy } from './resolve'
import { pdfPathFor, type FilingDirs } from './filing-paths'
import { fetchImeiAttachments, imeiLine } from './imei'
import type { ThreadMessage } from '../gmail'
import type { Fulfilment, InvoiceStep, Offer } from './types'

/** What the Gmail connection offers for IMEI files. Absent when Gmail is not connected. */
export interface GmailThreadApi {
  messages: (threadId: string) => Promise<ThreadMessage[]>
  file: (messageId: string, attachmentId: string) => Promise<Uint8Array>
  /** The RFC Message-ID of one of our own sent messages, to reply to it. */
  rfcId: (messageId: string) => Promise<string | null>
}

export interface InvoiceDeps extends FulfilDeps {
  /** OFFERS_ALLOW_APPROVE: approving in a live organisation. Its own switch. */
  allowApprove: boolean
  /** OFFERS_AUTO_INVOICE=off: nothing is approved or emailed automatically (the manual buttons still work). */
  autoOff?: boolean
  /** Sends one email from info@fonenova.com (the connected Gmail), with attachments. Null when Gmail is not set up. */
  mail?: (m: { to: string; subject: string; text: string; html: string; attachments: { filename: string; mime: string; bytes: Uint8Array }[]; threadId?: string; inReplyTo?: string }) => Promise<{ id: string; threadId?: string }>
  /** Reads Mobile One's threads for IMEI sheets and labels, and fetches them. Null when Gmail is not connected. */
  gmailThread?: GmailThreadApi
  /** Where the PDF goes, and how it gets there. */
  filing: { dirs: FilingDirs | null; upload: (path: string, bytes: Uint8Array) => Promise<{ kind: 'ok' | 'exists' | 'unavailable' | 'error'; message?: string }> }
  /** The synced bills and the confirmed pairs, for matching. */
  bills: () => Promise<{ bills: XeroInvoice[]; pairs: XeroPair[] }>
  savePair: (p: XeroPair) => Promise<void>
}

export type ActionResult = { ok: boolean; message: string }
const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const nowOf = (d: FulfilDeps) => d.now ?? new Date()
const link = (d: FulfilDeps, o: Offer) => (d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(o.id)}` } : undefined)
const clientOf = async (d: FulfilDeps, o: Offer): Promise<Client | undefined> => (clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))).find((c) => c.id === o.pricing?.clientId)

async function setStep(d: FulfilDeps, id: string, key: 'approve' | 'send' | 'filing', step: InvoiceStep, note: string): Promise<Offer | null> {
  return mutate(d.store, id, (o) => (o.fulfilment ? { ...o, updatedAt: nowOf(d).toISOString(), fulfilment: { ...o.fulfilment, [key]: step }, audit: log(o, nowOf(d).toISOString(), note) } : null))
}

/** Claim a step before doing it: only one caller gets `working`. Null if it is already done or being done. */
async function claim(d: FulfilDeps, id: string, key: 'approve' | 'send' | 'filing'): Promise<Offer | null> {
  const at = nowOf(d).toISOString()
  return mutate(d.store, id, (o) => {
    const f = o.fulfilment
    const cur = f?.[key]
    if (!f || cur?.state === 'done' || (cur?.state === 'working' && nowOf(d).getTime() - Date.parse(cur.at ?? at) < 10 * 60_000)) return null
    return { ...o, updatedAt: at, fulfilment: { ...f, [key]: { state: 'working', at } } }
  })
}

type Ready = { ok: true; offer: Offer; f: Fulfilment; client: Client; api: NonNullable<ReturnType<FulfilDeps['xero']>>; org: { name: string; isDemo: boolean } } | { ok: false; message: string }

/** What approving, sending and filing all need first: the draft, the client, and the organisation it was made in. */
async function ready(d: InvoiceDeps, offerId: string): Promise<Ready> {
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || offer.status !== 'accepted' || !f) return { ok: false, message: 'This offer has not been accepted.' }
  if (f.draft.state !== 'done' || !f.draft.invoiceId) return { ok: false, message: 'There is no draft invoice yet.' }
  const client = await clientOf(d, offer)
  if (!client) return { ok: false, message: 'The client this offer was priced for no longer exists.' }
  const api = d.xero()
  if (!api?.getInvoice) return { ok: false, message: 'The Xero write connection is not set up.' }
  try {
    const org = await api.organisation() // fixes this run to the selected tenant
    if (org.name !== f.draft.org) return { ok: false, message: `The selected Xero organisation (${org.name}) is not the one this draft was made in (${f.draft.org ?? 'unknown'}). Nothing was changed.` }
    return { ok: true, offer, f, client, api, org }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached.' }
  }
}

// ---------------------------------------------------------------------------
// Bill matching
// ---------------------------------------------------------------------------
export interface BillCandidate { id: string; number: string; supplier: string; date: string | null; totalCents: number; diffCents: number }

/** What the order cost: the items at Mobile One's prices plus Mobile One's shipping. */
export const expectedCostCents = (o: Pick<Offer, 'lines' | 'shipping'> & { fulfilment?: { shipping?: { mobileOneCents?: number } } }) => o.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0) + (o.fulfilment?.shipping?.mobileOneCents ?? o.shipping?.mobileOneCents ?? 0)

/** Mobile One bills that are not paired yet and come to about what the order cost (within 1%, at least €1). Pure. */
export function suggestBills(o: Pick<Offer, 'lines' | 'shipping'>, bills: readonly XeroInvoice[], pairs: readonly XeroPair[]): BillCandidate[] {
  const cost = expectedCostCents(o)
  const taken = new Set(pairs.map((p) => p.billId))
  const tol = Math.max(100, Math.round(cost * 0.01))
  return bills
    .filter((b) => b.kind === 'bill' && /mobile\s*one/i.test(b.contactName) && b.currency === 'EUR' && !['VOIDED', 'DELETED'].includes(b.status) && !taken.has(b.id) && Math.abs(b.totalCents - cost) <= tol)
    .map((b) => ({ id: b.id, number: b.number || b.reference, supplier: b.contactName, date: b.date, totalCents: b.totalCents, diffCents: b.totalCents - cost }))
    .sort((a, b) => Math.abs(a.diffCents) - Math.abs(b.diffCents))
    .slice(0, 3)
}

export async function confirmBill(offerId: string, billId: string, d: InvoiceDeps): Promise<ActionResult> {
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || !f || offer.status !== 'accepted') return { ok: false, message: 'This offer has not been accepted.' }
  if (!/^FN-ORD-\d{3,}$/.test(f.orderRef)) return { ok: false, message: 'Only a real order (FN-ORD-…) can be paired with a bill; a test order has none.' }
  if (f.draft.state !== 'done' || !f.draft.invoiceId) return { ok: false, message: 'There is no draft invoice to pair the bill with yet.' }
  if (f.bill) return { ok: false, message: `This order is already paired with bill ${f.bill.billNumber}.` }
  const { bills, pairs } = await d.bills()
  const bill = suggestBills(offer, bills, pairs).find((b) => b.id === billId)
  if (!bill) return { ok: false, message: 'That bill is not a suggestion for this order any more (it may be paired already, voided, or the amount differs).' }
  if (pairs.some((p) => p.orderId === f.orderRef)) return { ok: false, message: `${f.orderRef} is already paired.` }
  const at = nowOf(d).toISOString()
  await d.savePair({ orderId: f.orderRef, invoiceId: f.draft.invoiceId, billId: bill.id, confirmedAt: at })
  await mutate(d.store, offerId, (o) => (o.fulfilment ? { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, bill: { billId: bill.id, billNumber: bill.number, supplier: bill.supplier, totalCents: bill.totalCents, confirmedAt: at } }, audit: log(o, at, `Paired ${f.orderRef} with ${bill.supplier} bill ${bill.number} (${eur(bill.totalCents)})`) } : null))
  return { ok: true, message: `Paired with bill ${bill.number}.` }
}

// ---------------------------------------------------------------------------
// Re-check the draft
// ---------------------------------------------------------------------------
const ADDRESS_WARNING = /address/i

/**
 * Look at the draft in Xero again and refresh what the panel warns about. The warnings are worked out
 * when the draft is made; after fixing the contact in Xero (an address added) this clears a stale one,
 * or raises one that is new. Read-only: nothing in Xero is changed.
 */
export async function recheckDraft(offerId: string, d: InvoiceDeps): Promise<ActionResult> {
  const r = await ready(d, offerId)
  if (!r.ok) return r
  const { f, api } = r
  try {
    const inv = await api.getInvoice!(f.draft.invoiceId!)
    if (!inv) return { ok: false, message: 'The draft is not in Xero any more (deleted?).' }
    let warnings = (f.draft.warnings ?? []).filter((w) => !ADDRESS_WARNING.test(w))
    if (inv.hasAddress === false) warnings = ['Add an address in Xero before approving', ...warnings]
    else if (inv.hasAddress === null) warnings = ["Could not check the contact's address in Xero", ...warnings]
    const at = nowOf(d).toISOString()
    await mutate(d.store, offerId, (o) => (o.fulfilment ? { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, draft: { ...o.fulfilment.draft, warnings: warnings.length ? warnings : undefined } }, audit: log(o, at, `Re-checked invoice ${inv.number} in Xero: ${inv.status.toLowerCase()}, ${eur(inv.totalCents)}, address ${inv.hasAddress ? 'present' : inv.hasAddress === false ? 'MISSING' : 'unknown'}`) } : null))
    return { ok: true, message: `Re-checked: ${inv.status.toLowerCase()} in Xero, ${eur(inv.totalCents)}, ${inv.hasAddress ? 'the contact has an address' : inv.hasAddress === false ? 'the contact still has no address' : 'the address could not be checked'}.` }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached' }
  }
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------
export async function approveInvoice(offerId: string, d: InvoiceDeps, opts: { confirm: boolean }): Promise<ActionResult> {
  if (!opts.confirm) return { ok: false, message: 'Approving needs your confirmation: tick the box first.' }
  const r = await ready(d, offerId)
  if (!r.ok) return r
  const { offer, f, client, api, org } = r
  if (f.approve?.state === 'done') return { ok: true, message: 'Already approved.' }
  if (!org.isDemo) {
    if (f.test) return { ok: false, message: 'A test invoice is never approved in the live organisation. Delete the test draft in Xero.' }
    if (!d.allowLiveXero) return { ok: false, message: 'Live Xero is switched off (XERO_WRITE_ALLOW_LIVE). Nothing was changed.' }
    if (!d.allowApprove) return { ok: false, message: 'Approving in the live organisation is its own switch (OFFERS_ALLOW_APPROVE), and it is not on. Nothing was changed.' }
  } else if (!f.test) return { ok: false, message: 'A real order is not approved in a demo organisation.' }

  const { figures, why } = await figuresOrWhy(d.store, offer)
  if (!figures) return { ok: false, message: why ?? 'The accepted offer could not be priced again.' }
  const expectedContact = f.test && !org.isDemo ? client.liveTestContactId : client.xeroContactId

  const claimed = await claim(d, offerId, 'approve')
  if (!claimed) return { ok: false, message: 'It is already being approved, or is approved.' }
  const stop = async (message: string, state: 'blocked' | 'failed' = 'blocked'): Promise<ActionResult> => {
    await setStep(d, offerId, 'approve', { state, reason: message, at: nowOf(d).toISOString() }, `Approve ${state}: ${message}`)
    return { ok: false, message }
  }
  try {
    const inv = await api.getInvoice!(f.draft.invoiceId!)
    if (!inv) return stop('The draft is not in Xero any more (deleted?).')
    if (inv.status === 'AUTHORISED' || inv.status === 'PAID') {
      await setStep(d, offerId, 'approve', { state: 'done', at: nowOf(d).toISOString(), detail: 'It was already approved in Xero.' }, `Invoice ${inv.number} was already approved in Xero`)
      return { ok: true, message: 'It was already approved in Xero.' }
    }
    if (inv.status !== 'DRAFT') return stop(`The invoice is ${inv.status.toLowerCase()} in Xero, not a draft.`)
    if (inv.currency !== 'EUR') return stop(`The draft is in ${inv.currency}, not euros.`)
    if (inv.totalCents !== figures.grandCents) return stop(`The draft in Xero totals ${eur(inv.totalCents)} but the client accepted ${eur(figures.grandCents)}. Fix the draft in Xero (or recreate it) first.`)
    if (expectedContact && inv.contactId?.toLowerCase() !== expectedContact.toLowerCase()) return stop('The draft now belongs to a different contact than the client it was made for.')
    if (inv.hasAddress === false) return stop('Add an address in Xero before approving')
    if (inv.hasAddress === null) return stop("Could not check the contact's address in Xero. Try again.")
    await api.approveInvoice!(f.draft.invoiceId!)
    const after = await api.getInvoice!(f.draft.invoiceId!)
    if (after?.status !== 'AUTHORISED') return stop(`Xero did not show it as approved afterwards (${after?.status ?? 'not found'}). Check it in Xero before pressing again.`, 'failed')
    await setStep(d, offerId, 'approve', { state: 'done', at: nowOf(d).toISOString() }, `Approved invoice ${inv.number} in Xero${f.test ? ' (test, Demo Company)' : ''}`)
    // The address was just checked, so a stale "add an address" note from when the draft was made goes.
    await mutate(d.store, offerId, (o) => (o.fulfilment?.draft.warnings ? { ...o, fulfilment: { ...o.fulfilment, draft: { ...o.fulfilment.draft, warnings: o.fulfilment.draft.warnings.filter((w) => !ADDRESS_WARNING.test(w)).length ? o.fulfilment.draft.warnings.filter((w) => !ADDRESS_WARNING.test(w)) : undefined } } } : null))
    await d.notify(`${f.test ? '[TEST] ' : ''}Invoice ${inv.number} approved in Xero (${eur(inv.totalCents)}). Nothing has been sent yet.`, link(d, offer))
    return { ok: true, message: `Invoice ${inv.number} approved.` }
  } catch (e) {
    return stop(e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached', 'failed')
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
export type SendVia = 'gmail' | 'xero'

/**
 * Send the approved invoice to the client, one of two ways, each its own click:
 * - `gmail`: from info@fonenova.com through the connected Gmail, to the client's invoice emails, with the
 *   invoice PDF (fetched from Xero) attached. Independent of Xero's email service.
 * - `xero`: Xero emails it to the contact's own address (which must be one of the client's invoice emails).
 */
export async function sendInvoice(offerId: string, d: InvoiceDeps, opts: { confirm: boolean; via?: SendVia }): Promise<ActionResult> {
  const via: SendVia = opts.via ?? 'xero'
  if (!opts.confirm) return { ok: false, message: 'Sending needs your confirmation: tick the box first.' }
  const r = await ready(d, offerId)
  if (!r.ok) return r
  const { offer, f, client, api, org } = r
  if (f.approve?.state !== 'done') return { ok: false, message: 'Approve the invoice first.' }
  if (f.send?.state === 'done') return { ok: true, message: 'Already sent.' }
  if (via === 'xero' && !api.emailInvoice) return { ok: false, message: 'The Xero write connection cannot send email.' }
  if (via === 'gmail' && (!d.mail || !api.invoicePdf)) return { ok: false, message: 'Gmail is not connected, or the PDF cannot be fetched from Xero.' }
  if (!org.isDemo) {
    if (f.test) return { ok: false, message: 'A test invoice is never sent from the live organisation.' }
    if (!d.allowLiveXero) return { ok: false, message: 'Live Xero is switched off (XERO_WRITE_ALLOW_LIVE). Nothing was sent.' }
    if (!d.allowReal) return { ok: false, message: 'Sending to real clients is switched off (OFFERS_ALLOW_REAL_SEND). Nothing was sent.' }
  }

  const claimed = await claim(d, offerId, 'send')
  if (!claimed) return { ok: false, message: 'It is already being sent, or is sent.' }
  const stop = async (message: string, state: 'blocked' | 'failed' = 'blocked'): Promise<ActionResult> => {
    await setStep(d, offerId, 'send', { state, reason: message, at: nowOf(d).toISOString() }, `Send ${state}: ${message}`)
    return { ok: false, message }
  }
  try {
    const inv = await api.getInvoice!(f.draft.invoiceId!)
    if (!inv) return stop('The invoice is not in Xero any more.')
    if (inv.status !== 'AUTHORISED') return stop(`The invoice is ${inv.status.toLowerCase()} in Xero; only an approved one is sent.`)
    if (inv.sentToContact) {
      await setStep(d, offerId, 'send', { state: 'done', at: nowOf(d).toISOString(), detail: 'Xero shows it was already emailed.' }, `Invoice ${inv.number}: Xero shows it was already emailed`)
      return { ok: true, message: 'Xero shows it was already emailed.' }
    }
    const wanted = client.invoiceEmails.map((e) => e.trim().toLowerCase()).filter(Boolean)
    if (wanted.length === 0) return stop(`${client.name} has no invoice email address (Offers, Clients).`)
    if (inv.totalCents !== (await figuresOrWhy(d.store, offer)).figures?.grandCents) return stop(`The invoice in Xero totals ${eur(inv.totalCents)}, which is not what the client accepted. Nothing was sent.`)

    let where: string
    let sentRef: { messageId: string; threadId?: string } | undefined
    if (via === 'xero') {
      // Xero emails only the contact's own address, so it must be one of the addresses chosen for this client.
      if (!inv.contactEmail) return stop('The Xero contact has no email address. Add one in Xero first.')
      if (!wanted.includes(inv.contactEmail.toLowerCase())) return stop(`Xero would email ${inv.contactEmail}, which is not one of ${client.name}'s invoice emails (${client.invoiceEmails.join(', ')}). Fix the contact in Xero or the client here.`)
      await api.emailInvoice!(f.draft.invoiceId!)
      where = inv.contactEmail
    } else {
      const pdf = await api.invoicePdf!(f.draft.invoiceId!)
      // IMEI files chosen before sending go with the invoice; chosen later, they follow in the same thread.
      const pack = f.imei && f.imei.sent?.state !== 'done' ? f.imei : undefined
      let extra: { filename: string; mime: string; bytes: Uint8Array }[] = []
      if (pack) {
        try {
          extra = await fetchImeiAttachments(d, pack)
        } catch (e) {
          return stop(`The IMEI files could not be fetched from Gmail (${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}). Nothing was sent. Remove them or try again.`)
        }
      }
      const subject = `${f.test ? '[TEST] ' : ''}Invoice ${inv.number} from FoneNova Ltd`
      const text = `Hello ${client.name},\n\nPlease find attached invoice ${inv.number} for ${eur(inv.totalCents)} (EUR).\nPayment details are on the invoice.${pack ? `\n${imeiLine(pack)}` : ''}\n\nKind regards,\nFoneNova Ltd`
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111"><p>Hello ${client.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')},</p><p>Please find attached invoice <strong>${inv.number}</strong> for <strong>${eur(inv.totalCents)}</strong> (EUR).<br>Payment details are on the invoice.${pack ? `<br>${imeiLine(pack).replace(/&/g, '&amp;').replace(/</g, '&lt;')}` : ''}</p><p>Kind regards,<br>FoneNova Ltd</p></div>`
      const sent = await d.mail!({ to: wanted.join(', '), subject, text, html, attachments: [{ filename: `Invoice-${inv.number}.pdf`, mime: 'application/pdf', bytes: pdf }, ...extra] })
      where = `${wanted.join(', ')} (Gmail, PDF attached${pack ? ', with IMEI files' : ''})`
      sentRef = { messageId: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) }
      if (pack) {
        const at = nowOf(d).toISOString()
        await mutate(d.store, offerId, (o) => (o.fulfilment?.imei ? { ...o, fulfilment: { ...o.fulfilment, imei: { ...o.fulfilment.imei, sent: { state: 'done' as const, at, how: 'with_invoice' as const, to: wanted.join(', ') } } } } : null))
      }
    }
    await setStep(d, offerId, 'send', { state: 'done', at: nowOf(d).toISOString(), detail: where, ...(sentRef ?? {}) }, `Invoice ${inv.number} emailed${via === 'gmail' ? ' from info@fonenova.com' : ' by Xero'} to ${where}`)
    await d.notify(`${f.test ? '[TEST] ' : ''}Invoice ${inv.number} was emailed to ${where} (${eur(inv.totalCents)}).`, link(d, offer))
    // The PDF is filed straight after, best effort: a problem there never undoes the send.
    await fileInvoice(offerId, d).catch(() => {})
    return { ok: true, message: `Invoice ${inv.number} emailed to ${where}.` }
  } catch (e) {
    // The email may or may not have gone: it is not retried by itself, and the next press checks again first.
    return stop(`${e instanceof Error ? e.message.slice(0, 160) : 'It could not be sent'}. It may or may not have been sent: check ${via === 'gmail' ? 'the Sent folder of info@fonenova.com' : 'the invoice in Xero'} before pressing again.`, 'failed')
  }
}

// ---------------------------------------------------------------------------
// File the PDF
// ---------------------------------------------------------------------------
export async function fileInvoice(offerId: string, d: InvoiceDeps): Promise<ActionResult> {
  const r = await ready(d, offerId)
  if (!r.ok) return r
  const { offer, f, client, api } = r
  if (f.approve?.state !== 'done') return { ok: false, message: 'Approve the invoice first: only an approved invoice is filed.' }
  if (f.filing?.state === 'done') return { ok: true, message: 'Already filed.' }
  if (!d.filing.dirs) {
    await setStep(d, offerId, 'filing', { state: 'skipped', reason: 'The filing folders are not set up (INVOICE_FILING_DIRS).', at: nowOf(d).toISOString() }, 'Filing skipped: folders not set up')
    return { ok: false, message: 'The filing folders are not set up (INVOICE_FILING_DIRS).' }
  }
  const claimed = await claim(d, offerId, 'filing')
  if (!claimed) return { ok: false, message: 'It is already being filed, or is filed.' }
  const stop = async (message: string): Promise<ActionResult> => {
    await setStep(d, offerId, 'filing', { state: 'failed', reason: message, at: nowOf(d).toISOString() }, `Filing failed: ${message}`)
    return { ok: false, message }
  }
  try {
    const number = f.draft.invoiceNumber ?? ''
    if (!d.filing.dirs[client.folder]) return stop(`No filing folder is set for ${client.name}'s folder (${client.folder}) in INVOICE_FILING_DIRS.`)
    const path = pdfPathFor(d.filing.dirs, client.folder, number, client.name)
    if (!path) return stop('The invoice number or the client folder is not usable for filing.')
    if (!api.invoicePdf) return stop('The Xero write connection cannot fetch PDFs.')
    const bytes = await api.invoicePdf(f.draft.invoiceId!)
    const res = await d.filing.upload(path, bytes)
    if (res.kind === 'ok' || res.kind === 'exists') {
      await setStep(d, offerId, 'filing', { state: 'done', at: nowOf(d).toISOString(), detail: path, ...(res.kind === 'exists' ? { reason: 'A file with that name was already there and was left alone.' } : {}) }, `Invoice ${number} filed: ${path}${res.kind === 'exists' ? ' (already there)' : ''}`)
      return { ok: true, message: res.kind === 'exists' ? 'It was already filed (left alone).' : `Filed ${path}.` }
    }
    return stop(res.message ?? 'OneDrive did not take the file.')
  } catch (e) {
    return stop(e instanceof Error ? e.message.slice(0, 200) : 'It did not work')
  }
}

/** For the panel: where each step stands, in words. */
export const stepWord = (s: InvoiceStep | undefined) => (!s ? 'not done' : s.state === 'done' ? `done ${s.at ? ukTime(s.at) : ''}`.trim() : s.state)
export { xeroDraftUrl }
