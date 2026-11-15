/**
 * Hamza's edits to an offer from the review screen: checked here before anything is saved.
 * Only these shapes are accepted; anything else is refused with a plain reason.
 */
import crypto from 'node:crypto'
import type { Client } from './clients'
import { priceOffer, toPricing, type PricingInput } from './pricing'
import type { Offer, OfferLine, OfferStatus } from './types'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export type OfferEdit =
  | { action: 'save'; id: string; lines: OfferLine[]; /** Mobile One's shipping as typed on the review screen; undefined leaves it as it is. */ shipping?: { cents: number | null; none: boolean } }
  | { action: 'status'; id: string; status: OfferStatus }
  | { action: 'price'; id: string; input: PricingInput }
  | { action: 'unprice'; id: string }
  | { action: 'send'; id: string }
  | { action: 'withdraw'; id: string }
  | { action: 'unlock'; id: string }
  | { action: 'create_test' }
  | { action: 'reply_ok'; id: string }
  | { action: 'fulfil_retry'; id: string }
  | { action: 'invoice_approve'; id: string; confirm: boolean }
  | { action: 'invoice_send'; id: string; confirm: boolean }
  | { action: 'invoice_file'; id: string }
  | { action: 'draft_recheck'; id: string }
  | { action: 'bill_confirm'; id: string; billId: string }

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null)
const optStr = (v: unknown, max: number): string | null | undefined => (v === null || v === undefined || v === '' ? null : str(v, max) ?? undefined)

export function checkEdit(body: unknown): Checked<OfferEdit> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>
  if (b.action === 'create_test') return { ok: true, value: { action: 'create_test' } }
  const id = str(b.id, 80)
  if (!id || !/^of_[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: 'Unknown offer' }
  if (b.action === 'status') {
    if (b.status !== 'needs_review' && b.status !== 'ready' && b.status !== 'dismissed') return { ok: false, error: 'status must be needs_review, ready or dismissed' }
    return { ok: true, value: { action: 'status', id, status: b.status } }
  }
  if (b.action === 'unprice') return { ok: true, value: { action: 'unprice', id } }
  if (b.action === 'send' || b.action === 'withdraw' || b.action === 'unlock' || b.action === 'reply_ok' || b.action === 'fulfil_retry' || b.action === 'invoice_file' || b.action === 'draft_recheck') return { ok: true, value: { action: b.action, id } }
  if (b.action === 'invoice_approve' || b.action === 'invoice_send') return { ok: true, value: { action: b.action, id, confirm: b.confirm === true } }
  if (b.action === 'bill_confirm') {
    const billId = str(b.billId, 80)
    if (!billId || !/^[0-9a-fA-F-]{20,40}$/.test(billId)) return { ok: false, error: 'Choose a bill from the suggestions' }
    return { ok: true, value: { action: 'bill_confirm', id, billId } }
  }
  if (b.action === 'price') {
    const clientId = str(b.clientId, 40)
    if (!clientId || !/^c_[a-z0-9]{2,24}$/.test(clientId)) return { ok: false, error: 'Choose a client' }
    const margin = b.marginCents === null || b.marginCents === undefined ? null : b.marginCents
    if (margin !== null && (typeof margin !== 'number' || !Number.isSafeInteger(margin))) return { ok: false, error: 'The margin must be a whole number of cents' }
    const raw = b.overrides ?? {}
    if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) return { ok: false, error: 'overrides must be an object' }
    const overrides: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[a-f0-9]{6,24}$/.test(k) || typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, error: 'A per-line margin must be a whole number of cents' }
      overrides[k] = v
    }
    const sc = b.shippingCents === null || b.shippingCents === undefined || b.shippingCents === '' ? null : b.shippingCents
    if (sc !== null && (typeof sc !== 'number' || !Number.isSafeInteger(sc))) return { ok: false, error: "The client's shipping must be a whole number of cents" }
    return { ok: true, value: { action: 'price', id, input: { clientId, marginCents: margin as number | null, overrides, ackLow: b.ackLow === true, shippingCents: sc as number | null } } }
  }
  if (b.action !== 'save') return { ok: false, error: 'action must be save, status, price, unprice, send, withdraw, unlock, reply_ok, fulfil_retry, create_test, invoice_approve, invoice_send, invoice_file, draft_recheck or bill_confirm' }
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
  let shipping: { cents: number | null; none: boolean } | undefined
  if (b.shipping !== undefined) {
    const s = (b.shipping ?? {}) as Record<string, unknown>
    const cents = s.cents === null || s.cents === undefined ? null : s.cents
    if (cents !== null && (typeof cents !== 'number' || !Number.isSafeInteger(cents) || cents < 1 || cents > 10_000_000)) return { ok: false, error: "Mobile One's shipping must be an amount between €0.01 and €100,000.00" }
    if (s.none !== undefined && typeof s.none !== 'boolean') return { ok: false, error: 'The no-shipping confirmation must be true or false' }
    shipping = { cents: s.none === true ? null : (cents as number | null), none: s.none === true }
  }
  return { ok: true, value: { action: 'save', id, lines, ...(shipping ? { shipping } : {}) } }
}

