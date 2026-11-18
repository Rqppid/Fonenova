/**
 * IMEI lists from Mobile One, passed on to the client. Only the IMEI list: never Mobile One's DHL label, invoice or any other file.
 *
 * Mobile One sends them by email, sometimes with the invoice and sometimes days later, so this works
 * both ways:
 * - picked before the invoice goes out: the files are attached to the invoice email itself;
 * - picked (or arriving) after: one explicit click sends them as a reply in the same Gmail thread
 *   as the invoice email, so the client sees one conversation.
 *
 * Nothing here runs by itself. The files are chosen by hand from the offer's own Mobile One thread
 * (or one whose link is pasted), the server checks every pick against that thread again, and only
 * where a file is saved, never the file. Sending is at most once and has the same gates as sending
 * the invoice: a test is only ever sent in the Demo Company, a real client needs live Xero and real sending on.
 */
import { gmailThreadIdFrom, type MailFile, type ThreadMessage } from '../gmail'
import { type FulfilDeps, load, log, mutate } from './fulfil'
import type { ActionResult, InvoiceDeps } from './invoice-flow'
import type { ImeiFile, ImeiPack, Offer } from './types'
import { getJson } from '../store'
import { clientsFrom, type Client } from './clients'

export type ImeiDeps = InvoiceDeps

/** All the files together may not pass this: Gmail refuses a message over about 25 MB once encoded. */
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024
const nowOf = (d: FulfilDeps) => d.now ?? new Date()
const IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|ico)$|^image\//i

export function kindOf(filename: string, mime: string): ImeiFile['kind'] {
  if (/imei/i.test(filename) || /\.(xlsx?|csv|ods)$/i.test(filename) || /spreadsheet|ms-excel|csv/i.test(mime)) return 'imei'
  if (/label|dhl|track|ship|waybill|awb/i.test(filename)) return 'label'
  return 'other'
}

export interface ImeiCandidate extends ImeiFile { from: string; subject: string; receivedAt: string }
const toCandidate = (m: ThreadMessage, f: MailFile): ImeiCandidate => ({ messageId: f.messageId, partId: f.partId, filename: f.filename, mime: f.mime, size: f.size, kind: kindOf(f.filename, f.mime), from: m.from, subject: m.subject, receivedAt: m.receivedAt })

/** Files other people sent in a thread: not ours, not pictures (signature logos). Newest first. Pure. */
export function candidatesIn(messages: readonly ThreadMessage[]): ImeiCandidate[] {
  return messages
    .filter((m) => !m.labels.includes('SENT'))
    .flatMap((m) => m.files.filter((f) => f.filename && !IMAGE.test(f.filename) && !IMAGE.test(f.mime) && f.size > 0).map((f) => toCandidate(m, f)))
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
}

type Located = { ok: true; offer: Offer; threadId: string; messages: ThreadMessage[] } | { ok: false; message: string }

/** The thread to look in (the pasted one, else the offer's own), checked to be Mobile One's. */
async function locate(d: ImeiDeps, offerId: string, pasted?: string): Promise<Located> {
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || offer.status !== 'accepted' || !f) return { ok: false, message: 'This offer has not been accepted.' }
  if (!d.gmailThread) return { ok: false, message: 'Gmail is not connected (or cannot read mail). Connect it in Settings.' }
  let threadId: string | null
  if (pasted?.trim()) {
    threadId = gmailThreadIdFrom(pasted)
    if (!threadId) return { ok: false, message: 'That is not a Gmail link or thread id. Open the email in Gmail and copy the address from the browser.' }
  } else threadId = offer.source.threadId
  if (!threadId || /^test-/.test(threadId)) return { ok: false, message: f.test ? 'A test offer has no real Mobile One email. Paste the link of an email in your own inbox to try it.' : 'This offer has no Gmail thread. Paste the link of the email with the IMEI sheet.' }
  let messages: ThreadMessage[]
  try {
    messages = await d.gmailThread.messages(threadId)
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Gmail could not be read' }
  }
  if (messages.length === 0) return { ok: false, message: 'That thread has no messages.' }
  // A real order only takes files from a thread Mobile One wrote in; a test may use any thread in the owner's own mailbox.
  if (!f.test && !messages.some((m) => /mobileone/i.test(m.from))) return { ok: false, message: 'That thread has nothing from Mobile One, so its files are not used for a real order.' }
  return { ok: true, offer, threadId, messages }
}

