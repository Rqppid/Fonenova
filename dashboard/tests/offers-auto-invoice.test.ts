import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceSteps } from '@/components/offers/invoice-steps'
import { OffersView } from '@/components/offers/offers-view'
import type { XeroApi, XeroInvoiceDetail } from '@/lib/offers/draft'
import { AUTO_DELAY_MS, AUTO_FROM, holdAuto, ORG_MISMATCH, resumeAuto, runAuto, scheduleAuto, sweepAuto } from '@/lib/offers/auto-invoice'
import { autoInvoiceOf, checkClients, seedClients, type Client } from '@/lib/offers/clients'
import type { InvoiceDeps } from '@/lib/offers/invoice-flow'
import type { Fulfilment, Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-18T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const MIN = (n: number) => new Date(NOW.getTime() + n * 60_000)
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3])
const WAVE = '1597cc5c-fbed-4817-a4e1-53149bb46d77'

function mem(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const tails = new Map<string, Promise<unknown>>()
  return { name: 'mem', data, async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(n: string, fn: () => Promise<T>) { const prev = tails.get(n) ?? Promise.resolve(); const run = prev.then(fn, fn); tails.set(n, run.catch(() => {})); return run } }
}

function offer(test = false, warnings?: string[]): Offer {
  const f: Fulfilment = { orderRef: test ? 'TEST-001' : 'FN-ORD-016', test, startedAt: HOURS(1), reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1, invoiceId: 'inv-1', invoiceNumber: '2026052', org: test ? 'Demo Company (UK)' : 'Fonenova Ltd', ...(warnings ? { warnings } : {}) } }
  return { id: 'of_a1', status: 'accepted', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'M <m@x.example>', to: 'i@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }], shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null }, pricing: { clientId: test ? 'c_test' : 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(4) }, sends: [{ clientId: test ? 'c_test' : 'c_wave', clientName: test ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 481_000, shippingCents: 24_000, units: 10, test, gmailMessageId: 'g1', outcome: 'accepted', resolvedAt: HOURS(1) }], ...(test ? { testOnly: true } : {}), fulfilment: f, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

type Opts = { isDemo?: boolean; allowReal?: boolean; allowLive?: boolean; allowApprove?: boolean; autoOff?: boolean; totalCents?: number; clientPatch?: Partial<Client>; now?: Date; noXero?: boolean }
function setup(o: Offer, opts: Opts = {}) {
  const isDemo = opts.isDemo ?? o.fulfilment!.test
  const store = mem()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: ['accounts@wave.example'], ...opts.clientPatch } : c.id === 'c_test' ? { ...c, xeroContactId: WAVE, invoiceEmails: ['owner@example.test'], ...opts.clientPatch } : c)))
  const mails: { to: string; subject: string }[] = []
  const pings: string[] = []
  const calls = { approve: 0, org: 0 }
  const live = { status: 'DRAFT', total: opts.totalCents ?? 481_000 }
  const api: XeroApi = {
    async organisation() { calls.org++; return { name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo } },
    async invoiceNumbers() { return [] }, async findByReference() { return null }, async createDraft() { throw new Error('n/a') },
    async getInvoice() { return { id: 'inv-1', number: '2026052', status: live.status, reference: 'x', currency: 'EUR', totalCents: live.total, contactId: WAVE, contactEmail: 'accounts@wave.example', hasAddress: true, sentToContact: false } as XeroInvoiceDetail },
    async approveInvoice() { calls.approve++; live.status = 'AUTHORISED' },
    async emailInvoice() {}, async invoicePdf() { return PDF },
  }
  const state = { now: opts.now ?? NOW }
  const d: InvoiceDeps = {
    store, get now() { return state.now }, allowReal: opts.allowReal ?? true, allowLiveXero: opts.allowLive ?? true, allowApprove: opts.allowApprove ?? true, autoOff: opts.autoOff,
    ownerAddress: 'owner@example.test', notify: async (t) => { pings.push(t); return true }, knownOrderIds: async () => [],
    xero: () => (opts.noXero ? null : api), reply: async () => ({ id: 'r' }), replied: async () => false,
    mail: async (m) => { mails.push(m); return { id: `sent-${mails.length}`, threadId: 'thr' } },
    filing: { dirs: null, upload: async () => ({ kind: 'ok' }) }, bills: async () => ({ bills: [], pairs: [] }), savePair: async () => {},
  } as InvoiceDeps
  return { d, mails, pings, calls, state, get: () => (store.data.get('offers') as Offer[])[0], store }
}

