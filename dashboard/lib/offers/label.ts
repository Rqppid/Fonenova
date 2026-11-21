/**
 * A readable name for an offer, made from what is in it, so two offers from the same sender are never both just "Offer".
 * Pure, used by the list and the offer's header.
 */
import { ukTime } from '../format-uk'
import type { Offer, OfferLine } from './types'

export interface OfferLabel { title: string; detail: string }

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const tidy = (s: string) => s.replace(/^apple\s+/i, '').replace(/\s*\((?:20\d\d|e-?sim[^)]*)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim()

/** "iPad Pro 13-inch 1TB", or "iPhone 16 + 2 more models". */
export function productSummary(lines: readonly OfferLine[]): string {
  if (lines.length === 0) return 'No lines'
  const keys: string[] = []
  const name = new Map<string, string>()
  for (const l of lines) {
    const model = tidy(l.model)
    const k = model.toLowerCase()
    if (!name.has(k)) { name.set(k, model); keys.push(k) }
  }
  const first = lines.find((l) => tidy(l.model).toLowerCase() === keys[0])!
  const storages = [...new Set(lines.filter((l) => tidy(l.model).toLowerCase() === keys[0]).map((l) => l.storage).filter((x): x is string => !!x))]
  const head = `${name.get(keys[0])}${storages.length === 1 ? ` ${storages[0]}` : ''}`.trim() || tidy(first.model)
  return keys.length === 1 ? head : `${head} + ${keys.length - 1} more model${keys.length === 2 ? '' : 's'}`
}

export function offerLabel(o: Pick<Offer, 'lines' | 'source' | 'fulfilment' | 'pricing' | 'testOnly'>, clientName?: string | null): OfferLabel {
  const units = o.lines.reduce((n, l) => n + l.qty, 0)
  const cost = o.lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0)
  const bits = [`cost ${eur(cost)}`, `received ${ukTime(o.source.receivedAt)}`]
  if (clientName && o.pricing) bits.push(`for ${clientName}`)
  if (o.fulfilment?.orderRef) bits.push(o.fulfilment.orderRef)
  return { title: `${productSummary(o.lines)}, ${units.toLocaleString('en-GB')} unit${units === 1 ? '' : 's'}`, detail: bits.join(' · ') }
}
