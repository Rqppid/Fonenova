import fs from 'node:fs'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const afterCalls = vi.hoisted(() => [] as (() => unknown)[])
vi.mock('next/server', () => ({ after: (fn: () => unknown) => void afterCalls.push(fn) }))
const reqHeaders = vi.hoisted(() => ({ value: new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' }) }))
vi.mock('next/headers', () => ({ headers: async () => reqHeaders.value }))

const STORE = 'https://offers-store.example.test'
const env = { ...process.env }
const data = new Map<string, string>()
const webhooks: { url: string; auth: string | null; body: unknown }[] = []

/** A stand-in for the Upstash REST API with the few commands the offer page uses. */
function fakeFetch() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input.startsWith(STORE)) {
      const cmd = JSON.parse(String(init.body)) as (string | number)[]
      const [op, key, ...rest] = cmd as [string, string, ...(string | number)[]]
      if (op === 'GET') return Response.json({ result: data.get(key) ?? null })
      if (op === 'SET') {
        if (rest.includes('NX') && data.has(key)) return Response.json({ result: null })
        data.set(key, String(rest[0]))
        return Response.json({ result: 'OK' })
      }
      if (op === 'INCR') {
        const n = Number(data.get(key) ?? 0) + 1
        data.set(key, String(n))
        return Response.json({ result: n })
      }
      if (op === 'EXPIRE') return Response.json({ result: 1 })
      return Response.json({ error: 'unknown command' })
    }
    webhooks.push({ url: input, auth: new Headers(init.headers).get('authorization'), body: JSON.parse(String(init.body)) })
    return Response.json({ ok: true })
  })
}

const TOKEN = 'A'.repeat(43)
const OTHER = 'B'.repeat(43)
const future = () => new Date(Date.now() + 3_600_000).toISOString()
const past = () => new Date(Date.now() - 3_600_000).toISOString()
const offer = (p: Record<string, unknown> = {}) => ({
  clientName: 'Wave Phone B.V.',
  lines: [{ description: 'iPhone 14 128GB AP Grade A+', qty: 200, unitSaleCents: 255_87 }, { description: 'Samsung S25 Ultra 256GB Grade A+', qty: 50, unitSaleCents: 625_67 }],
  units: 250, totalCents: 82_457_50, issuedAt: new Date().toISOString(), expiresAt: future(), test: false, status: 'open', ...p,
})

beforeEach(async () => {
  vi.resetModules()
  data.clear()
  webhooks.length = 0
  afterCalls.length = 0
  reqHeaders.value = new Headers({ 'x-vercel-forwarded-for': '203.0.113.7' })
  Object.assign(process.env, { OFFERS_PUBLIC_REDIS_URL: STORE, OFFERS_PUBLIC_REDIS_TOKEN: 'store-token-0123456789abcdefghij', OFFERS_WEBHOOK_TOKEN: 'webhook-token-0123456789abcdef', OFFERS_WEBHOOK_URL: 'https://dashboard.example.test/api/offers/answered' })
  vi.stubGlobal('fetch', fakeFetch())
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

const put = async (token: string, o: object) => {
  const { hashToken } = await import('@/lib/offers-public')
  data.set(`pub:offer:${hashToken(token)}`, JSON.stringify(o))
}
const post = async (body: unknown, ip = '203.0.113.7') => {
  const { POST } = await import('@/app/api/offer/answer/route')
  return POST(new Request('https://fonenova.com/api/offer/answer', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip, 'user-agent': 'TestBrowser/1.0' }, body: JSON.stringify(body) }))
}
const accept = (p: Record<string, unknown> = {}) => ({ token: TOKEN, decision: 'accept', confirmed: true, remarks: '', ...p })

