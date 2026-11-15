/**
 * Single-owner Google sign-in. Only AUTH_ALLOWED_EMAIL gets a session.
 *
 * Flow: /auth/login sends the browser to Google with state, nonce and a PKCE challenge
 * held in a short-lived signed cookie. /auth/callback swaps the code for an ID token
 * directly with Google's token endpoint over TLS, checks issuer, audience, expiry, nonce
 * and the verified email, then sets a signed session cookie.
 *
 * Uses Web Crypto only, so the same code runs in proxy.ts and in server components.
 * Fails closed: if configuration is missing in production, nobody gets in.
 */

export const SESSION_COOKIE = 'fn_session'
export const OAUTH_COOKIE = 'fn_oauth'
/** 30 days, renewed whenever the dashboard is used (see sessionNeedsRenewal), so it only ends after a month of not opening it. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
/** A session is re-issued once it is this much older than a fresh one, so a busy day costs one new cookie, not one per request. */
const RENEW_AFTER_SECONDS = 24 * 60 * 60
const OAUTH_TTL_SECONDS = 10 * 60

export interface AuthConfig {
  secret: string
  allowedEmail: string
  clientId: string
  clientSecret: string
  /** Public origin, e.g. https://dashboard.fonenova.com. Fixed, never taken from the Host header. */
  origin: string
}

export type ConfigResult = { ok: true; config: AuthConfig } | { ok: false; missing: string[] }

/** Local `next dev` only. Production builds always require sign-in. */
export function authBypassed(): boolean {
  return process.env.NODE_ENV === 'development' && !process.env.GOOGLE_CLIENT_ID
}

export function authConfig(): ConfigResult {
  const env = {
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_ALLOWED_EMAIL: process.env.AUTH_ALLOWED_EMAIL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    AUTH_URL: process.env.AUTH_URL,
  }
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k)
  if (env.AUTH_SECRET && env.AUTH_SECRET.length < 32) missing.push('AUTH_SECRET (must be at least 32 characters)')
  if (missing.length) return { ok: false, missing }
  return {
    ok: true,
    config: {
      secret: env.AUTH_SECRET!,
      allowedEmail: env.AUTH_ALLOWED_EMAIL!.trim().toLowerCase(),
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      origin: env.AUTH_URL!.replace(/\/$/, ''),
    },
  }
}

export function redirectUri(c: AuthConfig): string {
  return `${c.origin}/auth/callback`
}

// ---------------------------------------------------------------------------
// Encoding and signing
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/** `payload.signature`, both base64url. Payload carries its own `exp` (seconds). */
export async function sign(data: Record<string, unknown>, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(data)))
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)))
  return `${payload}.${b64url(sig)}`
}

export async function verify<T extends { exp: number }>(token: string | undefined, secret: string): Promise<T | null> {
  if (!token) return null
  const [payload, sig, extra] = token.split('.')
  if (!payload || !sig || extra !== undefined) return null
  try {
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig) as BufferSource, enc.encode(payload))
    if (!ok) return null
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as T
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null
    return data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface Session {
  email: string
  exp: number
}

export async function createSession(email: string, c: AuthConfig): Promise<string> {
  return sign({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }, c.secret)
}

/** True once a valid session has used up a day of its life: time to hand out a fresh 30 days. Pure. */
export function sessionNeedsRenewal(s: Session, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return s.exp - nowSeconds < SESSION_TTL_SECONDS - RENEW_AFTER_SECONDS
}

/**
 * Where to go after signing in, taken from a link the user came in on. Only a path on this site is
 * accepted: it must start with one "/", and may not be "//host", have a backslash, a control character,
 * or a scheme. Anything else is the home page, so a crafted link can never send the owner elsewhere.
 */
export function safeNext(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '/'
  if (/^\/(login|auth\/)/.test(raw)) return '/'
  return raw
}

/** A session is valid only if signed by us, unexpired, and for the allowed email. */
export async function readSession(token: string | undefined, c: AuthConfig): Promise<Session | null> {
  const s = await verify<Session>(token, c.secret)
  if (!s || typeof s.email !== 'string' || s.email.toLowerCase() !== c.allowedEmail) return null
  return s
}

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge,
})

// ---------------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------------

export interface OAuthState {
  state: string
  nonce: string
  verifier: string
  exp: number
  /** Where to land after sign-in (already passed through safeNext). */
  next?: string
}

export async function startOAuth(c: AuthConfig, next?: string): Promise<{ url: string; cookie: string }> {
  const dest = safeNext(next)
  const st: OAuthState = {
    ...(dest !== '/' ? { next: dest } : {}),
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS,
  }
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(st.verifier))))
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email',
    state: st.state,
    nonce: st.nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    login_hint: c.allowedEmail,
  })
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, cookie: await sign({ ...st }, c.secret) }
}

export type CallbackResult = { ok: true; email: string; next?: string } | { ok: false; reason: 'state' | 'exchange' | 'token' | 'denied' }

export async function finishOAuth(
  c: AuthConfig,
  params: URLSearchParams,
  oauthCookie: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CallbackResult> {
  const st = await verify<OAuthState>(oauthCookie, c.secret)
  const code = params.get('code')
  if (!st || !code || params.get('state') !== st.state) return { ok: false, reason: 'state' }

  let idToken: string | undefined
  try {
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: redirectUri(c),
        grant_type: 'authorization_code',
        code_verifier: st.verifier,
      }),
      cache: 'no-store',
    })
    if (!res.ok) return { ok: false, reason: 'exchange' }
    idToken = ((await res.json()) as { id_token?: string }).id_token
  } catch {
    return { ok: false, reason: 'exchange' }
  }
  if (!idToken) return { ok: false, reason: 'token' }

  // The ID token came straight from Google's token endpoint over TLS, so per OpenID Connect
  // Core 3.1.3.7 the TLS server check stands in for the signature check. The claims are still
  // validated in full.
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(idToken.split('.')[1] ?? '')))
  } catch {
    return { ok: false, reason: 'token' }
  }
  const now = Math.floor(Date.now() / 1000)
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com'
  const audOk = claims.aud === c.clientId
  const expOk = typeof claims.exp === 'number' && claims.exp > now
  const nonceOk = claims.nonce === st.nonce
  if (!issOk || !audOk || !expOk || !nonceOk) return { ok: false, reason: 'token' }

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
  if (claims.email_verified !== true || email !== c.allowedEmail) return { ok: false, reason: 'denied' }
  return { ok: true, email, ...(st.next ? { next: safeNext(st.next) } : {}) }
}
