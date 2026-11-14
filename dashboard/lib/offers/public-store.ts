/**
 * The dashboard's side of the public offers store: the separate Upstash database that
 * fonenova.com reads. The dashboard writes what a client may see (sale prices only) and reads
 * back their answer. The shapes mirror the public site's `lib/offers-public.ts`; a test keeps
 * the two in step. Nothing here touches the dashboard's own store.
 */
import 'server-only'
import crypto from 'node:crypto'
import { checkPublicStoreEnv } from './env-check'

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

/** Set, and not obviously mistyped. */
export function publicStoreConfigured(): boolean {
  return checkPublicStoreEnv(process.env).configured
}

/** Why the public store cannot be used, in plain words naming the variable (never its value), or null. */
export function publicStoreProblem(): string | null {
  const c = checkPublicStoreEnv(process.env)
  if (c.problem) return c.problem
  return c.configured ? null : 'The public offers store is not set up yet (OFFERS_PUBLIC_REDIS_URL and OFFERS_PUBLIC_REDIS_TOKEN in Vercel).'
}

/**
 * Every error from here is a plain sentence. The values of the variables are checked before any
 * request, and a failing request is reported without the text of the underlying error: Node's own
 * messages ("Invalid header", "Failed to parse URL") contain the value they choked on.
 */
async function run(cmd: (string | number)[]): Promise<unknown> {
  const problem = publicStoreProblem()
  if (problem) throw new Error(problem)
  let res: Response
  try {
    res = await fetch(process.env.OFFERS_PUBLIC_REDIS_URL!, { method: 'POST', headers: { authorization: `Bearer ${process.env.OFFERS_PUBLIC_REDIS_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd), cache: 'no-store', signal: AbortSignal.timeout(8_000) })
  } catch (e) {
    throw new Error(e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'The public offers store did not answer in time.' : 'The public offers store could not be reached. Check OFFERS_PUBLIC_REDIS_URL and OFFERS_PUBLIC_REDIS_TOKEN in Vercel.')
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'The public offers store refused the token. Check OFFERS_PUBLIC_REDIS_TOKEN in Vercel.' : `The public offers store answered ${res.status}.`)
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
  if (body.error) throw new Error('The public offers store refused a command.')
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
