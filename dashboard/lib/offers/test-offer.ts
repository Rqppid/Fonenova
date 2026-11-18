/**
 * A made-up offer for trying the whole journey (price, send to yourself, accept, reply, draft
 * invoice) without waiting for a real Mobile One email. It is marked `testOnly`: the pricing and
 * sending code refuse to use it for any client that is not a test client, so it can never reach a
 * real client, whatever the screen shows. Its source address cannot receive mail.
 */
import crypto from 'node:crypto'
import type { Offer, OfferLine, OfferStatus } from './types'

/** At most this many unanswered test offers at once, so the list cannot fill up with them. */
export const TEST_OFFER_CAP = 3
const OPEN: readonly OfferStatus[] = ['needs_review', 'ready', 'sent']

export const TEST_SUBJECT = '[TEST] Sample offer, not from Mobile One'

const SAMPLE: [string, string, string, number, number][] = [
  ['iPhone 16', '128GB', 'Grade A', 20, 41_200],
  ['Samsung Galaxy S25', '256GB', 'Grade A', 10, 49_800],
  ['iPhone 15', '128GB', 'Grade B', 15, 30_100],
]

export function openTestOffers(offers: readonly Offer[]): number {
  return offers.filter((o) => o.testOnly && OPEN.includes(o.status)).length
}

export function makeTestOffer(now: string, rand: (n: number) => string = (n) => crypto.randomBytes(n).toString('hex')): Offer {
  const key = rand(6)
  const lines: OfferLine[] = SAMPLE.map(([model, storage, grade, qty, cost], i) => ({
    id: rand(6),
    model,
    storage,
    grade,
    qty,
    unitCostCents: cost,
    sourceText: `TEST: ${model} ${storage} ${grade} x${qty} @ €${(cost / 100).toFixed(2)} (line ${i + 1})`,
    note: 'Sample line for testing',
  }))
  return {
    id: `of_test_${key}`,
    status: 'ready',
    testOnly: true,
    source: {
      gmailMessageId: `test-${key}`,
      threadId: `test-${key}`,
      rfcMessageId: null,
      from: 'TEST Mobile One <test-offer@example.invalid>',
      to: 'info@fonenova.com',
      subject: TEST_SUBJECT,
      receivedAt: now,
    },
    text: 'TEST OFFER, made in Quay Pilot for testing. It is not from Mobile One and can only be priced for and sent to the test client.\n\n' + lines.map((l) => l.sourceText).join('\n'),
    lines,
    createdAt: now,
    updatedAt: now,
    audit: [{ at: now, what: 'Test offer created (not from Mobile One). It can only be priced for and sent to a test client.' }],
  }
}
