import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { creditGaps, referencedInvoices, xeroChecks } from '@/lib/xero/checks'
import { attentionItems } from '@/lib/attention'
import { allocateCredits } from '@/lib/metrics'
import type { CreditNote, Ledger, XeroCreditNote, XeroInvoice, XeroSnapshot } from '@/lib/types'

const doc = (p: Partial<XeroInvoice> & Pick<XeroInvoice, 'id' | 'kind' | 'totalCents'>): XeroInvoice => ({
  number: p.id, reference: '', status: 'PAID', contactName: p.kind === 'sale' ? 'Wave Phone B.V.' : 'Mobile One Trade B.V.', currency: 'EUR',
  date: '2026-07-10', dueDate: '2026-07-17', amountDueCents: 0, amountPaidCents: p.totalCents, payments: [], ...p,
})
const credit = (id: string, kind: 'sale' | 'bill', totalCents: number, allocations: [string, number][], date = '2026-08-19'): XeroCreditNote => ({
  id, number: id, reference: '', kind, status: 'PAID', contactName: '', currency: 'EUR', date, totalCents,
  allocatedTo: allocations.map((a) => a[0]), allocations: allocations.map(([invoiceNumber, amountCents]) => ({ invoiceNumber, amountCents })),
})
const note = (p: Partial<CreditNote> & Pick<CreditNote, 'side' | 'number' | 'amountCents' | 'refersToInvoices'>): CreditNote => ({
  date: '2026-08-19', orderIds: [], covers: '', xeroShows: '', check: '', ...p,
})

describe('credit notes against Xero', () => {
  it('reads the invoice numbers a ledger note names', () => {
    expect(referencedInvoices('2026050049, 2026070068 & 2026070069')).toEqual(['2026050049', '2026070068', '2026070069'])
    expect(referencedInvoices('2026070073 & 2026080081')).toEqual(['2026070073', '2026080081'])
  })

  it('finds missing, short and over-allocated credits, and accepts one Xero credit covering several memos', () => {
    const ledgerNotes = [
      note({ side: 'supplier', number: '2026080086', amountCents: 43_668_00, refersToInvoices: '2026070077', date: '2026-08-13' }),
      note({ side: 'supplier', number: '2026080085', amountCents: 31_456_00, refersToInvoices: '2026050049, 2026070068 & 2026070069', date: '2026-08-13' }),
      note({ side: 'supplier', number: '2026080087', amountCents: 27_238_68, refersToInvoices: '2026070073 & 2026080081' }),
      note({ side: 'client', number: 'FN-CN-202602', amountCents: 27_907_11, refersToInvoices: '2026037' }),
      note({ side: 'client', number: 'FN-CN-202603', amountCents: 21_000_00, refersToInvoices: '2026026' }),
      note({ side: 'client', number: 'FN-CN-202604', amountCents: 9_889_00, refersToInvoices: '2026027' }),
      note({ side: 'client', number: 'FN-CN-202605', amountCents: 894_00, refersToInvoices: '2026011' }),
    ]
    const xero = [
      credit('MO-85', 'bill', 895_00, [['2026050049', 895_00]], '2026-08-13'),
      credit('MO-87', 'bill', 27_238_68, [['2026080081', 27_238_68]]),
      credit('MO-87b', 'bill', 378_00, [['2026070073', 378_00]]),
      credit('CN-02', 'sale', 27_907_11, [['2026037', 27_907_11]]),
      credit('CN-03-05', 'sale', 31_783_00, [['2026033', 31_783_00]]), // three memos booked as one
    ]
    const gaps = Object.fromEntries(creditGaps(ledgerNotes, xero).map((g) => [g.note.number, g.gapCents]))
    expect(gaps).toEqual({ '2026080086': 43_668_00, '2026080085': 30_561_00, '2026080087': -378_00 })
  })

  it('treats a credit applied to another invoice of the same side as moved, not missing (real Xero: 2026037 holds FN-CN-202601)', () => {
    const ledgerNotes = [
      note({ side: 'client', number: 'FN-CN-202601', amountCents: 44_804_00, refersToInvoices: '2026034' }),
      note({ side: 'client', number: 'FN-CN-202602', amountCents: 27_907_11, refersToInvoices: '2026037' }),
    ]
    expect(creditGaps(ledgerNotes, [credit('CN', 'sale', 72_711_11, [['2026037', 72_711_11]])])).toEqual([])
  })
})

