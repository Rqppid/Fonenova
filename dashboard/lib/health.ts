/**
 * The watchdog: every way the data can quietly stop flowing, checked in one place. Pure, so the
 * daily job, Settings and the Friday email all show the same list.
 *
 * Red means "something is broken or missing": the daily job reports it to the outside monitor
 * (Healthchecks.io), which emails you. Amber means "worth knowing", shown on the dashboard and in
 * the Friday email. If the daily job itself stops running, the outside monitor notices the
 * missing ping and emails you too, so silence really does mean all is well.
 */
import type { MakeStatus } from './make'
import type { PaymentsHealth, PaymentsResult } from './payments-types'
import type { SourceStatus } from './sync-core'
import type { IsoDate, XeroInvoice, XeroSnapshot } from './types'

export type HealthLevel = 'ok' | 'amber' | 'red'

export interface HealthCheck {
  id: string
  level: HealthLevel
  title: string
  detail: string
  /** What to do about it, when it is not ok. */
  fix?: string
  /** For the invoice-gap check: the missing numbers, so Settings can mark them "not used". */
  numbers?: string[]
}

export interface HealthInput {
  now: Date
  today: IsoDate
  sources: SourceStatus[]
  xero: { configured: boolean; connected: boolean; snapshot: XeroSnapshot | null }
  oneDrive: { configured: boolean; connected: boolean; canWrite?: boolean }
  /** ONEDRIVE_WRITE_TOKEN is set: the payments service expects to keep its trackers current. */
  trackerWritesWanted?: boolean
  make: MakeStatus | null
  makeConfigured: boolean
  gmail: { configured: boolean; connected: boolean }
  watchdogConfigured: boolean
  /** Invoice numbers the owner confirmed were never used (e.g. deleted in Invoice2Go). */
  ignoredInvoiceNumbers: string[]
  /** The payments service's /api/health answer. Absent or not-configured: no check (Preview, local). */
  payments?: PaymentsResult<PaymentsHealth>
}

const HOUR = 3_600_000
const daysSince = (iso: string, now: Date) => Math.floor((now.getTime() - Date.parse(iso)) / (24 * HOUR))
const QUIET_AMBER_DAYS = 7
const QUIET_RED_DAYS = 14
/** The payments service matches every few minutes; half an hour without a run means it stopped. */
const PAYMENTS_STALE_MINUTES = 30

function paymentsCheck(r: PaymentsResult<PaymentsHealth> | undefined): HealthCheck | null {
  if (!r || r.kind === 'not-configured') return null
  const fix = 'Check the fonenova-payments service. Until it runs cleanly again, new Revolut payments are not matched.'
  if (r.kind !== 'ok') return { id: 'payments', level: 'red', title: 'Payments service unreachable', detail: r.kind === 'error' ? r.message : r.error, fix: 'Check the fonenova-payments service is running, and PAYMENTS_API_URL and PAYMENTS_API_TOKEN in Vercel.' }
  const h = r.data
  const mins = h.minutes_ago
  const when = mins === null ? 'It has not run.' : `Last run ${mins < 90 ? `${Math.round(mins)} min` : `${Math.round(mins / 60)} h`} ago.`
  // last_error is a short technical string from the service: shown as details, never the headline.
  const details = h.last_error ? ` Details: ${h.last_error}` : ''
  if (mins === null || mins > PAYMENTS_STALE_MINUTES) return { id: 'payments', level: 'red', title: 'Payments matching has stopped', detail: `${when}${details}`, fix }
  if (!h.ok) return { id: 'payments', level: 'red', title: 'Payments matching failed its last run', detail: `${when}${details}`, fix }
  return { id: 'payments', level: 'ok', title: 'Payments matching', detail: when }
}

/**
 * Numbers missing from your own invoice run, e.g. 2026038, 2026040 → 2026039. Only numbers made
 * of a 4-digit year and a counter are checked (Invoice2Go's), from the oldest kept to the newest.
 * Voided invoices count as used.
 */