/** Step 1: look. Returns the files found; nothing is saved. */
export async function findImeiFiles(offerId: string, d: ImeiDeps, opts: { thread?: string } = {}): Promise<ActionResult & { threadId?: string; candidates?: ImeiCandidate[] }> {
  const r = await locate(d, offerId, opts.thread)
  if (!r.ok) return r
  // Only the IMEI lists are ever offered: a label, an invoice or any other file in the thread is not sent to a client.
  const candidates = candidatesIn(r.messages).filter((c) => c.kind === 'imei')
  if (candidates.length === 0) return { ok: true, message: 'No IMEI list in that thread yet. Try again when the email arrives, or paste the link of another email.', threadId: r.threadId, candidates }
  return { ok: true, message: `${candidates.length} IMEI list${candidates.length === 1 ? '' : 's'} found in the thread.`, threadId: r.threadId, candidates }
}

/** Step 2: keep the ones picked. The server looks the thread up again, so only a real file of that thread can be saved. */
export async function attachImeiFiles(offerId: string, d: ImeiDeps, input: { thread: string; picks: { messageId: string; partId: string }[] }): Promise<ActionResult> {
  const r = await locate(d, offerId, input.thread)
  if (!r.ok) return r
  const f = r.offer.fulfilment!
  if (f.imei?.sent && f.imei.sent.state !== 'failed') return { ok: false, message: f.imei.sent.state === 'working' ? 'The IMEI files are being sent right now.' : 'The IMEI files were already sent to the client.' }
  if (input.picks.length === 0) return { ok: false, message: 'Tick at least one file.' }
  if (input.picks.length > 8) return { ok: false, message: 'At most 8 files.' }
  const found = candidatesIn(r.messages)
  const files: ImeiFile[] = []
  for (const p of input.picks) {
    const c = found.find((x) => x.messageId === p.messageId && x.partId === p.partId)
    if (!c) return { ok: false, message: 'One of the files is not in that thread any more. Look again.' }
    if (c.kind !== 'imei') return { ok: false, message: 'Only an IMEI list can be sent to a client. That file is not one.' }
    if (files.some((x) => x.messageId === c.messageId && x.partId === c.partId)) continue
    files.push({ messageId: c.messageId, partId: c.partId, filename: c.filename, mime: c.mime, size: c.size, kind: c.kind })
  }
  if (files.reduce((n, x) => n + x.size, 0) > MAX_TOTAL_BYTES) return { ok: false, message: 'Those files are too big to email together (15 MB at most). Pick fewer.' }
  const at = nowOf(d).toISOString()
  const pack: ImeiPack = { threadId: r.threadId, files, chosenAt: at }
  await mutate(d.store, offerId, (o) => (o.fulfilment ? { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, imei: pack }, audit: log(o, at, `IMEI files chosen: ${files.map((x) => x.filename).join(', ')}`) } : null))
  const willGo = f.send?.state === 'done' ? 'Send them to the client now (same thread as the invoice).' : 'They will be attached to the invoice email.'
  return { ok: true, message: `${files.length} file${files.length === 1 ? '' : 's'} chosen. ${willGo}` }
}