describe('which clients are automatic', () => {
  const [wave, eu, test] = seedClients()
  it('Wave, EU Telecoms and the test client by default; any other client not; an explicit setting wins', () => {
    expect(autoInvoiceOf(wave)).toBe(true)
    expect(autoInvoiceOf(eu)).toBe(true)
    expect(autoInvoiceOf(test)).toBe(true)
    expect(autoInvoiceOf({ id: 'c_new', test: false })).toBe(false)
    expect(autoInvoiceOf({ ...wave, autoInvoice: false })).toBe(false)
    expect(autoInvoiceOf({ id: 'c_new', test: false, autoInvoice: true })).toBe(true)
  })
  it('a real client cannot be switched to automatic half set up, and the value must be on or off', () => {
    const base = { ...wave, termsConfirmed: true, invoiceEmails: ['a@wave.example'] }
    expect(checkClients([{ ...base, autoInvoice: true }], [base])).toMatchObject({ ok: true })
    expect(checkClients([{ ...base, invoiceEmails: [], autoInvoice: true }], [base])).toMatchObject({ ok: false, error: expect.stringContaining('automatic invoicing needs') })
    expect(checkClients([{ ...base, xeroContactId: null, autoInvoice: true }], [base])).toMatchObject({ ok: false })
    expect(checkClients([{ ...base, autoInvoice: 'yes' }], [base])).toMatchObject({ ok: false, error: expect.stringContaining('on or off') })
    const saved = checkClients([{ ...base, autoInvoice: false }], [base])
    expect(saved.ok && saved.value[0].autoInvoice).toBe(false)
  })
})

describe('scheduling the automatic invoice', () => {
  it('schedules it 10 minutes after the draft, and tells you once with the time', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto).toMatchObject({ state: 'scheduled', dueAt: MIN(10).toISOString() })
    expect(AUTO_DELAY_MS).toBe(10 * 60_000)
    expect(t.pings).toHaveLength(1)
    expect(t.pings[0]).toContain('2026052')
    expect(t.pings[0]).toContain('€4,810.00')
    expect(t.pings[0]).toContain('10:10')
    expect(t.pings[0]).toContain('unless you press Hold')
    await scheduleAuto('of_a1', t.d)
    expect(t.pings).toHaveLength(1)
  })
  it('does nothing for a client that is not automatic, or when the kill switch is on', async () => {
    const off = setup(offer(), { clientPatch: { autoInvoice: false } })
    await scheduleAuto('of_a1', off.d)
    expect(off.get().fulfilment!.auto).toBeUndefined()
    const kill = setup(offer(), { autoOff: true })
    await scheduleAuto('of_a1', kill.d)
    expect(kill.get().fulfilment!.auto).toBeUndefined()
    expect(off.pings.length + kill.pings.length).toBe(0)
  })
  it('is blocked, with the reason, when the draft has an address warning, and goes ahead once that clears', async () => {
    const t = setup(offer(false, ['Add an address in Xero before approving']))
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('no usable address') })
    expect(t.pings).toHaveLength(1)
    await scheduleAuto('of_a1', t.d)
    expect(t.pings).toHaveLength(1) // not told twice
    const cur = t.get(); cur.fulfilment!.draft.warnings = undefined
    t.store.data.set('offers', [cur])
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto!.state).toBe('scheduled')
  })
  it('the "recent invoices" note does not block it (Wave is invoiced often)', async () => {
    const t = setup(offer(false, ['Wave Phone B.V. already has 3 invoices in Xero from the last 14 days: 2026044']))
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto!.state).toBe('scheduled')
  })
  it('holds for missing terms, a missing invoice email, a test in live Xero, a real order in a demo, or no Xero connection', async () => {
    const terms = setup(offer(), { clientPatch: { termsConfirmed: false } })
    await scheduleAuto('of_a1', terms.d)
    expect(terms.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('payment terms') })
    const email = setup(offer(), { clientPatch: { invoiceEmails: [] } })
    await scheduleAuto('of_a1', email.d)
    expect(email.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('invoice email') })
    const liveTest = offer(true); liveTest.fulfilment!.draft.org = 'Fonenova Ltd'
    const lt = setup(liveTest, { isDemo: false })
    await scheduleAuto('of_a1', lt.d)
    expect(lt.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('never approved in the live') })
    const realInDemo = offer(); realInDemo.fulfilment!.draft.org = 'Demo Company (UK)'
    const realDemo = setup(realInDemo, { isDemo: true })
    await scheduleAuto('of_a1', realDemo.d)
    expect(realDemo.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('demo') })
    const none = setup(offer(), { noXero: true })
    await scheduleAuto('of_a1', none.d)
    expect(none.get().fulfilment!.auto!.state).toBe('blocked')
  })
})

