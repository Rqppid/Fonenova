/**
 * The client-facing side of Offers: everything fonenova.com knows about an offer.
 *
 * This reads and writes ONE place, a separate Upstash Redis database (OFFERS_PUBLIC_REDIS_URL /
 * OFFERS_PUBLIC_REDIS_TOKEN) that holds only what a client may see (the sale prices on their
 * offer) and what they answered. It deliberately has no access to the dashboard's store or its
 * key, so costs, margins and every login stay out of reach of this public site.
 *
 * Offers are addressed by the SHA-256 of the link's token, so the database alone cannot produce
 * a working link. Plain Node and fetch only: no imports from the app, so it is easy to test.
 */
import crypto from 'node:crypto'
import { MAX_REMARKS, type OfferState } from './offers-format'

export { eur, ukTime, MAX_REMARKS, type OfferState } from './offers-format'

/** What a client sees. Sale prices only: there is no field here for cost, margin or profit. */
export interface PublicOffer {
  clientName: string
  lines: { description: string; qty: number; unitSaleCents: number }[]
  units: number
  totalCents: number
  issuedAt: string
  expiresAt: string
  /** A test send to the owner's own inbox. */
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


const ANSWER_TTL_SECONDS = 90 * 24 * 3600
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The only form of the token stored or logged anywhere. */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
export const validToken = (t: unknown): t is string => typeof t === 'string' && TOKEN_PATTERN.test(t)

export function offerState(offer: PublicOffer, answer: PublicAnswer | null, now: Date = new Date()): OfferState {
  if (answer) return 'answered'
  if (offer.status === 'withdrawn') return 'withdrawn'
  if (now.getTime() >= Date.parse(offer.expiresAt)) return 'expired'
  return 'open'
}

// ---------------------------------------------------------------------------
// The public store (Upstash REST: POST the command as a JSON array)
// ---------------------------------------------------------------------------

type Cmd = (string | number)[]

export function publicStoreConfigured(): boolean {
  return !!(process.env.OFFERS_PUBLIC_REDIS_URL && process.env.OFFERS_PUBLIC_REDIS_TOKEN)
}

async function run(cmd: Cmd): Promise<unknown> {
  const url = process.env.OFFERS_PUBLIC_REDIS_URL
  const token = process.env.OFFERS_PUBLIC_REDIS_TOKEN
  if (!url || !token) throw new Error('The offers store is not set up')
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`The offers store answered ${res.status}`)
  const body = (await res.json()) as { result?: unknown; error?: string }
  if (body.error) throw new Error('The offers store refused a command')
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

export async function getOffer(hash: string): Promise<PublicOffer | null> {
  return parse<PublicOffer>(await run(['GET', `pub:offer:${hash}`]))
}

export async function getAnswer(hash: string): Promise<PublicAnswer | null> {
  return parse<PublicAnswer>(await run(['GET', `pub:answer:${hash}`]))
}

/**
 * Save the answer only if there is none yet. True for the one caller that wrote it; false for
 * anyone else, however close together they came. This is what makes an offer single use.
 */
export async function answerOnce(hash: string, answer: PublicAnswer): Promise<boolean> {
  return (await run(['SET', `pub:answer:${hash}`, JSON.stringify(answer), 'NX', 'EX', ANSWER_TTL_SECONDS])) === 'OK'
}

/** Count one hit against a limit. False once `limit` hits have been made inside the window. */
export async function allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const n = Number(await run(['INCR', `pub:rl:${key}`]))
  if (n === 1) await run(['EXPIRE', `pub:rl:${key}`, windowSeconds])
  return n <= limit
}

// ---------------------------------------------------------------------------
// The visitor
// ---------------------------------------------------------------------------

/** The visitor's IP as Vercel reports it. Only ever logged and used as a rate-limit key. */
export function clientIp(h: { get(name: string): string | null }): string {
  const raw = h.get('x-vercel-forwarded-for') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for') ?? ''
  const ip = raw.split(',')[0]?.trim().slice(0, 64)
  return ip || 'unknown'
}

export const clientAgent = (h: { get(name: string): string | null }) => (h.get('user-agent') ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300)

/** Remarks as plain text: trimmed, control characters removed, at most MAX_REMARKS characters. */
export function cleanRemarks(v: unknown): string | null {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return t.length > MAX_REMARKS ? null : t
}

/** Tell the dashboard an answer arrived. Only the hash is sent; the dashboard reads the answer itself. Never throws. */
export async function notifyDashboard(hash: string): Promise<void> {
  const token = process.env.OFFERS_WEBHOOK_TOKEN
  if (!token) return
  try {
    await fetch(process.env.OFFERS_WEBHOOK_URL ?? 'https://dashboard.fonenova.com/api/offers/answered', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hash }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    // The dashboard's 5-minute check picks the answer up anyway.
  }
}
