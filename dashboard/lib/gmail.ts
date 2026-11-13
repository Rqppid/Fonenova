/**
 * Gmail connection: sends the Friday cash email, and reads Mobile One's offers (lib/offers).
 *
 * Google sign-in with the dashboard's own OAuth client (GOOGLE_CLIENT_ID / SECRET), auth code
 * with PKCE. A new connection asks for gmail.send and gmail.readonly (read, never change or
 * delete). A connection made before reading existed keeps gmail.send only, and keeps sending,
 * until it is connected again. Only AUTH_ALLOWED_EMAIL may connect. Tokens live in the store
 * (encrypted online). With the Google consent screen set to Internal (Workspace), the refresh
 * token does not expire.
 */
import crypto from 'node:crypto'
import { getJson, getStore, type Store } from './store'

const AUTH = () => process.env.FN_GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = () => process.env.FN_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token'
const USERINFO = () => process.env.FN_GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo'
const GMAIL = () => (process.env.FN_GMAIL_API_URL ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/$/, '')
const SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly'
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** Whether a granted scope lets the dashboard read mail. */
export const scopeCanRead = (scope: string | undefined) => (scope ?? '').split(/\s+/).some((x) => x === READ_SCOPE || x === 'https://mail.google.com/' || x === 'https://www.googleapis.com/auth/gmail.modify')

export interface GmailConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  allowedEmail: string | null
  /** Who the Friday email goes to. */
  to: string
}

export function gmailConfig(): GmailConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  const allowed = process.env.AUTH_ALLOWED_EMAIL?.trim().toLowerCase() || null
  return {
    clientId,
    clientSecret,
    redirectUri: `${process.env.AUTH_URL?.replace(/\/$/, '') ?? 'http://localhost:3100'}/gmail/callback`,
    allowedEmail: allowed,
    to: process.env.DIGEST_TO?.trim() || allowed || 'info@fonenova.com',
  }
}

interface Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email: string
  /** The scope Google granted. Missing on tokens saved before reading existed: send-only. */
  scope?: string
}

export async function gmailConnected(store: Store = getStore()): Promise<{ connected: boolean; email: string | null; canRead: boolean }> {
  const t = await getJson<Tokens>(store, 'gmail:tokens')
  return { connected: !!t, email: t?.email ?? null, canRead: scopeCanRead(t?.scope) }
}

export async function disconnectGmail(): Promise<void> {
  await getStore().del('gmail:tokens')
}

const b64url = (b: Buffer) => b.toString('base64url')

export function startGmailAuth(c: GmailConfig): { url: string; state: string; verifier: string } {
  const state = b64url(crypto.randomBytes(24))
  const verifier = b64url(crypto.randomBytes(48))
  const q = new URLSearchParams({
    client_id: c.clientId,
    response_type: 'code',
    redirect_uri: c.redirectUri,
    scope: SCOPES,
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    access_type: 'offline', // a refresh token, so Friday's email sends with nobody signed in
    prompt: 'consent', // Google only returns the refresh token on a consent screen
    ...(c.allowedEmail ? { login_hint: c.allowedEmail } : {}),
  })
  return { url: `${AUTH()}?${q}`, state, verifier }
}

async function tokenRequest(c: GmailConfig, body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  const res = await fetch(TOKEN(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Google refused (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export async function finishGmailAuth(c: GmailConfig, code: string, verifier: string): Promise<string> {
  const t = await tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: c.redirectUri, code_verifier: verifier })
  if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove QuayPilot from your Google account’s third-party access and connect again.')
  const who = await fetch(USERINFO(), { headers: { authorization: `Bearer ${t.access_token}` }, cache: 'no-store' })
  const email = who.ok ? String(((await who.json()) as { email?: string }).email ?? '').toLowerCase() : ''
  if (!email) throw new Error('Could not read which Google account signed in')
  if (c.allowedEmail && email !== c.allowedEmail) throw new Error(`Only ${c.allowedEmail} can send the weekly email (signed in as ${email})`)
  await getStore().set('gmail:tokens', { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, email, scope: t.scope ?? '' } satisfies Tokens)
  return email
}

async function accessToken(c: GmailConfig, store: Store): Promise<Tokens> {
  return store.withLock('gmail:tokens', async () => {
    const t = await getJson<Tokens>(store, 'gmail:tokens')
    if (!t) throw new Error('Gmail is not connected')
    if (t.expiresAt - 60_000 > Date.now()) return t
    const r = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: t.refreshToken })
    const next = { ...t, accessToken: r.access_token, refreshToken: r.refresh_token ?? t.refreshToken, expiresAt: Date.now() + r.expires_in * 1000 }
    await store.set('gmail:tokens', next)
    return next
  })
}

