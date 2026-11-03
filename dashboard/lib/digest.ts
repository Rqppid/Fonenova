/**
 * The Friday cash email: who is late paying, what has to be paid out in the next 14 days next to
 * what should come in, the Xero problems the live checks found, and drafts waiting for approval.
 * Pure: the same figures as the dashboard (it takes a LiveView), rendered as HTML and plain text.
 */
import { cashCalendar, overdueOrders } from './metrics'
import type { AttentionItem } from './attention'
import type { HealthCheck } from './health'
import type { LiveView } from './live-view'
import type { Cents, FxRate, IsoDate, XeroInvoice } from './types'

export const DIGEST_DAYS = 14

export interface Digest {
  subject: string
  html: string
  text: string
  figures: { owedToYouCents: Cents; overdueCents: Cents; overdueCount: number; dueOutCents: Cents; dueInCents: Cents; problems: number; drafts: number }
}

const eur = (c: Cents) => `€${Math.round(c / 100).toLocaleString('en-GB')}`
const eurShort = (c: Cents) => (Math.abs(c) >= 1_000_000_00 ? `€${(c / 1_000_000_00).toFixed(1)}M` : Math.abs(c) >= 10_000_00 ? `€${Math.round(c / 1_000_00)}k` : eur(c))
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
const fmtDate = (d: IsoDate | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'no date')

