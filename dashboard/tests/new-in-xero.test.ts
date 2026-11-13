import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { matchInvoices, withXero } from '@/lib/xero/pairing'
import type { Ledger, Order, XeroInvoice } from '@/lib/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

/** The real documents from Xero (read on 13 Nov 2026). */
const doc = (p: Partial<XeroInvoice> & Pick<XeroInvoice, 'id' | 'kind' | 'number' | 'totalCents' | 'date'>): XeroInvoice => ({
  reference: '', status: 'AUTHORISED', contactName: p.kind === 'sale' ? 'Wave Phone B.V.' : 'Mobile One Trade B.V.', currency: 'EUR',
  dueDate: null, amountDueCents: p.totalCents, amountPaidCents: 0, payments: [], ...p,
})
const inv46 = doc({ id: '1f9c9412', kind: 'sale', number: '2026046', totalCents: 258_810_00, date: '2026-10-22', reference: 'Auto-synced from Invoice2go' })
const inv47 = doc({ id: '4124b011-e979-410a-927d-4905d727a4df', kind: 'sale', number: '2026047', totalCents: 120_060_50, date: '2026-11-12', dueDate: '2026-11-26', reference: 'Auto-synced from Invoice2go' })
const bill105 = doc({ id: '9e03c0cb', kind: 'bill', number: '2026100105', totalCents: 256_500_00, date: '2026-10-22' })
const bill106 = doc({ id: 'd84d5220', kind: 'bill', number: '2026110106', totalCents: 117_240_50, date: '2026-11-12' })
const invoices = [inv46, inv47, bill105, bill106]

const order46 = { id: 'FN-ORD-038', date: '2026-10-22', clientInvoiceNo: '2026046', supplierInvoiceNo: '2026100105', customerId: 'wave', customerName: 'Wave Phone B.V.', supplierId: 'm1', supplierName: 'Mobile One Trade B.V.', clientTotalCents: 258_810_00, supplierTotalCents: 256_500_00 } as unknown as Order
const ledger = { orders: [order46], lines: [], customers: [{ id: 'wave', name: 'Wave Phone B.V.' }], suppliers: [{ id: 'm1', name: 'Mobile One Trade B.V.' }], creditNotes: [], exceptions: [], meta: { snapshotDate: '2026-10-04' } } as unknown as Ledger

describe('a new Xero invoice that is not in the ledger yet (2026047)', () => {
  it('is listed to match with its bill, while 2026046 (in the ledger) is not', () => {
    const m = matchInvoices({ invoices, ledgerOrders: [order46], pairs: [], since: '2026-01-01' })
    expect(m.suggestions.map((s) => [s.invoice.number, s.bill?.number])).toEqual([['2026047', '2026110106']])
    expect(m.suggestions[0].margin).toBeCloseTo(1 - 117_240_50 / 120_060_50, 6)
  })

  it('shows on the Orders page in "New in Xero: not yet an order", with the suggested bill', async () => {
    const { NewInXero } = await import('@/components/dashboard/matching')
    const { CurrencyProvider } = await import('@/components/currency')
    const m = matchInvoices({ invoices, ledgerOrders: [order46], pairs: [], since: '2026-01-01' })
    const html = renderToString(h(CurrencyProvider, { fx: { ok: false, reason: 'test' } as never, children: null } as never, h(NewInXero, { matching: m, writable: true, onMatch: () => {} }))).replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')
    for (const t of ['New in Xero: not yet an order', 'Invoice 2026047', 'Wave Phone B.V.', '120,060.50', 'Best bill: 2026110106', 'Confirm pair']) expect(html).toContain(t)
    expect(html).not.toContain('2026046')
    const none = renderToString(h(CurrencyProvider, { fx: { ok: false, reason: 'test' } as never, children: null } as never, h(NewInXero, { matching: { auto: [], suggestions: [], freeBills: [] }, writable: true, onMatch: () => {} })))
    expect(none).toBe('')
  })

  it('becomes an order once the pair is confirmed, and leaves the list', () => {
    const pairs = [{ orderId: 'FN-ORD-039', invoiceId: inv47.id, billId: bill106.id, confirmedAt: '2026-11-13T10:00:00Z' }]
    const r = withXero(ledger, { fetchedAt: '2026-11-13T09:00:00Z', invoices, creditNotes: [], bankBalances: null, problems: [] } as never, pairs, '2026-11-13')
    expect(r.ledger.orders.map((o) => o.clientInvoiceNo)).toEqual(['2026046', '2026047'])
    expect(r.matching?.suggestions).toEqual([])
  })
})
