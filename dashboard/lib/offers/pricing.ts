/**
 * Prices an offer for one client: sale price = unit cost + margin, in whole cents. Pure, so the
 * screen and the server run the same code and the server's figures are the ones that count.
 *
 * - Fixed and locked clients (EU Telecoms): every line is cost + the fixed margin; no overrides.
 * - Manual clients (Wave): one per-unit margin for the offer, a per-line override allowed.
 * - A line under the minimum margin (a safety net for typos, e.g. 0.70 for 7.00) is flagged, and
 *   the offer can only be marked priced after the owner ticks that he knows.
 */
import { offerFlags } from './check'
import { multiplierOf, type Client } from './clients'
import type { Offer, OfferLine, OfferPricing } from './types'

export const MIN_MARGIN_CENTS = 400
export const MAX_MARGIN_CENTS = 50_000

export interface PricingInput {
  clientId: string
  marginCents: number | null
  overrides: Record<string, number>
  ackLow: boolean
  /** What the client is charged for shipping, if the owner changed it from the default (Mobile One's x the client's multiplier). */
  shippingCents?: number | null
  /** Mobile One's shipping, from the offer itself (never from the browser's say-so on the server). */
  mobileShipping?: { cents: number | null; none: boolean }
}

/** The pricing input for an offer that is already priced: its saved price plus its saved shipping. */
export const pricingInputOf = (o: Pick<Offer, 'pricing' | 'shipping'>): PricingInput => ({
  clientId: o.pricing?.clientId ?? '',
  marginCents: o.pricing?.marginCents ?? null,
  overrides: o.pricing?.overrides ?? {},
  ackLow: o.pricing?.ackLow ?? false,
  shippingCents: o.pricing?.shippingCents ?? null,
  mobileShipping: { cents: o.shipping?.mobileOneCents ?? null, none: o.shipping?.source === 'none' },
})

const MAX_SHIPPING_CENTS = 10_000_000

export interface ShippingResult {
  mobileOneCents: number | null
  multiplier: number
  /** Mobile One's shipping x the multiplier, rounded to the cent. Null until Mobile One's shipping is known. */
  defaultClientCents: number | null
  /** What the client is charged: 0 when there is no shipping. Null while it cannot be worked out. */
  clientCents: number | null
  none: boolean
  error: string | null
}

/**
 * Shipping for one client. Never defaults to zero: with no Mobile One figure (and no "no shipping"
 * confirmation) there is no answer, only an error asking for one.
 */
export function shippingFor(client: Client, input: Pick<PricingInput, 'shippingCents' | 'mobileShipping'>): ShippingResult {
  const multiplier = multiplierOf(client)
  const m = input.mobileShipping
  const base = { multiplier, none: false }
  if (m?.none) return { ...base, none: true, mobileOneCents: 0, defaultClientCents: 0, clientCents: 0, error: null }
  if (!m || m.cents === null) return { ...base, mobileOneCents: null, defaultClientCents: null, clientCents: null, error: "Enter Mobile One's shipping cost on the offer (or confirm there is no shipping) before it can be priced and sent. It is never assumed to be zero." }
  if (!Number.isSafeInteger(m.cents) || m.cents < 1 || m.cents > MAX_SHIPPING_CENTS) return { ...base, mobileOneCents: m.cents, defaultClientCents: null, clientCents: null, error: "Mobile One's shipping must be an amount between €0.01 and €100,000.00." }
  const def = Math.round(m.cents * multiplier)
  const own = input.shippingCents
  if (own !== null && own !== undefined) {
    if (!Number.isSafeInteger(own) || own < 1 || own > MAX_SHIPPING_CENTS) return { ...base, mobileOneCents: m.cents, defaultClientCents: def, clientCents: null, error: "The client's shipping must be an amount between €0.01 and €100,000.00." }
    return { ...base, mobileOneCents: m.cents, defaultClientCents: def, clientCents: own, error: null }
  }
  return { ...base, mobileOneCents: m.cents, defaultClientCents: def, clientCents: def, error: null }
}

export interface PricedLine {
  id: string
  marginCents: number | null
  saleCents: number | null
  lineSaleCents: number | null
  lineProfitCents: number | null
  low: boolean
  overridden: boolean
  /** Why this line cannot be priced yet. */
  blocked: string | null
}

export interface PricingResult {
  lines: PricedLine[]
  /** `saleCents` is the items only; `shippingCents` is shipping; `grandCents` is what the client pays in all. */
  totals: { units: number; costCents: number; saleCents: number; profitCents: number; profitPerUnitCents: number | null; shippingCents: number; grandCents: number; shippingProfitCents: number }
  shipping: ShippingResult
  lowCount: number
  /** The owner must tick the box before this can be marked priced. */
  needsAck: boolean
  errors: string[]
  /** Everything needed to mark it priced is in place. */
  ok: boolean
}

