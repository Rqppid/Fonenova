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

/** How an offer is priced for one client. Sale prices come from this, never from the browser. */
export interface OfferPricing {
  clientId: string
  /** The per-unit margin for the whole offer (manual clients), in cents. Null for fixed clients. */
  marginCents: number | null
  /** Per-line margins that replace the offer margin, by line id. */
  overrides: Record<string, number>
  /** Hamza ticked "I know N lines are under the minimum". */
  ackLow: boolean
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
  units: number
  /** A test send to the owner's own inbox. */
  test: boolean
  /** Null until Gmail confirms; a send stuck without it is rolled back by the 5-minute check. */
  gmailMessageId: string | null
  outcome: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn'
  answer?: { decision: 'accept' | 'decline'; remarks: string; at: string; ip: string; ua: string }
  resolvedAt?: string
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
