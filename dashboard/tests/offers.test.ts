import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SAMPLES } from './fixtures/offers'
import type { MailMessage } from '@/lib/gmail'
import type { OfferLine } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
const user = vi.hoisted(() => ({ value: 'info@fonenova.com' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const env = { ...process.env }
let dir: string
beforeEach(() => {
  vi.resetModules()
  user.value = 'info@fonenova.com'
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-offers-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.fonenova.com', CRON_SECRET: 'cron-secret-0123456789' })
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

const line = (p: Partial<OfferLine>): OfferLine => ({ id: 'aaaaaa', model: 'iPhone 16 Pro', storage: '128GB', grade: null, qty: 10, unitCostCents: 541_00, sourceText: '', note: null, ...p })

describe('cleaning Mobile One emails', () => {
  it('turns the HTML-only offer into its three lines, without the signature or images', async () => {
    const { htmlToText } = await import('@/lib/gmail')
    const { cleanOfferText } = await import('@/lib/offers/clean')
    const t = cleanOfferText(htmlToText(SAMPLES.nov12Html))
    expect(t).toContain('iPhone 14 128GB AP Grade A+ price 248.87  (200) pieces')
    expect(t).toContain('Samsung S25 Ultra 256GB Grade A+ price 617.67 (50) pieces')
    expect(t).not.toMatch(/Sincerely|Mobile One Trade B\.V\.|example\.invalid/)
  })

  it('drops quoted earlier messages, so a reply is judged on its own words', async () => {
    const { cleanOfferText, mayBeOffer } = await import('@/lib/offers/clean')
    const inv = cleanOfferText(SAMPLES.invoiceReply)
    expect(inv).not.toContain('641')
    expect(cleanOfferText(SAMPLES.shortReply)).toBe('Yes , 17 pro')
    expect(mayBeOffer(cleanOfferText(SAMPLES.shortReply))).toBe(true) // 17: the reader decides it is not an offer
    expect(mayBeOffer('Thanks, noted.')).toBe(false)
    expect(cleanOfferText(SAMPLES.oct14a)).toContain('Apple iPhone 13 Mini, 128GB – 50 units') // *bold* markers removed
  })

  it('reads a Gmail API message: headers, the text part, attachments', async () => {
    const { parseGmailMessage } = await import('@/lib/gmail')
    const b = (s: string) => Buffer.from(s).toString('base64url')
    const m = parseGmailMessage({
      id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-11-12T10:29:42Z')), labelIds: ['INBOX'],
      payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Mobile One Trade <bv@mobileone.info>' }, { name: 'Subject', value: 'Offer' }, { name: 'Message-ID', value: '<abc@mobileone.info>' }, { name: 'To', value: 'info@fonenova.com' }],
        parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b('iPhone 14 price 248.87 (200) pieces') } }, { mimeType: 'text/html', body: { data: b('<b>x</b>') } }] }, { mimeType: 'application/pdf', filename: '2026090090.pdf', body: { attachmentId: 'a' } }] },
    })
    expect(m).toMatchObject({ id: 'm1', threadId: 't1', rfcMessageId: '<abc@mobileone.info>', subject: 'Offer', receivedAt: '2026-11-12T10:29:42.000Z', text: 'iPhone 14 price 248.87 (200) pieces', attachments: ['2026090090.pdf'] })
  })
})