describe('which orders automatic invoicing touches', () => {
  it('never an order that started before automatic invoicing went live (nothing scheduled, nothing sent)', async () => {
    const old = offer(); old.fulfilment!.startedAt = new Date(Date.parse(AUTO_FROM) - 3_600_000).toISOString()
    const t = setup(old)
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto).toBeUndefined()
    t.state.now = MIN(60)
    expect(await sweepAuto(t.d)).toEqual({ scheduled: 0, ran: 0 })
    expect(t.mails).toHaveLength(0)
    expect(t.pings).toHaveLength(0)
  })
  it('a scheduled one is stopped if the owner got there first and approved it himself', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    const cur = t.get(); cur.fulfilment!.approve = { state: 'done', at: MIN(3).toISOString() }
    t.store.data.set('offers', [cur])
    t.state.now = MIN(11)
    await sweepAuto(t.d)
    expect(t.calls.approve).toBe(0)
    expect(t.mails).toHaveLength(0)
    expect(t.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining('already started the invoice yourself') })
  })
  it('an order already started by hand is not scheduled at all', async () => {
    const mine = offer(); mine.fulfilment!.send = { state: 'failed', reason: 'x', at: HOURS(0) }
    const t = setup(mine)
    await scheduleAuto('of_a1', t.d)
    expect(t.get().fulfilment!.auto).toBeUndefined()
  })
  it('the 5-minute pass ignores orders older than a week', async () => {
    const t = setup(offer())
    t.state.now = new Date(NOW.getTime() + 8 * 24 * 3_600_000)
    expect(await sweepAuto(t.d)).toEqual({ scheduled: 0, ran: 0 })
    expect(t.get().fulfilment!.auto).toBeUndefined()
    expect(t.calls.org).toBe(0)
  })
  it('a Demo test left while the dashboard points at live says how to fix it, and is not re-checked every pass; a real order is', async () => {
    const demoTest = offer(true) // draft made in the Demo Company
    const dt = setup(demoTest, { isDemo: false })
    await scheduleAuto('of_a1', dt.d)
    expect(dt.get().fulfilment!.auto).toMatchObject({ state: 'blocked', reason: expect.stringContaining(`${ORG_MISMATCH} Demo Company (UK)`) })
    expect(dt.get().fulfilment!.auto!.reason).toContain('Re-check in Xero')
    const after = dt.calls.org
    await sweepAuto(dt.d); await sweepAuto(dt.d)
    expect(dt.calls.org).toBe(after)
    expect(dt.pings).toHaveLength(1)
    // A real order pointed at the wrong organisation is re-checked each pass, so switching back lets it go ahead on its own.
    const real = setup(offer(), { isDemo: true })
    await scheduleAuto('of_a1', real.d)
    expect(real.get().fulfilment!.auto!.state).toBe('blocked')
    const calls = real.calls.org
    await sweepAuto(real.d)
    expect(real.calls.org).toBeGreaterThan(calls)
    expect(real.mails).toHaveLength(0)
  })
})

