/**
 * Runs the watchdog (lib/health.ts) against live state, and reports it to the outside monitor.
 *
 * HEALTHCHECK_URL is a Healthchecks.io ping URL (https://hc-ping.com/<uuid>). Every daily run
 * pings it: plain when nothing is red, "/fail" with the problems in the body when something is.
 * Healthchecks emails you on a fail ping, and also when no ping arrives at all (the job itself
 * stopped), so nothing can break without you hearing about it.
 */
import { loadOneDriveState, loadSettings, loadXeroState } from './data-source'
import { gmailConfig, gmailConnected } from './gmail'
import { healthChecks, healthSummary, type HealthCheck } from './health'
import { loadMakeStatus } from './make'
import { getHealth as getPaymentsHealth } from './payments-source'
import type { OffersStatus } from './offers/types'
import { getJson, getStore } from './store'
import { todayIso } from './periods'
import type { SourceStatus } from './sync-core'

const makeConfigured = () => !!(process.env.MAKE_API_TOKEN && process.env.MAKE_SCENARIOS)

/**
 * `paymentsTimeoutMs`: the daily job and the Friday email wait the full 7 s for the payments
 * service; the dashboard page passes a shorter limit so a hung service cannot hold the page up.
 */
export async function loadHealth(sources: SourceStatus[], opts: { paymentsTimeoutMs?: number } = {}): Promise<HealthCheck[]> {
  const [xero, oneDrive, make, settings, gmail, payments, offers] = await Promise.all([
    loadXeroState(),
    loadOneDriveState(),
    loadMakeStatus(),
    loadSettings(),
    gmailConfig() ? gmailConnected().then((g) => ({ configured: true, connected: g.connected }), () => ({ configured: true, connected: false })) : Promise.resolve({ configured: false, connected: false }),
    getPaymentsHealth(opts.paymentsTimeoutMs),
    getJson<OffersStatus>(getStore(), 'offers:status').catch(() => null),
  ])
  return healthChecks({
    now: new Date(),
    today: todayIso(),
    sources,
    xero: { configured: xero.configured, connected: xero.connected, snapshot: xero.snapshot },
    oneDrive: { configured: oneDrive.configured, connected: oneDrive.connected, canWrite: oneDrive.canWrite },
    trackerWritesWanted: !!process.env.ONEDRIVE_WRITE_TOKEN,
    make,
    makeConfigured: makeConfigured(),
    gmail,
    watchdogConfigured: !!process.env.HEALTHCHECK_URL,
    ignoredInvoiceNumbers: settings.ignoredInvoiceNumbers,
    payments,
    offers,
  })
}

/** Ping the outside monitor. Never throws: a monitor outage must not break the daily sync. */
export async function reportHealth(checks: readonly HealthCheck[], fetchImpl: typeof fetch = fetch): Promise<'ok' | 'fail' | 'not set up' | 'ping failed'> {
  const url = process.env.HEALTHCHECK_URL?.replace(/\/$/, '')
  if (!url) return 'not set up'
  const red = checks.some((c) => c.level === 'red')
  try {
    const res = await fetchImpl(red ? `${url}/fail` : url, { method: 'POST', body: healthSummary(checks), cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    return res.ok ? (red ? 'fail' : 'ok') : 'ping failed'
  } catch {
    return 'ping failed'
  }
}
