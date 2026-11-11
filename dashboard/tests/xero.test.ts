import { describe, expect, it } from 'vitest'
import { applyLiveStatus, cashPosition } from '@/lib/metrics'
import { mapBankSummary, mapCreditNote, mapInvoice, matchOrders, parseXeroDate } from '@/lib/xero/map'
import type { Order } from '@/lib/types'

const order = (p: Partial<Order>): Order => ({
  id: 'FN-ORD-001', date: '2026-05-01', customerId: 'w', customerName: 'Wave', supplierId: 's', supplierName: 'Mobile One',
  clientInvoiceNo: '2026034', supplierInvoiceNo: '2026070077', clientTotalCents: 10000, supplierTotalCents: 9000,
  grossMarginCents: 1000, goodsMarginCents: 1000, shippingMarginCents: 0, ledgerMarginRatio: null,
  clientStatus: 'AUTHORISED', clientOwesCents: 10000, supplierStatus: 'AUTHORISED', weOweSupplierCents: 9000,
  clientOwesMinusWeOweCents: 1000, flags: [], clientPdf: { fileName: null }, supplierPdf: { fileName: null }, ...p,
})

const xSale = {
  Type: 'ACCREC', InvoiceID: 'a', InvoiceNumber: '2026034', Reference: '', Status: 'AUTHORISED', CurrencyCode: 'EUR',
  Contact: { Name: 'Wave Phone B.V.' }, Date: '/Date(1784592000000+0000)/', DueDate: '/Date(1785196800000+0000)/',
  Total: 100.0, AmountDue: 40.0, AmountPaid: 60.0, Payments: [{ PaymentID: 'p1', Date: '/Date(1784851200000+0000)/', Amount: 60.0 }],
}
const xBill = { ...xSale, Type: 'ACCPAY', InvoiceID: 'b', InvoiceNumber: 'MO-2026070077', Reference: '2026070077', Total: 90, AmountDue: 90, AmountPaid: 0, Payments: [], DueDateString: '2026-07-25T00:00:00' }

describe('Xero mapping', () => {
  it('reads both Xero date formats', () => {
    expect(parseXeroDate('/Date(1784592000000+0000)/')).toBe('2026-07-21')
    expect(parseXeroDate('2026-05-13T00:00:00')).toBe('2026-05-13')
    expect(parseXeroDate(undefined)).toBeNull()
  })
  it('maps an invoice to cents, with each payment as its own line', () => {
    const i = mapInvoice(xSale)!
    expect(i).toMatchObject({ kind: 'sale', totalCents: 10000, amountDueCents: 4000, amountPaidCents: 6000, dueDate: '2026-07-28' })
    expect(i.payments).toEqual([{ id: 'p1', date: '2026-07-24', amountCents: 6000 }])
    expect(mapInvoice({ ...xSale, Type: 'ACCRECCREDIT' })).toBeNull()
  })
  it('reads closing balances from the Bank Summary report', () => {
    const report = {
      Rows: [
        { RowType: 'Header', Cells: [{ Value: 'Bank Accounts' }, { Value: 'Opening Balance' }, { Value: 'Cash Received' }, { Value: 'Cash Spent' }, { Value: 'FX Gain' }, { Value: 'Closing Balance' }] },
        { RowType: 'Section', Rows: [
          { RowType: 'Row', Cells: [{ Value: 'Business Current' }, { Value: '1.00' }, {}, {}, {}, { Value: '12,345.67' }] },
          { RowType: 'SummaryRow', Cells: [{ Value: 'Total' }, {}, {}, {}, {}, { Value: '12,345.67' }] },
        ] },
      ],
    }
    expect(mapBankSummary(report)).toEqual([{ accountName: 'Business Current', closingCents: 1234567 }])
    expect(mapBankSummary({ Rows: [] })).toBeNull()
  })
})