export async function clearImeiFiles(offerId: string, d: FulfilDeps): Promise<ActionResult> {
  const offer = await load(d.store, offerId)
  const imei = offer?.fulfilment?.imei
  if (!imei) return { ok: true, message: 'Nothing chosen.' }
  if (imei.sent && imei.sent.state !== 'failed') return { ok: false, message: 'They were sent (or are being sent), so the choice stays as the record.' }
  const at = nowOf(d).toISOString()
  await mutate(d.store, offerId, (o) => {
    if (!o.fulfilment?.imei) return null
    const { imei: _gone, ...rest } = o.fulfilment
    return { ...o, updatedAt: at, fulfilment: rest, audit: log(o, at, 'IMEI choice removed') }
  })
  return { ok: true, message: 'Removed.' }
}

/** The bytes of the chosen files, fetched from Gmail now. Throws a plain sentence if one cannot be had. */
export async function fetchImeiAttachments(d: ImeiDeps, pack: ImeiPack): Promise<{ filename: string; mime: string; bytes: Uint8Array }[]> {
  if (!d.gmailThread) throw new Error('Gmail cannot read the IMEI files right now')
  const out: { filename: string; mime: string; bytes: Uint8Array }[] = []
  let total = 0
  // Gmail's fetch handle for a file changes every time the message is read, so read the thread again and take the current one.
  const now = (await d.gmailThread.messages(pack.threadId)).flatMap((m) => m.files)
  for (const f of pack.files) {
    const fresh = now.find((x) => x.messageId === f.messageId && x.partId === f.partId && x.filename === f.filename)
    if (!fresh) throw new Error(`${f.filename} is no longer in the Gmail thread`)
    const bytes = await d.gmailThread.file(f.messageId, fresh.attachmentId)
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw new Error('The IMEI files are too big to email together')
    out.push({ filename: f.filename, mime: f.mime, bytes })
  }
  return out
}

/** What the invoice email says about the files it carries: always IMEI lists. */
export const imeiLine = (pack: ImeiPack) => `${pack.files.length === 1 ? 'The IMEI list is' : 'The IMEI lists are'} attached: ${pack.files.map((f) => f.filename).join(', ')}.`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Step 3, when the invoice has already gone: send the chosen files as a reply in the invoice's thread.
 * If the invoice went by Xero's own email there is no thread of ours, so it is a new email instead.
 */