export function invoiceGaps(invoices: readonly XeroInvoice[], ignored: readonly string[] = []): string[] {
  const nums = invoices
    .filter((i) => i.kind === 'sale' && i.status !== 'DELETED' && /^\d{7}$/.test(i.number))
    .map((i) => i.number)
  const byYear = new Map<string, number[]>()
  for (const n of nums) byYear.set(n.slice(0, 4), [...(byYear.get(n.slice(0, 4)) ?? []), Number(n.slice(4))])
  const skip = new Set(ignored)
  const gaps: string[] = []
  for (const [year, seq] of byYear) {
    const have = new Set(seq)
    const lo = Math.min(...seq)
    const hi = Math.max(...seq)
    for (let k = lo + 1; k < hi; k++) {
      const n = `${year}${String(k).padStart(3, '0')}`
      if (!have.has(k) && !skip.has(n)) gaps.push(n)
    }
  }
  return gaps.sort()
}

const newest = (docs: readonly XeroInvoice[], kind: 'sale' | 'bill') =>
  docs.filter((d) => d.kind === kind && d.date && d.status !== 'VOIDED' && d.status !== 'DELETED').map((d) => d.date!).sort().at(-1) ?? null

export function healthChecks(h: HealthInput): HealthCheck[] {
  const out: HealthCheck[] = []
  const add = (c: HealthCheck) => out.push(c)

  // Connections and the sync itself.
  for (const s of h.sources.filter((x) => x.configured)) {
    add(s.ok
      ? { id: `sync-${s.source}`, level: 'ok', title: s.label, detail: s.message }
      : { id: `sync-${s.source}`, level: 'red', title: `${s.label} is not syncing`, detail: s.message, fix: 'Open Settings → Data sources. If it says "not connected", connect it again.' })
  }
  if (h.oneDrive.configured && !h.oneDrive.connected) add({ id: 'onedrive', level: 'red', title: 'OneDrive is disconnected', detail: 'The ledger and VAT trackers are no longer read.', fix: 'Settings → Connect OneDrive.' })
  if (h.trackerWritesWanted && h.oneDrive.connected && !h.oneDrive.canWrite) add({ id: 'onedrive-write', level: 'amber', title: 'Payments trackers are not being updated on OneDrive', detail: 'OneDrive is connected read-only, so the payments service cannot save the trackers.', fix: 'Settings → OneDrive → Disconnect, then Connect OneDrive, and approve access to your files.' })
  if (h.xero.configured && !h.xero.connected) add({ id: 'xero', level: 'red', title: 'Xero is disconnected', detail: 'Invoices, bills and the checks have stopped.', fix: 'Settings → Connect Xero.' })

  const snap = h.xero.snapshot
  if (snap) {
    const age = (h.now.getTime() - Date.parse(snap.fetchedAt)) / HOUR
    add(age > 30
      ? { id: 'xero-age', level: 'red', title: 'Xero has not refreshed for over a day', detail: `Last good copy ${snap.fetchedAt.slice(0, 16).replace('T', ' ')} UTC.${snap.problems[0] ? ` ${snap.problems[0]}` : ''}`, fix: 'Settings → Data sources; reconnect Xero if it asks.' }
      : { id: 'xero-age', level: 'ok', title: 'Xero', detail: `Refreshed ${Math.round(age * 60) < 90 ? `${Math.round(age * 60)} min` : `${Math.round(age)} h`} ago` })

    // Documents arriving at all: a long silence means a sync upstream (Invoice2Go → Make → Xero) stopped.
    for (const [kind, what, path] of [['sale', 'sales invoice', 'Invoice2Go → Make → Xero'], ['bill', 'supplier bill', 'email → Make → Xero']] as const) {
      const last = newest(snap.invoices, kind)
      if (!last) continue
      const d = daysSince(last, h.now)
      const level: HealthLevel = d >= QUIET_RED_DAYS ? 'red' : d >= QUIET_AMBER_DAYS ? 'amber' : 'ok'
      add({
        id: `quiet-${kind}`,
        level,
        title: level === 'ok' ? `Newest ${what}` : `No new ${what} in Xero for ${d} days`,
        detail: `Newest is dated ${last}.`,
        ...(level === 'ok' ? {} : { fix: `If you have ${kind === 'sale' ? 'invoiced' : 'been billed'} since, the ${path} sync has stopped: check that scenario's History in Make.` }),
      })
    }

    const gaps = invoiceGaps(snap.invoices, h.ignoredInvoiceNumbers)
    add(gaps.length
      ? { id: 'invoice-gaps', level: 'red', title: `${gaps.length} invoice number${gaps.length > 1 ? 's' : ''} missing from Xero`, detail: `Not in Xero: ${gaps.join(', ')}. Your invoice numbers run in order, so each gap is an invoice that never synced, or one deleted in Invoice2Go.`, fix: 'Look each one up in Invoice2Go. If it was sent, it needs to reach Xero; if it was deleted, mark it "not used" in Settings.', numbers: gaps }
      : { id: 'invoice-gaps', level: 'ok', title: 'Invoice numbers', detail: 'No gaps in the run.' })
  }

  // The automations.
  if (!h.makeConfigured) {
    add({ id: 'make', level: 'amber', title: 'Make.com is not being watched', detail: 'A stopped or failing scenario would go unnoticed.', fix: 'Add MAKE_API_TOKEN, MAKE_ZONE, MAKE_ORG_ID and MAKE_SCENARIOS in Vercel.' })
  } else if (!h.make || !h.make.scenarios.length) {
    add({ id: 'make', level: 'red', title: 'Make.com could not be read', detail: h.make?.problems[0] ?? 'No scenarios came back.', fix: 'Check the Make API token in Vercel is still valid.' })
  } else {
    for (const s of h.make.scenarios) {
      const bad = !s.active || s.lastRunOk === false
      add(bad
        ? { id: `make-${s.id}`, level: 'red', title: `Make scenario "${s.name}" ${s.active ? 'failed' : 'is switched off'}`, detail: s.lastError ?? (s.lastRunAt ? `Last run ${s.lastRunAt.slice(0, 16).replace('T', ' ')} UTC.` : 'It has not run.'), fix: 'Open it in Make, look at History, fix and re-run the failed item, and switch it back on.' }
        : { id: `make-${s.id}`, level: 'ok', title: s.name, detail: s.lastRunAt ? `Last run ${s.lastRunAt.slice(0, 16).replace('T', ' ')} UTC` : 'On' })
    }
    const { creditsUsed: used, creditsLimit: limit } = h.make
    if (used !== null && limit !== null && used >= limit * 0.8) add({ id: 'make-credits', level: used >= limit * 0.95 ? 'red' : 'amber', title: 'Make credits nearly used up', detail: `${used.toLocaleString('en-GB')} of ${limit.toLocaleString('en-GB')} this period. At zero every scenario stops.`, fix: 'Upgrade the Make plan or wait for the reset.' })
  }

  // Revolut payment matching (the fonenova-payments service).
  const pay = paymentsCheck(h.payments)
  if (pay) add(pay)

  // The alert channels themselves.
  if (h.gmail.configured && !h.gmail.connected) add({ id: 'gmail', level: 'amber', title: 'Friday email is not connected', detail: 'No weekly summary will be sent.', fix: 'Settings → Connect Gmail.' })
  if (!h.watchdogConfigured) add({ id: 'watchdog', level: 'amber', title: 'Outside monitor not set up', detail: 'Problems only show when you open the dashboard, and nobody notices if the daily check itself stops.', fix: 'Create a free check at healthchecks.io and add its ping URL in Vercel as HEALTHCHECK_URL.' })

  return out
}

/** Plain text for the outside monitor's email and the Friday email: problems first. */
export function healthSummary(checks: readonly HealthCheck[]): string {
  const bad = checks.filter((c) => c.level !== 'ok').sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1))
  if (!bad.length) return 'QuayPilot: all checks pass.'
  return ['QuayPilot needs attention:', ...bad.map((c) => `${c.level === 'red' ? 'RED' : 'AMBER'}  ${c.title}. ${c.detail}${c.fix ? ` Fix: ${c.fix}` : ''}`), '', 'Open https://dashboard.fonenova.com/#settings'].join('\n')
}
