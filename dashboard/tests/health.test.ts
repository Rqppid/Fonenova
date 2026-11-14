import { afterEach, describe, expect, it, vi } from 'vitest'
import { healthChecks, healthSummary, invoiceGaps, type HealthInput } from '@/lib/health'
import { validateSettings, validateSettingsPatch } from '@/lib/data-source'
import type { XeroInvoice, XeroSnapshot } from '@/lib/types'

vi.mock('server-only', () => ({}))

const doc = (number: string, kind: 'sale' | 'bill', date: string, status = 'PAID'): XeroInvoice => ({
  id: `${kind}-${number}`, number, reference: '', kind, status, contactName: '', currency: 'EUR', date, dueDate: date, totalCents: 1, amountDueCents: 0, amountPaidCents: 1, payments: [],
})
// The real run in Xero on 3 Nov: 2026038, 040, 042 to 046, with 039 and 041 missing.
const real = ['2026036', '2026037', '2026038', '2026040', '2026042', '2026043', '2026044', '2026045', '2026046'].map((n) => doc(n, 'sale', '2026-10-22'))
const snap = (invoices: XeroInvoice[], fetchedAt = '2026-11-03T06:00:00Z'): XeroSnapshot => ({ fetchedAt, tenantName: 'Fonenova Ltd', baseCurrency: 'GBP', invoices, creditNotes: [], bankBalances: null, problems: [] })
const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  now: new Date('2026-11-03T07:00:00Z'), today: '2026-11-03', sources: [],
  xero: { configured: true, connected: true, snapshot: snap([...real, doc('2026100105', 'bill', '2026-10-22')]) },
  oneDrive: { configured: true, connected: true }, make: null, makeConfigured: false,
  gmail: { configured: true, connected: true }, watchdogConfigured: true, ignoredInvoiceNumbers: [], ...over,
})
const level = (checks: ReturnType<typeof healthChecks>, id: string) => checks.find((c) => c.id === id)?.level

describe('watchdog', () => {
  it('finds the invoice numbers missing from the real run, and forgets ones marked unused', () => {
    expect(invoiceGaps(real)).toEqual(['2026039', '2026041'])
    expect(invoiceGaps(real, ['2026039'])).toEqual(['2026041'])
    expect(invoiceGaps([...real, doc('2026039', 'sale', '2026-09-01', 'VOIDED'), doc('2026041', 'sale', '2026-09-01', 'VOIDED')])).toEqual([]) // voided still counts as used
  })

  it('turns amber, then red, when no invoices or bills arrive (12 days since 22 Oct)', () => {
    const c = healthChecks(base())
    expect([level(c, 'quiet-sale'), level(c, 'quiet-bill'), level(c, 'invoice-gaps')]).toEqual(['amber', 'amber', 'red'])
    expect(level(healthChecks(base({ now: new Date('2026-11-06T07:00:00Z') })), 'quiet-sale')).toBe('red')
    expect(c.find((x) => x.id === 'invoice-gaps')!.numbers).toEqual(['2026039', '2026041'])
  })

  it('goes red when Xero stops refreshing, a connection drops, or a Make scenario fails', () => {
    const c = healthChecks(base({
      xero: { configured: true, connected: true, snapshot: snap(real, '2026-11-01T06:00:00Z') },
      oneDrive: { configured: true, connected: false },
      makeConfigured: true,
      make: { configured: true, scenarios: [{ id: '8119866', name: 'Mobile One Bills', active: true, lastRunAt: '2026-11-02T09:00:00Z', lastRunOk: false, lastError: 'Xero 401' }], creditsUsed: 970, creditsLimit: 1000, problems: [], fetchedAt: '' },
    }))
    expect([level(c, 'xero-age'), level(c, 'onedrive'), level(c, 'make-8119866'), level(c, 'make-credits')]).toEqual(['red', 'red', 'red', 'red'])
  })

  it('warns when the alert channels themselves are missing', () => {
    const c = healthChecks(base({ watchdogConfigured: false, makeConfigured: false, gmail: { configured: true, connected: false, message: 'Gmail is not connected. Press Connect Gmail.' } }))
    expect([level(c, 'watchdog'), level(c, 'make'), level(c, 'gmail')]).toEqual(['amber', 'amber', 'amber'])
    expect(c.find((x) => x.id === 'gmail')!.detail).toBe('Gmail is not connected. Press Connect Gmail.') // says what to do, not just "not working"
    expect(level(healthChecks(base({ gmail: { configured: true, connected: true } })), 'gmail')).toBeUndefined()
  })

  it('writes a summary with reds first', () => {
    const s = healthSummary(healthChecks(base()))
    expect(s.split('\n')[1]).toMatch(/^RED {2}2 invoice numbers missing from Xero/)
    expect(healthSummary([])).toBe('QuayPilot: all checks pass.')
  })
})

