/**
 * The dashboard's side of the public offers store: the separate Upstash database that
 * fonenova.com reads. The dashboard writes what a client may see (sale prices only) and reads
 * back their answer. The shapes mirror the public site's `lib/offers-public.ts`; a test keeps
 * the two in step. Nothing here touches the dashboard's own store.
 */
import 'server-only'
import crypto from 'node:crypto'

/** What a client sees. Sale prices only: there is no field for cost, margin or profit. */
export interface PublicOffer {
  clientName: string
  lines: { description: string; qty: number; unitSaleCents: number }[]
  units: number
  totalCents: number
  issuedAt: string
  expiresAt: string
  test: boolean
  status: 'open' | 'withdrawn'
}

export interface PublicAnswer {
  decision: 'accept' | 'decline'
  remarks: string
  at: string
  ip: string
  ua: string
}

export const OFFER_VALID_MS = 24 * 3600 * 1000
const KEEP_AFTER_EXPIRY_SECONDS = 30 * 24 * 3600

/** A new link token: 32 random bytes, 43 characters of base64url. */
export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

export function publicStoreConfigured(): boolean {
  return !!(process.env.OFFERS_PUBLIC_REDIS_URL && process.env.OFFERS_PUBLIC_REDIS_TOKEN)
}

async function run(cmd: (string | number)[]): Promise<unknown> {
  const url = process.env.OFFERS_PUBLIC_REDIS_URL
  const token = process.env.OFFERS_PUBLIC_REDIS_TOKEN
  if (!url || !token) throw new Error('The public offers store is not set up (OFFERS_PUBLIC_REDIS_URL and OFFERS_PUBLIC_REDIS_TOKEN)')
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd), cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`The public offers store answered ${res.status}`)
  const body = (await res.json()) as { result?: unknown; error?: string }
  if (body.error) throw new Error('The public offers store refused a command')
  return body.result
}

const parse = <T>(raw: unknown): T | null => {
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function putPublicOffer(hash: string, offer: PublicOffer): Promise<void> {
  const ttl = Math.max(3600, Math.ceil((Date.parse(offer.expiresAt) - Date.now()) / 1000) + KEEP_AFTER_EXPIRY_SECONDS)
  // NX: a link can only ever be created once.
  if ((await run(['SET', `pub:offer:${hash}`, JSON.stringify(offer), 'NX', 'EX', ttl])) !== 'OK') throw new Error('That link already exists')
}

export const getPublicOffer = async (hash: string) => parse<PublicOffer>(await run(['GET', `pub:offer:${hash}`]))
export const getPublicAnswer = async (hash: string) => parse<PublicAnswer>(await run(['GET', `pub:answer:${hash}`]))
export const deletePublicOffer = async (hash: string) => void (await run(['DEL', `pub:offer:${hash}`]))

/** Stop the link answering: the page then says the offer is no longer available. */
export async function withdrawPublicOffer(hash: string): Promise<void> {
  const o = await getPublicOffer(hash)
  if (!o) return
  await run(['SET', `pub:offer:${hash}`, JSON.stringify({ ...o, status: 'withdrawn' }), 'XX', 'KEEPTTL'])
}
