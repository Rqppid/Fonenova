/**
 * Our own DHL price for an order, worked out from the parcel's weight and size.
 *
 * It only PRICES. Nothing is saved and no invoice is touched: the owner reads the quote, picks one, it fills
 * the "Our DHL cost" box, and a person still presses "Make the draft invoice". A failed or odd quote leaves
 * the box alone and says why in plain words; a price is never guessed.
 *
 * The rate lookup itself is a `DhlRater` so it can be faked in tests; the real one is in dhl-mydhl.ts.
 */
import { getJson, type Store } from '../store'
import { clientsFrom, shippingBasisOf, type Client } from './clients'
import { load } from './fulfil'
import type { XeroApi } from './draft'

export interface DhlAddress { countryCode: string; postalCode: string; city: string }
export interface Parcel { weightKg: number; lengthCm: number; widthCm: number; heightCm: number }
export interface DhlQuote {
  service: string
  productCode: string | null
  /** Whole cents in `currency`. Never rounded from a float. */
  cents: number
  currency: string
  /** What DHL bills for: the larger of the real and the volumetric weight, as DHL reports it. Null when DHL did not say. */
  billableWeightKg: number | null
  actualWeightKg: number | null
  volumetricWeightKg: number | null
}
export type DhlRater = (q: { parcel: Parcel; origin: DhlAddress; destination: DhlAddress; plannedDate: string }) => Promise<DhlQuote[]>

/** A single parcel is never worth more than this to DHL; anything above is treated as a wrong reading, not a price. */
export const MAX_QUOTE_CENTS = 500_000
export const MAX_WEIGHT_KG = 70
export const MAX_SIDE_CM = 300

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const twoDp = (n: number) => Math.round(n * 100) === n * 100 || Math.abs(Math.round(n * 100) - n * 100) < 1e-9

export function checkParcel(raw: unknown): { ok: true; value: Parcel } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>
  const w = num(b.weightKg), l = num(b.lengthCm), wd = num(b.widthCm), h = num(b.heightCm)
  if (w === null || l === null || wd === null || h === null) return { ok: false, error: 'Enter the weight and the length, width and height.' }
  if (w <= 0) return { ok: false, error: 'The weight must be more than zero.' }
  if (w > MAX_WEIGHT_KG) return { ok: false, error: `DHL Express takes at most ${MAX_WEIGHT_KG} kg in one piece. Check the weight.` }
  if (![l, wd, h].every((x) => x > 0)) return { ok: false, error: 'The length, width and height must each be more than zero.' }
  if (![l, wd, h].every((x) => x <= MAX_SIDE_CM)) return { ok: false, error: `No side can be longer than ${MAX_SIDE_CM} cm. Check the size.` }
  if (![w, l, wd, h].every(twoDp)) return { ok: false, error: 'Use at most two decimals.' }
  return { ok: true, value: { weightKg: w, lengthCm: l, widthCm: wd, heightCm: h } }
}

export function checkOrigin(raw: unknown): { ok: true; value: DhlAddress } | { ok: false; error: string } {
  const b = (raw ?? {}) as Record<string, unknown>
  const cc = typeof b.countryCode === 'string' ? b.countryCode.trim().toUpperCase() : ''
  const postalCode = typeof b.postalCode === 'string' ? b.postalCode.trim() : ''
  const city = typeof b.city === 'string' ? b.city.trim() : ''
  if (!/^[A-Z]{2}$/.test(cc)) return { ok: false, error: 'The country is a two-letter code, for example BG or GB.' }
  if (!postalCode || postalCode.length > 20) return { ok: false, error: 'Enter the postcode parcels are collected from.' }
  if (!city || city.length > 60) return { ok: false, error: 'Enter the city parcels are collected from.' }
  return { ok: true, value: { countryCode: cc, postalCode, city } }
}

const COUNTRIES: Record<string, string> = {
  austria: 'AT', belgium: 'BE', bulgaria: 'BG', croatia: 'HR', cyprus: 'CY', 'czech republic': 'CZ', czechia: 'CZ', denmark: 'DK', estonia: 'EE', finland: 'FI', france: 'FR',
  germany: 'DE', greece: 'GR', hungary: 'HU', ireland: 'IE', italy: 'IT', latvia: 'LV', lithuania: 'LT', luxembourg: 'LU', malta: 'MT', netherlands: 'NL', 'the netherlands': 'NL',
  poland: 'PL', portugal: 'PT', romania: 'RO', slovakia: 'SK', slovenia: 'SI', spain: 'ES', sweden: 'SE', norway: 'NO', switzerland: 'CH', 'united kingdom': 'GB', uk: 'GB',
  'great britain': 'GB', england: 'GB', iceland: 'IS', serbia: 'RS', 'north macedonia': 'MK', albania: 'AL', 'bosnia and herzegovina': 'BA', montenegro: 'ME', moldova: 'MD', ukraine: 'UA', turkey: 'TR',
}
/** A Xero country is free text: a two-letter code is used as it is, a name is looked up. Anything else is not guessed. */
export const countryCodeOf = (raw: string | undefined | null): string | null => {
  const t = (raw ?? '').trim()
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  return COUNTRIES[t.toLowerCase()] ?? null
}