const validMargin = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_MARGIN_CENTS

export function priceOffer(lines: readonly OfferLine[], client: Client, input: PricingInput): PricingResult {
  const errors: string[] = []
  const flags = offerFlags(lines)
  const ids = new Set(lines.map((l) => l.id))
  const overrides = Object.entries(input.overrides ?? {})
  const locked = client.margin.type === 'fixed' && client.margin.locked
  if (locked && overrides.length) errors.push(`${client.name}'s margin is locked, so lines cannot be changed one by one.`)
  for (const [id, m] of overrides) {
    if (!ids.has(id)) errors.push('A per-line margin is for a line that is not in this offer.')
    else if (!validMargin(m)) errors.push('A per-line margin must be between €0.01 and €500.00.')
  }
  const base = client.margin.type === 'fixed' ? client.margin.perUnitCents : input.marginCents
  // A manual client needs a margin for every line: either the one for the whole offer, or one typed on each line.
  const everyLineOwn = lines.length > 0 && lines.every((l) => validMargin(input.overrides?.[l.id]))
  if (client.margin.type === 'manual' && !validMargin(base) && !everyLineOwn) errors.push('Enter the margin per unit for this offer (between €0.01 and €500.00), or a margin on every line.')

  const priced: PricedLine[] = lines.map((l) => {
    const o = locked ? undefined : input.overrides?.[l.id]
    const overridden = validMargin(o)
    const margin = overridden ? (o as number) : validMargin(base) ? base : null
    const blocked = (flags.get(l.id) ?? []).find((f) => f.level === 'error')?.message ?? null
    const ok = margin !== null && l.qty > 0 && l.unitCostCents > 0
    return {
      id: l.id,
      marginCents: margin,
      saleCents: ok ? l.unitCostCents + margin : null,
      lineSaleCents: ok ? l.qty * (l.unitCostCents + margin) : null,
      lineProfitCents: ok ? l.qty * margin : null,
      low: margin !== null && margin < MIN_MARGIN_CENTS,
      overridden,
      blocked,
    }
  })
  const blockedCount = priced.filter((p) => p.blocked).length
  if (blockedCount) errors.push(`${blockedCount} line${blockedCount === 1 ? '' : 's'} need fixing in the review first (see the flags above).`)
  if (!lines.length) errors.push('This offer has no lines.')
  const shipping = shippingFor(client, input)
  if (shipping.error) errors.push(shipping.error)

  const units = lines.reduce((n, l) => n + l.qty, 0)
  const costCents = lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0)
  const saleCents = priced.reduce((n, p) => n + (p.lineSaleCents ?? 0), 0)
  const profitCents = priced.reduce((n, p) => n + (p.lineProfitCents ?? 0), 0)
  const lowCount = priced.filter((p) => p.low).length
  const needsAck = lowCount > 0
  const complete = priced.length > 0 && priced.every((p) => p.saleCents !== null)
  return {
    lines: priced,
    totals: {
      units, costCents, saleCents, profitCents, profitPerUnitCents: units ? Math.round(profitCents / units) : null,
      shippingCents: shipping.clientCents ?? 0,
      grandCents: saleCents + (shipping.clientCents ?? 0),
      shippingProfitCents: shipping.clientCents !== null && shipping.mobileOneCents !== null ? shipping.clientCents - shipping.mobileOneCents : 0,
    },
    shipping,
    lowCount,
    needsAck,
    errors,
    ok: errors.length === 0 && complete && (!needsAck || input.ackLow === true),
  }
}

/** What is saved on the offer once priced. */
export const toPricing = (input: PricingInput, client: Client, now: string): OfferPricing => ({
  clientId: client.id,
  marginCents: client.margin.type === 'manual' ? input.marginCents : null,
  overrides: client.margin.type === 'fixed' && client.margin.locked ? {} : { ...input.overrides },
  ackLow: input.ackLow === true,
  shippingCents: shippingFor(client, input).clientCents ?? 0,
  pricedAt: now,
})

/**
 * The only figures Phase 3 may publish to a client: description, quantity and sale price. No
 * cost, no margin, no profit. The type has no field for them, so they cannot leak by accident.
 */
export interface PublicLine { description: string; qty: number; unitSaleCents: number }
export function publicLines(lines: readonly OfferLine[], priced: PricingResult): PublicLine[] {
  return lines.map((l, i) => ({
    description: [l.model, l.storage, l.grade].filter(Boolean).join(' '),
    qty: l.qty,
    unitSaleCents: priced.lines[i].saleCents ?? 0,
  }))
}
