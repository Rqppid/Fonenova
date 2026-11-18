/**
 * The clients offers are priced for, and how each one's margin works. Types, the first-run list
 * and the checks on every save. No server imports, so the Clients screen uses the same checks.
 */
export type MarginRule = { type: 'fixed'; perUnitCents: number; locked: boolean } | { type: 'manual' }
export type Terms = { days: number } | 'upfront'
export type Folder = 'wave' | 'telecom' | 'tradewise' | 'giglobal' | 'other'

export interface Client {
  id: string
  name: string
  /** Xero's ContactID. Invoices use it, never the name. Optional until invoices are raised from Quay Pilot. */
  xeroContactId: string | null
  /** A test client only: its contact in the LIVE Xero organisation. Without it a test offer can only go to the Demo Company. */
  liveTestContactId?: string | null
  offerEmails: string[]
  invoiceEmails: string[]
  margin: MarginRule
  terms: Terms
  /** The owner chose the payment terms on purpose. Required before a client can stop being a test client; the shipped default is only a placeholder. */
  termsConfirmed?: boolean
  /** Client shipping = Mobile One's shipping x this. Default 2; editable per client. */
  shippingMultiplier?: number
  /** How shipping is charged: a multiple of Mobile One's shipping, or our own DHL cost typed per order. Default: see shippingBasisOf. */
  shippingBasis?: ShippingBasis
  /** Skip the manual approval step. Always false until the approve step exists. */
  autoApprove: false
  /**
   * Approve the invoice in Xero and email it to the client by itself, 10 minutes after the client accepts
   * (with a Hold button). Absent on a client saved before this existed: see autoInvoiceOf.
   */
  autoInvoice?: boolean
  folder: Folder
  /** A test client: a real inbox of the owner's, never a real customer. */
  test: boolean
}

export const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'wave', label: 'Wave Phone folder' },
  { key: 'telecom', label: 'EU Telecoms folder' },
  { key: 'tradewise', label: 'Trade Wise folder' },
  { key: 'giglobal', label: 'G&I Global folder' },
  { key: 'other', label: 'New customers folder' },
]

/** Shown to the owner in words next to the price panel. */
export const ruleText = (c: Client) =>
  c.margin.type === 'fixed'
    ? `Fixed €${(c.margin.perUnitCents / 100).toFixed(2)} per unit${c.margin.locked ? ', locked' : ''}`
    : 'You set the margin per offer'