export async function sendImeiFollowUp(offerId: string, d: ImeiDeps, opts: { confirm: boolean }): Promise<ActionResult> {
  if (!opts.confirm) return { ok: false, message: 'Sending needs your confirmation: tick the box first.' }
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || offer.status !== 'accepted' || !f) return { ok: false, message: 'This offer has not been accepted.' }
  const pack = f.imei
  if (!pack || pack.files.length === 0) return { ok: false, message: 'Choose the IMEI files first.' }
  if (f.send?.state !== 'done') return { ok: false, message: 'The invoice has not been sent yet. The files go with it when it is.' }
  if (pack.sent?.state === 'done') return { ok: true, message: 'Already sent.' }
  if (!d.mail || !d.gmailThread) return { ok: false, message: 'Gmail is not connected.' }
  // The same gates as sending the invoice.
  const api = d.xero()
  if (!api) return { ok: false, message: 'The Xero write connection is not set up.' }
  let isDemo: boolean
  try {
    const org = await api.organisation()
    if (org.name !== f.draft.org) return { ok: false, message: `The selected Xero organisation (${org.name}) is not the one this invoice was made in (${f.draft.org ?? 'unknown'}). Nothing was sent.` }
    isDemo = org.isDemo
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached.' }
  }
  if (!isDemo) {
    if (f.test) return { ok: false, message: 'A test is never sent from the live organisation.' }
    if (!d.allowLiveXero) return { ok: false, message: 'Live Xero is switched off (XERO_WRITE_ALLOW_LIVE). Nothing was sent.' }
    if (!d.allowReal) return { ok: false, message: 'Sending to real clients is switched off (OFFERS_ALLOW_REAL_SEND). Nothing was sent.' }
  } else if (!f.test) return { ok: false, message: 'A real order is not sent from a demo organisation.' }

  const client: Client | undefined = (clientsFrom(await getJson<Client[]>(d.store, 'offers:clients'))).find((c) => c.id === offer.pricing?.clientId)
  const wanted = (client?.invoiceEmails ?? []).map((e) => e.trim()).filter(Boolean)
  if (!client || wanted.length === 0) return { ok: false, message: `${client?.name ?? 'The client'} has no invoice email address (Offers, Clients).` }

  // Claim before sending: only one caller goes on.
  const at = nowOf(d).toISOString()
  const claimed = await mutate(d.store, offerId, (o) => {
    const cur = o.fulfilment?.imei?.sent
    if (!o.fulfilment?.imei || cur?.state === 'done' || (cur?.state === 'working' && nowOf(d).getTime() - Date.parse(cur.at) < 10 * 60_000)) return null
    return { ...o, updatedAt: at, fulfilment: { ...o.fulfilment, imei: { ...o.fulfilment.imei, sent: { state: 'working' as const, at } } } }
  })
  if (!claimed) return { ok: false, message: 'It is already being sent, or is sent.' }
  const stop = async (message: string, state: 'failed' = 'failed'): Promise<ActionResult> => {
    await mutate(d.store, offerId, (o) => (o.fulfilment?.imei ? { ...o, updatedAt: nowOf(d).toISOString(), fulfilment: { ...o.fulfilment, imei: { ...o.fulfilment.imei, sent: { state, at: nowOf(d).toISOString(), reason: message } } }, audit: log(o, nowOf(d).toISOString(), `IMEI email ${state}: ${message}`) } : null))
    return { ok: false, message }
  }
  try {
    const attachments = await fetchImeiAttachments(d, pack)
    const number = f.draft.invoiceNumber ?? ''
    const threadId = f.send.threadId
    const inReplyTo = threadId && f.send.messageId ? ((await d.gmailThread.rfcId(f.send.messageId).catch(() => null)) ?? undefined) : undefined
    const base = `${f.test ? '[TEST] ' : ''}Invoice ${number} from FoneNova Ltd`
    const subject = threadId ? `Re: ${base}` : `${f.test ? '[TEST] ' : ''}IMEI list for invoice ${number}`
    const text = `Hello ${client.name},\n\nPlease find the IMEI list for invoice ${number} attached.\n${pack.files.map((x) => `- ${x.filename}`).join('\n')}\n\nKind regards,\nFoneNova Ltd`
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111"><p>Hello ${esc(client.name)},</p><p>Please find the IMEI list for invoice <strong>${esc(number)}</strong> attached.</p><ul>${pack.files.map((x) => `<li>${esc(x.filename)}</li>`).join('')}</ul><p>Kind regards,<br>FoneNova Ltd</p></div>`
    await d.mail({ to: wanted.join(', '), subject, text, html, attachments, ...(threadId ? { threadId } : {}), ...(inReplyTo ? { inReplyTo } : {}) })
    const done = nowOf(d).toISOString()
    const where = `${wanted.join(', ')}${threadId ? ' (same thread as the invoice)' : ''}`
    await mutate(d.store, offerId, (o) => (o.fulfilment?.imei ? { ...o, updatedAt: done, fulfilment: { ...o.fulfilment, imei: { ...o.fulfilment.imei, sent: { state: 'done' as const, at: done, how: 'follow_up' as const, to: where } } }, audit: log(o, done, `IMEI files emailed to ${where}`) } : null))
    await d.notify(`${f.test ? '[TEST] ' : ''}IMEI files for invoice ${number} were emailed to ${where}.`, d.dashboardUrl ? { label: 'Open offer', url: `${d.dashboardUrl}/offers?id=${encodeURIComponent(offer.id)}` } : undefined)
    return { ok: true, message: `IMEI files emailed to ${where}.` }
  } catch (e) {
    return stop(`${e instanceof Error ? e.message.slice(0, 160) : 'It could not be sent'}. It may or may not have been sent: check the Sent folder of info@fonenova.com before pressing again.`)
  }
}
