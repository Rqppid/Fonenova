/**
 * Checks every request to the payments routes before anything reaches the service. Only these
 * fields, in these shapes, are ever forwarded; anything else is refused with a 400.
 */
import type { Tracker } from './payments-types'

const INVOICE = /^[0-9/]{1,20}$/
const TRACKER_KEYS: readonly Tracker[] = ['wave', 'tw', 'm1']

const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

export function checkApprove(body: unknown): Checked<{ exception_id: number; invoice: string; amount_cents?: number }> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>
  if (!positiveInt(b.exception_id)) return { ok: false, error: 'exception_id must be a positive whole number' }
  if (typeof b.invoice !== 'string' || !INVOICE.test(b.invoice)) return { ok: false, error: 'invoice must be digits and slashes only, up to 20 characters' }
  if (b.amount_cents !== undefined && b.amount_cents !== null && !positiveInt(b.amount_cents)) return { ok: false, error: 'amount_cents must be a positive whole number of cents' }
  return { ok: true, value: { exception_id: b.exception_id, invoice: b.invoice, ...(positiveInt(b.amount_cents) ? { amount_cents: b.amount_cents } : {}) } }
}

export function checkDismiss(body: unknown): Checked<{ exception_id: number; dismiss_reason: string }> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>
  if (!positiveInt(b.exception_id)) return { ok: false, error: 'exception_id must be a positive whole number' }
  const reason = typeof b.dismiss_reason === 'string' ? b.dismiss_reason.trim() : ''
  if (reason.length < 3 || reason.length > 300) return { ok: false, error: 'A reason of 3 to 300 characters is required to dismiss' }
  return { ok: true, value: { exception_id: b.exception_id, dismiss_reason: reason } }
}

export function checkTracker(key: string | null): Checked<Tracker> {
  return key && (TRACKER_KEYS as readonly string[]).includes(key) ? { ok: true, value: key as Tracker } : { ok: false, error: 'key must be wave, tw or m1' }
}
