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

export function buildAnswerEmail(i: { outcome: AnswerOutcome; offer: Offer; send: OfferSend; lines: PublicLine[] | null; dashboardUrl?: string }): NotifyEmail {
  const { outcome, send } = i
  const w = WORD[outcome]
  const subject = `${send.test ? '[TEST] ' : ''}${w.head}: ${send.clientName} ${w.verb} the offer (${eur(send.totalCents)})`
  const when = outcome === 'expired' ? `Deadline passed: ${ukTime(send.expiresAt)}` : `Answered: ${ukTime(send.answer?.at ?? send.resolvedAt ?? send.sentAt)}`
  const remarks = send.answer?.remarks ?? ''
  const link = i.dashboardUrl ? `${i.dashboardUrl}/offers?id=${encodeURIComponent(i.offer.id)}` : null
  const next =
    outcome === 'accepted' ? (send.test ? 'This was a test, so nothing else happens.' : 'Reply to Mobile One and raise the invoice yourself for now.')
    : 'The offer is unlocked: reprice it and send it to another client.'
  const rows = (i.lines ?? []).map((l) => ({ ...l, total: l.qty * l.unitSaleCents }))

  const text = [
    `${send.clientName} ${w.verb} the offer${send.test ? ' (test)' : ''}.`,
    '',
    `Total: ${send.units.toLocaleString('en-GB')} units, ${eur(send.totalCents)}`,
    when,
    '',
    ...(rows.length ? ['Items (sale prices):', ...rows.map((r) => `${r.description}: ${r.qty.toLocaleString('en-GB')} x ${eur(r.unitSaleCents)} = ${eur(r.total)}`), ''] : ['Items: see the offer on the dashboard.', '']),
    outcome === 'expired' ? 'No answer was received.' : remarks ? `Remarks: ${remarks}` : 'No remarks.',
    '',
    next,
    ...(link ? ['', `Open the offer: ${link}`] : []),
  ].join('\n')

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:620px">
<p><strong>${esc(send.clientName)} ${w.verb} the offer</strong>${send.test ? ' (test)' : ''}.</p>
<p>Total: <strong>${send.units.toLocaleString('en-GB')} units, ${eur(send.totalCents)}</strong><br>${esc(when)}</p>
${rows.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left;color:#555"><th style="padding:6px;border-bottom:1px solid #ddd">Item</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Qty</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Unit price</th><th style="padding:6px;border-bottom:1px solid #ddd;text-align:right">Total</th></tr></thead><tbody>${rows.map((r) => `<tr><td style="padding:6px;border-bottom:1px solid #eee">${esc(r.description)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${r.qty.toLocaleString('en-GB')}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${eur(r.unitSaleCents)}</td><td style="padding:6px;border-bottom:1px solid #eee;text-align:right">${eur(r.total)}</td></tr>`).join('')}</tbody></table>` : '<p>Items: see the offer on the dashboard.</p>'}
<p>${outcome === 'expired' ? 'No answer was received.' : remarks ? `Remarks: <span style="white-space:pre-wrap">${esc(remarks)}</span>` : 'No remarks.'}</p>
<p>${esc(next)}</p>
${link ? `<p><a href="${esc(link)}">Open the offer</a></p>` : ''}
</div>`
  return { subject, text, html }
}