describe('checks on offer lines', () => {
  it('flags "iPhone 7 Pro" and accepts every model in the real samples', async () => {
    const { knownModel, lineFlags } = await import('@/lib/offers/check')
    expect(lineFlags(line({ model: 'iPhone 7 Pro', storage: '256GB', qty: 300, unitCostCents: 854_00 })).map((f) => f.code)).toContain('model')
    for (const m of ['iPhone 14', 'iPhone 15', 'Samsung S25 Ultra', 'Apple iPhone 13 Mini', 'Samsung Galaxy S24', 'Samsung Galaxy S25 5G', 'iphone 15 pro', 'iPhone 16 Pro', 'iPhone 17 (e-Sim)', 'IPHONE 17 AIR', 'iPhone 17 Pro Max', 'iPhone 16e']) expect(knownModel(m), m).toBe(true)
  })

  it('flags bad quantities, prices outside €20 to €2,500, duplicates, and lines that do not match the email', async () => {
    const { lineFlags, offerFlags } = await import('@/lib/offers/check')
    expect(lineFlags(line({ qty: 0 })).map((f) => f.code)).toContain('qty')
    expect(lineFlags(line({ unitCostCents: 5_00 })).map((f) => f.code)).toContain('cost')
    expect(lineFlags(line({ unitCostCents: 3_000_00 })).map((f) => f.code)).toContain('cost')
    expect(lineFlags(line({ storage: null })).map((f) => f.code)).toContain('storage')
    const a = line({ id: 'a1a1a1' }), b = line({ id: 'b2b2b2' })
    expect(offerFlags([a, b]).get('a1a1a1')!.map((f) => f.code)).toContain('duplicate')
    expect(lineFlags(line({ qty: 165, unitCostCents: 558_50, sourceText: 'iPhone 16 Pro 128GB (e-Sim) - 165 Nos.- €558.50' }))).toEqual([])
    expect(lineFlags(line({ qty: 156, unitCostCents: 558_50, sourceText: 'iPhone 16 Pro 128GB (e-Sim) - 165 Nos.- €558.50' })).map((f) => f.code)).toContain('source')
  })
})

describe('the AI reader', () => {
  it('maps the strict tool answer to lines in cents, keeping typos and notes', async () => {
    const { readOffer } = await import('@/lib/offers/parse')
    const create = vi.fn(async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_offer', id: 't', input: { is_offer: true, reason: 'Prices for phones', lines: [{ model: 'iPhone 7 Pro', storage: '256GB', grade: null, quantity: 300, unit_cost_eur: 854, source_text: 'I have 300 units of the iPhone 7 Pro, 256GB, available at €854 each.', note: 'May mean iPhone 17 Pro' }] } }] }))
    const r = await readOffer(SAMPLES.oct21, '', { messages: { create } } as never)
    expect(r.isOffer).toBe(true)
    expect(r.lines[0]).toMatchObject({ model: 'iPhone 7 Pro', storage: '256GB', qty: 300, unitCostCents: 854_00, note: 'May mean iPhone 17 Pro' })
    const call = (create.mock.calls[0] as unknown as [{ tool_choice: unknown; tools: { strict: boolean }[] }])[0]
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'record_offer' })
    expect(call.tools[0].strict).toBe(true)
  })
})

