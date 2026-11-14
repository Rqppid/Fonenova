/**
 * The email to the owner when a client accepts, declines, or lets an offer expire. It sits beside
 * the Telegram message and never replaces or blocks it. It is for the owner, but it still shows
 * sale prices only (what the client saw): no costs or margins.
 */
import { ukTime } from '../format-uk'
import type { Offer, OfferSend } from './types'
import type { PublicLine } from './pricing'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type AnswerOutcome = 'accepted' | 'declined' | 'expired'
export interface NotifyEmail { subject: string; text: string; html: string }

const WORD: Record<AnswerOutcome, { head: string; verb: string }> = {
  accepted: { head: 'ACCEPTED', verb: 'accepted' },
  declined: { head: 'DECLINED', verb: 'declined' },
  expired: { head: 'EXPIRED', verb: 'did not answer' },
}

export interface DraftInfo {
  /** Link to the draft in Xero, when one exists. */
  url?: string | null
  number?: string | null
  org?: string | null
  /** Why there is no draft yet, in plain words. */
  note?: string | null
  /** Things to check on the draft (a missing address, a recent invoice to the same contact). */
  warnings?: string[]
}

export function buildAnswerEmail(i: { outcome: AnswerOutcome; offer: Offer; send: OfferSend; lines: PublicLine[] | null; shippingCents?: number; dashboardUrl?: string; orderRef?: string | null; draft?: DraftInfo | null }): NotifyEmail {
  const { outcome, send } = i
  const w = WORD[outcome]
  const subject = `${send.test ? '[TEST] ' : ''}${w.head}: ${send.clientName} ${w.verb} the offer (${eur(send.totalCents)})`
  const when = outcome === 'expired' ? `Deadline passed: ${ukTime(send.expiresAt)}` : `Answered: ${ukTime(send.answer?.at ?? send.resolvedAt ?? send.sentAt)}`
  const remarks = send.answer?.remarks ?? ''
  const link = i.dashboardUrl ? `${i.dashboardUrl}/offers?id=${encodeURIComponent(i.offer.id)}` : null
  const shipping = i.shippingCents ?? send.shippingCents ?? 0
  const accepted = outcome === 'accepted'
  const reference = [i.orderRef, `Mobile One offer "${i.offer.source.subject || '(no subject)'}"`, i.offer.id].filter(Boolean).join(' · ')
  const next =
    accepted ? (send.test ? 'This was a test: the would-be reply to Mobile One goes to your inbox, and the draft invoice goes to the Xero Demo Company.' : 'Quay Pilot is replying to Mobile One and raising a draft invoice in Xero (a draft only: nothing is approved or sent).')
    : 'The offer is unlocked: reprice it and send it to another client.'
  const rows = (i.lines ?? []).map((l) => ({ ...l, total: l.qty * l.unitSaleCents }))
  const d = i.draft
  const draftLine = !accepted ? null : d?.url ? `Xero draft${d.number ? ` ${d.number}` : ''}${d.org ? ` (${d.org})` : ''}: ${d.url}` : `Xero draft: not created${d?.note ? `. ${d.note}` : ' yet'}`

  const text = [
    `${send.clientName} ${w.verb} the offer${send.test ? ' (test)' : ''}.`,
    '',
    `Client: ${send.clientName}`,
    `Offer reference: ${reference}`,
    `Currency: EUR`,
    when,
    '',
    ...(rows.length ? ['Items (sale prices):', ...rows.map((r) => `${r.description}: ${r.qty.toLocaleString('en-GB')} x ${eur(r.unitSaleCents)} = ${eur(r.total)}`)] : ['Items: see the offer on the dashboard.']),
    ...(shipping ? [`Shipping: ${eur(shipping)}`] : []),
    `Total: ${send.units.toLocaleString('en-GB')} units, ${eur(send.totalCents)}${shipping ? ' (including shipping)' : ''}`,
    '',
    outcome === 'expired' ? 'No answer was received.' : remarks ? `Remarks: ${remarks}` : 'No remarks.',
    ...(draftLine ? ['', draftLine, ...(d?.warnings ?? []).map((x) => `Check: ${x}`)] : []),
    '',
    next,
    ...(link ? ['', `Open the offer: ${link}`] : []),
  ].join('\n')

  const cell = 'padding:6px;border-bottom:1px solid #eee'
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:620px">
<p><strong>${esc(send.clientName)} ${w.verb} the offer</strong>${send.test ? ' (test)' : ''}.</p>
<p>Client: ${esc(send.clientName)}<br>Offer reference: ${esc(reference)}<br>Currency: EUR<br>${esc(when)}</p>
${rows.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left;color:#555"><th style="padding:6px;border-bottom:1px solid #ddd">Item</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Qty</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Unit price</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Total</th></tr></thead><tbody>${rows.map((r) => `<tr><td style="${cell}">${esc(r.description)}</td><td style="${cell};text-align:right">${r.qty.toLocaleString('en-GB')}</td><td style="${cell};text-align:right">${eur(r.unitSaleCents)}</td><td style="${cell};text-align:right">${eur(r.total)}</td></tr>`).join('')}${shipping ? `<tr><td style="${cell}">Shipping</td><td style="${cell}"></td><td style="${cell}"></td><td style="${cell};text-align:right">${eur(shipping)}</td></tr>` : ''}</tbody><tfoot><tr><td style="padding:8px 6px;font-weight:bold">Total</td><td style="padding:8px 6px;text-align:right;font-weight:bold">${send.units.toLocaleString('en-GB')}</td><td></td><td style="padding:8px 6px;text-align:right;font-weight:bold">${eur(send.totalCents)}</td></tr></tfoot></table>` : `<p>Total: <strong>${send.units.toLocaleString('en-GB')} units, ${eur(send.totalCents)}</strong></p>`}
<p>${outcome === 'expired' ? 'No answer was received.' : remarks ? `Remarks: <span style="white-space:pre-wrap">${esc(remarks)}</span>` : 'No remarks.'}</p>
${draftLine ? `<p>${d?.url ? `Xero draft${d.number ? ` <strong>${esc(d.number)}</strong>` : ''}${d.org ? ` (${esc(d.org)})` : ''}: <a href="${esc(d.url)}">open in Xero</a>` : esc(draftLine)}${(d?.warnings ?? []).map((x) => `<br><strong>Check:</strong> ${esc(x)}`).join('')}</p>` : ''}
<p>${esc(next)}</p>
${link ? `<p><a href="${esc(link)}">Open the offer</a></p>` : ''}
</div>`
  return { subject, text, html }
}