/** The first list: Wave and EU Telecoms as agreed, plus an empty test client to fill in. */
export function seedClients(): Client[] {
  return [
    { id: 'c_wave', name: 'Wave Phone B.V.', xeroContactId: '1597cc5c-fbed-4817-a4e1-53149bb46d77', offerEmails: ['info@wavephone.nl'], invoiceEmails: ['info@wavephone.nl'], margin: { type: 'manual' }, terms: { days: 30 }, termsConfirmed: false, shippingMultiplier: 2, shippingBasis: 'mobile_one', autoApprove: false, folder: 'wave', test: false },
    { id: 'c_eutelecoms', name: 'EU Telecoms BL EOOD', xeroContactId: 'a7401e62-a54e-495e-98cd-85f3c6c027b8', offerEmails: ['contact@eutelecoms.com'], invoiceEmails: ['contact@eutelecoms.com'], margin: { type: 'fixed', perUnitCents: 400, locked: true }, terms: { days: 30 }, termsConfirmed: false, shippingMultiplier: 2, shippingBasis: 'own_dhl', autoApprove: false, folder: 'telecom', test: false },
    { id: 'c_test', name: 'Test client (my own inbox)', xeroContactId: null, offerEmails: [], invoiceEmails: [], margin: { type: 'manual' }, terms: { days: 30 }, termsConfirmed: false, shippingMultiplier: 2, shippingBasis: 'mobile_one', autoInvoice: true, autoApprove: false, folder: 'other', test: true },
  ]
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const EMAIL = /^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}\.[^\s@<>,;]{2,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MARGIN_CENTS = 50_000

function emails(v: unknown, label: string, who: string): Checked<string[]> {
  if (!Array.isArray(v) || v.length > 10) return { ok: false, error: `${who}: ${label} must be a list of up to 10 addresses` }
  const out: string[] = []
  for (const e of v) {
    const s = typeof e === 'string' ? e.trim().toLowerCase() : ''
    if (!EMAIL.test(s)) return { ok: false, error: `${who}: "${String(e).slice(0, 60)}" is not a valid email address` }
    if (!out.includes(s)) out.push(s)
  }
  return { ok: true, value: out }
}

/** Automatic invoicing is a setting of every client, off until it is switched on. */
export const autoInvoiceOf = (c: Pick<Client, 'autoInvoice'>): boolean => c.autoInvoice === true

/**
 * How a client is charged for shipping (a setting of every client):
 * - mobile_one: Mobile One's shipping (from their invoice) times the client's multiplier.
 * - own_dhl: the cost of our own DHL label to them, typed per order, no mark-up.
 */
export type ShippingBasis = 'mobile_one' | 'own_dhl'
export const shippingBasisOf = (c: Pick<Client, 'shippingBasis'>): ShippingBasis => c.shippingBasis ?? 'mobile_one'

/**
 * Lists saved before these two settings were explicit: fill in what those clients effectively had, once, so nothing
 * changes for them. This is the ONLY place that knows two clients by id; after it, every client is an ordinary record
 * and a save from the Clients screen keeps the explicit values. Pure and idempotent.
 */
export function backfillClientDefaults(list: readonly Client[]): Client[] {
  const legacy: Record<string, Pick<Client, 'shippingBasis' | 'autoInvoice'>> = {
    c_wave: { shippingBasis: 'mobile_one', autoInvoice: true },
    c_eutelecoms: { shippingBasis: 'own_dhl', autoInvoice: true },
  }
  return list.map((c) => {
    const l = legacy[c.id]
    // Automatic invoicing needs terms confirmed, a Xero contact and an invoice address (checkClients enforces it on save), so a
    // legacy client that is not ready yet is simply off until the owner switches it on.
    const ready = c.test || (c.termsConfirmed && c.xeroContactId !== null && c.invoiceEmails.length > 0)
    return { ...c, shippingBasis: c.shippingBasis ?? l?.shippingBasis ?? 'mobile_one', autoInvoice: c.autoInvoice ?? ((l?.autoInvoice ?? c.test) && ready) }
  })
}

/** The saved clients (or the first-run list), with every setting explicit. Use this everywhere a client list is read. */
export const clientsFrom = (saved: readonly Client[] | null | undefined): Client[] => backfillClientDefaults(saved ?? seedClients())

export const DEFAULT_SHIPPING_MULTIPLIER = 2
export const multiplierOf = (c: Pick<Client, 'shippingMultiplier'>) => c.shippingMultiplier ?? DEFAULT_SHIPPING_MULTIPLIER

/** What the client is charged for a typed figure: Mobile One's shipping times the multiplier, or our own DHL cost as typed (no mark-up). In cents. */
export const chargeFor = (c: Pick<Client, 'shippingBasis' | 'shippingMultiplier'>, typedCents: number): number => (shippingBasisOf(c) === 'own_dhl' ? typedCents : Math.round(typedCents * multiplierOf(c)))

/**
 * `previous` is the saved list: a client that is new, or that was a test client, must have its payment
 * terms confirmed before it can be saved as a real one. A real client that is already saved is not
 * held up by this when something else is edited.
 */
export function checkClients(body: unknown, previous: readonly Client[] = []): Checked<Client[]> {
  if (!Array.isArray(body) || body.length > 50) return { ok: false, error: 'Expected a list of up to 50 clients' }
  const out: Client[] = []
  for (const raw of body) {
    const b = (raw ?? {}) as Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const who = name || 'A client'
    if (!name || name.length > 80) return { ok: false, error: 'Every client needs a name (up to 80 characters)' }
    const id = typeof b.id === 'string' ? b.id : ''
    if (!/^c_[a-z0-9]{2,24}$/.test(id)) return { ok: false, error: `${who}: unknown id` }
    if (out.some((c) => c.id === id || c.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `${who}: appears twice` }
    const contact = b.xeroContactId === null || b.xeroContactId === undefined || b.xeroContactId === '' ? null : String(b.xeroContactId).trim()
    if (contact !== null && !UUID.test(contact)) return { ok: false, error: `${who}: the Xero ContactID must look like a1b2c3d4-e5f6-7890-abcd-ef1234567890` }
    const liveRaw = b.liveTestContactId === null || b.liveTestContactId === undefined || b.liveTestContactId === '' ? null : String(b.liveTestContactId).trim()
    if (liveRaw !== null && !UUID.test(liveRaw)) return { ok: false, error: `${who}: the live test contact id must look like a1b2c3d4-e5f6-7890-abcd-ef1234567890` }
    if (liveRaw !== null && b.test !== true) return { ok: false, error: `${who}: a live test contact belongs to a test client only` }
    const offer = emails(b.offerEmails ?? [], 'offer emails', who)
    if (!offer.ok) return offer
    const invoice = emails(b.invoiceEmails ?? [], 'invoice emails', who)
    if (!invoice.ok) return invoice
    const m = (b.margin ?? {}) as Record<string, unknown>
    let margin: MarginRule
    if (m.type === 'fixed') {
      if (typeof m.perUnitCents !== 'number' || !Number.isSafeInteger(m.perUnitCents) || m.perUnitCents < 1 || m.perUnitCents > MAX_MARGIN_CENTS) return { ok: false, error: `${who}: a fixed margin must be between €0.01 and €500.00 per unit` }
      margin = { type: 'fixed', perUnitCents: m.perUnitCents, locked: m.locked === true }
    } else if (m.type === 'manual') margin = { type: 'manual' }
    else return { ok: false, error: `${who}: margin must be fixed or manual` }
    const t = b.terms
    let terms: Terms
    if (t === 'upfront') terms = 'upfront'
    else if (t && typeof t === 'object' && typeof (t as { days?: unknown }).days === 'number' && Number.isSafeInteger((t as { days: number }).days) && (t as { days: number }).days >= 0 && (t as { days: number }).days <= 180) terms = { days: (t as { days: number }).days }
    else return { ok: false, error: `${who}: payment terms are a number of days (0 to 180) or upfront` }
    const mult = b.shippingMultiplier === undefined || b.shippingMultiplier === null || b.shippingMultiplier === '' ? DEFAULT_SHIPPING_MULTIPLIER : b.shippingMultiplier
    if (typeof mult !== 'number' || !Number.isFinite(mult) || mult < 0.5 || mult > 10 || Math.round(mult * 100) !== mult * 100) return { ok: false, error: `${who}: the shipping multiplier must be between 0.5 and 10 (for example 2)` }
    if (b.shippingBasis !== undefined && b.shippingBasis !== 'mobile_one' && b.shippingBasis !== 'own_dhl') return { ok: false, error: `${who}: shipping is charged as Mobile One's shipping times a number, or our own DHL cost` }
    const termsConfirmed = b.termsConfirmed === true
    const was = previous.find((c) => c.id === id)
    if (b.test !== true && !termsConfirmed && (!was || was.test)) return { ok: false, error: `${who}: choose the payment terms (for example 7 or 14 days) before this client can be a real client` }
    if (b.autoApprove === true) return { ok: false, error: `${who}: auto-approve arrives with the approve step; it stays off for now` }
    const folder = FOLDERS.find((f) => f.key === b.folder)?.key
    if (!folder) return { ok: false, error: `${who}: choose a folder` }
    if (b.autoInvoice !== undefined && typeof b.autoInvoice !== 'boolean') return { ok: false, error: `${who}: automatic invoicing must be on or off` }
    // Automatic invoicing for a real client needs everything an invoice needs, so it cannot be switched on half set up.
    if (b.autoInvoice === true && b.test !== true && (!(termsConfirmed || (was && !was.test && was.termsConfirmed)) || contact === null || invoice.value.length === 0)) return { ok: false, error: `${who}: automatic invoicing needs the payment terms confirmed, a Xero ContactID and at least one invoice email` }
    out.push({ id, name, xeroContactId: contact, ...(liveRaw ? { liveTestContactId: liveRaw } : {}), offerEmails: offer.value, invoiceEmails: invoice.value, margin, terms, termsConfirmed, shippingMultiplier: mult, ...(b.shippingBasis === 'mobile_one' || b.shippingBasis === 'own_dhl' ? { shippingBasis: b.shippingBasis } : {}), autoApprove: false, ...(typeof b.autoInvoice === 'boolean' ? { autoInvoice: b.autoInvoice } : {}), folder, test: b.test === true })
  }
  return { ok: true, value: out }
}