describe('picking up offers from Gmail', () => {
  const msg = (id: string, text: string, p: Partial<MailMessage> = {}): MailMessage => ({ id, threadId: `t-${id}`, rfcMessageId: `<${id}@m>`, from: 'Mobile One Trade <bv@mobileone.info>', to: 'info@fonenova.com', subject: 'Offer', receivedAt: '2026-11-12T10:29:42.000Z', labels: ['INBOX'], text, attachments: [], ...p })
  const mails: Record<string, MailMessage> = {
    o1: msg('o1', SAMPLES.sep30),
    o2: msg('o2', SAMPLES.oct21, { subject: '' }),
    inv: msg('inv', SAMPLES.invoiceReply, { attachments: ['2026090091.pdf'] }),
    ours: msg('ours', 'Hello, I accept the offer 2026', { from: 'FoneNova <info@fonenova.com>', labels: ['SENT'] }),
    other: msg('other', 'Offer 123', { from: 'someone@else.com' }),
  }
  // A stand-in for the AI: offers are the emails with euro prices left after cleaning.
  const read = vi.fn(async (text: string) => {
    const lines = [...text.matchAll(/(IPHONE[^\n–-]+|iPhone 7 Pro)[^\n]*?(\d+)\s*(?:Nos|units)[^\n]*?€(\d+(?:\.\d+)?)/gi)].map((m, i) => ({ id: `l${i}aaaa`, model: m[1].trim(), storage: '256GB', grade: null, qty: Number(m[2]), unitCostCents: Math.round(Number(m[3]) * 100), sourceText: m[0], note: null }))
    const seven = /iPhone 7 Pro/.test(text) ? [{ id: 'l7aaaa', model: 'iPhone 7 Pro', storage: '256GB', grade: null, qty: 300, unitCostCents: 854_00, sourceText: 'I have 300 units of the iPhone 7 Pro, 256GB, available at €854 each.', note: null }] : []
    const all = seven.length ? seven : lines
    return { isOffer: all.length > 0, reason: '', lines: all }
  })

  it('stores each offer once as NEEDS REVIEW, skips our replies, others and non-offers, and pings Telegram', async () => {
    const { getStore, getJson } = await import('@/lib/store')
    const { ingestOffers } = await import('@/lib/offers/ingest')
    const store = getStore()
    const notify = vi.fn(async () => true)
    const deps = { store, list: async () => ['other', 'ours', 'inv', 'o2', 'o1'], get: async (id: string) => mails[id], read, notify, dashboardUrl: 'https://dashboard.fonenova.com', now: new Date('2026-11-13T10:00:00Z') }
    const r = await ingestOffers(deps)
    expect(r.added.map((o) => o.source.gmailMessageId)).toEqual(['o1', 'o2'])
    expect(read).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('accept'))
    const offers = (await getJson<{ id: string; status: string; lines: unknown[] }[]>(store, 'offers'))!
    expect(offers.map((o) => [o.id, o.status, o.lines.length])).toEqual([['of_o2', 'needs_review', 1], ['of_o1', 'needs_review', 2]])
    expect(notify).toHaveBeenCalledTimes(2)
    const sevenPing = (notify.mock.calls as unknown as [string, { url: string }][]).find((c) => c[0].includes('7 Pro'))!
    expect(sevenPing[0]).toContain('1 line need a check')
    expect(sevenPing[1].url).toBe('https://dashboard.fonenova.com/offers?id=of_o2')
    // A second run finds nothing new.
    const again = await ingestOffers(deps)
    expect([again.checked, again.added.length]).toEqual([0, 0])
    expect(await getJson(store, 'offers:status')).toMatchObject({ ok: true, checked: 0, added: 0 })
  })

  it('leaves an email it could not read for the next run, and records the error', async () => {
    const { getStore, getJson } = await import('@/lib/store')
    const { ingestOffers } = await import('@/lib/offers/ingest')
    const store = getStore()
    const failing = { store, list: async () => ['o1'], get: async (id: string) => mails[id], read: async () => { throw new Error('AI is down') }, notify: async () => true }
    const r = await ingestOffers(failing)
    expect(r.errors).toEqual(['AI is down'])
    expect(await getJson(store, 'offers:status')).toMatchObject({ ok: false, error: 'AI is down' })
    expect((await ingestOffers({ ...failing, read })).added).toHaveLength(1)
  })
})

