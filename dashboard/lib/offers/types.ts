/**
 * Offers from Mobile One, as Quay Pilot keeps them. Money is integer euro cents. Types only, so
 * the review screen (client) and the ingest job (server) share them.
 */
export type OfferStatus = 'needs_review' | 'ready' | 'dismissed' | 'sent' | 'accepted' | 'declined' | 'expired'

export interface OfferLine {
  id: string
  /** As Mobile One wrote it. Typos are kept, and flagged, never silently corrected. */
  model: string
  storage: string | null
  grade: string | null
  qty: number
  unitCostCents: number
  /** The line of the email this came from, so the review can check it. */
  sourceText: string
  /** The reader's remark, e.g. "may mean iPhone 17 Pro". */
  note: string | null
}

/**
 * Mobile One's shipping cost on an offer. It is never assumed: `email` was read from their email,
 * `manual` was typed by the owner, `none` means the owner confirmed there is no shipping.
 */
export interface OfferShipping {
  mobileOneCents: number | null
  source: 'email' | 'manual' | 'none'
  /** The line of the email it was read from, for the review screen. */
  sourceText: string | null
}

/** How an offer is priced for one client. Sale prices come from this, never from the browser. */
export interface OfferPricing {
  clientId: string
  /** The per-unit margin for the whole offer (manual clients), in cents. Null for fixed clients. */
  marginCents: number | null
  /** Per-line margins that replace the offer margin, by line id. */
  overrides: Record<string, number>
  /** Hamza ticked "I know N lines are under the minimum". */
  ackLow: boolean
  /** What the client is charged for shipping (Mobile One's shipping x the client's multiplier unless changed), in cents. 0 when there is none. */
  shippingCents?: number
  pricedAt: string
}

/** One time an offer was sent to a client. The link's token is never kept, only its hash. */
export interface OfferSend {
  clientId: string
  clientName: string
  to: string[]
  /** SHA-256 of the link's token: how the public store and the answer find this send. */
  tokenHash: string
  /** The first characters of the token, to recognise a link in a question from a client. */
  tokenHint: string
  sentAt: string
  expiresAt: string
  totalCents: number
  /** The shipping inside `totalCents`, in cents. */
  shippingCents?: number
  units: number
  /** A test send to the owner's own inbox. */
  test: boolean
  /** Null until Gmail confirms; a send stuck without it is rolled back by the 5-minute check. */
  gmailMessageId: string | null
  outcome: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn'
  answer?: { decision: 'accept' | 'decline'; remarks: string; at: string; ip: string; ua: string }
  resolvedAt?: string
  /** The owner was emailed about this answer. Set before sending, so a retried webhook or the 5-minute check can never email twice. */
  notifiedAt?: string
}

/**
 * What was sent to Xero for a draft invoice and what came back, for debugging a refusal. Never a
 * token or an Authorization header: the tenant is shown as its first 8 characters.
 */
export interface DraftDebug {
  at: string
  method: string
  endpoint: string
  apiVersion: string
  /** First 8 characters of the Xero-Tenant-Id header the request carried. */
  tenant: string
  /** First 8 characters of the OrganisationID Xero reported for that tenant (should match `tenant`). */
  organisationId?: string | null
  /** Organisations the write app is connected to, as "name [first 8 of id]". */
  connections?: string[]
  idempotencyKey: string
  /** The fields that matter, exactly as sent (the currency fields included; CurrencyRate is not sent). */
  request: Record<string, unknown>
  status: number
  /** Xero's own error body, truncated and with anything bearer-like removed. */
  rawBody: string
}

/** What happens after a client accepts: the reply to Mobile One and the DRAFT invoice in Xero. */
export interface ReplyStep {
  /** held = waiting for the owner's one tap (a check failed or could not be made). */
  state: 'pending' | 'sending' | 'sent' | 'held' | 'failed'
  /** Why it is held or failed, in plain words. */
  reason?: string
  attempts: number
  at?: string
  messageId?: string
  /** Where it went: Mobile One's address for a real offer, the owner's inbox for a test. */
  to?: string
}
export interface DraftStep {
  /** working = being raised right now; blocked = a rule or setting needs the owner (no automatic retry). */
  state: 'pending' | 'working' | 'done' | 'failed' | 'blocked'
  reason?: string
  attempts: number
  at?: string
  invoiceId?: string
  invoiceNumber?: string
  org?: string
  /** Xero's own validation messages and the checks that followed, in plain sentences. Never a token or a raw response. */
  details?: string[]
  /** Which setting the message points at (Branding theme, Currency, Tax type, Account code, Contact, Date). */
  field?: string
  /** The request and Xero's raw answer for the last refusal. */
  debug?: DraftDebug
  /** Things to check on the draft that did not stop it being created (a missing address, a recent invoice to the same contact). */
  warnings?: string[]
  /** How many times Xero has definitely refused this draft. Each refusal moves the idempotency key on, so a fixed setting is never answered from a stored refusal. */
  rejections?: number
}
/** One step after the draft exists: approve, send, file. Each needs an explicit click; none happens by itself. */
export interface InvoiceStep {
  /** blocked = a check failed and says why; failed = the attempt ended badly (an unknown outcome is never retried by itself); skipped = not set up. */
  state: 'working' | 'done' | 'blocked' | 'failed' | 'skipped'
  reason?: string
  at?: string
  /** For the send step: where Xero sent it. For the filing step: where the PDF is. */
  detail?: string
}

/** The supplier's bill that belongs to this order, once confirmed. It is saved as a Xero pair as well, so the Matching page and profit figures use it. */
export interface BillMatch {
  billId: string
  billNumber: string
  supplier: string
  totalCents: number
  confirmedAt: string
}

export interface Fulfilment {
  /** FN-ORD-### for a real offer, TEST-### for a test one. */
  orderRef: string
  test: boolean
  startedAt: string
  reply: ReplyStep
  draft: DraftStep
  /** A "this needs you" message was sent for a stuck step, so it is not repeated every 5 minutes. */
  alerted?: boolean
  approve?: InvoiceStep
  send?: InvoiceStep
  filing?: InvoiceStep
  bill?: BillMatch
}

export interface Offer {
  id: string
  status: OfferStatus
  source: {
    gmailMessageId: string
    threadId: string
    rfcMessageId: string | null
    from: string
    to: string
    subject: string
    receivedAt: string
  }
  /** The email body, cleaned (quotes and signature removed), for the review screen. */
  text: string
  lines: OfferLine[]
  /** Set once the offer is priced for a client; cleared if the lines or status change. */
  pricing?: OfferPricing
  /** Every time it was sent to a client, newest last. */
  sends?: OfferSend[]
  /** Made by hand for testing: it can only be priced for and sent to a test client. */
  testOnly?: boolean
  /** Mobile One's shipping cost; absent until read from the email or entered. */
  shipping?: OfferShipping
  /** Set when a client accepts; absent on offers accepted before this existed. */
  fulfilment?: Fulfilment
  createdAt: string
  updatedAt: string
  audit: { at: string; what: string }[]
}

export interface OffersStatus {
  lastRunAt: string
  ok: boolean
  checked: number
  added: number
  error: string | null
}

export type FlagLevel = 'warn' | 'error'
export interface LineFlag {
  code: 'model' | 'storage' | 'qty' | 'cost' | 'duplicate' | 'source' | 'note'
  level: FlagLevel
  message: string
}
