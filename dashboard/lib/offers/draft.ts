/**
 * Raises the DRAFT sales invoice for an accepted offer. Draft only: this module never authorises,
 * emails or files anything. Xero is reached through the small XeroApi interface, so the rules
 * (org guard, numbering, adopting an existing draft, retry on a taken number) are tested with a
 * fake and the real HTTP lives in lib/xero/write.ts.
 */
import { getJson, type Store } from '../store'
import type { Client } from './clients'
import { nextInvoiceNumber } from './numbering'
import type { PublicLine } from './pricing'

export interface DraftSettings {
  /** Xero tax type on every line. The agreed default is none (EU trade under the margin scheme). */
  taxType: string
  accountCode: string
  /** The branding theme ("Sold under VAT Margin Scheme, ART 313"), by Xero id. Null leaves Xero's default. */
  brandingThemeId: string | null
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

export interface XeroApi {
  organisation(): Promise<{ name: string; isDemo: boolean }>
  /** Every sales (ACCREC) invoice number in the organisation, whatever its status. */
  invoiceNumbers(): Promise<string[]>
  findByReference(reference: string): Promise<XeroInvoiceRef | null>
  createDraft(body: DraftBody, idempotencyKey: string): Promise<XeroInvoiceRef>
  /** After Xero rejected the draft: check the currency, tax type, account, contact and branding theme, and say which is wrong. Best effort. */
  diagnose?(body: DraftBody): Promise<string[]>
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
  constructor(public messages: string[], public field: string | null) {
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
  | { ok: true; id: string; number: string; org: string; adopted: boolean }
  | { ok: false; error: string; /** Worth retrying later: Xero or the network, not a rule. */ retry: boolean; details?: string[]; field?: string }

const euros = (cents: number) => Math.round(cents) / 100
const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function dueDate(now: Date, terms: Client['terms']): string {
  const days = terms === 'upfront' ? 0 : terms.days
  return isoDate(new Date(now.getTime() + days * 86_400_000))
}

export function buildDraftBody(a: { number: string; reference: string; contactId: string; lines: readonly PublicLine[]; terms: Client['terms']; now: Date; settings: DraftSettings }): DraftBody {
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
    LineItems: a.lines.map((l) => ({ Description: l.description, Quantity: l.qty, UnitAmount: euros(l.unitSaleCents), AccountCode: a.settings.accountCode, TaxType: a.settings.taxType })),
  }
}

const MAX_TRIES = 3

export async function raiseDraft(a: { api: XeroApi; store: Store; reference: string; client: Client; test: boolean; lines: readonly PublicLine[]; settings: DraftSettings; now?: Date }): Promise<DraftResult> {
  const now = a.now ?? new Date()
  const fail = (error: string, retry = false, extra: { details?: string[]; field?: string } = {}): DraftResult => ({ ok: false, error, retry, ...extra })
  if (!a.client.xeroContactId) return fail(`${a.client.name} has no Xero ContactID yet. Add it on the Clients screen.`)
  if (a.lines.length === 0) return fail('The offer has no priced lines, so there is nothing to invoice.')
  try {
    const org = await a.api.organisation()
    // The guard: test offers touch only a demo organisation, real offers only the live one.
    if (a.test && !org.isDemo) return fail(`Test offers may only create drafts in the Xero Demo Company, and the connected organisation (${org.name}) is not a demo. Nothing was created.`)
    if (!a.test && org.isDemo) return fail(`Real offers may not create drafts in a demo organisation (${org.name}). Connect the live Xero organisation. Nothing was created.`)

    // A draft with this reference may already exist (an earlier attempt that lost its answer): adopt it.
    const existing = await a.api.findByReference(a.reference)
    if (existing) return { ok: true, id: existing.id, number: existing.number, org: org.name, adopted: true }

    // One number at a time, so two runs never take the same one.
    return await a.store.withLock('offers:invoice-number', async (): Promise<DraftResult> => {
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        const hwm = await getJson<number>(a.store, 'offers:invoice-hwm')
        const n = nextInvoiceNumber(await a.api.invoiceNumbers(), hwm, org.isDemo)
        if (!n.ok) return fail(n.error)
        const body = buildDraftBody({ number: n.number, reference: a.reference, contactId: a.client.xeroContactId!, lines: a.lines, terms: a.client.terms, now, settings: a.settings })
        try {
          const made = await a.api.createDraft(body, `fn-draft-${a.reference}`)
          await a.store.set('offers:invoice-hwm', Number(n.number))
          return { ok: true, id: made.id, number: made.number, org: org.name, adopted: false }
        } catch (e) {
          if (e instanceof DuplicateInvoiceNumber) {
            // Taken in the meantime: remember it so the next attempt goes past it.
            await a.store.set('offers:invoice-hwm', Number(n.number))
            continue
          }
          if (e instanceof XeroRejected) {
            // Xero understood the draft and refused it: say exactly why, and which setting to check.
            const found = a.api.diagnose ? await a.api.diagnose(body).catch(() => [] as string[]) : []
            const first = e.messages[0] ?? 'no reason given'
            return fail(`Xero rejected the draft invoice${e.field ? ` (${e.field})` : ''}: ${first}`, false, { details: [...e.messages, ...found], ...(e.field ? { field: e.field } : {}) })
          }
          throw e
        }
      }
      return fail('Xero kept refusing the invoice number. Nothing was created; it will be tried again.', true)
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
