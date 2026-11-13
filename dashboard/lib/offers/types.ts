/**
 * Offers from Mobile One, as Quay Pilot keeps them. Money is integer euro cents. Types only, so
 * the review screen (client) and the ingest job (server) share them.
 */
export type OfferStatus = 'needs_review' | 'ready' | 'dismissed'

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
