/**
 * The clients offers are priced for, and how each one's margin works. Types, the first-run list
 * and the checks on every save. No server imports, so the Clients screen uses the same checks.
 */
export type MarginRule = { type: 'fixed'; perUnitCents: number; locked: boolean } | { type: 'manual' }
export type Terms = { days: number } | 'upfront'
export type Folder = 'wave' | 'telecom' | 'other'

export interface Client {
  id: string
  name: string
  /** Xero's ContactID. Invoices use it, never the name. Optional until invoices are raised from Quay Pilot. */
  xeroContactId: string | null
  offerEmails: string[]
  invoiceEmails: string[]
  margin: MarginRule
  terms: Terms
  /** Skip the manual approval step. Always false until the approve step exists. */
  autoApprove: false
  folder: Folder
  /** A test client: a real inbox of the owner's, never a real customer. */
  test: boolean
}

export const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'wave', label: 'Wave Phone folder' },
  { key: 'telecom', label: 'EU Telecoms folder' },
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
    { id: 'c_wave', name: 'Wave Phone B.V.', xeroContactId: '1597cc5c-fbed-4817-a4e1-53149bb46d77', offerEmails: ['info@wavephone.nl'], invoiceEmails: ['info@wavephone.nl'], margin: { type: 'manual' }, terms: { days: 30 }, autoApprove: false, folder: 'wave', test: false },
    { id: 'c_eutelecoms', name: 'EU Telecoms BL EOOD', xeroContactId: 'a7401e62-a54e-495e-98cd-85f3c6c027b8', offerEmails: ['contact@eutelecoms.com'], invoiceEmails: ['contact@eutelecoms.com'], margin: { type: 'fixed', perUnitCents: 400, locked: true }, terms: { days: 30 }, autoApprove: false, folder: 'telecom', test: false },
    { id: 'c_test', name: 'Test client (my own inbox)', xeroContactId: null, offerEmails: [], invoiceEmails: [], margin: { type: 'manual' }, terms: { days: 30 }, autoApprove: false, folder: 'other', test: true },
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

export function checkClients(body: unknown): Checked<Client[]> {
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
    if (b.autoApprove === true) return { ok: false, error: `${who}: auto-approve arrives with the approve step; it stays off for now` }
    if (b.folder !== 'wave' && b.folder !== 'telecom' && b.folder !== 'other') return { ok: false, error: `${who}: choose a folder` }
    out.push({ id, name, xeroContactId: contact, offerEmails: offer.value, invoiceEmails: invoice.value, margin, terms, autoApprove: false, folder: b.folder, test: b.test === true })
  }
  return { ok: true, value: out }
}