export function buildDigest(args: {
  view: LiveView
  fx: FxRate | null
  today: IsoDate
  /** The dashboard's address, for links, e.g. https://dashboard.fonenova.com */
  appUrl: string
  drafts: readonly XeroInvoice[]
  /** Attention items to list (HIGH first); the live Xero checks plus anything else worth a look. */
  problems: readonly AttentionItem[]
  /** The watchdog's checks (lib/health.ts); anything not ok is listed under "System health". */
  health?: readonly HealthCheck[]
}): Digest {
  const { view, today } = args
  const orders = view.ledger.orders
  const late = overdueOrders(orders, today)
  const owed = orders.reduce((n, o) => n + Math.max(0, o.clientOwesCents ?? 0), 0)
  // Order flows only: overheads are GBP and owner-entered, and would blur the EUR trade picture.
  const cal = cashCalendar({ orders, overheads: [], today, days: DIGEST_DAYS, fx: args.fx, bank: null })
  const windowEntries = [...cal.overdue, ...cal.days.flatMap((d) => d.entries)]
  const outs = windowEntries.filter((e) => e.kind === 'out').sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  const ins = cal.days.flatMap((d) => d.entries).filter((e) => e.kind === 'in')
  const dueOut = -outs.reduce((n, e) => n + e.amountCents, 0)
  const dueIn = ins.reduce((n, e) => n + e.amountCents, 0)
  const problems = [...args.problems].sort((a, b) => (a.priority === b.priority ? b.impactCents - a.impactCents : a.priority === 'HIGH' ? -1 : 1)).slice(0, 8)
  const link = (hash: string) => `${args.appUrl.replace(/\/$/, '')}/#${hash}`

  const subjectBits = [
    late.length ? `${eurShort(late.reduce((n, x) => n + x.owedCents, 0))} overdue` : 'nothing overdue',
    dueOut ? `${eurShort(dueOut)} to pay in ${DIGEST_DAYS} days` : null,
    problems.length ? `${problems.length} Xero problem${problems.length > 1 ? 's' : ''}` : null,
  ].filter(Boolean)
  const subject = `QuayPilot weekly: ${subjectBits.join(', ')}`

  // Plain text first: it is what a phone preview shows.
  const t: string[] = [`Fone Nova, week to ${fmtDate(today)}`, '']
  t.push(`Owed to you: ${eur(owed)}. Overdue: ${eur(late.reduce((n, x) => n + x.owedCents, 0))} on ${late.length} invoice${late.length === 1 ? '' : 's'}.`)
  t.push(`Next ${DIGEST_DAYS} days: ${eur(dueOut)} to pay suppliers (overdue included), ${eur(dueIn)} due in from clients.${dueOut > dueIn ? ` Gap: ${eur(dueOut - dueIn)} from your own cash unless clients pay early.` : ''}`)
  if (late.length) {
    t.push('', 'CHASE THESE')
    for (const x of late.slice(0, 10)) t.push(`- ${x.order.customerName}: invoice ${x.order.clientInvoiceNo}, ${eur(x.owedCents)}, ${x.days} days late`)
  }
  if (outs.length) {
    t.push('', `TO PAY (next ${DIGEST_DAYS} days)`)
    for (const e of outs.slice(0, 12)) t.push(`- ${e.date && e.date < today ? 'OVERDUE' : fmtDate(e.date)}: ${e.label}, ${eur(-e.amountCents)}${e.fundingGap ? ' (client not paid yet)' : ''}`)
  }
  if (problems.length) {
    t.push('', 'FIX IN XERO')
    for (const p of problems) t.push(`- ${p.reference}: ${p.issue}`)
  }
  const sick = (args.health ?? []).filter((c) => c.level !== 'ok')
  if (sick.length) {
    t.push('', 'SYSTEM HEALTH')
    for (const c of sick) t.push(`- ${c.level === 'red' ? 'RED' : 'AMBER'}: ${c.title}. ${c.fix ?? c.detail}`)
  }
  if (args.drafts.length) t.push('', `${args.drafts.length} synced draft${args.drafts.length > 1 ? 's' : ''} waiting to be approved in Xero.`)
  t.push('', `Open QuayPilot: ${args.appUrl}`, 'Sent automatically every Friday. Figures as in the dashboard; credit notes that never reached Xero or the ledger cannot be seen.')
  const text = t.join('\n')

  // HTML: plain tables and inline styles, which every mail client renders.
  const td = 'padding:6px 8px;border-bottom:1px solid #e6e7ea;font-size:14px;vertical-align:top'
  const tdR = `${td};text-align:right;white-space:nowrap;font-weight:600`
  const h2 = 'font-size:15px;margin:22px 0 6px;color:#0b2350'
  const table = (rows: string[]) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">${rows.join('')}</table>`
  const card = (label: string, value: string, tone = '#0b2350') => `<td style="padding:10px 12px;border:1px solid #e6e7ea;border-radius:6px;width:33%"><div style="font-size:12px;color:#6c7078">${label}</div><div style="font-size:20px;font-weight:700;color:${tone}">${value}</div></td>`
  const h: string[] = []
  h.push(`<div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#1d2330;max-width:640px;margin:0 auto">`)
  h.push(`<div style="font-size:18px;font-weight:700"><span style="color:#0b2350">Quay</span><span style="color:#0a72df">Pilot</span> <span style="font-weight:400;color:#6c7078;font-size:14px">· week to ${fmtDate(today)}</span></div>`)
  h.push(`<table role="presentation" cellspacing="8" style="width:100%;margin-top:10px"><tr>${card('Owed to you', eur(owed))}${card('Overdue', eur(late.reduce((n, x) => n + x.owedCents, 0)), late.length ? '#b42318' : '#0b2350')}${card(`To pay in ${DIGEST_DAYS} days`, eur(dueOut))}</tr></table>`)
  if (dueOut > dueIn) h.push(`<p style="font-size:14px;margin:6px 0;color:#b54708"><strong>Cash gap:</strong> ${eur(dueOut - dueIn)} more goes out than is due in over the next ${DIGEST_DAYS} days, unless clients pay early.</p>`)
  if (late.length) {
    h.push(`<h2 style="${h2}">Chase these</h2>`)
    h.push(table(late.slice(0, 10).map((x) => `<tr><td style="${td}">${esc(x.order.customerName)}<div style="color:#6c7078;font-size:12px">invoice ${esc(x.order.clientInvoiceNo)} · ${x.days} days late</div></td><td style="${tdR}">${eur(x.owedCents)}</td></tr>`)))
  }
  if (outs.length) {
    h.push(`<h2 style="${h2}">To pay, next ${DIGEST_DAYS} days</h2>`)
    h.push(table(outs.slice(0, 12).map((e) => `<tr><td style="${td};white-space:nowrap;color:${e.date && e.date < today ? '#b42318' : '#6c7078'}">${e.date && e.date < today ? 'Overdue' : fmtDate(e.date)}</td><td style="${td}">${esc(e.label)}${e.fundingGap ? '<div style="color:#b54708;font-size:12px">client has not paid yet</div>' : ''}</td><td style="${tdR}">${eur(-e.amountCents)}</td></tr>`)))
  }
  if (problems.length) {
    h.push(`<h2 style="${h2}">Fix in Xero</h2>`)
    h.push(table(problems.map((p) => `<tr><td style="${td}"><strong>${esc(p.reference)}</strong><div style="color:#4a4f59;font-size:13px">${esc(p.issue)}</div>${p.link ? `<a href="${esc(p.link)}" style="color:#0a72df;font-size:13px">Open in Xero</a>` : ''}</td><td style="${tdR}">${p.impactCents ? eur(p.impactCents) : ''}</td></tr>`)))
  }
  if (sick.length) {
    h.push(`<h2 style="${h2}">System health</h2>`)
    h.push(table(sick.map((c) => `<tr><td style="${td}"><strong style="color:${c.level === 'red' ? '#b42318' : '#b54708'}">${esc(c.title)}</strong><div style="color:#4a4f59;font-size:13px">${esc(c.fix ?? c.detail)}</div></td></tr>`)))
  } else if (args.health) {
    h.push(`<p style="font-size:13px;color:#027a48;margin:18px 0 0">System health: every connection, automation and check is working.</p>`)
  }
  if (args.drafts.length) h.push(`<p style="font-size:14px;margin:18px 0 0"><a href="${link('matching')}" style="color:#0a72df">${args.drafts.length} synced draft${args.drafts.length > 1 ? 's' : ''}</a> waiting to be approved in Xero.</p>`)
  if (!late.length && !outs.length && !problems.length && !args.drafts.length) h.push(`<p style="font-size:14px">Nothing overdue, nothing due out and no Xero problems this week.</p>`)
  h.push(`<p style="margin:24px 0 0"><a href="${link('overview')}" style="display:inline-block;background:#0b2350;color:#fff;text-decoration:none;padding:9px 14px;border-radius:6px;font-size:14px">Open QuayPilot</a></p>`)
  h.push(`<p style="font-size:12px;color:#6c7078;margin-top:18px">Sent automatically every Friday. Figures as in the dashboard. A credit note that never reached Xero or the ledger cannot be seen here.</p></div>`)

  return {
    subject,
    html: h.join(''),
    text,
    figures: { owedToYouCents: owed, overdueCents: late.reduce((n, x) => n + x.owedCents, 0), overdueCount: late.length, dueOutCents: dueOut, dueInCents: dueIn, problems: problems.length, drafts: args.drafts.length },
  }
}
