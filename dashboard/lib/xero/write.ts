/**
 * The Xero WRITE connection: a second, separate Xero app from the read-only one in client.ts, so
 * the read-only connection never gains write access. It can create sales invoices and read what it
 * needs to number them. Only DRAFTs are ever created here; nothing is authorised, emailed or
 * deleted. Same PKCE sign-in (no client secret stored) and the same single-use refresh handling.
 */
import 'server-only'
import crypto from 'node:crypto'
import { DuplicateInvoiceNumber, parseXeroValidation, XeroRejected, type DraftBody, type XeroApi, type XeroInvoiceRef } from '../offers/draft'
import { getJson, getStore, storeWritable, type Store } from '../store'
import type { DraftDebug } from '../offers/types'

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

/** An organisation the write app is connected to. */
export interface XeroOrg { tenantId: string; name: string; isDemo: boolean }

interface Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  /** The organisation drafts go to. Null until one is chosen: live is never picked by default. */
  tenantId: string | null
  tenantName: string | null
  isDemo: boolean | null
  /** Every organisation this login reaches (absent on a login saved before this list existed: just the selected one). */
  orgs?: XeroOrg[]
  /** The organisation(s) the user chose in the latest consent flow, as Xero reported them. */
  chosenTenantIds?: string[]
}

const orgsOf = (t: Tokens): XeroOrg[] => t.orgs ?? (t.tenantId ? [{ tenantId: t.tenantId, name: t.tenantName ?? '', isDemo: t.isDemo === true }] : [])

export interface XeroWriteStatus {
  configured: boolean
  connected: boolean
  /** The organisation drafts go to (null until one is chosen). */
  orgName: string | null
  isDemo: boolean | null
  selectedTenantId: string | null
  /** Every connected organisation, with which one drafts go to and which one was chosen in the latest consent. */
  orgs: { tenantId: string; name: string; isDemo: boolean; selected: boolean; justConnected: boolean }[]
}

