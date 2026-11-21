/**
 * Raises the DRAFT sales invoice for an accepted offer. Draft only: this module never authorises,
 * emails or files anything. Xero is reached through the small XeroApi interface, so the rules
 * (org guard, numbering, adopting an existing draft, retry on a taken number) are tested with a
 * fake and the real HTTP lives in lib/xero/write.ts.
 */
import { getJson, type Store } from '../store'
import type { Client } from './clients'
import type { DraftDebug } from './types'
import { nextInvoiceNumber } from './numbering'
import type { PublicLine } from './pricing'

export interface DraftSettings {
  /** Xero tax type on every line. The agreed default is none (EU trade under the margin scheme). */
  taxType: string
  accountCode: string
  /** The branding theme ("Sold under VAT Margin Scheme, ART 313"), by Xero id. Null leaves Xero's default. */
  brandingThemeId: string | null
  /**
   * The theme for each Xero organisation, by its id: a theme id exists in one organisation only, so one
   * organisation's id is never sent to another. `brandingThemeId` above is what was saved before this
   * existed and belongs to the LIVE organisation.
   */
  brandingThemeIds?: Record<string, string>
}

/** The branding theme for this organisation: its own, else the older single id for a live organisation, never for a demo. */
export function themeFor(s: Pick<DraftSettings, 'brandingThemeId' | 'brandingThemeIds'>, org: { id?: string | null; isDemo: boolean }): string | null {
  const own = org.id ? s.brandingThemeIds?.[org.id.toLowerCase()] : undefined
  if (own) return own
  return org.isDemo ? null : s.brandingThemeId
}
export const DEFAULT_DRAFT_SETTINGS: DraftSettings = { taxType: 'NONE', accountCode: '200', brandingThemeId: null }

export async function loadDraftSettings(store: Store): Promise<DraftSettings> {
  const saved = await getJson<Partial<DraftSettings>>(store, 'offers:draft-settings')
  return { ...DEFAULT_DRAFT_SETTINGS, ...(saved ?? {}) }
}

export interface DraftBody {
  Type: 'ACCREC'
  Status: 'DRAFT'
  InvoiceNumber: string
  Reference: string
  Contact: { ContactID: string }
  Date: string
  DueDate: string
  CurrencyCode: 'EUR'
  LineAmountTypes: 'Exclusive'
  BrandingThemeID?: string
  LineItems: { Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string }[]
}

export interface XeroInvoiceRef { id: string; number: string; status: string }

/** An invoice as Xero holds it right now, for the checks before approving or sending. */
export interface XeroInvoiceDetail {
  id: string
  number: string
  status: string
  reference: string
  currency: string
  totalCents: number
  contactId: string | null
  /** The contact's email as Xero has it (Xero's own email goes only there). */
  contactEmail: string | null
  hasAddress: boolean | null
  /** Xero has already emailed it. */
  sentToContact: boolean
}

export interface XeroApi {
  organisation(): Promise<{ name: string; isDemo: boolean; id?: string }>
  /** Every sales (ACCREC) invoice number in the organisation, whatever its status. */
  invoiceNumbers(): Promise<string[]>
  findByReference(reference: string): Promise<XeroInvoiceRef | null>
  createDraft(body: DraftBody, idempotencyKey: string): Promise<XeroInvoiceRef>
  /** After Xero rejected the draft: check the currency, tax type, account, contact and branding theme, and say which is wrong. Best effort. */
  diagnose?(body: DraftBody): Promise<string[]>
  /** The invoice as Xero holds it now. Null when it does not exist (any more). */
  getInvoice?(id: string): Promise<XeroInvoiceDetail | null>
  /** Draft -> approved (AUTHORISED). Nothing else is changed. */
  approveInvoice?(id: string): Promise<void>
  /** Xero emails the approved invoice to its contact's email address. */
  emailInvoice?(id: string): Promise<void>
  /** The invoice as a PDF (checked to start with %PDF). */
  invoicePdf?(id: string): Promise<Uint8Array>
  /** The contact's address, and its invoices from the last 14 days (for warnings; best effort, never blocks a draft). */
  contactCheck?(contactId: string, sinceDate: string): Promise<{ hasAddress: boolean | null; recent: { number: string; date: string; status: string; reference: string }[] }>
  /** The organisation's branding themes with their API ids, for the Settings dropdown. */
  brandingThemes?(): Promise<{ id: string; name: string }[]>
}

/** Thrown by the real client when Xero says the invoice number is already taken. */
export class DuplicateInvoiceNumber extends Error {
  constructor() {
    super('That invoice number is already used in Xero')
    this.name = 'DuplicateInvoiceNumber'
  }
}

/** Xero understood the draft and refused it (a 400): a rule or a setting is wrong, so trying again cannot help. */
export class XeroRejected extends Error {
  constructor(public messages: string[], public field: string | null, public debug?: DraftDebug) {
    super('Xero rejected the draft invoice')
    this.name = 'XeroRejected'
  }
}