describe('routes', () => {
  it('the 5-minute check refuses a call without the CRON_SECRET', async () => {
    const { GET, POST } = await import('@/app/api/cron/offers/route')
    expect((await GET(new Request('https://dashboard.fonenova.com/api/cron/offers'))).status).toBe(401)
    expect((await POST(new Request('https://dashboard.fonenova.com/api/cron/offers', { method: 'POST', headers: { authorization: 'Bearer wrong' } }))).status).toBe(401)
  })

  it('saving a review needs the signed-in owner, the dashboard origin and valid lines', async () => {
    const { getStore, getJson } = await import('@/lib/store')
    const store = getStore()
    await store.set('offers', [{ id: 'of_o1', status: 'needs_review', source: { gmailMessageId: 'o1', threadId: 't', rfcMessageId: null, from: '', to: '', subject: 'Offer', receivedAt: '2026-11-12T10:00:00Z' }, text: '', lines: [line({ id: 'a1a1a1' })], createdAt: '', updatedAt: '', audit: [] }])
    const { PUT } = await import('@/app/api/offers/route')
    const put = (body: unknown, origin = 'https://dashboard.fonenova.com') => PUT(new Request('https://dashboard.fonenova.com/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }))
    expect((await put({ action: 'status', id: 'of_o1', status: 'ready' }, 'https://evil.example')).status).toBe(403)
    user.value = false
    expect((await put({ action: 'status', id: 'of_o1', status: 'ready' })).status).toBe(401)
    user.value = 'info@fonenova.com'
    expect((await put({ action: 'save', id: 'of_o1', lines: [{ model: 'iPhone 17 Pro', storage: '256GB', grade: null, qty: 1.5, unitCostCents: 854_00 }] })).status).toBe(400)
    expect((await put({ action: 'save', id: 'of_x', lines: [] })).status).toBe(404)
    expect((await put({ action: 'save', id: 'of_o1', lines: [{ id: 'a1a1a1', model: 'iPhone 17 Pro', storage: '256GB', grade: null, qty: 300, unitCostCents: 854_00 }] })).status).toBe(200)
    expect((await put({ action: 'status', id: 'of_o1', status: 'ready' })).status).toBe(200)
    const saved = (await getJson<{ status: string; lines: OfferLine[]; audit: { what: string }[] }[]>(store, 'offers'))![0]
    expect([saved.status, saved.lines[0].model, saved.audit.map((a) => a.what)]).toEqual(['ready', 'iPhone 17 Pro', ['Lines edited (1)', 'Marked reviewed']])
  })
})

describe('review screen', () => {
  it('shows each line with its flags and the email line it came from', async () => {
    const { OfferDetail } = await import('@/components/offers/offers-view')
    const html = renderToString(h(OfferDetail, { offer: { id: 'of_o2', status: 'needs_review', source: { gmailMessageId: 'o2', threadId: 't', rfcMessageId: null, from: 'Mobile One Trade <bv@mobileone.info>', to: 'fonenovaltd@gmail.com', subject: '', receivedAt: '2026-10-21T09:11:41Z' }, text: SAMPLES.oct21, lines: [line({ id: 'l7aaaa', model: 'iPhone 7 Pro', storage: '256GB', qty: 300, unitCostCents: 854_00, sourceText: 'I have 300 units of the iPhone 7 Pro, 256GB, available at €854 each.' })], createdAt: '', updatedAt: '', audit: [] } })).replace(/<!-- -->/g, '')
    expect(html).toContain('is not a model Mobile One usually sells')
    expect(html).toContain('Email: “I have 300 units of the iPhone 7 Pro')
    expect(html).toContain('€256,200.00')
    expect(html).toContain('Mark reviewed')
  })
})

describe('watchdog', () => {
  it('is red when offers have not been checked for 30 minutes, or the last check failed', async () => {
    const { healthChecks } = await import('@/lib/health')
    const base = { now: new Date('2026-11-13T10:00:00Z'), today: '2026-11-13', sources: [], xero: { configured: false, connected: false, snapshot: null }, oneDrive: { configured: false, connected: false }, make: null, makeConfigured: true, gmail: { configured: false, connected: false }, watchdogConfigured: true, ignoredInvoiceNumbers: [] }
    const of = (offers: unknown) => healthChecks({ ...base, offers } as never).find((c) => c.id === 'offers')
    expect(of({ lastRunAt: '2026-11-13T09:57:00Z', ok: true, checked: 1, added: 0, error: null })?.level).toBe('ok')
    expect(of({ lastRunAt: '2026-11-13T09:00:00Z', ok: true, checked: 0, added: 0, error: null })?.level).toBe('red')
    expect(of({ lastRunAt: '2026-11-13T09:58:00Z', ok: false, checked: 0, added: 0, error: 'Gmail is connected send-only' })).toMatchObject({ level: 'red', detail: 'Gmail is connected send-only' })
    expect(of(null)).toBeUndefined()
  })
})
