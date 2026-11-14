/**
 * Sends the Friday cash email: loads the same data the page does, builds the digest and sends it
 * through the connected Gmail account. Records the outcome so Settings can show the last send.
 */
import { getDataSource, loadFxRate, loadSettings, loadXeroState } from './data-source'
import { buildDigest, type Digest } from './digest'
import { gmailConfig, gmailConnected, sendGmail, type GmailState } from './gmail'
import { liveView } from './live-view'
import { todayIso } from './periods'
import { getJson, getStore } from './store'
import { syncSources } from './sync'
import { draftsAwaiting } from './xero/pairing'
import { loadHealth } from './watchdog'

export interface DigestStatus {
  at: string
  ok: boolean
  message: string
  to: string | null
  test: boolean
}

export async function lastDigest(): Promise<DigestStatus | null> {
  try {
    return await getJson<DigestStatus>(getStore(), 'digest:last')
  } catch {
    return null
  }
}

export async function prepareDigest(): Promise<{ digest: Digest } | { error: string }> {
  const sources = await syncSources({ force: true }) // fresh Xero and files before anything is sent
  const [result, xero, fx] = await Promise.all([getDataSource().load(), loadXeroState(), loadFxRate()])
  if (!result.ok) return { error: `${result.title}: ${result.detail}` }
  const today = todayIso()
  const view = liveView(result.ledger, xero.snapshot, xero.pairs, today)
  const digest = buildDigest({
    view,
    fx: fx.ok ? fx.fx : null,
    today,
    appUrl: process.env.AUTH_URL ?? 'http://localhost:3100',
    drafts: draftsAwaiting(xero.snapshot),
    problems: view.checks.items,
    health: await loadHealth(sources).catch(() => undefined),
  })
  return { digest }
}

export async function sendDigest(opts: { test?: boolean } = {}): Promise<DigestStatus> {
  const c = gmailConfig()
  const record = async (s: Omit<DigestStatus, 'at' | 'test'>): Promise<DigestStatus> => {
    const status = { ...s, at: new Date().toISOString(), test: !!opts.test }
    await getStore().set('digest:last', status).catch(() => {})
    return status
  }
  if (!c) return record({ ok: false, message: 'Not set up: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are needed', to: null })
  try {
    const p = await prepareDigest()
    if ('error' in p) return record({ ok: false, message: p.error, to: c.to })
    const subject = opts.test ? `[Test] ${p.digest.subject}` : p.digest.subject
    const sent = await sendGmail(c, { subject, text: p.digest.text, html: p.digest.html })
    return record({ ok: true, message: `Sent from ${sent.from}`, to: sent.to })
  } catch (e) {
    return record({ ok: false, message: e instanceof Error ? e.message.slice(0, 240) : String(e), to: c.to })
  }
}

export interface WeeklyEmailState {
  configured: boolean
  connected: boolean
  /** The Friday email is switched on in Settings. */
  enabled: boolean
  /** The connection can read mail (Offers needs it). */
  canRead: boolean
  /** Whether the saved login works, and if not exactly why. */
  state: GmailState
  message: string | null
  from: string | null
  to: string | null
  last: DigestStatus | null
}

export async function loadWeeklyEmailState(): Promise<WeeklyEmailState> {
  const c = gmailConfig()
  if (!c) return { configured: false, connected: false, enabled: false, canRead: false, state: 'not_connected', message: null, from: null, to: null, last: null }
  const enabled = await loadSettings().then((s) => s.fridayEmail, () => false)
  const [g, last] = await Promise.all([gmailConnected(), lastDigest()])
  return { configured: true, connected: g.connected, enabled, canRead: g.canRead, state: g.state, message: g.message, from: g.email, to: c.to, last }
}