describe('running it when it is due', () => {
  it('does nothing before the time; at the time it approves and emails once, and three sweeps still send once', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    t.state.now = MIN(9)
    expect(await runAuto('of_a1', t.d)).toMatchObject({ ok: false })
    expect(await sweepAuto(t.d)).toMatchObject({ ran: 0 })
    expect(t.mails).toHaveLength(0)
    t.state.now = MIN(11)
    await Promise.all([1, 2, 3].map(() => sweepAuto(t.d)))
    expect(t.calls.approve).toBe(1)
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0]).toMatchObject({ to: 'accounts@wave.example', subject: 'Invoice 2026052 from FoneNova Ltd' })
    const f = t.get().fulfilment!
    expect(f.approve!.state).toBe('done')
    expect(f.send!.state).toBe('done')
    expect(f.auto!.state).toBe('done')
  })
  it('Hold stops it for good; releasing the hold schedules it again 10 minutes out', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    expect(await holdAuto('of_a1', t.d)).toMatchObject({ ok: true })
    t.state.now = MIN(30)
    await sweepAuto(t.d)
    expect(t.mails).toHaveLength(0)
    expect(t.get().fulfilment!.auto!.state).toBe('held')
    expect(await holdAuto('of_a1', t.d)).toMatchObject({ ok: false })
    expect(await resumeAuto('of_a1', t.d)).toMatchObject({ ok: true })
    expect(t.get().fulfilment!.auto).toMatchObject({ state: 'scheduled', dueAt: new Date(MIN(30).getTime() + AUTO_DELAY_MS).toISOString() })
  })
  it('keeps every existing gate: approving off, real sending off, wrong total, live Xero off', async () => {
    const run = async (o: Opts, expectApproved: boolean) => {
      const t = setup(offer(), o)
      await scheduleAuto('of_a1', t.d)
      t.state.now = MIN(11)
      await runAuto('of_a1', t.d)
      return t
    }
    const noApprove = await run({ allowApprove: false }, false)
    expect(noApprove.get().fulfilment!.auto).toMatchObject({ state: 'failed', reason: expect.stringContaining('OFFERS_ALLOW_APPROVE') })
    expect(noApprove.calls.approve).toBe(0)
    expect(noApprove.mails).toHaveLength(0)
    expect(noApprove.pings.some((p) => p.includes('nothing was sent'))).toBe(true)
    const noReal = await run({ allowReal: false }, true)
    expect(noReal.get().fulfilment!.auto).toMatchObject({ state: 'failed', reason: expect.stringContaining('OFFERS_ALLOW_REAL_SEND') })
    expect(noReal.mails).toHaveLength(0)
    expect(noReal.pings.some((p) => p.includes('approved in Xero but NOT emailed'))).toBe(true)
    const wrong = await run({ totalCents: 480_000 }, false)
    expect(wrong.get().fulfilment!.auto).toMatchObject({ state: 'failed', reason: expect.stringContaining('but the client accepted') })
    expect(wrong.calls.approve).toBe(0)
    expect(wrong.mails).toHaveLength(0)
    const noLive = await run({ allowLive: false }, false)
    expect(noLive.get().fulfilment!.auto).toMatchObject({ state: 'failed', reason: expect.stringContaining('XERO_WRITE_ALLOW_LIVE') })
    expect(noLive.mails).toHaveLength(0)
  })
  it('a failed one is never retried by itself, and the manual buttons are still there', async () => {
    const t = setup(offer(), { allowApprove: false })
    await scheduleAuto('of_a1', t.d)
    t.state.now = MIN(11)
    await runAuto('of_a1', t.d)
    t.d.allowApprove = true
    t.state.now = MIN(60)
    await sweepAuto(t.d)
    expect(t.mails).toHaveLength(0)
    expect(t.get().fulfilment!.auto!.state).toBe('failed')
  })
  it('turning the kill switch on in the 10 minutes stops it', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    t.d.autoOff = true
    t.state.now = MIN(11)
    await sweepAuto(t.d)
    expect(t.mails).toHaveLength(0)
    expect(t.get().fulfilment!.auto!.state).toBe('blocked')
  })
  it('a Demo test invoice runs the whole way: approved and emailed to the owner, marked [TEST]', async () => {
    const t = setup(offer(true))
    await scheduleAuto('of_a1', t.d)
    t.state.now = MIN(11)
    await sweepAuto(t.d)
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0]).toMatchObject({ to: 'owner@example.test', subject: '[TEST] Invoice 2026052 from FoneNova Ltd' })
    expect(t.get().fulfilment!.auto!.state).toBe('done')
  })
  it('one that ended unclear (the server stopped while running) is flagged, not repeated', async () => {
    const t = setup(offer())
    await scheduleAuto('of_a1', t.d)
    const cur = t.get(); cur.fulfilment!.auto = { state: 'running', dueAt: MIN(10).toISOString(), at: MIN(10).toISOString() }
    t.store.data.set('offers', [cur])
    t.state.now = MIN(25)
    await sweepAuto(t.d)
    expect(t.get().fulfilment!.auto).toMatchObject({ state: 'failed', reason: expect.stringContaining('ended unclear') })
    expect(t.mails).toHaveLength(0)
  })
})

