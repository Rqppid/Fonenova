/**
 * The email a client gets with their offer. It is built only from the public figures (what the
 * client page shows): description, quantity, sale price, total. The type of its input has no
 * cost, margin or profit, so they cannot end up in it. No payment terms are stated.
 */
import { ukTime } from '../format-uk'
import type { PublicOffer } from './public-store'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface OfferEmail {
  subject: string
  text: string
  html: string
}

export function buildOfferEmail(o: Pick<PublicOffer, 'clientName' | 'lines' | 'units' | 'totalCents' | 'expiresAt' | 'test'>, link: string): OfferEmail {
  const until = ukTime(o.expiresAt)
  const subject = `${o.test ? '[TEST] ' : ''}Offer from FoneNova: ${o.units.toLocaleString('en-GB')} units, valid until ${until}`
  const rows = o.lines.map((l) => ({ ...l, total: l.qty * l.unitSaleCents }))
  const text = [
    `Hello ${o.clientName},`,
    '',
    'Please find our offer below. All prices are in euros.',
    '',
    ...rows.map((r) => `${r.description}: ${r.qty.toLocaleString('en-GB')} x ${eur(r.unitSaleCents)} = ${eur(r.total)}`),
    '',
    `Total: ${o.units.toLocaleString('en-GB')} units, ${eur(o.totalCents)}`,
    `Valid until: ${until}`,
    '',
    'To accept or decline, open this link (the offer is for all items together):',
    link,
    '',
    'Subject to availability. Prices are valid until the time above.',
    '',
    'Kind regards,',
    'FoneNova Ltd',
  ].join('\n')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:620px">
<p>Hello ${esc(o.clientName)},</p>
<p>Please find our offer below. All prices are in euros.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr style="text-align:left;color:#555"><th style="padding:8px 6px;border-bottom:1px solid #ddd">Item</th><th style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:right">Qty</th><th style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:right">Unit price</th><th style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:right">Total</th></tr></thead>
<tbody>${rows.map((r) => `<tr><td style="padding:8px 6px;border-bottom:1px solid #eee">${esc(r.description)}</td><td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right">${r.qty.toLocaleString('en-GB')}</td><td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right">${eur(r.unitSaleCents)}</td><td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right">${eur(r.total)}</td></tr>`).join('')}</tbody>
<tfoot><tr><td style="padding:10px 6px;font-weight:bold">Total</td><td style="padding:10px 6px;text-align:right;font-weight:bold">${o.units.toLocaleString('en-GB')}</td><td></td><td style="padding:10px 6px;text-align:right;font-weight:bold">${eur(o.totalCents)}</td></tr></tfoot>
</table>
<p>Valid until <strong>${esc(until)}</strong>. The offer is for all items together.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#0070d2;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">Accept or decline</a></p>
<p style="font-size:12px;color:#666">If the button does not work, copy this link into your browser:<br>${esc(link)}</p>
<p style="font-size:12px;color:#666">Subject to availability. Prices are valid until the time above.</p>
<p>Kind regards,<br>FoneNova Ltd</p>
</div>`
  return { subject, text, html }
}
