/**
 * The Xero WRITE connection: a second, separate Xero app from the read-only one in client.ts, so
 * the read-only connection never gains write access. It can create sales invoices and read what it
 * needs to number them. Only DRAFTs are ever created here; nothing is authorised, emailed or
 * deleted. Same PKCE sign-in (no client secret stored) and the same single-use refresh handling.
 */
import 'server-only'
import crypto from 'node:crypto'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi, type XeroInvoiceRef } from '../offers/draft'
import { getJson, getStore, storeWritable, type Store } from '../store'

const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
const TOKEN_URL = 'https://identity.xero.com/connect/token'
const CONNECTIONS_URL = 'https://api.xero.com/connections'
const API = 'https://api.xero.com/api.xro/2.0'

// Granular scopes (apps created after 2 March 2026). Override with XERO_WRITE_SCOPES if Xero's app
// settings list different names.
const DEFAULT_SCOPES = 'offline_access accounting.invoices accounting.contacts.read accounting.settings.read'

export interface XeroWriteConfig { clientId: string; redirectUri: string; scopes: string }

export function xeroWriteConfig(): XeroWriteConfig | null {
  const clientId = process.env.XERO_WRITE_CLIENT_ID?.trim()
  if (!clientId) return null
  return {
    clientId,
    redirectUri: process.env.XERO_WRITE_REDIRECT_URI?.trim() || `${process.env.AUTH_URL?.replace(/\/$/, '') ?? 'http://localhost:3100'}/xero-write/callback`,
    scopes: process.env.XERO_WRITE_SCOPES?.trim() || DEFAULT_SCOPES,
  }
}

export const xeroWriteAvailable = () => storeWritable()

interface Tokens { accessToken: string; refreshToken: string; expiresAt: number; tenantId: string; tenantName: string; isDemo: boolean }

export interface XeroWriteStatus { configured: boolean; connected: boolean; orgName: string | null; isDemo: boolean | null }

export async function xeroWriteStatus(store: Store = getStore()): Promise<XeroWriteStatus> {
  const configured = !!xeroWriteConfig()
  try {
    const t = await getJson<Tokens>(store, 'xero-write:tokens')
    return { configured, connected: !!t, orgName: t?.tenantName ?? null, isDemo: t ? t.isDemo : null }
  } catch {
    return { configured, connected: false, orgName: null, isDemo: null }
  }
}

export async function disconnectXeroWrite(): Promise<void> {
  await getStore().del('xero-write:tokens')
}

const b64url = (b: Buffer) => b.toString('base64url')

export function startXeroWriteAuth(c: XeroWriteConfig): { url: string; state: string; verifier: string } {
  const state = b64url(crypto.randomBytes(24))
  const verifier = b64url(crypto.randomBytes(48))
  const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope: c.scopes, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })
  return { url: `${AUTHORIZE_URL}?${q}`, state, verifier }
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  // The response body is never included: it can echo request values.
  if (!res.ok) throw new Error(`Xero refused the write sign-in (${res.status})`)
  return res.json()
}