describe('what the screen shows', () => {
  const render = (o: Offer) => renderToString(h(InvoiceSteps, { offer: o, setup: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: true, orgIsLive: true } })).replace(/<!-- -->/g, '')
  const withAuto = (auto: Fulfilment['auto']) => { const o = offer(); o.fulfilment!.auto = auto; return o }
  it('scheduled shows the time and a Hold button; held shows a way back; blocked and failed show the reason', () => {
    const due = MIN(10).toISOString()
    const sched = render(withAuto({ state: 'scheduled', dueAt: due }))
    expect(sched).toContain('auto-hold-button')
    expect(sched).toContain('by itself')
    expect(render(withAuto({ state: 'held', dueAt: due }))).toContain('auto-resume-button')
    expect(render(withAuto({ state: 'blocked', dueAt: due, reason: 'No usable address' }))).toContain('It will not go out by itself: No usable address')
    expect(render(withAuto({ state: 'failed', dueAt: due, reason: 'Xero said no' }))).toContain('The automatic invoice stopped: Xero said no')
    expect(render(offer())).not.toContain('step-auto')
  })

  const view = (offers: Offer[]) => renderToString(h(OffersView, { offers, status: null, setup: { gmail: null, telegram: false, schedule: true }, selected: null, clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
  const items = (html: string) => (html.match(/data-testid="offer-item"/g) ?? []).length
  it('an accepted test offer stays in the list until its invoice has been emailed', () => {
    const accepted = offer(true)
    expect(items(view([accepted]))).toBe(1)
    const done = offer(true); done.fulfilment!.send = { state: 'done', at: HOURS(0) }
    expect(items(view([done]))).toBe(0)
    const declined = offer(true); declined.status = 'declined'
    expect(items(view([declined]))).toBe(0)
  })
  it('says it is updating by itself while something is waiting, and not when everything has settled', () => {
    const sent = offer(true); sent.status = 'sent'
    expect(view([sent])).toContain('updating automatically')
    const draftPending = offer(true); draftPending.fulfilment!.draft = { state: 'pending', attempts: 0 }
    expect(view([draftPending])).toContain('updating automatically')
    const scheduled = offer(true); scheduled.fulfilment!.auto = { state: 'scheduled', dueAt: MIN(10).toISOString() }
    expect(view([scheduled])).toContain('updating automatically')
    expect(view([offer(true)])).not.toContain('updating automatically')
  })
})
