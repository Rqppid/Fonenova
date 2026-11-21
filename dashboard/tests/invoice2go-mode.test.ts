import fs from 'node:fs'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { seedClients } from '@/lib/offers/clients'
import { DuplicateInvoiceNumber, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { checkEdit } from '@/lib/offers/edit'
import { fulfilOffer, retryFulfilment, sweepFulfilment, type ReplyMessage } from '@/lib/offers/fulfil'
import { approveInvoice, confirmBill, fileInvoice, recheckDraft, sendInvoice, type InvoiceDeps } from '@/lib/offers/invoice-flow'
import { invoicingModeFrom } from '@/lib/offers/invoicing-mode'
import { linkInvoice2go, updateOrderNotes } from '@/lib/offers/invoice2go'
import { acceptByEmail } from '@/lib/offers/manual-accept'
import { invoiceAmount, isInvoice2goNumber, suggestInvoices } from '@/lib/offers/order-note'
import { holdAuto, resumeAuto, runAuto, scheduleAuto, sweepAuto } from '@/lib/offers/auto-invoice'
import { setOrderShipping } from '@/lib/offers/shipping'
import { findImeiFiles, sendImeiFollowUp } from '@/lib/offers/imei'
import type { Offer, OfferLine, OfferSend } from '@/lib/offers/types'
import type { XeroInvoice } from '@/lib/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

function memStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    name: 'mem', data,
    async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } },
    async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) },
    async del(k: StoreKey) { data.delete(k) },
    async withLock<T>(_n: string, fn: () => Promise<T>) { return fn() },
  }
}
const NOW = new Date('2026-11-21T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const LINES: OfferLine[] = [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: '', note: null }]
const ITEMS = 457_000

function accepted(clientId = 'c_wave'): Offer {
  const send: OfferSend = { clientId, clientName: 'EU Telecoms', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: ITEMS, units: 10, test: false, gmailMessageId: 'g1', outcome: 'accepted', answer: { decision: 'accept', remarks: '', at: HOURS(1), ip: '1.1.1.1', ua: 'x' }, resolvedAt: HOURS(1) }
  return { id: 'o1', status: 'accepted', source: { gmailMessageId: 'm1', threadId: 't1', rfcMessageId: '<a@mobileone.info>', from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: LINES, pricing: { clientId, marginCents: 700, overrides: {}, ackLow: false, shippingLater: true, pricedAt: HOURS(3) }, sends: [send], createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

function setup(o: Offer, invoicing: boolean, invoices: XeroInvoice[] = []) {
  const store = memStore()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' || c.id === 'c_eutelecoms' ? { ...c, termsConfirmed: true, xeroContactId: '11111111-2222-3333-4444-555555555555', invoiceEmails: ['a@b.test'] } : c)))
  const pings: string[] = []
  const sent: ReplyMessage[] = []
  const calls = { xero: 0, mail: 0 }
  const created: DraftBody[] = []
  const api: XeroApi = {
    async organisation() { calls.xero++; return { name: 'Fonenova Ltd', isDemo: false } },
    async invoiceNumbers() { calls.xero++; return ['2026047'] },
    async findByReference() { calls.xero++; return null },
    async createDraft(b) { calls.xero++; if (b.InvoiceNumber === '2026047') throw new DuplicateInvoiceNumber(); created.push(b); return { id: 'inv', number: b.InvoiceNumber, status: 'DRAFT' } },
  }
  const d: InvoiceDeps = {
    store, now: NOW, allowReal: true, allowLiveXero: true, allowApprove: true, invoicing, ownerAddress: 'o@example.test',
    notify: async (t) => { pings.push(t); return true },
    knownOrderIds: async () => ['FN-ORD-014'],
    xero: () => { calls.xero++; return api },
    reply: async (m) => { sent.push(m); return { id: `r${sent.length}` } },
    replied: async () => false,
    mail: async () => { calls.mail++; return { id: 'm' } },
    filing: { dirs: null, upload: async () => ({ kind: 'unavailable' as const }) },
    bills: async () => ({ bills: [], pairs: [] }),
    savePair: async () => {},
  }
  const get = () => (store.data.get('offers') as Offer[])[0]
  return { d, store, pings, sent, calls, created, get, invoices }
}

describe('the switch', () => {
  it('is Invoice2go unless it says exactly "dashboard"', () => {
    for (const v of [undefined, '', 'invoice2go', 'DASHBOARD2', 'true', 'on']) expect(invoicingModeFrom(v), String(v)).toBe('invoice2go')
    expect(invoicingModeFrom('dashboard')).toBe('dashboard')
    expect(invoicingModeFrom(' Dashboard ')).toBe('dashboard')
  })
  it('the production builder is OFF when the variable is missing, and on only for "dashboard"', async () => {
    const { fulfilDeps } = await import('@/lib/offers/fulfil-server')
    const saved = process.env.OFFERS_INVOICING
    delete process.env.OFFERS_INVOICING
    expect(fulfilDeps(memStore()).invoicing).toBe(false)
    process.env.OFFERS_INVOICING = 'dashboard'
    expect(fulfilDeps(memStore()).invoicing).toBe(true)
    if (saved === undefined) delete process.env.OFFERS_INVOICING; else process.env.OFFERS_INVOICING = saved
  })
})

describe('accepting an offer while Invoice2go makes the invoices', () => {
  it('replies to Mobile One, makes no draft, and says where the invoice is made', async () => {
    const t = setup(accepted(), false)
    await fulfilOffer('o1', t.d)
    const f = t.get().fulfilment!
    expect(f.reply.state).toBe('sent')
    expect(t.sent).toHaveLength(1)
    expect(f.draft.state).toBe('off')
    expect(f.auto).toBeUndefined()
    expect(t.calls).toEqual({ xero: 0, mail: 0 })
    expect(t.created).toHaveLength(0)
    expect(t.pings.join(' ')).toContain('Invoice2go')
  })
  it('recorded by hand does the same, and nothing is emailed to the client', async () => {
    const o = accepted(); o.status = 'ready'; o.sends = []
    const t = setup(o, false)
    const r = await acceptByEmail('o1', { ...t.d, fulfil: (id) => fulfilOffer(id, t.d) }, { totalCents: ITEMS, note: 'ok by email', confirm: true })
    expect(r.ok).toBe(true)
    expect(t.get().fulfilment!.draft.state).toBe('off')
    expect(t.calls).toEqual({ xero: 0, mail: 0 })
  })
  it('a retry or the 5-minute sweep still makes no draft, and a draft waiting for shipping is closed', async () => {
    const t = setup(accepted(), true)
    await fulfilOffer('o1', t.d)
    expect(t.get().fulfilment!.draft.state).toBe('waiting')
    const off = { ...t.d, invoicing: false }
    await sweepFulfilment(off)
    expect(t.get().fulfilment!.draft.state).toBe('off')
    t.pings.length = 0
    await retryFulfilment('o1', off)
    await sweepFulfilment({ ...off, now: new Date(NOW.getTime() + 48 * 3_600_000) })
    expect(t.created).toHaveLength(0)
    expect(t.pings.join(' ')).not.toContain('waiting for the shipping')
  })
})

describe('every dashboard invoice action is refused', () => {
  it('shipping, approve, send, file, re-check, bill pairing and the IMEI feature', async () => {
    const t = setup(accepted(), true)
    await fulfilOffer('o1', t.d)
    await setOrderShipping('o1', t.d, { cents: 12_000, none: false })
    expect(t.get().fulfilment!.draft.state).toBe('done')
    const off = { ...t.d, invoicing: false }
    const xeroCallsBefore = t.calls.xero
    expect((await setOrderShipping('o1', off, { cents: 5_000, none: false })).ok).toBe(false)
    for (const r of [await approveInvoice('o1', off, { confirm: true }), await sendInvoice('o1', off, { confirm: true }), await fileInvoice('o1', off), await recheckDraft('o1', off), await confirmBill('o1', 'b1', off), await findImeiFiles('o1', off), await sendImeiFollowUp('o1', off, { confirm: true }), await resumeAuto('o1', off)]) {
      expect(r.ok).toBe(false)
      expect(r.message).toContain('Invoice2go')
    }
    expect(t.calls.xero).toBe(xeroCallsBefore)
    expect(t.calls.mail).toBe(0)
  })
  it('a queued automatic invoice is held and can never run later; nothing new is scheduled', async () => {
    const t = setup(accepted(), true)
    await fulfilOffer('o1', t.d)
    await setOrderShipping('o1', t.d, { cents: 12_000, none: false })
    await scheduleAuto('o1', t.d)
    expect(t.get().fulfilment!.auto?.state).toBe('scheduled')
    const off = { ...t.d, invoicing: false, now: new Date(NOW.getTime() + 60 * 60_000) }
    await sweepAuto(off)
    expect(t.get().fulfilment!.auto?.state).toBe('held')
    expect(t.get().fulfilment!.auto?.reason).toContain('Invoice2go')
    expect((await runAuto('o1', off)).ok).toBe(false)
    await scheduleAuto('o1', off)
    expect(t.get().fulfilment!.auto?.state).toBe('held')
    expect((await holdAuto('o1', off)).ok).toBe(false)
    expect(t.calls.mail).toBe(0)
  })
})

describe('the amount to type into Invoice2go', () => {
  const [wave, eu] = ['c_wave', 'c_eutelecoms'].map((id) => seedClients().find((c) => c.id === id)!)
  it('own DHL cost as typed, Mobile One x the multiplier otherwise, items only until a cost is entered', () => {
    expect(invoiceAmount(ITEMS, eu, 8_550)).toMatchObject({ shippingCents: 8_550, totalCents: ITEMS + 8_550 })
    expect(invoiceAmount(ITEMS, wave, 12_500)).toMatchObject({ shippingCents: 25_000, totalCents: ITEMS + 25_000 })
    expect(invoiceAmount(ITEMS, wave, 12_500).working).toContain('x 2')
    expect(invoiceAmount(ITEMS, eu, null)).toMatchObject({ shippingCents: 0, totalCents: ITEMS })
    expect(invoiceAmount(ITEMS, eu, null).working).toContain('Enter the DHL cost')
  })
  it('an Invoice2go number is seven digits', () => {
    expect(isInvoice2goNumber('2026049')).toBe(true)
    for (const n of ['202604', '20260490', 'FN-ORD-1', '', '2026 049']) expect(isInvoice2goNumber(n), n).toBe(false)
  })
})

const inv = (over: Partial<XeroInvoice>): XeroInvoice => ({ id: 'x1', number: '2026049', reference: '', kind: 'sale', status: 'DRAFT', contactName: 'EU Telecoms BL Ltd', currency: 'EUR', date: '2026-11-20', dueDate: null, totalCents: ITEMS + 8_550, amountDueCents: 0, amountPaidCents: 0, payments: [], ...over })

describe('suggesting and linking the invoice', () => {
  const eu = seedClients().find((c) => c.id === 'c_eutelecoms')!
  const o = accepted()
  it('matches the client and the exact amount, ignoring voided, deleted, other clients and taken numbers', () => {
    const list = [inv({}), inv({ id: 'x2', number: '2026050', status: 'VOIDED' }), inv({ id: 'x3', number: '2026051', contactName: 'Wave Phone B.V.' }), inv({ id: 'x4', number: '2026052', totalCents: 1 }), inv({ id: 'x5', number: '2026053', kind: 'bill' })]
    expect(suggestInvoices(o, eu, ITEMS + 8_550, list).map((m) => m.number)).toEqual(['2026049'])
    expect(suggestInvoices(o, eu, ITEMS + 8_550, list, ['2026049'])).toEqual([])
    // before a cost is entered, anything at or above the items total is offered, marked as not exact
    const loose = suggestInvoices(o, eu, null, list)
    expect(loose.map((m) => m.number)).toContain('2026049')
    expect(loose.every((m) => !m.exact)).toBe(true)
  })
  it('saves notes and the link, creates nothing, and refuses a bad, duplicate or wrong number', async () => {
    const t = setup(accepted(), false)
    await fulfilOffer('o1', t.d)
    expect((await updateOrderNotes('o1', t.d, { goodsArrived: true, dhlCostCents: 8_550 })).ok).toBe(true)
    expect(t.get().fulfilment!.order).toMatchObject({ dhlCostCents: 8_550 })
    expect(t.get().fulfilment!.order!.goodsArrivedAt).toBeTruthy()
    expect((await updateOrderNotes('o1', t.d, { dhlCostCents: 0 })).ok).toBe(false)
    expect((await updateOrderNotes('o1', t.d, { goodsArrived: false })).ok).toBe(true)
    const list = [inv({ contactName: 'Wave Phone B.V.', totalCents: ITEMS + 17_100 })]
    expect((await linkInvoice2go('o1', t.d, { number: '2026O49', xeroInvoiceId: null }, list)).ok).toBe(false)
    expect((await linkInvoice2go('o1', t.d, { number: '2026050', xeroInvoiceId: 'x1' }, list)).message).toContain('2026049')
    expect((await linkInvoice2go('o1', t.d, { number: '2026049', xeroInvoiceId: 'nope' }, list)).ok).toBe(false)
    expect((await linkInvoice2go('o1', t.d, { number: '2026049', xeroInvoiceId: 'x1' }, list)).ok).toBe(true)
    expect(t.get().fulfilment!.order!.invoice2go).toMatchObject({ number: '2026049', xeroInvoiceId: 'x1' })
    expect(t.calls).toEqual({ xero: 0, mail: 0 })
    expect(t.created).toHaveLength(0)
    // the same number cannot be linked to a second order
    const second = accepted(); second.id = 'o2'
    t.store.data.set('offers', [t.get(), { ...second, fulfilment: { ...t.get().fulfilment!, orderRef: 'FN-ORD-099', order: undefined } }])
    expect((await linkInvoice2go('o2', t.d, { number: '2026049', xeroInvoiceId: null }, list)).message).toContain('already linked')
  })
  it('the requests are shaped right', () => {
    expect(checkEdit({ action: 'order_update', id: 'of_a1', goodsArrived: true, dhlCostCents: 8_550 })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'order_update', id: 'of_a1', dhlCostCents: 0 })).toMatchObject({ ok: false })
    expect(checkEdit({ action: 'invoice2go_link', id: 'of_a1', number: '2026049', xeroInvoiceId: null })).toMatchObject({ ok: true })
    expect(checkEdit({ action: 'invoice2go_link', id: 'of_a1', number: '49' })).toMatchObject({ ok: false })
  })
})

describe('the order card', () => {
  const render = (o: Offer, invoicing: boolean) => renderToString(h(AfterAcceptance, { offer: o, invoice: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: false, orgIsLive: true, invoicing }, client: seedClients().find((c) => c.id === 'c_eutelecoms')!, matches: [] })).replace(/<!-- -->/g, '')
  it('shows the Invoice2go checklist and no draft, shipping or invoice steps', async () => {
    const t = setup(accepted(), false)
    await fulfilOffer('o1', t.d)
    const html = render(t.get(), false)
    expect(html).toContain('data-testid="invoice2go-banner"')
    expect(html).toContain('data-testid="goods-arrived"')
    expect(html).toContain('Our DHL cost, euros')
    expect(html).toContain('Invoice2go number')
    for (const gone of ['step-draft', 'step-shipping', 'step-approve', 'step-send', 'Make the draft invoice']) expect(html).not.toContain(gone)
  })
  it('the dormant dashboard mode still shows the draft steps', async () => {
    const t = setup(accepted(), true)
    await fulfilOffer('o1', t.d)
    const html = render(t.get(), true)
    expect(html).toContain('step-draft')
    expect(html).not.toContain('invoice2go-banner')
  })
})

describe('nothing is ever addressed to the Make mailhook', () => {
  it('no source file contains a Make mailhook address', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && /@hook\.[a-z0-9.-]*make\.com|@hook\.integromat/i.test(fs.readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    for (const r of ['lib', 'components', 'app']) walk(path.join(process.cwd(), r))
    expect(hits).toEqual([])
  })
})