describe('links and states', () => {
  it('addresses an offer by the SHA-256 of the token, and only accepts 43-character tokens', async () => {
    const { hashToken, validToken } = await import('@/lib/offers-public')
    expect(hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(TOKEN)).not.toContain(TOKEN)
    expect(hashToken(TOKEN)).not.toBe(hashToken(OTHER))
    expect(validToken(TOKEN)).toBe(true)
    for (const bad of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, `${'A'.repeat(42)} `, null, 5]) expect(validToken(bad), String(bad)).toBe(false)
  })

  it('works out open, answered, expired and withdrawn', async () => {
    const { offerState } = await import('@/lib/offers-public')
    const now = new Date('2026-11-14T10:00:00Z')
    const o = offer({ expiresAt: '2026-11-14T10:45:00Z' }) as never
    const a = { decision: 'accept', remarks: '', at: '', ip: '', ua: '' } as never
    expect(offerState(o, null, now)).toBe('open')
    expect(offerState(o, null, new Date('2026-11-14T10:45:00Z'))).toBe('expired') // the expiry moment itself is expired
    expect(offerState(o, a, now)).toBe('answered')
    expect(offerState(offer({ status: 'withdrawn' }) as never, null, now)).toBe('withdrawn')
    expect(offerState(offer({ status: 'withdrawn' }) as never, a, now)).toBe('answered') // an answer given first stands
  })

  it('writes UK time with the right offset in winter and summer', async () => {
    const { ukTime } = await import('@/lib/offers-format')
    expect(ukTime('2026-11-14T10:45:00Z')).toMatch(/Sat,? 14 Nov 2026, 10:45 UK time/)
    expect(ukTime('2026-07-01T10:00:00Z')).toMatch(/Wed,? 1 Jul 2026, 11:00 UK time/)
  })

  it('keeps remarks as plain text of at most 500 characters', async () => {
    const { cleanRemarks } = await import('@/lib/offers-public')
    expect(cleanRemarks(undefined)).toBe('')
    expect(cleanRemarks('  price too high on S25  ')).toBe('price too high on S25')
    expect(cleanRemarks('a\u0000b\u0007c')).toBe('abc')
    expect(cleanRemarks('x'.repeat(500))).toHaveLength(500)
    expect(cleanRemarks('x'.repeat(501))).toBeNull()
    expect(cleanRemarks(5)).toBeNull()
  })
})