describe('xeroChecks', () => {
  const base = { meta: { snapshotDate: '2026-10-04' }, creditNotes: [], exceptions: [], orders: [], customers: [], suppliers: [], lines: [] } as unknown as Ledger
  const order = (id: string, client: string, bill: string, clientTotal: number, billTotal: number) => ({ id, clientInvoiceNo: client, supplierInvoiceNo: bill, clientTotalCents: clientTotal, supplierTotalCents: billTotal, source: 'ledger' }) as Ledger['orders'][number]
  const snap = (invoices: XeroInvoice[], creditNotes: XeroCreditNote[] = []): XeroSnapshot => ({ fetchedAt: '2026-10-26T06:00:00Z', tenantName: 'Fonenova Ltd', baseCurrency: 'GBP', invoices, creditNotes, bankBalances: null, problems: [] })

  it('flags an invoice whose Xero total is missing the agreed discount', () => {
    const o = order('FN-ORD-018', '2026022', '2026070062', 46_342_00, 44_212_00)
    const r = xeroChecks({ ledger: base, orders: [o], snapshot: snap([doc({ id: 's', kind: 'sale', number: '2026022', totalCents: 55_442_00 }), doc({ id: 'b', kind: 'bill', number: '2026070062', totalCents: 44_212_00 })]), today: '2026-10-26' })
    expect(r.items.map((i) => [i.id, i.impactCents, i.priority])).toEqual([['X-TOTAL-FN-ORD-018-sale', 9_100_00, 'HIGH']])
    expect(r.items[0].link).toContain('AccountsReceivable')
  })

  it('groups small part-unpaid bills into one item, and gives a large one its own line', () => {
    const r = xeroChecks({ ledger: base, orders: [], snapshot: snap([
      doc({ id: 'a', kind: 'bill', number: '2026050049', totalCents: 139_300_00, status: 'AUTHORISED', amountDueCents: 3_105_00, dueDate: '2026-05-27' }),
      doc({ id: 'b', kind: 'bill', number: '2026060058', totalCents: 26_200_00, status: 'AUTHORISED', amountDueCents: 16_200_00, dueDate: '2026-06-24' }),
      doc({ id: 'c', kind: 'bill', number: '2026080084', totalCents: 157_369_00, status: 'AUTHORISED', amountDueCents: 3_999_77, dueDate: '2026-08-16' }),
    ]), today: '2026-10-26' })
    expect(r.items.map((i) => [i.id, i.impactCents])).toEqual([['X-BILL-b', 16_200_00], ['X-BILLS-SMALL', 7_104_77]])
    expect(r.items[1].issue).toContain('2026080084 €3,999.77 (71 days)')
  })

  it('flags an overdue bill whose order has no client invoice in Xero, and an old draft', () => {
    const o = order('FN-ORD-001', '2026/02/0001', '2026020014', 8_084_00, 7_990_00)
    const r = xeroChecks({ ledger: base, orders: [o], snapshot: snap([
      doc({ id: 'b', kind: 'bill', number: '2026020014', totalCents: 7_990_00, status: 'AUTHORISED', amountDueCents: 7_990_00, dueDate: '2026-02-10' }),
      doc({ id: 'd', kind: 'bill', number: '2026100200', totalCents: 1_000_00, status: 'DRAFT', date: '2026-10-01' }),
      doc({ id: 'ok', kind: 'bill', number: '2026100201', totalCents: 1_000_00, status: 'AUTHORISED', amountDueCents: 1_000_00, dueDate: '2026-10-24' }), // 2 days late, nothing paired: normal slack
    ]), today: '2026-10-26' })
    expect(r.items.map((i) => [i.id, i.priority])).toEqual([['X-BILL-b', 'HIGH'], ['X-DRAFT-d', 'MEDIUM']])
    expect(r.items[0].issue).toContain('not in Xero')
  })

  it('replaces Exceptions-tab rows about Xero once the live checks cover them, and stays quiet without Xero', () => {
    const o = order('FN-ORD-018', '2026022', '2026070062', 46_342_00, 44_212_00)
    const ledger = { ...base, orders: [o], exceptions: [
      { id: 'EX-01', priority: 'HIGH', reference: 'FN-ORD-018', orderId: 'FN-ORD-018', issue: 'The Xero invoice is €55,442', impactCents: 9_100_00, suggestedAction: 'Apply the discount in Xero.' },
      { id: 'EX-03', priority: 'HIGH', reference: 'FN-ORD-017', orderId: 'FN-ORD-017', issue: 'Loss-making order', impactCents: -50_00, suggestedAction: 'Recharge shipping.' },
      { id: 'EX-10', priority: 'MEDIUM', reference: 'Credit notes', orderId: null, issue: 'Credit notes do not map onto Xero credits.', impactCents: 0, suggestedAction: '' },
    ] } as unknown as Ledger
    expect(xeroChecks({ ledger, orders: [o], snapshot: null, today: '2026-10-26' })).toEqual({ items: [], supersedes: [] })
    const fixed = xeroChecks({ ledger, orders: [o], snapshot: snap([doc({ id: 's', kind: 'sale', number: '2026022', totalCents: 46_342_00 })]), today: '2026-10-26' })
    expect(fixed.items).toEqual([]) // fixed in Xero: nothing left on screen
    expect(fixed.supersedes).toEqual(['EX-01', 'EX-10'])
    expect(attentionItems(ledger, allocateCredits([]), fixed).map((i) => i.id)).toEqual(['EX-03'])
  })
})

const real = path.join(__dirname, '..', 'data', 'generated', 'ledger.json')