async function organisationOf(accessToken: string, tenantId: string): Promise<{ name: string; isDemo: boolean }> {
  const res = await fetch(`${API}/Organisation`, { headers: { authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Xero would not describe the organisation (${res.status}). The write app may be missing the accounting.settings.read permission.`)
  const o = ((await res.json()) as { Organisations?: { Name?: string; IsDemoCompany?: boolean }[] }).Organisations?.[0]
  if (!o) throw new Error('Xero returned no organisation')
  return { name: String(o.Name ?? ''), isDemo: o.IsDemoCompany === true }
}

export async function finishXeroWriteAuth(c: XeroWriteConfig, code: string, verifier: string): Promise<{ name: string; isDemo: boolean }> {
  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: c.clientId, code, redirect_uri: c.redirectUri, code_verifier: verifier })
  const conns = await fetch(CONNECTIONS_URL, { headers: { authorization: `Bearer ${t.access_token}` }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!conns.ok) throw new Error(`Could not list Xero organisations (${conns.status})`)
  const list = (await conns.json()) as { tenantId: string; tenantName: string; tenantType: string }[]
  const org = list.find((x) => x.tenantType === 'ORGANISATION') ?? list[0]
  if (!org) throw new Error('This Xero login has no organisation connected')
  const info = await organisationOf(t.access_token, org.tenantId)
  await getStore().set('xero-write:tokens', { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, tenantId: org.tenantId, tenantName: info.name || org.tenantName, isDemo: info.isDemo } satisfies Tokens)
  return info
}

async function validTokens(c: XeroWriteConfig, store: Store): Promise<Tokens> {
  return store.withLock('xero-write:tokens', async () => {
    const t = await getJson<Tokens>(store, 'xero-write:tokens')
    if (!t) throw new Error('The Xero write connection is not set up. Connect it in Settings.')
    if (t.expiresAt - 60_000 > Date.now()) return t
    const r = await tokenRequest({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: t.refreshToken })
    const next: Tokens = { ...t, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: Date.now() + r.expires_in * 1000 }
    await store.set('xero-write:tokens', next) // refresh tokens are single-use: save the new one at once
    return next
  })
}

interface RawInvoice { InvoiceID?: string; InvoiceNumber?: string; Status?: string }
const toRef = (i: RawInvoice): XeroInvoiceRef => ({ id: String(i.InvoiceID ?? ''), number: String(i.InvoiceNumber ?? ''), status: String(i.Status ?? '') })

/** The real Xero behind the XeroApi the draft logic uses. Throws plain sentences, never response bodies. */
export function xeroWriteApi(store: Store = getStore()): XeroApi {
  const c = xeroWriteConfig()
  if (!c) throw new Error('The Xero write app is not set up (XERO_WRITE_CLIENT_ID is missing)')
  const call = async (path: string, init: RequestInit = {}) => {
    const t = await validTokens(c, store)
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${t.accessToken}`)
    headers.set('xero-tenant-id', t.tenantId)
    headers.set('accept', 'application/json')
    return fetch(`${API}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(30_000) })
  }
  const check = (res: Response, what: string) => {
    if (res.ok) return
    if (res.status === 401 || res.status === 403) throw new Error(`Xero refused ${what} (${res.status}). Reconnect the Xero write connection in Settings.`)
    if (res.status === 429) throw new Error('Xero rate limit reached; it will be tried again')
    throw new Error(`Xero ${what} failed (${res.status})`)
  }
  return {
    async organisation() {
      const t = await validTokens(c, store)
      // Live, not remembered: the guard must see the organisation the token really reaches.
      return organisationOf(t.accessToken, t.tenantId)
    },
    async invoiceNumbers() {
      const out: string[] = []
      for (let page = 1; page <= 50; page++) {
        const res = await call(`/Invoices?where=${encodeURIComponent('Type=="ACCREC"')}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID,VOIDED,DELETED&summaryOnly=true&pageSize=1000&page=${page}`)
        check(res, 'listing invoice numbers')
        const rows = ((await res.json()) as { Invoices?: RawInvoice[] }).Invoices ?? []
        for (const r of rows) if (r.InvoiceNumber) out.push(r.InvoiceNumber)
        if (rows.length < 1000) break
      }
      return out
    },
    async findByReference(reference) {
      const res = await call(`/Invoices?where=${encodeURIComponent(`Type=="ACCREC" AND Reference=="${reference.replace(/["\\]/g, '')}"`)}&summaryOnly=true`)
      check(res, 'looking for an existing draft')
      const rows = ((await res.json()) as { Invoices?: RawInvoice[] }).Invoices ?? []
      const live = rows.find((r) => r.Status !== 'VOIDED' && r.Status !== 'DELETED')
      return live ? toRef(live) : null
    },
    async createDraft(body: DraftBody, idempotencyKey: string) {
      const res = await call('/Invoices', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.slice(0, 128) }, body: JSON.stringify({ Invoices: [body] }) })
      if (res.status === 400) {
        const text = await res.text().catch(() => '')
        if (/unique|already (exists|been used|in use)/i.test(text)) throw new DuplicateInvoiceNumber()
        throw new Error('Xero did not accept the draft invoice (400). Check the contact, account code and tax type in Settings.')
      }
      check(res, 'creating the draft')
      const made = ((await res.json()) as { Invoices?: RawInvoice[] }).Invoices?.[0]
      if (!made?.InvoiceID) throw new Error('Xero answered without an invoice id')
      return toRef(made)
    },
  }
}

export function xeroInvoiceUrl(id: string): string {
  return `https://go.xero.com/app/invoicing/view/${encodeURIComponent(id)}`
}
