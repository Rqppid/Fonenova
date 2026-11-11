/**
 * A made-up payments service state for tests and the local mock. Every figure is fake. Covers
 * part paid, fully paid, overpaid (negative remaining), cancelled, several payments on one
 * invoice, a credit note, exceptions of every severity, and held surplus.
 */
import type { PaymentsState } from '../../lib/payments-types'

export function paymentsFixture(): PaymentsState {
  return {
    generated_at: '2026-11-08T09:58:00Z',
    currency: 'EUR',
    health: { ok: true, last_run: '2026-11-08T09:55:00Z', minutes_ago: 3, last_error: null },
    customer_invoices: [
      {
        number: '2026044', party: 'Wave Phone B.V.', tracker: 'wave', date: '2026-10-14',
        total_cents: 103_954_94, paid_cents: 60_000_00, credits_cents: 0, remaining_cents: 43_954_94, state: 'partly_paid',
        payments: [
          { date: '2026-10-20', amount_cents: 40_000_00, fee_cents: 0, method: 'Bank Transfer', source: 'auto', remark: 'Ref 2026044', bank_event_id: 'rv-1' },
          { date: '2026-10-27', amount_cents: 15_000_00, fee_cents: 0, method: 'Bank Transfer', source: 'approved', remark: 'No reference; allocated by hand', bank_event_id: 'rv-2' },
          { date: '2026-11-03', amount_cents: 5_000_00, fee_cents: 0, method: 'Bank Transfer', source: 'auto', remark: null, bank_event_id: 'rv-3' },
        ],
      },
      {
        number: '2026046', party: 'Wave Phone B.V.', tracker: 'wave', date: '2026-10-22',
        total_cents: 258_810_00, paid_cents: 0, credits_cents: 0, remaining_cents: 258_810_00, state: 'not_paid', payments: [],
      },
      {
        number: '2026043', party: 'Wave Phone B.V.', tracker: 'wave', date: '2026-10-08',
        total_cents: 103_846_00, paid_cents: 103_846_00, credits_cents: 0, remaining_cents: 0, state: 'fully_paid',
        payments: [{ date: '2026-10-22', amount_cents: 103_846_00, fee_cents: 0, method: 'Bank Transfer', source: 'auto', remark: 'Ref 2026043', bank_event_id: 'rv-4' }],
      },
      {
        number: '2026028', party: 'TradeWise', tracker: 'tw', date: '2026-07-15',
        total_cents: 24_280_00, paid_cents: 24_300_00, credits_cents: 0, remaining_cents: -20_00, state: 'fully_paid',
        payments: [{ date: '2026-11-01', amount_cents: 24_300_00, fee_cents: 0, method: 'Bank Transfer', source: 'approved', remark: 'Paid €20 over', bank_event_id: 'rv-5' }],
      },
      {
        number: '2026/02/0001', party: 'TradeWise', tracker: 'tw', date: '2026-02-05',
        total_cents: 8_084_00, paid_cents: 0, credits_cents: 0, remaining_cents: 8_084_00, state: 'cancelled', payments: [],
      },
      {
        number: '2026019', party: 'G and I Global Ltd', tracker: 'giglobal', date: '2026-11-11',
        total_cents: 55_290_00, paid_cents: 0, credits_cents: 0, remaining_cents: 55_290_00, state: 'not_paid', payments: [],
      },
    ],
    supplier_invoices: [
      {
        number: '2026100105', party: 'Mobile One Trade B.V.', tracker: 'm1', date: '2026-10-22',
        total_cents: 256_500_00, paid_cents: 100_000_00, credits_cents: 0, remaining_cents: 156_500_00, state: 'partly_paid',
        payments: [{ date: '2026-10-24', amount_cents: 100_000_00, fee_cents: 50, method: 'Bank Transfer', source: 'auto', remark: 'INV 2026100105', bank_event_id: 'rv-6' }],
      },
      {
        number: '2026070077', party: 'Mobile One Trade B.V.', tracker: 'm1', date: '2026-07-23',
        total_cents: 43_668_00, paid_cents: 43_668_00, credits_cents: 43_668_00, remaining_cents: -43_668_00, state: 'fully_paid',
        payments: [
          { date: '2026-08-10', amount_cents: 43_668_00, fee_cents: 50, method: 'Bank Transfer', source: 'historic', remark: null, bank_event_id: null },
          { date: '2026-08-13', amount_cents: 43_668_00, fee_cents: 0, method: 'Credit Note', source: 'historic', remark: 'Credit note 2026080086', bank_event_id: null },
        ],
      },
    ],
    exceptions: [
      {
        id: 41, code: 'X-NO-REF', severity: 'MEDIUM', detail: 'Wave Phone paid €35,200.00 with no invoice number in the reference.', created_at: '2026-11-07T14:02:00Z',
        suggestions: [
          { invoice: '2026046', invoice_id: 7, remaining_cents: 258_810_00, why: 'Oldest open invoice for this customer' },
          { invoice: '2026044', invoice_id: 6, remaining_cents: 43_954_94, why: 'Remaining balance closest to the amount', distance: 8_754_94 },
        ],
        bank_event: { date: '2026-11-07', amount_cents: 35_200_00, reference: 'PAYMENT', description: 'WAVE PHONE B.V.' },
      },
      {
        id: 42, code: 'X-UNKNOWN-PAYER', severity: 'HIGH', detail: 'A payment came from an account that is not a known customer.', created_at: '2026-11-08T08:11:00Z',
        suggestions: [],
        bank_event: { date: '2026-11-08', amount_cents: 12_500_00, reference: 'INV 2026045', description: 'J SMITH TRADING' },
      },
      {
        id: 43, code: 'X-OUT-OVER', severity: 'LOW', detail: 'A payment to Mobile One is more than the bill it names still needs.', created_at: '2026-11-06T10:00:00Z',
        suggestions: [{ invoice: '2026100105', invoice_id: 9, remaining_cents: 156_500_00, why: 'Named in the reference' }],
        bank_event: { date: '2026-11-06', amount_cents: 160_000_00, reference: '2026100105', description: 'MOBILE ONE TRADE BV' },
      },
      {
        id: 44, code: 'X-REVERSAL', severity: 'MEDIUM', detail: 'Revolut reversed an earlier incoming payment from Wave Phone.', created_at: '2026-11-05T09:30:00Z',
        suggestions: [{ invoice: '2026044', invoice_id: 6, remaining_cents: 43_954_94, why: 'The reversed payment was on this invoice' }],
        bank_event: { date: '2026-11-05', amount_cents: -5_000_00, reference: 'REVERSAL', description: 'WAVE PHONE B.V.' },
      },
      {
        id: 45, code: 'X-TOKEN', severity: 'HIGH', detail: 'The Revolut access token expires in 3 days.', created_at: '2026-11-08T06:00:00Z',
        suggestions: [],
        bank_event: null,
      },
      {
        id: 46, code: 'X-OVERPAY', severity: 'LOW', detail: 'TradeWise paid €20.00 more than invoice 2026028 needed.', created_at: '2026-11-01T12:00:00Z',
        suggestions: [{ invoice: '2026046', invoice_id: 7, remaining_cents: 258_810_00, why: 'Open invoice for the same party group' }],
        bank_event: { date: '2026-11-01', amount_cents: 24_300_00, reference: '2026028', description: 'TRADEWISE' },
      },
    ],
    held_surplus: [{ party: 'TradeWise', amount_cents: 20_00, bank_event_id: 'rv-5' }],
  }
}