const FIELD_HINTS: [RegExp, string][] = [
  [/branding/i, 'Branding theme'],
  [/currenc/i, 'Currency'],
  [/tax/i, 'Tax type'],
  [/account/i, 'Account code'],
  [/contact/i, 'Contact'],
  [/due ?date|\bdate\b/i, 'Date'],
  [/invoice ?number/i, 'Invoice number'],
]

/**
 * Xero's 400 body, reduced to its validation messages and a guess at which field they point at.
 * Only the messages Xero wrote are kept (short, de-duplicated, anything bearer-like removed); the
 * body itself is never passed on.
 */
export function parseXeroValidation(text: string): { messages: string[]; field: string | null } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { messages: [], field: null }
  }
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v !== 'string') return
    const m = v.replace(/bearer\s+\S+/gi, '[removed]').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (m && !out.includes(m)) out.push(m)
  }
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 4) return
    if (Array.isArray(o)) return void o.forEach((x) => walk(x, depth + 1))
    const r = o as Record<string, unknown>
    if (Array.isArray(r.ValidationErrors)) for (const e of r.ValidationErrors) add((e as { Message?: unknown } | null)?.Message)
    if (Array.isArray(r.Elements)) walk(r.Elements, depth + 1)
  }
  walk(json, 0)
  const top = json as { Message?: unknown; Detail?: unknown } | null
  if (out.length === 0) add(top?.Detail)
  if (out.length === 0) add(top?.Message)
  const messages = out.slice(0, 6)
  const field = FIELD_HINTS.find(([re]) => messages.some((m) => re.test(m)))?.[1] ?? null
  return { messages, field }
}

export type DraftResult =
  | { ok: true; id: string; number: string; org: string; adopted: boolean; warnings: string[] }
  | { ok: false; error: string; /** Worth retrying later: Xero or the network, not a rule. */ retry: boolean; details?: string[]; field?: string; debug?: DraftDebug; rejected?: boolean }

const euros = (cents: number) => Math.round(cents) / 100
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function dueDate(now: Date, terms: Client['terms']): string {
  const days = terms === 'upfront' ? 0 : terms.days
  return isoDate(new Date(now.getTime() + days * 86_400_000))
}

export { xeroDraftUrl } from './xero-url'

/** The description of the shipping line on the draft. */
export const SHIPPING_DESCRIPTION = 'SHIPPING CHARGES'

export function buildDraftBody(a: { number: string; reference: string; contactId: string; lines: readonly PublicLine[]; shippingCents?: number; terms: Client['terms']; now: Date; settings: DraftSettings }): DraftBody {
  return {
    Type: 'ACCREC',
    Status: 'DRAFT',
    InvoiceNumber: a.number,
    Reference: a.reference,
    Contact: { ContactID: a.contactId },
    Date: isoDate(a.now),
    DueDate: dueDate(a.now, a.terms),
    CurrencyCode: 'EUR',
    LineAmountTypes: 'Exclusive',
    ...(a.settings.brandingThemeId ? { BrandingThemeID: a.settings.brandingThemeId } : {}),
    LineItems: [
      ...a.lines.map((l) => ({ Description: l.description, Quantity: l.qty, UnitAmount: euros(l.unitSaleCents), AccountCode: a.settings.accountCode, TaxType: a.settings.taxType })),
      // Its own line, on the same account and tax type as the items (invoice 2026047 does the same).
      ...(a.shippingCents && a.shippingCents > 0 ? [{ Description: SHIPPING_DESCRIPTION, Quantity: 1, UnitAmount: euros(a.shippingCents), AccountCode: a.settings.accountCode, TaxType: a.settings.taxType }] : []),
    ],
  }
}

/** The number is read from Xero, and if Xero calls it a duplicate it is read again and tried once more, never more. */
const MAX_TRIES = 2

