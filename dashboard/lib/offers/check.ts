/**
 * Checks on each offer line, so Hamza's review starts with what looks wrong. Pure and free of
 * server imports, so the review screen runs the same checks as he edits.
 */
import type { LineFlag, OfferLine } from './types'

/** Models Mobile One sells today. Anything else is flagged ("iPhone 7 Pro" usually means 17 Pro). */
const KNOWN: RegExp[] = [
  /^(apple\s+)?iphone\s+(1[1-7])\s*(e|plus|mini|air|pro\s*max|pro)?$/i,
  /^(apple\s+)?iphone\s+(16e|se)$/i,
  /^(samsung\s+)?(galaxy\s+)?s2[1-6]\s*(fe|edge|plus|\+|ultra)?(\s*5g)?$/i,
  /^(samsung\s+)?(galaxy\s+)?a[0-9]{2}(\s*5g)?$/i,
  /^(samsung\s+)?(galaxy\s+)?z\s*(fold|flip)\s*[3-7](\s*fe)?$/i,
]
const STORAGE = /^(64|128|256|512)\s*gb$|^(1|2)\s*tb$/i
const MIN_CENTS = 20_00
const MAX_CENTS = 2_500_00

/** "IPHONE 17 AIR" and "Apple iPhone 17 Air (e-Sim)" both → "iphone 17 air". */
export function modelKey(model: string): string {
  return model.toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(apple|samsung|galaxy|5g|e-?sim|dual sim)\b/g, '').replace(/\s+/g, ' ').trim()
}

export const knownModel = (model: string) => KNOWN.some((r) => r.test(model.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim()))

const digits = (s: string) => s.replace(/[^0-9]/g, '')

export function lineFlags(line: OfferLine, all: readonly OfferLine[] = [line]): LineFlag[] {
  const f: LineFlag[] = []
  if (!knownModel(line.model)) f.push({ code: 'model', level: 'error', message: `"${line.model}" is not a model Mobile One usually sells. Check it is not a typo (e.g. iPhone 7 Pro for 17 Pro).` })
  if (!line.storage) f.push({ code: 'storage', level: 'warn', message: 'No storage size given.' })
  else if (!STORAGE.test(line.storage.trim())) f.push({ code: 'storage', level: 'warn', message: `Storage "${line.storage}" looks unusual.` })
  if (!Number.isSafeInteger(line.qty) || line.qty <= 0) f.push({ code: 'qty', level: 'error', message: 'Quantity must be a whole number above 0.' })
  if (!Number.isSafeInteger(line.unitCostCents) || line.unitCostCents < MIN_CENTS || line.unitCostCents > MAX_CENTS) f.push({ code: 'cost', level: 'error', message: 'Unit cost is outside €20 to €2,500. Check the price.' })
  const same = all.filter((o) => modelKey(o.model) === modelKey(line.model) && (o.storage ?? '').toLowerCase() === (line.storage ?? '').toLowerCase() && (o.grade ?? '').toLowerCase() === (line.grade ?? '').toLowerCase())
  if (same.length > 1) f.push({ code: 'duplicate', level: 'warn', message: 'The same model, storage and grade appears more than once.' })
  // The reader must have copied price and quantity from the email: both should appear in its line.
  if (line.sourceText) {
    const src = digits(line.sourceText)
    const price = digits((line.unitCostCents / 100).toFixed(2)).replace(/00$/, '')
    if (!src.includes(price) || !src.includes(String(line.qty))) f.push({ code: 'source', level: 'warn', message: 'Price or quantity does not match the email line exactly. Check it against the email.' })
  }
  if (line.note) f.push({ code: 'note', level: 'warn', message: line.note })
  return f
}

export function offerFlags(lines: readonly OfferLine[]): Map<string, LineFlag[]> {
  return new Map(lines.map((l) => [l.id, lineFlags(l, lines)]))
}

export const offerCostCents = (lines: readonly OfferLine[]) => lines.reduce((n, l) => n + l.qty * l.unitCostCents, 0)
export const offerUnits = (lines: readonly OfferLine[]) => lines.reduce((n, l) => n + l.qty, 0)
