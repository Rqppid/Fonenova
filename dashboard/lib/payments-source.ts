/**
 * Server-only client for the fonenova-payments service (Revolut EUR matching, read-only).
 *
 * PAYMENTS_API_URL and PAYMENTS_API_TOKEN are server variables (never NEXT_PUBLIC_), set in
 * Production only; anywhere else the page says "not configured" rather than showing zeros. Every
 * call is no-store with a timeout. Problems come back as plain words that never include the token,
 * the service address or a response body, and nothing here logs a response.
 */
import 'server-only'
import type { Invoice, PaymentsHealth, PaymentsResult, PaymentsState, Tracker } from './payments-types'

const TIMEOUT_MS = 15_000

export function paymentsConfig(): { url: string; token: string } | null {
  const url = process.env.PAYMENTS_API_URL?.trim()
  const token = process.env.PAYMENTS_API_TOKEN?.trim()
  return url && token ? { url: url.replace(/\/$/, ''), token } : null
}

async function call(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<PaymentsResult<Response>> {
  const c = paymentsConfig()
  if (!c) return { kind: 'not-configured' }
  let res: Response
  try {
    res = await fetch(`${c.url}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${c.token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { kind: 'error', message: timeout ? 'The payments service did not answer in time.' : 'The payments service could not be reached.' }
  }
  if (res.ok) return { kind: 'ok', data: res }
  if (res.status === 400 || res.status === 409) {
    // The service explains a refusal in {error}; pass that sentence on, nothing else.
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    const error = typeof body?.error === 'string' ? body.error.slice(0, 300) : res.status === 409 ? 'The payments service refused this.' : 'The payments service rejected the request.'
    return { kind: 'refused', status: res.status, error }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'error', message: 'The payments service refused the dashboard’s token. Check PAYMENTS_API_TOKEN in Vercel.' }
  return { kind: 'error', message: `The payments service answered ${res.status}.` }
}

async function json<T>(r: PaymentsResult<Response>): Promise<PaymentsResult<T>> {
  if (r.kind !== 'ok') return r
  try {
    return { kind: 'ok', data: (await r.data.json()) as T }
  } catch {
    return { kind: 'error', message: 'The payments service sent something that is not valid data.' }
  }
}

export async function getState(): Promise<PaymentsResult<PaymentsState>> {
  const r = await json<PaymentsState>(await call('/api/state'))
  if (r.kind === 'ok' && (r.data.currency !== 'EUR' || !Array.isArray(r.data.customer_invoices) || !Array.isArray(r.data.supplier_invoices) || !Array.isArray(r.data.exceptions))) {
    return { kind: 'error', message: 'The payments service sent data in an unexpected shape, so nothing is shown.' }
  }
  return r
}

export async function getHealth(): Promise<PaymentsResult<PaymentsHealth>> {
  return json<PaymentsHealth>(await call('/api/health'))
}

export async function approve(body: { exception_id: number; invoice: string; amount_cents?: number }): Promise<PaymentsResult<{ ok: true }>> {
  return json<{ ok: true }>(await call('/api/approve', { method: 'POST', body }))
}

export async function dismiss(body: { exception_id: number; dismiss_reason: string }): Promise<PaymentsResult<{ ok: true }>> {
  return json<{ ok: true }>(await call('/api/approve', { method: 'POST', body }))
}

/** The tracker spreadsheet as the service sends it, for the download route to pass on. */
export async function trackerFile(key: Tracker): Promise<PaymentsResult<Response>> {
  return call(`/api/tracker?key=${key}`)
}

/**
 * What each party still owes or is owed: the sum of the service's own `remaining_cents` per party.
 * Customers and Mobile One are always kept apart, and no payments are ever added together.
 */
export function partyTotals(invoices: readonly Invoice[]): { party: string; remainingCents: number; open: number }[] {
  const by = new Map<string, { remainingCents: number; open: number }>()
  for (const i of invoices) {
    if (i.state === 'cancelled') continue
    const p = by.get(i.party) ?? { remainingCents: 0, open: 0 }
    p.remainingCents += i.remaining_cents
    if (i.state === 'not_paid' || i.state === 'partly_paid') p.open++
    by.set(i.party, p)
  }
  return [...by.entries()].map(([party, v]) => ({ party, ...v })).sort((a, b) => b.remainingCents - a.remainingCents)
}