/** RFC 2822 message with a plain-text and an HTML part. Headers are UTF-8 encoded. */
export function mimeMessage(m: { from: string; to: string; subject: string; text: string; html: string }): string {
  const boundary = `qp_${crypto.randomBytes(9).toString('hex')}`
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\r\n')].join('\r\n')
  return [
    `From: ${enc('QuayPilot')} <${m.from}>`,
    `To: ${m.to}`,
    `Subject: ${enc(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    part('text/plain', m.text),
    part('text/html', m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

export async function sendGmail(c: GmailConfig, msg: { subject: string; text: string; html: string; to?: string }, store: Store = getStore()): Promise<{ id: string; to: string; from: string }> {
  const t = await accessToken(c, store)
  const to = msg.to ?? c.to
  const raw = Buffer.from(mimeMessage({ from: t.email, to, subject: msg.subject, text: msg.text, html: msg.html })).toString('base64url')
  const res = await fetch(`${GMAIL()}/users/me/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Gmail did not send it (${res.status}): ${(await res.text()).slice(0, 200)}`)
  return { id: String(((await res.json()) as { id?: string }).id ?? ''), to, from: t.email }
}

// ---------------------------------------------------------------------------
// Reading (gmail.readonly): Mobile One's offers. Never changes or deletes anything.
// ---------------------------------------------------------------------------

export interface MailMessage {
  id: string
  threadId: string
  /** The RFC 822 Message-ID header, for replying in the same thread later. */
  rfcMessageId: string | null
  from: string
  to: string
  subject: string
  /** ISO time Gmail received it. */
  receivedAt: string
  labels: string[]
  /** Plain text of the body: the text part, or the HTML part turned into text. */
  text: string
  attachments: string[]
}

type Part = { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string }; parts?: Part[]; headers?: { name: string; value: string }[] }

const decode = (data: string | undefined) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '')

/** HTML to readable text: block elements become line breaks, tags and entities go. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d|ol|ul|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '* ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&euro;/gi, '€')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A Gmail API message (format=full) as plain fields. Pure, for tests. */
export function parseGmailMessage(j: { id?: string; threadId?: string; internalDate?: string; labelIds?: string[]; payload?: Part }): MailMessage {
  const headers = new Map((j.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]))
  let plain = ''
  let html = ''
  const attachments: string[] = []
  const walk = (p: Part | undefined) => {
    if (!p) return
    if (p.filename) attachments.push(p.filename)
    else if (p.mimeType === 'text/plain' && !plain) plain = decode(p.body?.data)
    else if (p.mimeType === 'text/html' && !html) html = decode(p.body?.data)
    for (const c of p.parts ?? []) walk(c)
  }
  walk(j.payload)
  return {
    id: String(j.id ?? ''),
    threadId: String(j.threadId ?? ''),
    rfcMessageId: headers.get('message-id') ?? null,
    from: headers.get('from') ?? '',
    to: headers.get('to') ?? '',
    subject: headers.get('subject') ?? '',
    receivedAt: new Date(Number(j.internalDate ?? 0)).toISOString(),
    labels: j.labelIds ?? [],
    text: (plain.trim() ? plain : htmlToText(html)).replace(/\r\n/g, '\n').trim(),
    attachments: attachments.filter(Boolean),
  }
}

async function gmailGet(c: GmailConfig, path: string, store: Store): Promise<unknown> {
  const t = await accessToken(c, store)
  if (!scopeCanRead(t.scope)) throw new Error('Gmail is connected send-only: connect it again in Settings to let QuayPilot read offers')
  const res = await fetch(`${GMAIL()}/users/me${path}`, { headers: { authorization: `Bearer ${t.accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Gmail answered ${res.status} reading mail`)
  return res.json()
}

/** Ids of messages matching a Gmail search, newest first (at most 50). */
export async function listMessageIds(c: GmailConfig, query: string, store: Store = getStore()): Promise<string[]> {
  const j = (await gmailGet(c, `/messages?maxResults=50&q=${encodeURIComponent(query)}`, store)) as { messages?: { id: string }[] }
  return (j.messages ?? []).map((m) => m.id)
}

export async function getMessage(c: GmailConfig, id: string, store: Store = getStore()): Promise<MailMessage> {
  return parseGmailMessage((await gmailGet(c, `/messages/${encodeURIComponent(id)}?format=full`, store)) as Parameters<typeof parseGmailMessage>[0])
}