export async function raiseDraft(a: { api: XeroApi; store: Store; reference: string; client: Client; test: boolean; lines: readonly PublicLine[]; settings: DraftSettings; now?: Date; idempotencyKey?: string; shippingCents?: number; /** XERO_WRITE_ALLOW_LIVE: drafts in a live organisation are off unless this was switched on on purpose. */ allowLive?: boolean }): Promise<DraftResult> {
  const now = a.now ?? new Date()
  const fail = (error: string, retry = false, extra: { details?: string[]; field?: string; debug?: DraftDebug; rejected?: boolean } = {}): DraftResult => ({ ok: false, error, retry, ...extra })
  if (a.lines.length === 0) return fail('The offer has no priced lines, so there is nothing to invoice.')
  try {
    const org = await a.api.organisation()
    // The guard: test offers touch only a demo organisation (unless a live test contact is mapped for the test client), real offers only the live one.
    const settings = { ...a.settings, brandingThemeId: themeFor(a.settings, org) }
    // A test offer never touches the live organisation, whatever contacts are mapped.
    if (a.test && !org.isDemo) return fail(`Test offers only go to the Xero Demo Company, and the selected organisation (${org.name}) is not a demo. Tests never create anything in the live organisation. Nothing was created.`)
    const contactId = a.client.xeroContactId
    if (!contactId) return fail(`${a.client.name} has no Xero ContactID yet. Add it on the Clients screen.`)
    if (!org.isDemo && !a.allowLive) return fail(`The connected Xero organisation (${org.name}) is a live one, and drafts in a live organisation are switched off. They need their own step: set XERO_WRITE_ALLOW_LIVE=true in Vercel. This is separate from sending offers to real clients. Nothing was created.`)
    if (!a.test && org.isDemo) return fail(`Real offers may not create drafts in a demo organisation (${org.name}). Connect the live Xero organisation. Nothing was created.`)

    // Things worth a look, none of which stop the draft: the contact has no address, or was invoiced in the last 14 days.
    const warnings: string[] = []
    const existing = await a.api.findByReference(a.reference)
    if (a.api.contactCheck) {
      try {
        const since = new Date(now.getTime() - 14 * 86_400_000).toISOString().slice(0, 10)
        const c = await a.api.contactCheck(contactId, since)
        if (c.hasAddress === false) warnings.push('Add an address in Xero before approving')
        const recent = c.recent.filter((r) => r.reference !== a.reference && !(existing && r.number === existing.number))
        if (recent.length) warnings.push(`${a.client.name} already has ${recent.length === 1 ? 'an invoice' : `${recent.length} invoices`} in Xero from the last 14 days: ${recent.slice(0, 4).map((r) => `${r.number || '(no number)'} (${r.date}, ${r.status.toLowerCase()})`).join(', ')}`)
      } catch {
        warnings.push("Could not check the contact's address and recent invoices in Xero")
      }
    }
    // A draft with this reference may already exist (an earlier attempt that lost its answer): link to it, never create another.
    if (existing) return { ok: true, id: existing.id, number: existing.number, org: org.name, adopted: true, warnings }

    // One at a time within this app, so two of our own runs never read the same highest number.
    // The number itself always comes from Xero (no local counter): the highest 7-digit sales number there, plus one.
    return await a.store.withLock('offers:invoice-number', async (): Promise<DraftResult> => {
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        // Inside the lock, every time: a draft for this reference may have appeared since the check above (a parallel run,
        // or a duplicate-number retry). Link to it; never make a second.
        const appeared = attempt === 0 && !a.api.findByReference ? null : await a.api.findByReference(a.reference)
        if (appeared) return { ok: true, id: appeared.id, number: appeared.number, org: org.name, adopted: true, warnings }
        const n = nextInvoiceNumber(await a.api.invoiceNumbers(), org.isDemo) // re-read from Xero every time
        if (!n.ok) return fail(n.error)
        const body = buildDraftBody({ number: n.number, reference: a.reference, contactId, lines: a.lines, shippingCents: a.shippingCents, terms: a.client.terms, now, settings })
        try {
          // The key carries the invoice number: a different number is a different request, and Xero
          // answers the same key with the same (stored) result.
          const made = await a.api.createDraft(body, `${a.idempotencyKey ?? `fn-draft-${a.reference}`}-n${n.number}`)
          return { ok: true, id: made.id, number: made.number, org: org.name, adopted: false, warnings }
        } catch (e) {
          if (e instanceof DuplicateInvoiceNumber) continue // taken in the meantime: read Xero again, once
          if (e instanceof XeroRejected) {
            // Xero understood the draft and refused it: say exactly why, and which setting to check.
            const found = a.api.diagnose ? await a.api.diagnose(body).catch(() => [] as string[]) : []
            const first = e.messages[0] ?? 'no reason given'
            return fail(`Xero rejected the draft invoice${e.field ? ` (${e.field})` : ''}: ${first}`, false, { details: [...e.messages, ...found], rejected: true, ...(e.field ? { field: e.field } : {}), ...(e.debug ? { debug: e.debug } : {}) })
          }
          throw e
        }
      }
      return fail('Xero said the invoice number was taken twice in a row. Nothing was created; the next attempt reads the numbers from Xero again, and a draft for this order is never made twice.', true)
    })
  } catch (e) {
    // Never include anything but our own sentence: no tokens, no response bodies.
    return fail(e instanceof Error && e.message ? e.message.slice(0, 200) : 'Xero could not be reached', true)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The Settings form's values, checked before they are saved. */
export function checkDraftSettings(body: unknown): { ok: true; value: DraftSettings } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const taxType = typeof b.taxType === 'string' ? b.taxType.trim().toUpperCase() : ''
  if (!/^[A-Z0-9]{2,40}$/.test(taxType)) return { ok: false, error: 'The tax type is a Xero code such as NONE or ZERORATEDOUTPUT (letters and digits only).' }
  const accountCode = typeof b.accountCode === 'string' ? b.accountCode.trim() : ''
  if (!/^[A-Za-z0-9]{1,10}$/.test(accountCode)) return { ok: false, error: 'The sales account is the account code in Xero, such as 200.' }
  const raw = typeof b.brandingThemeId === 'string' ? b.brandingThemeId.trim() : ''
  if (raw && !UUID.test(raw)) return { ok: false, error: 'The branding theme id must look like a1b2c3d4-e5f6-7890-abcd-ef1234567890 (or be left empty).' }
  return { ok: true, value: { taxType, accountCode, brandingThemeId: raw || null } }
}
