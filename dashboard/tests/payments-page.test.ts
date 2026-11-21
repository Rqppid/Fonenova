import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { agoWords, monthTotals, newestPaymentDate, paymentFeed, staleness, ukMonthKey } from '@/lib/payments-summary'
import { paymentsFixture } from './fixtures/payments'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')

describe('the recent payments feed', () => {
  const s = paymentsFixture()
  const feed = paymentFeed(s)
  it('lists every payment in and out, newest first, with the invoice and what is left on it', () => {
    const matched = feed.filter((r) => r.matched)
    expect(matched).toHaveLength(s.customer_invoices.concat(s.supplier_invoices).flatMap((i) => i.payments).length)
    const dates = feed.map((r) => r.date ?? '')
    expect([...dates].sort().reverse()).toEqual(dates)
    const first = feed.find((r) => r.invoice?.number === '2026044' && r.date === '2026-11-03')!
    expect(first).toMatchObject({ direction: 'in', party: 'Wave Phone B.V.', amountCents: 5_000_00 })
    expect(first.invoice!.remaining_cents).toBe(43_954_94)
    expect(feed.find((r) => r.invoice?.number === '2026100105')).toMatchObject({ direction: 'out', feeCents: 50 })
  })
  it('shows bank lines still waiting for an invoice, but not overpayments, reversals or notices already counted elsewhere', () => {
    const unmatched = feed.filter((r) => !r.matched).map((r) => r.key)
    expect(unmatched).toEqual(expect.arrayContaining(['ex-41', 'ex-42', 'ex-43']))
    for (const id of ['ex-44', 'ex-45', 'ex-46']) expect(unmatched).not.toContain(id)
    expect(feed.find((r) => r.key === 'ex-43')!.direction).toBe('out')
    expect(feed.find((r) => r.key === 'ex-41')!.direction).toBe('in')
  })
})

describe('the monthly figures', () => {
  const feed = paymentFeed(paymentsFixture())
  it('count matched payments in the UK calendar month, never a credit note or an unmatched line', () => {
    const t = monthTotals(feed, new Date('2026-11-08T10:00:00Z'))
    expect(t.monthKey).toBe('2026-11')
    expect(t.receivedCents).toBe(5_000_00 + 24_300_00) // 3 Nov Wave and 1 Nov TradeWise
    expect(t.paidOutCents).toBe(0)
    const oct = monthTotals(feed, new Date('2026-10-31T12:00:00Z'))
    expect(oct.receivedCents).toBe(40_000_00 + 15_000_00 + 103_846_00)
    expect(oct.paidOutCents).toBe(100_000_00)
    const aug = monthTotals(feed, new Date('2026-08-20T12:00:00Z'))
    expect(aug.paidOutCents).toBe(43_668_00) // the bank transfer, not the credit note
  })
  it('uses UK time for the month', () => {
    expect(ukMonthKey(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10') // UK clocks went back on 25 Oct, so this is still GMT
    expect(ukMonthKey(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07') // BST: 00:30 on 1 July
  })
  it('knows the newest payment date', () => {
    expect(newestPaymentDate(feed)).toBe('2026-11-08')
  })
})

describe('staleness in words', () => {
  const health = (o: Partial<{ ok: boolean; minutes_ago: number | null; last_error: string | null }>) => ({ ok: true, last_run: null, minutes_ago: 3, last_error: null, ...o })
  it('fresh, late and old', () => {
    expect(staleness(health({}))).toBe('fresh')
    expect(staleness(health({ minutes_ago: 45 }))).toBe('late')
    expect(staleness(health({ last_error: 'x' }))).toBe('late')
    expect(staleness(health({ minutes_ago: 361 }))).toBe('old')
    expect(staleness(health({ ok: false }))).toBe('old')
    expect(staleness(health({ minutes_ago: null }))).toBe('old')
    expect(agoWords(168)).toBe('3 hours ago')
    expect(agoWords(60 * 48)).toBe('2 days ago')
  })
  it('the banner says what old means, with the newest payment date', async () => {
    const { Freshness } = await import('@/components/payments/payments-view')
    const html = render(h(Freshness, { state: { generated_at: '2026-11-08T10:00:00Z', health: health({ ok: false, minutes_ago: 3000, last_error: 'Revolut token expired' }) }, newestPayment: '2026-11-03' }))
    expect(html).toContain('data-level="old"')
    expect(html).toContain('Possibly out of date')
    expect(html).toContain('Newest payment shown: 3 Nov')
    expect(html).toMatch(/Payments after [^<]*3 Nov[^<]* may not be shown yet/)
    expect(html).toContain('Revolut token expired')
  })
})

describe('the page', () => {
  it('leads with the banner, the four tiles and the feed, then needs attention and the invoices', async () => {
    const { PaymentsView } = await import('@/components/payments/payments-view')
    const { partyTotals } = await import('@/lib/payments-source')
    const s = paymentsFixture()
    const html = render(h(PaymentsView, { result: { kind: 'ok', data: s }, totals: { customers: partyTotals(s.customer_invoices), supplier: partyTotals(s.supplier_invoices) }, now: new Date('2026-11-08T10:00:00Z') }))
    const at = (x: string) => html.indexOf(x)
    expect(at('data-testid="summary-tiles"')).toBeGreaterThan(at('Payments data status'))
    expect(at('data-testid="recent-payments"')).toBeGreaterThan(at('data-testid="summary-tiles"'))
    expect(at('id="pay-attn"')).toBeGreaterThan(at('data-testid="recent-payments"'))
    expect(html).toContain('Received in November 2026')
    expect(html).toContain('Customers still owe you')
    expect(html).toContain('You still owe Mobile One')
    expect(html).toContain('€29,300.00') // received this month: 5,000 + 24,300
    expect(html).toContain('data-testid="feed-row"')
    expect(html).toContain('Not matched yet')
  })
  it('shows no all-time total of payments', async () => {
    const { PaymentsView } = await import('@/components/payments/payments-view')
    const { partyTotals } = await import('@/lib/payments-source')
    const s = paymentsFixture()
    const html = render(h(PaymentsView, { result: { kind: 'ok', data: s }, totals: { customers: partyTotals(s.customer_invoices), supplier: partyTotals(s.supplier_invoices) }, now: new Date('2026-11-08T10:00:00Z') }))
    const all = [...s.customer_invoices, ...s.supplier_invoices].flatMap((i) => i.payments).reduce((n, p) => n + p.amount_cents, 0)
    expect(html).not.toContain(new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2 }).format(all / 100))
  })
})