export function checkQuote(q: DhlQuote): string | null {
  if (!Number.isSafeInteger(q.cents) || q.cents < 1) return 'DHL returned a price that is not a positive amount.'
  if (q.cents > MAX_QUOTE_CENTS) return 'DHL returned an unusually high price, so it was not used. Check the weight and size.'
  if (q.currency !== 'EUR') return `DHL priced this in ${q.currency || 'an unknown currency'}, not euros. It was not converted. Enter the cost by hand.`
  return null
}

export interface DhlDeps {
  store: Store
  now?: Date
  xero: () => Pick<XeroApi, 'organisation'> & { contactAddress?: (contactId: string) => Promise<{ lines: string[]; city: string; postalCode: string; country: string } | null> } | null
  /** Null when DHL is not set up (no account or API key). */
  rater: DhlRater | null
}

export type DhlResult =
  | { ok: true; message: string; quotes: DhlQuote[] }
  | { ok: false; message: string; needsOrigin?: true }

export async function loadOrigin(store: Store): Promise<DhlAddress | null> {
  const c = checkOrigin(await getJson<unknown>(store, 'offers:dhl-origin'))
  return c.ok ? c.value : null
}

export async function setOrigin(store: Store, raw: unknown): Promise<{ ok: boolean; message: string }> {
  const c = checkOrigin(raw)
  if (!c.ok) return { ok: false, message: c.error }
  await store.set('offers:dhl-origin', c.value)
  return { ok: true, message: `Parcels are collected from ${c.value.city}, ${c.value.countryCode}.` }
}

/** Price one parcel for an order. Read-only: saves nothing. */
export async function quoteOrderShipping(offerId: string, d: DhlDeps, parcelRaw: unknown): Promise<DhlResult> {
  const p = checkParcel(parcelRaw)
  if (!p.ok) return { ok: false, message: p.error }
  const offer = await load(d.store, offerId)
  const f = offer?.fulfilment
  if (!offer || offer.status !== 'accepted' || !f) return { ok: false, message: 'This offer has not been accepted.' }
  if (f.draft.state !== 'waiting') return { ok: false, message: 'The draft invoice is not waiting for shipping, so there is nothing to price.' }
  const client = clientsFrom(await getJson<Client[]>(d.store, 'offers:clients')).find((c) => c.id === offer.pricing?.clientId)
  if (!client) return { ok: false, message: 'The client this offer was priced for no longer exists.' }
  if (shippingBasisOf(client) !== 'own_dhl') return { ok: false, message: 'This client is not charged our own DHL cost.' }
  if (!d.rater) return { ok: false, message: 'DHL is not set up on the dashboard yet. Enter the cost by hand.' }

  const origin = await loadOrigin(d.store)
  if (!origin) return { ok: false, message: 'Say where parcels are collected from first.', needsOrigin: true }

  const api = d.xero()
  if (!api?.contactAddress) return { ok: false, message: "The Xero connection is not set up, so the client's address cannot be read. Enter the cost by hand." }
  let contactId: string | null
  try {
    const org = await api.organisation()
    contactId = f.test && !org.isDemo ? client.liveTestContactId ?? null : client.xeroContactId
  } catch {
    return { ok: false, message: 'Xero could not be reached. Try again in a moment, or enter the cost by hand.' }
  }
  if (!contactId) return { ok: false, message: "This client has no Xero contact, so there is no address to ship to." }
  let addr: Awaited<ReturnType<NonNullable<typeof api.contactAddress>>>
  try {
    addr = await api.contactAddress(contactId)
  } catch {
    return { ok: false, message: "The client's address could not be read from Xero. Try again, or enter the cost by hand." }
  }
  if (!addr || !addr.city.trim() || !addr.postalCode.trim()) return { ok: false, message: "The client's Xero contact has no full address (city and postcode). Add it in Xero, then try again." }
  const cc = countryCodeOf(addr.country)
  if (!cc) return { ok: false, message: `The client's country in Xero (${addr.country.trim() || 'empty'}) is not one I can match to a DHL country. Set it in Xero as a two-letter code, for example BG.` }

  const plannedDate = (d.now ?? new Date()).toISOString().slice(0, 10)
  let quotes: DhlQuote[]
  try {
    quotes = await d.rater({ parcel: p.value, origin, destination: { countryCode: cc, postalCode: addr.postalCode.trim(), city: addr.city.trim() }, plannedDate })
  } catch (e) {
    return { ok: false, message: `DHL did not give a price: ${e instanceof Error ? e.message.slice(0, 200) : 'it could not be reached'}. Enter the cost by hand.` }
  }
  const good = quotes.filter((q) => checkQuote(q) === null)
  if (good.length === 0) return { ok: false, message: quotes.length ? (checkQuote(quotes[0]) ?? 'DHL gave no usable price.') : 'DHL has no service for this parcel and route. Enter the cost by hand.' }
  good.sort((a, b) => a.cents - b.cents)
  return { ok: true, message: `DHL gave ${good.length === 1 ? 'one price' : `${good.length} prices`}. Pick the service you use: it fills the box, nothing is saved until you press Make the draft invoice.`, quotes: good }
}