export async function xeroWriteStatus(store: Store = getStore()): Promise<XeroWriteStatus> {
  const configured = !!xeroWriteConfig()
  try {
    const t = await getJson<Tokens>(store, 'xero-write:tokens')
    if (!t) return { configured, connected: false, orgName: null, isDemo: null, selectedTenantId: null, orgs: [] }
    return {
      configured,
      connected: true,
      orgName: t.tenantName ?? null,
      isDemo: t.tenantId ? t.isDemo : null,
      selectedTenantId: t.tenantId ?? null,
      orgs: orgsOf(t).map((o) => ({ ...o, selected: o.tenantId === t.tenantId, justConnected: (t.chosenTenantIds ?? []).includes(o.tenantId) })),
    }
  } catch {
    return { configured, connected: false, orgName: null, isDemo: null, selectedTenantId: null, orgs: [] }
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

/** What a request logs and shows: never a token or a header, and ids cut to 8 characters. */
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : null)
/** Anything bearer-like removed, then cut: Xero's own error text is kept, nothing else. */
const scrub = (s: string, max: number) => s.replace(/bearer\s+[\w.~+/=-]+/gi, '[removed]').slice(0, max)
const xeroLog = (entry: Record<string, unknown>) => console.log(JSON.stringify({ event: 'xero-write', at: new Date().toISOString(), ...entry }))
export const XERO_API_VERSION = 'Xero Accounting API 2.0 (https://api.xero.com/api.xro/2.0)'

/** The draft fields that matter when debugging, exactly as sent. CurrencyRate is not sent: Xero applies its own rate. */
export function describeRequest(body: DraftBody): Record<string, unknown> {
  return {
    Type: body.Type, Status: body.Status, InvoiceNumber: body.InvoiceNumber, Reference: body.Reference,
    CurrencyCode: body.CurrencyCode, CurrencyRate: 'not sent', LineAmountTypes: body.LineAmountTypes,
    Date: body.Date, DueDate: body.DueDate, ContactID: short(body.Contact.ContactID), BrandingThemeID: body.BrandingThemeID ? short(body.BrandingThemeID) : 'not sent',
    LineItems: body.LineItems.map((l) => ({ Quantity: l.Quantity, UnitAmount: l.UnitAmount, AccountCode: l.AccountCode, TaxType: l.TaxType })),
  }
}

async function organisationOf(accessToken: string, tenantId: string): Promise<{ name: string; isDemo: boolean }> {
  const res = await fetch(`${API}/Organisation`, { headers: { authorization: `Bearer ${accessToken}`, 'xero-tenant-id': tenantId, accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Xero would not describe the organisation (${res.status}). The write app may be missing the accounting.settings.read permission.`)
  const o = ((await res.json()) as { Organisations?: { Name?: string; IsDemoCompany?: boolean }[] }).Organisations?.[0]
  if (!o) throw new Error('Xero returned no organisation')
  return { name: String(o.Name ?? ''), isDemo: o.IsDemoCompany === true }
}

/** The claims inside Xero's access token (a JWT we just received from Xero's token endpoint). Read only, never trusted for anything but the auth event id. */
function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

interface Connection { id?: string; authEventId?: string; tenantId: string; tenantName?: string; tenantType?: string; createdDateUtc?: string; updatedDateUtc?: string }

async function listConnections(accessToken: string): Promise<Connection[]> {
  const res = await fetch(CONNECTIONS_URL, { headers: { authorization: `Bearer ${accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Could not list Xero organisations (${res.status})`)
  const list = (await res.json()) as Connection[]
  const orgs = list.filter((x) => x.tenantType === 'ORGANISATION')
  return orgs.length ? orgs : list
}

async function describeOrgs(accessToken: string, conns: Connection[]): Promise<XeroOrg[]> {
  return Promise.all(conns.map(async (c) => {
    const info = await organisationOf(accessToken, c.tenantId)
    return { tenantId: c.tenantId, name: info.name || c.tenantName || '', isDemo: info.isDemo }
  }))
}

export interface XeroWriteFinish {
  /** What the user chose in this consent flow, as Xero reports it (the connections that share this flow's authEventId; else the newest). */
  chosen: XeroOrg[]
  /** The organisation drafts go to after this sign-in: the one already selected, or the chosen one if it is a demo. Never a live one by itself. */
  selected: XeroOrg | null
  orgs: XeroOrg[]
}

/**
 * Finish the consent. Every organisation the login reaches is recorded, and the organisation(s) chosen in THIS
 * flow are identified from Xero's own authEventId (not "the first in the list"). Which one drafts go to is a
 * separate matter: an organisation already selected stays selected, a demo chosen on a fresh connection is
 * selected, and a live organisation is NEVER selected by consent alone: that is the explicit "Use ... (live)" step.
 */
export async function finishXeroWriteAuth(c: XeroWriteConfig, code: string, verifier: string, store: Store = getStore()): Promise<XeroWriteFinish> {
  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: c.clientId, code, redirect_uri: c.redirectUri, code_verifier: verifier })
  const conns = await listConnections(t.access_token)
  if (conns.length === 0) throw new Error('This Xero login has no organisation connected')
  const orgs = await describeOrgs(t.access_token, conns)

  const flow = typeof jwtClaims(t.access_token).authentication_event_id === 'string' ? (jwtClaims(t.access_token).authentication_event_id as string) : null
  let chosenConns = flow ? conns.filter((x) => x.authEventId === flow) : []
  if (chosenConns.length === 0) {
    const stamp = (x: Connection) => Date.parse(x.updatedDateUtc ?? x.createdDateUtc ?? '') || 0
    chosenConns = [[...conns].sort((a, b) => stamp(b) - stamp(a))[0]]
  }
  const chosen = orgs.filter((o) => chosenConns.some((x) => x.tenantId === o.tenantId))

  const prev = await getJson<Tokens>(store, 'xero-write:tokens').catch(() => null)
  const kept = prev?.tenantId ? orgs.find((o) => o.tenantId === prev.tenantId) : undefined
  const selected = kept ?? (chosen.length === 1 && chosen[0].isDemo ? chosen[0] : null)
  await store.set('xero-write:tokens', {
    accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000,
    tenantId: selected?.tenantId ?? null, tenantName: selected?.name ?? null, isDemo: selected ? selected.isDemo : null,
    orgs, chosenTenantIds: chosen.map((o) => o.tenantId),
  } satisfies Tokens)
  return { chosen, selected, orgs }
}

/** Re-list the organisations this login reaches (after connecting another one in Xero). Keeps the selection if it is still connected. */
export async function refreshXeroWriteOrgs(store: Store = getStore()): Promise<XeroWriteStatus> {
  const c = xeroWriteConfig()
  if (!c) throw new Error('The Xero write app is not set up')
  const t = await validTokens(c, store)
  const orgs = await describeOrgs(t.accessToken, await listConnections(t.accessToken))
  const keep = t.tenantId ? orgs.find((o) => o.tenantId === t.tenantId) : undefined
  await store.set('xero-write:tokens', { ...t, orgs, tenantId: keep?.tenantId ?? null, tenantName: keep?.name ?? null, isDemo: keep ? keep.isDemo : null })
  return xeroWriteStatus(store)
}

export type SelectResult = { ok: true; org: XeroOrg } | { ok: false; error: string }

/**
 * Choose which organisation drafts go to. Always an explicit act. A live organisation needs `confirmLive`
 * on top (the Settings card asks for a separate tick), and the organisation must still be connected in Xero.
 */
export async function selectXeroWriteOrg(tenantId: string, opts: { confirmLive?: boolean } = {}, store: Store = getStore()): Promise<SelectResult> {
  const c = xeroWriteConfig()
  if (!c) return { ok: false, error: 'The Xero write app is not set up' }
  try {
    const t = await validTokens(c, store)
    const orgs = await describeOrgs(t.accessToken, await listConnections(t.accessToken))
    const org = orgs.find((o) => o.tenantId === tenantId)
    if (!org) return { ok: false, error: 'That organisation is not connected to the Xero write app (any more). Connect it again, then choose it.' }
    if (!org.isDemo && opts.confirmLive !== true) return { ok: false, error: `Choosing ${org.name} (live) needs its own confirmation: tick the box that says drafts will be created in the live organisation.` }
    await store.set('xero-write:tokens', { ...t, orgs, tenantId: org.tenantId, tenantName: org.name, isDemo: org.isDemo })
    xeroLog({ event: 'xero-write-selected', tenant: short(org.tenantId), demo: org.isDemo })
    return { ok: true, org }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached' }
  }
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
  // The organisation this run is working in, fixed the first time it is looked at: if the selection is changed
  // while a draft is being made, every later request refuses instead of writing to a different organisation.
  let locked: string | null = null
  const call = async (path: string, init: RequestInit = {}) => {
    const t = await validTokens(c, store)
    if (!t.tenantId) throw new Error('No Xero organisation is chosen for drafts. Choose one on the Settings card (Xero draft invoices).')
    if (locked && t.tenantId !== locked) throw new Error('The Xero organisation for drafts was changed while this draft was being made. Nothing was created; try again.')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${t.accessToken}`)
    headers.set('xero-tenant-id', t.tenantId)
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    const res = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(30_000) })
    // One line per request: which tenant it carried and what came back. No tokens, no headers, no bodies.
    xeroLog({ method: init.method ?? 'GET', path: path.split('?')[0], tenant: short(t.tenantId), status: res.status })
    return res
  }
  /** Where a request really goes: the one tenant header comes from the saved login, for every call. */
  const tenant = async () => {
    const id = (await validTokens(c, store)).tenantId
    if (!id) throw new Error('No Xero organisation is chosen for drafts. Choose one on the Settings card (Xero draft invoices).')
    return id
  }
  const check = (res: Response, what: string) => {
    if (res.ok) return
    if (res.status === 401 || res.status === 403) throw new Error(`Xero refused ${what} (${res.status}). Reconnect the Xero write connection in Settings.`)
    if (res.status === 429) throw new Error('Xero rate limit reached; it will be tried again')
    throw new Error(`Xero ${what} failed (${res.status})`)
  }
  // Live, not remembered, and through the same call() as every other request, so the guard looks
  // at exactly the tenant the draft is sent to.
  // The organisation as Xero describes it, for the tenant the request carries.
  const organisationRaw = async () => {
    const res = await call('/Organisation')
    if (!res.ok) throw new Error(`Xero would not describe the organisation (${res.status}). The write app may be missing the accounting.settings.read permission.`)
    const o = ((await res.json()) as { Organisations?: { OrganisationID?: string; Name?: string; IsDemoCompany?: boolean }[] }).Organisations?.[0]
    if (!o) throw new Error('Xero returned no organisation')
    return { name: String(o.Name ?? ''), isDemo: o.IsDemoCompany === true, ...(o.OrganisationID ? { id: o.OrganisationID } : {}) }
  }
  // The guard every draft starts with: the organisation Xero reports must be the selected tenant, and from here on
  // this run only ever talks to that one.
  const organisation = async () => {
    const tid = await tenant()
    const o = await organisationRaw()
    if (o.id && o.id.toLowerCase() !== tid.toLowerCase()) throw new Error(`Xero reports the selected tenant (${short(tid)}) as a different organisation (${o.name}). Nothing was created. Choose the organisation again on the Settings card.`)
    locked = tid
    return o
  }
  return {
    organisation,
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
    async diagnose(body: DraftBody) {
      const found: string[] = []
      const get = async <T,>(path: string, what: string): Promise<T | null> => {
        try {
          const res = await call(path)
          if (res.status === 404) return null
          if (!res.ok) {
            found.push(`Could not check ${what} (Xero answered ${res.status}). The write app may lack the settings or contacts permission.`)
            return null
          }
          return (await res.json()) as T
        } catch {
          found.push(`Could not check ${what} (Xero could not be reached).`)
          return null
        }
      }
      const line = body.LineItems[0]
      // The tenant header and the organisation Xero says that tenant is must be the same one.
      const tid = await tenant()
      const org = await organisationRaw().catch(() => null)
      if (org?.id && org.id.toLowerCase() !== tid.toLowerCase()) found.push(`The request carried tenant ${short(tid)} but Xero reports that tenant as organisation ${short(org.id)} (${org.name}). Reconnect the Xero write connection in Settings.`)
      const cur = await get<{ Currencies?: { Code?: string }[] }>('/Currencies', 'the currency')
      if (cur && !(cur.Currencies ?? []).some((c) => c.Code === body.CurrencyCode)) found.push(`Currency ${body.CurrencyCode} is not switched on in this organisation. In Xero: Settings, Currencies, Add currency, then try again.`)
      const tax = await get<{ TaxRates?: { Name?: string; TaxType?: string; Status?: string; CanApplyToRevenue?: boolean }[] }>('/TaxRates', 'the tax type')
      if (tax && line) {
        const rates = tax.TaxRates ?? []
        const t = rates.find((r) => r.TaxType === line.TaxType)
        const usable = rates.filter((r) => r.Status === 'ACTIVE' && r.CanApplyToRevenue).slice(0, 8).map((r) => `${r.Name} (${r.TaxType})`).join(', ')
        if (!t) found.push(`Tax type ${line.TaxType} does not exist in this organisation. Tax types usable on sales here: ${usable || 'none found'}.`)
        else if (t.Status !== 'ACTIVE' || t.CanApplyToRevenue === false) found.push(`Tax type ${line.TaxType} cannot be used on sales in this organisation. Tax types usable on sales here: ${usable || 'none found'}.`)
      }
      if (line) {
        const acc = await get<{ Accounts?: { Code?: string; Status?: string; Type?: string; Name?: string }[] }>(`/Accounts?where=${encodeURIComponent(`Code=="${line.AccountCode.replace(/["\\]/g, '')}"`)}`, 'the sales account')
        const a = acc?.Accounts?.[0]
        if (acc && !a) found.push(`Account code ${line.AccountCode} does not exist in this organisation.`)
        else if (a && (a.Status !== 'ACTIVE' || !['REVENUE', 'SALES', 'OTHERINCOME'].includes(String(a.Type)))) found.push(`Account ${line.AccountCode} (${a.Name ?? 'unnamed'}) is ${a.Status === 'ACTIVE' ? `a ${a.Type} account, not a sales account` : 'archived'}. Pick a sales account code in Settings.`)
      }
      const contact = await get<{ Contacts?: { ContactStatus?: string }[] }>(`/Contacts/${encodeURIComponent(body.Contact.ContactID)}`, 'the contact')
      if (contact === null && !found.some((f) => f.includes('the contact'))) found.push('The contact was not found in this organisation. The saved ContactID is from another organisation or was deleted: copy it again from the Demo Company contact.')
      else if (contact?.Contacts?.[0]?.ContactStatus === 'ARCHIVED') found.push('The contact is archived in Xero. Restore it or use another contact.')
      if (body.BrandingThemeID) {
        const th = await get<{ BrandingThemes?: { BrandingThemeID?: string; Name?: string }[] }>('/BrandingThemes', 'the branding theme')
        if (th && !(th.BrandingThemes ?? []).some((b) => b.BrandingThemeID?.toLowerCase() === body.BrandingThemeID!.toLowerCase())) {
          found.push(`The saved branding theme id is not a theme in this organisation (the id in the editor page address is not always the API id). Themes here: ${(th.BrandingThemes ?? []).map((b) => `${b.Name} (${b.BrandingThemeID})`).join(', ') || 'none'}. Pick one in Settings.`)
        }
      }
      if (found.length === 0) found.push('Checked the currency, tax type, account, contact and branding theme: all exist. The message from Xero above is the cause.')
      return found
    },
    async getInvoice(id: string) {
      const res = await call(`/Invoices/${encodeURIComponent(id)}`)
      if (res.status === 404) return null
      check(res, 'reading the invoice')
      const inv = ((await res.json()) as { Invoices?: (RawInvoice & { Reference?: string; CurrencyCode?: string; Total?: number; SentToContact?: boolean; Contact?: { ContactID?: string } })[] }).Invoices?.[0]
      if (!inv) return null
      const contactId = inv.Contact?.ContactID ?? null
      let contactEmail: string | null = null
      let hasAddress: boolean | null = null
      if (contactId) {
        const cRes = await call(`/Contacts/${encodeURIComponent(contactId)}`)
        if (cRes.ok) {
          const c = ((await cRes.json()) as { Contacts?: { EmailAddress?: string; Addresses?: Record<string, unknown>[] }[] }).Contacts?.[0]
          contactEmail = c?.EmailAddress?.trim() || null
          hasAddress = (c?.Addresses ?? []).some((a) => ['AddressLine1', 'AddressLine2', 'AddressLine3', 'AddressLine4', 'City', 'PostalCode'].some((k) => typeof a[k] === 'string' && (a[k] as string).trim() !== ''))
        }
      }
      return { id: String(inv.InvoiceID ?? id), number: String(inv.InvoiceNumber ?? ''), status: String(inv.Status ?? ''), reference: String(inv.Reference ?? ''), currency: String(inv.CurrencyCode ?? ''), totalCents: Math.round(Number(inv.Total ?? 0) * 100), contactId, contactEmail, hasAddress, sentToContact: inv.SentToContact === true }
    },
    async approveInvoice(id: string) {
      const res = await call(`/Invoices/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `fn-approve-${id}`.slice(0, 128) }, body: JSON.stringify({ Invoices: [{ InvoiceID: id, Status: 'AUTHORISED' }] }) })
      if (res.status === 400) throw new Error(`Xero would not approve it: ${parseXeroValidation(await res.text().catch(() => '')).messages[0] ?? 'no reason given'}`)
      check(res, 'approving the invoice')
    },
    async emailInvoice(id: string) {
      // Xero's documented request is an empty JSON object; the contact's own email address is used.
      const res = await call(`/Invoices/${encodeURIComponent(id)}/Email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (res.ok) return
      // Say what Xero said (its own words only, scrubbed), so a failure can be understood instead of guessed at.
      const text = await res.text().catch(() => '')
      const why = parseXeroValidation(text).messages[0] ?? (text.trim().startsWith('{') ? '' : scrub(text, 120))
      xeroLog({ event: 'xero-write-email-failed', status: res.status, body: scrub(text, 600) })
      if (res.status === 401 || res.status === 403) throw new Error(`Xero refused to email it (${res.status}). Reconnect the Xero write connection in Settings.`)
      throw new Error(`Xero would not email it (${res.status})${why ? `: ${why}` : ''}`)
    },
    async invoicePdf(id: string) {
      const res = await call(`/Invoices/${encodeURIComponent(id)}`, { headers: { accept: 'application/pdf' } })
      check(res, 'downloading the PDF')
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length < 100 || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') throw new Error('Xero did not return a PDF')
      return bytes
    },
    async contactCheck(contactId: string, sinceDate: string) {
      const cRes = await call(`/Contacts/${encodeURIComponent(contactId)}`)
      let hasAddress: boolean | null = null
      if (cRes.ok) {
        const addrs = ((await cRes.json()) as { Contacts?: { Addresses?: Record<string, unknown>[] }[] }).Contacts?.[0]?.Addresses ?? []
        const filled = (a: Record<string, unknown>) => ['AddressLine1', 'AddressLine2', 'AddressLine3', 'AddressLine4', 'City', 'PostalCode'].some((k) => typeof a[k] === 'string' && (a[k] as string).trim() !== '')
        hasAddress = addrs.some(filled)
      }
      const [y, m, d] = sinceDate.split('-').map(Number)
      const iRes = await call(`/Invoices?ContactIDs=${encodeURIComponent(contactId)}&where=${encodeURIComponent(`Type=="ACCREC" AND Date>=DateTime(${y}, ${m}, ${d})`)}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID&summaryOnly=true`)
      if (!iRes.ok) throw new Error('could not list')
      const rows = ((await iRes.json()) as { Invoices?: (RawInvoice & { DateString?: string; Reference?: string })[] }).Invoices ?? []
      return { hasAddress, recent: rows.map((r) => ({ number: String(r.InvoiceNumber ?? ''), date: String(r.DateString ?? '').slice(0, 10), status: String(r.Status ?? ''), reference: String(r.Reference ?? '') })) }
    },
    async brandingThemes() {
      const res = await call('/BrandingThemes')
      check(res, 'listing branding themes')
      const rows = ((await res.json()) as { BrandingThemes?: { BrandingThemeID?: string; Name?: string }[] }).BrandingThemes ?? []
      return rows.filter((r) => r.BrandingThemeID).map((r) => ({ id: String(r.BrandingThemeID), name: String(r.Name ?? '') }))
    },
    async createDraft(body: DraftBody, idempotencyKey: string) {
      const key = idempotencyKey.slice(0, 128)
      const res = await call('/Invoices', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ Invoices: [body] }) })
      if (res.status === 400) {
        const text = await res.text().catch(() => '')
        const { messages, field } = parseXeroValidation(text)
        // Xero words it as "Invoice # must be unique" (or "... already exists"). The invoice number is the only
        // unique-constrained field in this request (the contact is sent by id, not by name).
        if (messages.some((m) => /must be unique|already (exists|been used|in use)/i.test(m) && !/contact/i.test(m))) throw new DuplicateInvoiceNumber()
        // Everything needed to see what happened, and nothing secret: the request fields, the tenant
        // (8 characters), the organisations this login reaches, and Xero's own error text.
        const tenantId = await tenant()
        const org = await organisationRaw().catch(() => null)
        const conns = await fetch(CONNECTIONS_URL, { headers: { authorization: `Bearer ${(await validTokens(c, store)).accessToken}` }, cache: 'no-store', signal: AbortSignal.timeout(15_000) }).then(async (r) => (r.ok ? ((await r.json()) as { tenantId?: string; tenantName?: string }[]).map((x) => `${x.tenantName ?? '?'} [${short(x.tenantId)}]`) : [`could not list (${r.status})`])).catch(() => ['could not list'])
        const debug: DraftDebug = { at: new Date().toISOString(), method: 'POST', endpoint: `${API}/Invoices`, apiVersion: XERO_API_VERSION, tenant: short(tenantId) ?? '', organisationId: short(org?.id), connections: conns, idempotencyKey: key, request: describeRequest(body), status: 400, rawBody: scrub(text, 2000) }
        xeroLog({ event: 'xero-write-rejected', ...debug })
        throw new XeroRejected(messages, field, debug)
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