/** The offer after an edit, with the change in its history. Ready needs at least one line. */
export function applyEdit(o: Offer, e: OfferEdit, now: string, clients: readonly Client[] = []): Offer | { error: string } {
  const log = (what: string) => [...o.audit, { at: now, what }].slice(-50)
  // Once an offer has been sent it is locked: only withdraw, unlock or the client's answer change it.
  if (o.status === 'sent' || o.status === 'accepted' || o.status === 'declined' || o.status === 'expired') {
    return { error: o.status === 'sent' ? 'This offer has been sent. Withdraw it to change it.' : o.status === 'accepted' ? 'This offer was accepted, so it can no longer be changed.' : 'This offer was answered or expired. Unlock it to reprice it.' }
  }
  if (e.action === 'send' || e.action === 'withdraw' || e.action === 'unlock' || e.action === 'reply_ok' || e.action === 'fulfil_retry' || e.action === 'create_test' || e.action === 'invoice_approve' || e.action === 'invoice_send' || e.action === 'invoice_file' || e.action === 'draft_recheck' || e.action === 'bill_confirm') return { error: 'That action is handled separately' }
  if (e.action === 'unprice') {
    if (!o.pricing) return { error: 'This offer is not priced' }
    const { pricing: _p, ...rest } = o
    return { ...rest, updatedAt: now, audit: log('Price removed') }
  }
  if (e.action === 'price') {
    if (o.status !== 'ready') return { error: 'Mark the offer reviewed before pricing it' }
    const client = clients.find((c) => c.id === e.input.clientId)
    if (!client) return { error: 'That client no longer exists' }
    if (o.testOnly && !client.test) return { error: 'This is a test offer: it can only be priced for a test client.' }
    // Mobile One's shipping comes from the offer itself, never from the request.
    const input: PricingInput = { ...e.input, mobileShipping: { cents: o.shipping?.mobileOneCents ?? null, none: o.shipping?.source === 'none' } }
    const r = priceOffer(o.lines, client, input)
    if (!r.ok) return { error: r.errors[0] ?? (r.needsAck ? `Tick the box to confirm the ${r.lowCount} line${r.lowCount === 1 ? '' : 's'} under the minimum margin` : 'This offer cannot be priced yet') }
    return { ...o, pricing: toPricing(input, client, now), updatedAt: now, audit: log(`Priced for ${client.name}: items ${eur(r.totals.saleCents)} + shipping ${eur(r.totals.shippingCents)} = ${eur(r.totals.grandCents)}, profit ${eur(r.totals.profitCents + r.totals.shippingProfitCents)}`) }
  }
  // Changing the lines or the status makes any saved price stale, so it is removed with a note.
  const { pricing, ...bare } = o
  const stale = pricing ? '. Price removed: price it again' : ''
  if (e.action === 'save') {
    if (o.status === 'dismissed') return { error: 'Restore this offer before editing it' }
    let shipping = o.shipping
    if (e.shipping) {
      const was = o.shipping
      shipping = e.shipping.none ? { mobileOneCents: 0, source: 'none', sourceText: null }
        : e.shipping.cents === null ? { mobileOneCents: null, source: 'manual', sourceText: was?.sourceText ?? null }
        : was && was.source === 'email' && was.mobileOneCents === e.shipping.cents ? was
        : { mobileOneCents: e.shipping.cents, source: 'manual', sourceText: was?.sourceText ?? null }
    }
    const shipNote = e.shipping && JSON.stringify(shipping) !== JSON.stringify(o.shipping) ? `; shipping ${shipping?.source === 'none' ? 'set to none' : shipping?.mobileOneCents === null ? 'cleared' : `set to ${eur(shipping!.mobileOneCents!)}`}` : ''
    return { ...bare, lines: e.lines, ...(shipping ? { shipping } : {}), updatedAt: now, audit: log(`Lines edited (${e.lines.length})${shipNote}${stale}`) }
  }
  if (e.status === 'ready' && !o.lines.length) return { error: 'An offer needs at least one line to be ready' }
  const what = e.status === 'ready' ? 'Marked reviewed' : e.status === 'dismissed' ? 'Marked not an offer' : 'Back to review'
  return { ...(e.status === 'ready' ? o : bare), status: e.status, updatedAt: now, audit: log(`${what}${e.status === 'ready' ? '' : stale}`) }
}
