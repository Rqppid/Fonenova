/**
 * The real DHL Express rate lookup (MyDHL API, GET /rates).
 *
 * NOT VERIFIED AGAINST DHL'S OFFICIAL DOCS OR A LIVE ACCOUNT. The query names and the response shape below
 * are from memory of the MyDHL REST rating call; developer.dhl.com could not be read from the build
 * environment and there are no API credentials yet. Before this is trusted: run it against DHL's test
 * environment (DHL_API_ENV=test) and compare a quote with the DHL screen. Until then the dashboard only
 * fills a box that a person reads and confirms, and any unexpected response is an error, never a price.
 *
 * Credentials come from the environment (set through the secure credential form, never the repo):
 *   DHL_ACCOUNT_NUMBER, DHL_API_KEY, DHL_API_SECRET, and optionally DHL_API_ENV=test.
 */
import type { DhlQuote, DhlRater } from './dhl'

const BASE = { live: 'https://express.api.dhl.com/mydhlapi', test: 'https://express.api.dhl.com/mydhlapi/test' }

export interface MyDhlConfig { account: string; key: string; secret: string; env: 'live' | 'test' }

export function myDhlConfig(env: Record<string, string | undefined> = process.env): MyDhlConfig | null {
  const account = env.DHL_ACCOUNT_NUMBER?.trim(), key = env.DHL_API_KEY?.trim(), secret = env.DHL_API_SECRET?.trim()
  if (!account || !key || !secret) return null
  return { account, key, secret, env: env.DHL_API_ENV?.trim().toLowerCase() === 'test' ? 'test' : 'live' }
}

const toCents = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null
  const c = Math.round(v * 100)
  return Math.abs(c - v * 100) < 1e-6 ? c : null // a price with more than two decimals is not trusted
}
const kg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

export function parseRates(body: unknown): DhlQuote[] {
  const products = (body as { products?: unknown })?.products
  if (!Array.isArray(products)) throw new Error('the answer was not in the expected form')
  const out: DhlQuote[] = []
  for (const p of products as Record<string, unknown>[]) {
    const prices = Array.isArray(p.totalPrice) ? (p.totalPrice as Record<string, unknown>[]) : []
    // BILLC is the price in the currency the account is billed in.
    const billed = prices.find((x) => x.currencyType === 'BILLC')
    const cents = toCents(billed?.price)
    if (!billed || cents === null || typeof billed.priceCurrency !== 'string' || typeof p.productName !== 'string') continue
    const w = (p.weight ?? {}) as Record<string, unknown>
    const provided = kg(w.provided), volumetric = kg(w.volumetric)
    out.push({ service: p.productName, productCode: typeof p.productCode === 'string' ? p.productCode : null, cents, currency: billed.priceCurrency, billableWeightKg: provided !== null && volumetric !== null ? Math.max(provided, volumetric) : null, actualWeightKg: provided, volumetricWeightKg: volumetric })
  }
  return out
}

export function myDhlRater(cfg: MyDhlConfig, fetchImpl: typeof fetch = fetch): DhlRater {
  return async ({ parcel, origin, destination, plannedDate }) => {
    const q = new URLSearchParams({
      accountNumber: cfg.account, originCountryCode: origin.countryCode, originPostalCode: origin.postalCode, originCityName: origin.city,
      destinationCountryCode: destination.countryCode, destinationPostalCode: destination.postalCode, destinationCityName: destination.city,
      weight: String(parcel.weightKg), length: String(parcel.lengthCm), width: String(parcel.widthCm), height: String(parcel.heightCm),
      plannedShippingDate: plannedDate, isCustomsDeclarable: String(origin.countryCode !== destination.countryCode && !isEu(origin.countryCode, destination.countryCode)), unitOfMeasurement: 'metric',
    })
    const res = await fetchImpl(`${BASE[cfg.env]}/rates?${q}`, { headers: { Authorization: `Basic ${Buffer.from(`${cfg.key}:${cfg.secret}`).toString('base64')}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      const detail = await res.json().then((j: { detail?: string; message?: string }) => j.detail ?? j.message ?? '').catch(() => '')
      throw new Error(`DHL answered ${res.status}${detail ? `: ${String(detail).slice(0, 150)}` : ''}`)
    }
    return parseRates(await res.json().catch(() => null))
  }
}

const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' '))
const isEu = (a: string, b: string) => EU.has(a) && EU.has(b)
