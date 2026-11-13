/**
 * Hamza's edits to an offer from the review screen: checked here before anything is saved.
 * Only these shapes are accepted; anything else is refused with a plain reason.
 */
import crypto from 'node:crypto'
import type { Offer, OfferLine, OfferStatus } from './types'

export type OfferEdit =
  | { action: 'save'; id: string; lines: OfferLine[] }
  | { action: 'status'; id: string; status: OfferStatus }

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)
const optStr = (v: unknown, max: number): string | null | undefined => (v === null || v === undefined || v === '' ? null : str(v, max) ?? undefined)

export function checkEdit(body: unknown): Checked<OfferEdit> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>
  const id = str(b.id, 80)
  if (!id || !/^of_[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: 'Unknown offer' }
  if (b.action === 'status') {
    if (b.status !== 'needs_review' && b.status !== 'ready' && b.status !== 'dismissed') return { ok: false, error: 'status must be needs_review, ready or dismissed' }
    return { ok: true, value: { action: 'status', id, status: b.status } }
  }
  if (b.action !== 'save') return { ok: false, error: 'action must be save or status' }
  if (!Array.isArray(b.lines) || b.lines.length > 100) return { ok: false, error: 'lines must be a list of at most 100' }
  const lines: OfferLine[] = []
  for (const [i, raw] of (b.lines as unknown[]).entries()) {
    const l = (raw ?? {}) as Record<string, unknown>
    const model = str(l.model, 80)
    const storage = optStr(l.storage, 40)
    const grade = optStr(l.grade, 40)
    const qty = l.qty
    const cost = l.unitCostCents
    if (!model) return { ok: false, error: `Line ${i + 1}: model is required (up to 80 characters)` }
    if (storage === undefined || grade === undefined) return { ok: false, error: `Line ${i + 1}: storage and grade are up to 40 characters` }
    if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1 || qty > 100_000) return { ok: false, error: `Line ${i + 1}: quantity must be a whole number from 1 to 100,000` }
    if (typeof cost !== 'number' || !Number.isSafeInteger(cost) || cost < 1 || cost > 10_000_000) return { ok: false, error: `Line ${i + 1}: unit cost must be a whole number of cents up to €100,000` }
    lines.push({
      id: typeof l.id === 'string' && /^[a-f0-9]{6,24}$/.test(l.id) ? l.id : crypto.randomBytes(6).toString('hex'),
      model, storage, grade, qty, unitCostCents: cost,
      sourceText: typeof l.sourceText === 'string' ? l.sourceText.slice(0, 300) : '',
      note: optStr(l.note, 200) ?? null,
    })
  }
  return { ok: true, value: { action: 'save', id, lines } }
}

/** The offer after an edit, with the change in its history. Ready needs at least one line. */
export function applyEdit(o: Offer, e: OfferEdit, now: string): Offer | { error: string } {
  if (e.action === 'save') {
    if (o.status === 'dismissed') return { error: 'Restore this offer before editing it' }
    return { ...o, lines: e.lines, updatedAt: now, audit: [...o.audit, { at: now, what: `Lines edited (${e.lines.length})` }].slice(-50) }
  }
  if (e.status === 'ready' && !o.lines.length) return { error: 'An offer needs at least one line to be ready' }
  const what = e.status === 'ready' ? 'Marked reviewed' : e.status === 'dismissed' ? 'Marked not an offer' : 'Back to review'
  return { ...o, status: e.status, updatedAt: now, audit: [...o.audit, { at: now, what }].slice(-50) }
}