describe('reporting to the outside monitor', () => {
  afterEach(() => { delete process.env.HEALTHCHECK_URL })
  it('pings /fail with the problems when anything is red, and plain when all is well', async () => {
    const { reportHealth } = await import('@/lib/watchdog')
    process.env.HEALTHCHECK_URL = 'https://hc-ping.com/abc'
    const calls: { url: string; body: string }[] = []
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, body: String(init.body) }), new Response('OK'))) as unknown as typeof fetch
    expect(await reportHealth([{ id: 'x', level: 'red', title: 'Xero is disconnected', detail: 'd' }], f)).toBe('fail')
    expect(await reportHealth([{ id: 'y', level: 'amber', title: 'a', detail: 'd' }], f)).toBe('ok')
    expect(calls.map((c) => c.url)).toEqual(['https://hc-ping.com/abc/fail', 'https://hc-ping.com/abc'])
    expect(calls[0].body).toContain('Xero is disconnected')
  })
})

describe('settings', () => {
  it('keeps older saved settings working and checks each change', () => {
    expect(validateSettings({ marginSchemeVat: true })).toEqual({ marginSchemeVat: true, ignoredInvoiceNumbers: [], fridayEmail: false })
    expect(validateSettings({ marginSchemeVat: false, fridayEmail: true })).toMatchObject({ fridayEmail: true })
    expect(validateSettingsPatch({ fridayEmail: true })).toEqual({ fridayEmail: true })
    expect(validateSettingsPatch({ fridayEmail: 'yes' })).toBeNull()
    expect(validateSettingsPatch({ ignoredInvoiceNumbers: ['2026039'] })).toEqual({ ignoredInvoiceNumbers: ['2026039'] })
    expect(validateSettingsPatch({ ignoredInvoiceNumbers: ['<script>'] })).toBeNull()
    expect(validateSettingsPatch({})).toBeNull()
  })
})

describe('payments service in the watchdog', () => {
  const pay = (payments: HealthInput['payments']) => healthChecks(base({ payments })).find((c) => c.id === 'payments')
  it('is red when stale (a 503 with ok:false), red when unreachable, green when fresh, absent when not configured', () => {
    expect(pay({ kind: 'ok', data: { ok: false, last_run: '2026-11-08T07:10:00Z', minutes_ago: 168, last_error: 'Revolut token expired' } })).toMatchObject({ level: 'red', title: 'Payments matching has stopped' })
    expect(pay({ kind: 'ok', data: { ok: false, last_run: null, minutes_ago: 3, last_error: 'HTTP 401 from Revolut' } })).toMatchObject({ level: 'red', title: 'Payments matching failed its last run', detail: 'Last run 3 min ago. Details: HTTP 401 from Revolut' })
    expect(pay({ kind: 'ok', data: { ok: true, last_run: null, minutes_ago: 45, last_error: null } })?.level).toBe('red')
    expect(pay({ kind: 'error', message: 'The payments service could not be reached.' })).toMatchObject({ level: 'red', title: 'Payments service unreachable' })
    expect(pay({ kind: 'ok', data: { ok: true, last_run: null, minutes_ago: 4, last_error: null } })?.level).toBe('ok')
    expect(pay({ kind: 'not-configured' })).toBeUndefined()
    expect(pay(undefined)).toBeUndefined()
    expect(healthSummary(healthChecks(base({ payments: { kind: 'ok', data: { ok: false, last_run: null, minutes_ago: 168, last_error: 'Revolut token expired' } } })))).toContain('Revolut token expired')
  })
})

describe('OneDrive write access in the watchdog', () => {
  const od = (over: Partial<HealthInput>) => healthChecks(base(over)).find((c) => c.id === 'onedrive-write')
  it('is amber only when the payments service expects tracker writes and the connection is read-only', () => {
    expect(od({ trackerWritesWanted: true, oneDrive: { configured: true, connected: true, canWrite: false } })?.level).toBe('amber')
    expect(od({ trackerWritesWanted: true, oneDrive: { configured: true, connected: true, canWrite: true } })).toBeUndefined()
    expect(od({ trackerWritesWanted: false, oneDrive: { configured: true, connected: true, canWrite: false } })).toBeUndefined()
  })
})