describe('matching Xero to ledger orders', () => {
  const sale = mapInvoice(xSale)!
  const bill = mapInvoice(xBill)!
  it('matches the sales invoice by number and the bill by supplier number in the reference', () => {
    const m = matchOrders([order({})], [sale, bill]).get('FN-ORD-001')!
    expect(m.client?.id).toBe('a')
    expect(m.bill?.id).toBe('b')
  })
  it('matches on the Order ID in Reference, and never on voided documents', () => {
    const byRef = mapInvoice({ ...xSale, InvoiceNumber: 'X1', Reference: 'FN-ORD-001' })!
    expect(matchOrders([order({})], [byRef]).get('FN-ORD-001')!.client?.id).toBe('a')
    const voided = mapInvoice({ ...xSale, Status: 'VOIDED' })!
    expect(matchOrders([order({})], [voided]).get('FN-ORD-001')!.client).toBeNull()
  })
  it('matches an invoice re-created in Xero with "-R" (2026/02/0001-R is 2026/02/0001), and prefers an exact number', () => {
    const o = order({ id: 'FN-ORD-009', clientInvoiceNo: '2026/02/0001', supplierInvoiceNo: '' })
    const recreated = mapInvoice({ ...xSale, InvoiceID: 'r', InvoiceNumber: '2026/02/0001-R', Reference: '' })!
    expect(matchOrders([o], [recreated]).get('FN-ORD-009')!.client?.id).toBe('r')
    const exact = mapInvoice({ ...xSale, InvoiceID: 'e', InvoiceNumber: '2026/02/0001', Reference: '' })!
    expect(matchOrders([o], [recreated, exact]).get('FN-ORD-009')!.client?.id).toBe('e')
    const other = mapInvoice({ ...xSale, InvoiceID: 'x', InvoiceNumber: '2026/02/0002-R', Reference: '' })!
    expect(matchOrders([o], [other]).get('FN-ORD-009')!.client).toBeNull()
  })
  it('overlays live balances and due dates, and reports what did not match', () => {
    const o2 = order({ id: 'FN-ORD-002', clientInvoiceNo: '999', supplierInvoiceNo: '888' })
    const { orders, summary } = applyLiveStatus([order({}), o2], matchOrders([order({}), o2], [sale, bill]))
    expect(orders[0]).toMatchObject({ clientOwesCents: 4000, weOweSupplierCents: 9000, live: { clientDueDate: '2026-07-28', billDueDate: '2026-07-25' } })
    expect(orders[0].clientTotalCents).toBe(10000) // sales stay as the ledger states them
    expect(orders[1]).toBe(o2) // untouched
    expect(summary).toMatchObject({ clientMatched: 1, billMatched: 1, gaps: [{ orderId: 'FN-ORD-002' }] })
    expect(cashPosition(orders).clientsOweCents).toBe(4000 + 10000)
  })
  it('ignores Xero documents not in EUR rather than mixing currencies', () => {
    const gbp = mapInvoice({ ...xSale, CurrencyCode: 'GBP' })!
    const { orders, summary } = applyLiveStatus([order({})], matchOrders([order({})], [gbp]))
    expect(orders[0].clientOwesCents).toBe(10000)
    expect(summary.gaps[0].problem).toMatch(/GBP, not EUR/)
  })
})

describe('Xero line items and credit notes', () => {
  it('reads line items when Xero sends them, and leaves them out when it does not', () => {
    const i = mapInvoice({ ...xSale, LineItems: [
      { Description: 'IPHONE 15 128GB - USED ', Quantity: 77, UnitAmount: 362.43, LineAmount: 27907.11 },
      { Description: 'SHIPPING CHARGES', Quantity: 1, UnitAmount: 400, LineAmount: 400 },
    ] })!
    expect(i.lines).toEqual([
      { description: 'IPHONE 15 128GB - USED', quantity: 77, unitCents: 36243, amountCents: 2790711 },
      { description: 'SHIPPING CHARGES', quantity: 1, unitCents: 40000, amountCents: 40000 },
    ])
    expect(mapInvoice(xSale)!.lines).toBeUndefined()
    const fxSale = mapInvoice({ Type: 'ACCREC', InvoiceID: 'f', CurrencyCode: 'EUR', CurrencyRate: 1.1512, Total: 100, Payments: [{ PaymentID: 'p', Amount: 100, CurrencyRate: 1.1402 }] })!
    expect([fxSale.currencyRate, fxSale.payments[0].currencyRate]).toEqual([1.1512, 1.1402])
  })
  it('maps credit notes both ways, with the invoices they were allocated to', () => {
    const cn = mapCreditNote({ Type: 'ACCRECCREDIT', CreditNoteID: 'c1', CreditNoteNumber: 'FN-CN-202606', Status: 'AUTHORISED', CurrencyCode: 'EUR',
      Contact: { Name: 'Wave Phone B.V.' }, Date: '/Date(1784592000000+0000)/', Total: 894, Allocations: [{ Invoice: { InvoiceNumber: '2026009' }, Amount: 894 }] })
    expect(cn).toMatchObject({ kind: 'sale', number: 'FN-CN-202606', totalCents: 89400, allocatedTo: ['2026009'], allocations: [{ invoiceNumber: '2026009', amountCents: 89400 }], date: '2026-07-21' })
    expect(cn!.remainingCents).toBeUndefined()
    expect(mapCreditNote({ Type: 'ACCPAYCREDIT', CreditNoteID: 'c3', Total: 10, RemainingCredit: 4 })!.remainingCents).toBe(400)
    expect(mapCreditNote({ Type: 'ACCPAYCREDIT', CreditNoteID: 'c2', Total: 1 })!.kind).toBe('bill')
    expect(mapCreditNote({ Type: 'ACCREC' })).toBeNull()
  })
})
