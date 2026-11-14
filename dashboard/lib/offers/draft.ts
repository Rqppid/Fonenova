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
}

/** Thrown by the real client when Xero says the invoice number is already taken. */
export class DuplicateInvoiceNumber extends Error {
  constructor() {
    super('That invoice number is already used in Xero')
    this.name = 'DuplicateInvoiceNumber'
  }
}

export type DraftResult =
  | { ok: true; id: string; number: string; org: string; adopted: boolean }
  | { ok: false; error: string; /** Worth retrying later: Xero or the network, not a rule. */ retry: boolean }

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
  const fail = (error: string, retry = false): DraftResult => ({ ok: false, error, retry })
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
        try {
          const made = await a.api.createDraft(buildDraftBody({ number: n.number, reference: a.reference, contactId: a.client.xeroContactId!, lines: a.lines, terms: a.client.terms, now, settings: a.settings }), `fn-draft-${a.reference}`)
          await a.store.set('offers:invoice-hwm', Number(n.number))
          return { ok: true, id: made.id, number: made.number, org: org.name, adopted: false }
        } catch (e) {
          if (e instanceof DuplicateInvoiceNumber) {
            // Taken in the meantime: remember it so the next attempt goes past it.
            await a.store.set('offers:invoice-hwm', Number(n.number))
            continue
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