describe.skipIf(!fs.existsSync(real))('xeroChecks on the real ledger, with Xero as the Credit Notes tab describes it', () => {
  it('finds the four problems found by hand, and nothing on the orders that match', () => {
    const ledger = JSON.parse(fs.readFileSync(real, 'utf8')) as Ledger
    // Xero mirrors the ledger, except where the Credit Notes and Exceptions tabs say it differs.
    const invoices: XeroInvoice[] = ledger.orders.flatMap((o) => [
      ...(o.clientStatus === 'NOT_IN_XERO' ? [] : [doc({ id: `s-${o.id}`, kind: 'sale', number: o.clientInvoiceNo, totalCents: o.id === 'FN-ORD-018' ? 55_442_00 : o.clientTotalCents })]),
      doc({ id: `b-${o.id}`, kind: 'bill', number: o.supplierInvoiceNo, totalCents: o.supplierTotalCents, ...(o.id === 'FN-ORD-001' ? { status: 'AUTHORISED', amountDueCents: 7_990_00, dueDate: '2026-02-10' } : {}) }),
    ])
    const creditNotes = [
      credit('MO-85', 'bill', 895_00, [['2026050049', 895_00]], '2026-08-13'),
      credit('MO-87', 'bill', 27_238_68, [['2026080081', 27_238_68]]),
      credit('MO-87b', 'bill', 378_00, [['2026070073', 378_00]]),
      credit('CN-02', 'sale', 72_711_11, [['2026037', 72_711_11]]), // as real Xero has it: 202601 and 202602 together
      credit('CN-03-05', 'sale', 31_783_00, [['2026033', 31_783_00]]),
    ]
    const r = xeroChecks({ ledger, orders: ledger.orders, snapshot: { fetchedAt: '2026-10-26T06:00:00Z', tenantName: 'Fonenova Ltd', baseCurrency: 'GBP', invoices, creditNotes, bankBalances: null, problems: [] }, today: '2026-10-26' })
    const found = r.items.map((i) => `${i.id} ${i.impactCents}`).sort()
    expect(found).toEqual([
      'X-BILL-b-FN-ORD-001 799000',
      'X-CREDIT-2026080085 3056100',
      'X-CREDIT-2026080086 4366800',
      'X-CREDIT-2026080087 37800',
      'X-TOTAL-FN-ORD-018-sale 910000',
    ])
    expect(r.supersedes.sort()).toEqual(['EX-01', 'EX-02', 'EX-10'])
  })
})

describe('draft credit notes', () => {
  const base = { meta: { snapshotDate: '2026-10-04' }, exceptions: [], orders: [], customers: [], suppliers: [], lines: [] }
  const snapOf = (creditNotes: XeroCreditNote[]): XeroSnapshot => ({ fetchedAt: '2026-11-07T06:00:00Z', tenantName: 'Fonenova Ltd', baseCurrency: 'GBP', invoices: [], creditNotes, bankBalances: null, problems: [] })
  const draft = (number: string, kind: 'sale' | 'bill', total: number, date = '2026-11-07'): XeroCreditNote => ({ id: `d-${number}`, number, reference: '', kind, status: 'DRAFT', contactName: kind === 'sale' ? 'Wave Phone B.V.' : 'Mobile One Trade B.V.', currency: 'EUR', date, totalCents: total, allocatedTo: [] })

  it('flags CN-202602 as a duplicate: Xero already credits 2026037 with FN-CN-202602 (and FN-CN-202601)', () => {
    const ledger = { ...base, creditNotes: [
      note({ side: 'client', number: 'FN-CN-202601', amountCents: 44_804_00, refersToInvoices: '2026034' }),
      note({ side: 'client', number: 'FN-CN-202602', amountCents: 27_907_11, refersToInvoices: '2026037' }),
    ] } as unknown as Ledger
    const r = xeroChecks({ ledger, orders: [], snapshot: snapOf([credit('CN', 'sale', 72_711_11, [['2026037', 72_711_11]]), draft('CN-202602', 'sale', 27_907_11)]), today: '2026-11-07' })
    expect(r.items.map((i) => [i.id, i.priority, i.impactCents])).toEqual([['X-CNDUP-d-CN-202602', 'HIGH', 27_907_11]])
    expect(r.items[0].issue).toContain('FN-CN-202602')
    expect(r.items[0].link).toContain('ViewCreditNote')
  })

  it('leaves a draft alone when it is the missing credit (2026080085), and nudges it after a week', () => {
    const ledger = { ...base, creditNotes: [note({ side: 'supplier', number: '2026080085', amountCents: 31_456_00, refersToInvoices: '2026050049, 2026070068 & 2026070069', date: '2026-08-13' })] } as unknown as Ledger
    const fresh = xeroChecks({ ledger, orders: [], snapshot: snapOf([draft('2026080085', 'bill', 31_456_00)]), today: '2026-11-07' })
    expect(fresh.items.map((i) => i.id)).toEqual(['X-CREDIT-2026080085']) // still missing until approved; no duplicate warning
    const old = xeroChecks({ ledger, orders: [], snapshot: snapOf([draft('2026080085', 'bill', 31_456_00, '2026-10-20')]), today: '2026-11-07' })
    expect(old.items.map((i) => i.id).sort()).toEqual(['X-CNDRAFT-d-2026080085', 'X-CREDIT-2026080085'])
  })
})