describe('answering an offer', () => {
  it('saves an accept once, with time, IP and browser, and tells the dashboard only the hash', async () => {
    await put(TOKEN, offer())
    const { hashToken } = await import('@/lib/offers-public')
    const r = await post(accept({ remarks: 'Please ship Monday' }))
    expect([r.status, (await r.json()).ok]).toEqual([200, true])
    expect(r.headers.get('cache-control')).toBe('no-store')
    const saved = JSON.parse(data.get(`pub:answer:${hashToken(TOKEN)}`)!)
    expect(saved).toMatchObject({ decision: 'accept', remarks: 'Please ship Monday', ip: '203.0.113.7', ua: 'TestBrowser/1.0' })
    expect(Date.parse(saved.at)).toBeGreaterThan(Date.now() - 5_000)
    expect(afterCalls).toHaveLength(1)
    await afterCalls[0]()
    expect(webhooks).toHaveLength(1)
    expect(webhooks[0]).toMatchObject({ url: 'https://dashboard.example.test/api/offers/answered', auth: 'Bearer webhook-token-0123456789abcdef', body: { hash: hashToken(TOKEN) } })
    expect(Object.keys(webhooks[0].body as object)).toEqual(['hash']) // never the token or the answer
  })

  it('needs the confirm step to accept, but not to decline', async () => {
    await put(TOKEN, offer())
    expect((await post(accept({ confirmed: false }))).status).toBe(400)
    expect((await post(accept({ confirmed: undefined }))).status).toBe(400)
    const d = await post({ token: TOKEN, decision: 'decline', remarks: 'price too high on S25' })
    expect(d.status).toBe(200)
  })

  it('is single use: of two answers at the same moment exactly one is saved', async () => {
    await put(TOKEN, offer())
    const both = await Promise.all([post(accept()), post({ token: TOKEN, decision: 'decline' }), post(accept())])
    expect(both.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const later = await post({ token: TOKEN, decision: 'decline' })
    expect([later.status, (await later.json()).error]).toEqual([409, 'answered'])
    expect(afterCalls).toHaveLength(1) // the dashboard is told once
  })

  it('refuses an expired or withdrawn offer, and a bad remarks length, without saving anything', async () => {
    await put(TOKEN, offer({ expiresAt: past() }))
    const e = await post(accept())
    expect([e.status, (await e.json()).error]).toEqual([409, 'expired'])
    await put(OTHER, offer({ status: 'withdrawn' }))
    const w = await post(accept({ token: OTHER }))
    expect([w.status, (await w.json()).error]).toEqual([409, 'withdrawn'])
    await put('C'.repeat(43), offer())
    expect((await post(accept({ token: 'C'.repeat(43), remarks: 'x'.repeat(501) }))).status).toBe(400)
    expect([...data.keys()].filter((k) => k.startsWith('pub:answer:'))).toEqual([])
    expect(afterCalls).toHaveLength(0)
  })

  it('treats a malformed and an unknown token exactly the same', async () => {
    const bad = await post(accept({ token: 'not-a-token' }))
    const unknown = await post(accept({ token: 'D'.repeat(43) }))
    expect([bad.status, await bad.json()]).toEqual([unknown.status, await unknown.json()])
    expect(bad.status).toBe(404)
  })

  it('limits attempts per visitor and per link', async () => {
    await put(TOKEN, offer({ status: 'withdrawn' }))
    const statuses: number[] = []
    for (let i = 0; i < 14; i++) statuses.push((await post(accept(), '198.51.100.9')).status)
    expect(statuses.slice(0, 12).every((s) => s === 409)).toBe(true)
    expect(statuses.slice(12)).toEqual([429, 429])
    expect((await post(accept(), '198.51.100.10')).status).toBe(409) // another visitor is not affected
  })

  it('says it is unavailable, not a success, when the store is not set up or fails', async () => {
    delete process.env.OFFERS_PUBLIC_REDIS_URL
    expect((await post(accept())).status).toBe(503)
    process.env.OFFERS_PUBLIC_REDIS_URL = STORE
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
    expect((await post(accept())).status).toBe(503)
  })
})

describe('the offer page', () => {
  const page = async (token: string) => {
    const { default: OfferPage } = await import('@/app/offer/[token]/page')
    return renderToString(await OfferPage({ params: Promise.resolve({ token }) })).replace(/<!-- -->/g, '')
  }

  it('shows the open offer with sale prices, the total and the expiry, and both buttons', async () => {
    await put(TOKEN, offer())
    const html = await page(TOKEN)
    for (const t of ['Offer for Wave Phone B.V.', 'iPhone 14 128GB AP Grade A+', '€255.87', '€51,174.00', '€625.67', '€824,575.00'.replace('824,575.00', '82,457.50'), 'Accept offer', 'Decline', 'Subject to availability', 'UK time']) expect(html, t).toContain(t)
  })

  it('never contains cost, margin or profit, and never a payment-terms promise', async () => {
    await put(TOKEN, offer())
    const html = (await page(TOKEN)).toLowerCase()
    for (const w of ['cost', 'margin', 'profit', 'payment terms', 'dashboard']) expect(html, w).not.toContain(w)
  })

  it('shows the same plain page for a malformed and an unknown link', async () => {
    const a = await page('nope')
    const b = await page('E'.repeat(43))
    expect(a).toBe(b)
    expect(a).toContain('This link is not valid')
    expect(a).not.toContain('Wave Phone')
  })

  it('is read-only once answered, expired or withdrawn', async () => {
    const { hashToken } = await import('@/lib/offers-public')
    await put(TOKEN, offer())
    data.set(`pub:answer:${hashToken(TOKEN)}`, JSON.stringify({ decision: 'accept', remarks: 'Ship <b>Monday</b>', at: '2026-11-14T09:30:00Z', ip: '203.0.113.7', ua: 'TestBrowser/1.0' }))
    const answered = await page(TOKEN)
    expect(answered).toContain('You accepted this offer')
    expect(answered).toContain('Ship &lt;b&gt;Monday&lt;/b&gt;') // remarks are escaped, never markup
    expect(answered).not.toContain('Accept offer')
    expect(answered).not.toContain('203.0.113.7') // the visitor's own details are never shown back
    await put(OTHER, offer({ expiresAt: past() }))
    const expired = await page(OTHER)
    expect(expired).toContain('This offer expired')
    expect(expired).not.toContain('Accept offer')
    await put('F'.repeat(43), offer({ status: 'withdrawn' }))
    const withdrawn = await page('F'.repeat(43))
    expect(withdrawn).toContain('no longer available')
    expect(withdrawn).not.toContain('Accept offer')
  })

  it('limits page views per visitor and says so plainly', async () => {
    await put(TOKEN, offer())
    let last = ''
    for (let i = 0; i < 62; i++) last = await page(TOKEN)
    expect(last).toContain('Too many requests')
  })

  it('says it is not available, rather than showing an error, when the store is down', async () => {
    delete process.env.OFFERS_PUBLIC_REDIS_URL
    expect(await page(TOKEN)).toContain('Not available right now')
  })
})

describe('keeping offers private', () => {
  it('is not indexed, not cached, and its link is not passed on', async () => {
    const config = (await import('../next.config.mjs')).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    const rules = await config.headers()
    const offerRule = rules.find((r) => r.source === '/offer/:path*')!
    const apiRule = rules.find((r) => r.source === '/api/offer/:path*')!
    for (const r of [offerRule, apiRule]) {
      const get = (k: string) => r.headers.find((x) => x.key === k)?.value
      expect(get('X-Robots-Tag')).toContain('noindex')
      expect(get('Cache-Control')).toContain('no-store')
      expect(get('Referrer-Policy')).toBe('no-referrer')
    }
    expect(rules.indexOf(offerRule)).toBeGreaterThan(rules.findIndex((r) => r.source === '/:path*')) // listed after the global rule so it wins
    const { metadata } = await import('@/app/offer/[token]/page')
    expect(metadata.robots).toMatchObject({ index: false, follow: false })
  })

  it('is disallowed in robots.txt and absent from the sitemap', async () => {
    const robots = (await import('@/app/robots')).default()
    expect(JSON.stringify(robots)).toContain('/offer/')
    expect((robots.rules as { disallow: string[] }).disallow).toEqual(expect.arrayContaining(['/offer/', '/api/offer/']))
    const sitemap = (await import('@/app/sitemap')).default()
    expect(sitemap.some((s) => s.url.includes('/offer'))).toBe(false)
  })

  it('keeps the link out of analytics', async () => {
    const { redactOfferUrl } = await import('@/components/site-analytics')
    const ev = (url: string) => ({ type: 'pageview' as const, url })
    expect(redactOfferUrl(ev(`https://fonenova.com/offer/${TOKEN}?utm=x#top`)).url).toBe('https://fonenova.com/offer/[redacted]')
    expect(redactOfferUrl(ev(`https://fonenova.com/offer/${TOKEN}`)).url).not.toContain(TOKEN)
    expect(redactOfferUrl(ev('https://fonenova.com/privacy?x=1')).url).toBe('https://fonenova.com/privacy?x=1')
    expect(redactOfferUrl(ev('not a url')).url).toBe('not a url')
  })

  it('is explained on the privacy page: what is recorded and for how long', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'app/privacy/page.tsx'), 'utf8')
    for (const t of ['Offer links.', 'IP', 'deleted after 90 days', 'does not record the address of offer pages']) expect(src, t).toContain(t)
    expect(src).toContain('14 November 2026')
  })

  it('reads and writes only the public store: the module has no path to the dashboard store or its key', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/offers-public.ts'), 'utf8')
    for (const w of ['FN_STORE_KEY', 'KV_REST_API', 'UPSTASH_REDIS_REST', 'XERO', 'GOOGLE_CLIENT', 'MS_CLIENT']) expect(src, w).not.toContain(w)
  })
})
