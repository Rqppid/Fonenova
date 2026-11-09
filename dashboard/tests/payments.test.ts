import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { paymentsFixture } from './fixtures/payments'

/** Server-rendered HTML without React's <!-- --> text separators, so phrases read as on screen. */
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')

vi.mock('server-only', () => ({}))
const user = vi.hoisted(() => ({ value: 'info@fonenova.com' as string | false | null }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => '/payments' }))

const TOKEN = 'sentinel-token-7f3a9c'
const URL_ = 'https://payments.internal.example'
const env = { ...process.env }
let calls: { url: string; init: RequestInit }[] = []
const reply = (status: number, body: unknown) => vi.fn(async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })))

beforeEach(() => {
  calls = []
  user.value = 'info@fonenova.com'
  Object.assign(process.env, { PAYMENTS_API_URL: URL_, PAYMENTS_API_TOKEN: TOKEN, AUTH_URL: 'https://dashboard.fonenova.com' })
  vi.stubGlobal('fetch', reply(200, { ok: true }))
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

const post = (path: string, body: unknown, origin = 'https://dashboard.fonenova.com') =>
  new Request(`https://dashboard.fonenova.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('money formatting', () => {
  it('formats integer cents in EUR with a true minus sign', async () => {
    const { eur } = await import('@/lib/format')
    expect([eur(3_520_000), eur(0), eur(-2_000), eur(5)]).toEqual(['€35,200.00', '€0.00', '−€20.00', '€0.05'])
  })
})

describe('approve and dismiss routes', () => {
  it('refuse a caller who is not signed in, without calling the service', async () => {
    user.value = false
    const { POST } = await import('@/app/api/payments/approve/route')
    const { POST: DISMISS } = await import('@/app/api/payments/dismiss/route')
    const { GET } = await import('@/app/api/payments/tracker/route')
    expect((await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046' }))).status).toBe(401)
    expect((await DISMISS(post('/api/payments/dismiss', { exception_id: 41, dismiss_reason: 'refund' }))).status).toBe(401)
    expect((await GET(new Request('https://dashboard.fonenova.com/api/payments/tracker?key=wave'))).status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('refuse bad input with a 400 and never forward it', async () => {
    const { POST } = await import('@/app/api/payments/approve/route')
    const { POST: DISMISS } = await import('@/app/api/payments/dismiss/route')
    const { GET } = await import('@/app/api/payments/tracker/route')
    const bad = [
      { exception_id: 41, invoice: '20; DROP' },
      { exception_id: 41, invoice: '2026046', amount_cents: -100 },
      { exception_id: 41, invoice: '2026046', amount_cents: 12.5 },
      { exception_id: 41, invoice: '2026046', amount_cents: '100' },
      { invoice: '2026046' },
      { exception_id: '41', invoice: '2026046' },
      { exception_id: 41.5, invoice: '2026046' },
      'not json',
    ]
    for (const b of bad) expect((await POST(post('/api/payments/approve', b))).status, JSON.stringify(b)).toBe(400)
    for (const b of [{ exception_id: 41 }, { exception_id: 41, dismiss_reason: '  ' }, { dismiss_reason: 'refund' }]) expect((await DISMISS(post('/api/payments/dismiss', b))).status).toBe(400)
    expect((await GET(new Request('https://dashboard.fonenova.com/api/payments/tracker?key=../x'))).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('refuse a change from another site', async () => {
    const { POST } = await import('@/app/api/payments/approve/route')
    expect((await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046' }, 'https://evil.example'))).status).toBe(403)
    expect((await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046' }, ''))).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('forward only the checked fields, with the token, and pass a refusal through', async () => {
    const { POST } = await import('@/app/api/payments/approve/route')
    const ok = await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046', amount_cents: 3_520_000, extra: 'ignored' }))
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true }])
    expect(calls[0].url).toBe(`${URL_}/api/approve`)
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ exception_id: 41, invoice: '2026046', amount_cents: 3_520_000 })
    vi.stubGlobal('fetch', reply(409, { error: 'Amount is more than the €43,954.94 still open on 2026044' }))
    const refused = await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026044', amount_cents: 5_000_000 }))
    expect([refused.status, (await refused.json()).error]).toEqual([409, 'Amount is more than the €43,954.94 still open on 2026044'])
    expect(refused.headers.get('cache-control')).toBe('no-store')
  })

  it('forward the tracker only when it is one of the three, and refuse anything else', async () => {
    const { POST } = await import('@/app/api/payments/approve/route')
    expect((await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046', tracker: 'wave' }))).status).toBe(200)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ exception_id: 41, invoice: '2026046', tracker: 'wave' })
    expect((await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026046', tracker: 'x' }))).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('pass on how much of a part-allocated payment is still unallocated', async () => {
    vi.stubGlobal('fetch', reply(200, { ok: true, still_unallocated_cents: 2_520_000 }))
    const { POST } = await import('@/app/api/payments/approve/route')
    const r = await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026044', amount_cents: 1_000_000 }))
    expect(await r.json()).toEqual({ ok: true, still_unallocated_cents: 2_520_000 })
    vi.stubGlobal('fetch', reply(200, { ok: true, still_unallocated_cents: 'lots' }))
    expect(await (await POST(post('/api/payments/approve', { exception_id: 41, invoice: '2026044' }))).json()).toEqual({ ok: true })
  })

  it('dismiss sends the reason, trimmed, to the approve endpoint', async () => {
    const { POST } = await import('@/app/api/payments/dismiss/route')
    expect((await POST(post('/api/payments/dismiss', { exception_id: 42, dismiss_reason: '  Revolut refund  ' }))).status).toBe(200)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ exception_id: 42, dismiss_reason: 'Revolut refund' })
  })
})

describe('payments data layer', () => {
  it('says "not configured" when the service settings are missing (Preview)', async () => {
    delete process.env.PAYMENTS_API_URL
    const { getState } = await import('@/lib/payments-source')
    expect(await getState()).toEqual({ kind: 'not-configured' })
    expect(calls).toHaveLength(0)
  })

  it('turns outages into plain errors that never contain the token or the address', async () => {
    const { getState } = await import('@/lib/payments-source')
    for (const f of [reply(500, 'stack trace with secrets'), reply(401, {}), vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }), reply(200, 'not json'), reply(200, { currency: 'GBP' })]) {
      vi.stubGlobal('fetch', f)
      const r = await getState()
      expect(r.kind).toBe('error')
      const text = JSON.stringify(r)
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('payments.internal')
      expect(text).not.toContain('stack trace')
    }
  })

  it('reads a 503 from /api/health as stale health data, not as an outage', async () => {
    const { getHealth } = await import('@/lib/payments-source')
    vi.stubGlobal('fetch', reply(503, { ok: false, last_run: '2026-11-08T07:10:00Z', minutes_ago: 168, last_error: 'Revolut token expired' }))
    expect(await getHealth()).toEqual({ kind: 'ok', data: { ok: false, last_run: '2026-11-08T07:10:00Z', minutes_ago: 168, last_error: 'Revolut token expired' } })
    vi.stubGlobal('fetch', reply(503, 'Service Unavailable'))
    expect((await getHealth()).kind).toBe('error')
    vi.stubGlobal('fetch', reply(500, { ok: false }))
    expect((await getHealth()).kind).toBe('error')
  })

  it('keeps customer and Mobile One balances apart, per party, from the service figures', async () => {
    const { partyTotals } = await import('@/lib/payments-source')
    const s = paymentsFixture()
    expect(partyTotals(s.customer_invoices)).toEqual([
      { party: 'Wave Phone B.V.', remainingCents: 43_954_94 + 258_810_00, openCents: 43_954_94 + 258_810_00, favourCents: 0, open: 2 },
      { party: 'TradeWise', remainingCents: -20_00, openCents: 0, favourCents: 20_00, open: 0 }, // the cancelled invoice is left out
    ])
    expect(partyTotals(s.supplier_invoices)).toEqual([{ party: 'Mobile One Trade B.V.', remainingCents: 156_500_00 - 43_668_00, openCents: 156_500_00, favourCents: 43_668_00, open: 1 }])
  })
})

describe('Payments page rendering', () => {
  it('shows each payment on its own row, and credits separately', async () => {
    const { InvoiceDetail } = await import('@/components/payments/payments-view')
    const inv = paymentsFixture().customer_invoices[0]
    const html = render(h(InvoiceDetail, { invoice: inv }))
    expect(html.match(/data-testid="payment-row"/g)).toHaveLength(3)
    for (const amount of ['€40,000.00', '€15,000.00', '€5,000.00']) expect(html).toContain(amount)
    expect(html).not.toContain('€60,000.00') // the three are never added into one figure here
    const credited = render(h(InvoiceDetail, { invoice: paymentsFixture().supplier_invoices[1] }))
    expect(credited).toContain('Credit notes applied to this invoice')
    expect(credited).toContain('(credited)')
  })

  it('offers only Dismiss where there is nothing to allocate, and the surplus for an overpayment', async () => {
    const { exceptionActions } = await import('@/components/payments/payments-view')
    const ev = { date: '2026-11-01', amount_cents: 100, reference: '', description: '' }
    const pick = (code: string, bank_event: typeof ev | null = ev) => exceptionActions({ code, bank_event })
    for (const code of ['X-REVERSAL', 'X-TOKEN', 'X-FETCH', 'X-BULK']) expect(pick(code).allocate, code).toBe(false)
    expect(pick('X-NO-REF', null).allocate).toBe(false) // no bank payment attached
    expect(pick('X-NO-REF')).toEqual({ allocate: true, why: null, side: 'customer', surplusOnly: false })
    expect(pick('X-OVERPAY')).toMatchObject({ allocate: true, surplusOnly: true })
    for (const code of ['X-OUT-UNKNOWN-ACCT', 'X-OUT-BAD-REF', 'X-OUT-OVER', 'X-OUT-NEW']) expect(pick(code).side, code).toBe('supplier')
  })

  it('shows no Allocate button on reversal or token items', async () => {
    const { Exceptions } = await import('@/components/payments/payments-view')
    const s = paymentsFixture()
    const one = (id: number) => render(h(Exceptions, { items: s.exceptions.filter((e) => e.id === id), customerInvoices: s.customer_invoices, supplierInvoices: s.supplier_invoices }))
    for (const id of [44, 45]) {
      const html = one(id)
      expect(html, String(id)).not.toMatch(/Allocate to|Another invoice/)
      expect(html).toContain('Nothing to allocate')
      expect(html).toContain('Dismiss')
    }
    expect(one(46)).toContain('Put the surplus on 2026046')
    expect(one(41)).toContain('Allocate to 2026046')
  })

  it('shows open, in your favour and net apart when credits are not yet set off, one line otherwise', async () => {
    const { PartyBalance } = await import('@/components/payments/payments-view')
    const both = render(h(PartyBalance, { t: { party: 'Mobile One Trade B.V.', remainingCents: 112_832_00, openCents: 156_500_00, favourCents: 43_668_00, open: 1 }, supplier: true }))
    for (const t of ['Open bills', '€156,500.00', 'In your favour', '€43,668.00', 'not yet set off', 'Net you owe', '€112,832.00']) expect(both).toContain(t)
    const plain = render(h(PartyBalance, { t: { party: 'Wave Phone B.V.', remainingCents: 5_00, openCents: 5_00, favourCents: 0, open: 1 }, supplier: false }))
    expect(plain.replace(/<[^>]+>/g, '')).toContain('Owes you €5.00 · 1 open')
    expect(plain).not.toContain('favour')
  })

  it('marks stale data in words, with the last error', async () => {
    const { Freshness } = await import('@/components/payments/payments-view')
    const stale = render(h(Freshness, { state: { generated_at: '2026-11-08T10:00:00Z', health: { ok: false, last_run: '2026-11-08T07:10:00Z', minutes_ago: 168, last_error: 'Revolut token expired' } } }))
    expect(stale).toContain('data-stale="true"')
    expect(stale).toContain('Possibly out of date')
    expect(stale).toContain('Revolut token expired')
    const fresh = render(h(Freshness, { state: { generated_at: '2026-11-08T10:00:00Z', health: { ok: true, last_run: null, minutes_ago: 3, last_error: null } } }))
    expect(fresh).toContain('data-stale="false"')
    expect(fresh).toContain('3 minutes ago')
  })

  it('shows an error with Retry and no figures when the service is down, and a clear message when not configured', async () => {
    const { PaymentsView } = await import('@/components/payments/payments-view')
    const down = render(h(PaymentsView, { result: { kind: 'error', message: 'The payments service could not be reached.' }, totals: null }))
    expect(down).toContain('Payments service unreachable')
    expect(down).toContain('Retry')
    expect(down).not.toMatch(/<table|€0\.00/)
    const off = render(h(PaymentsView, { result: { kind: 'not-configured' }, totals: null }))
    expect(off).toContain('Payments service not configured')
    expect(off).not.toMatch(/<table|€/)
  })

  it('renders the full page with HIGH first, no combined payment totals, and no token', async () => {
    const { PaymentsView } = await import('@/components/payments/payments-view')
    const { partyTotals } = await import('@/lib/payments-source')
    const s = paymentsFixture()
    const html = render(h(PaymentsView, { result: { kind: 'ok', data: s }, totals: { customers: partyTotals(s.customer_invoices), supplier: partyTotals(s.supplier_invoices) } }))
    expect(html.indexOf('data-severity="HIGH"')).toBeLessThan(html.indexOf('data-severity="MEDIUM"'))
    expect(html).toContain('Allocate to 2026046 · remaining €258,810.00')
    expect(html).not.toMatch(/total (received|paid)/i)
    const allPayments = [...s.customer_invoices, ...s.supplier_invoices].flatMap((i) => i.payments).reduce((n, p) => n + p.amount_cents, 0)
    expect(html).not.toContain(new Intl.NumberFormat('en-IE', { minimumFractionDigits: 2 }).format(allPayments / 100))
    expect(html).not.toContain(TOKEN)
    expect(html).toContain('href="/api/payments/tracker?key=m1"')
  })
})
