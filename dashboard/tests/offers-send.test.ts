import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seedClients, type Client } from '@/lib/offers/clients'
import type { Offer, OfferLine, OfferSend } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const PUB = 'https://public-store.example.test'
const GMAIL = 'https://gmail.example.test/gmail/v1'
const WEBHOOK = 'webhook-token-0123456789abcdefghij'
const env = { ...process.env }
let dir: string
const pub = new Map<string, string>()
const mails: string[] = []
const pings: { text: string; markup: unknown }[] = []
const fail = { gmail: false, publicPut: false }

function fakeFetch() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input.startsWith(PUB)) {
      const cmd = JSON.parse(String(init.body)) as (string | number)[]
      const [op, key, ...rest] = cmd as [string, string, ...(string | number)[]]
      if (op === 'GET') return Response.json({ result: pub.get(key) ?? null })
      if (op === 'DEL') return Response.json({ result: pub.delete(key) ? 1 : 0 })
      if (op === 'SET') {
        if (fail.publicPut) return new Response('boom', { status: 500 })
        if (rest.includes('NX') && pub.has(key)) return Response.json({ result: null })
        if (rest.includes('XX') && !pub.has(key)) return Response.json({ result: null })
        pub.set(key, String(rest[0]))
        return Response.json({ result: 'OK' })
      }
      return Response.json({ error: 'unknown' })
    }
    if (input.startsWith(GMAIL)) {
      if (fail.gmail) return new Response('nope', { status: 500 })
      mails.push((JSON.parse(String(init.body)) as { raw: string }).raw)
      return Response.json({ id: `gm${mails.length}` })
    }
    if (input.startsWith('https://telegram.example.test')) {
      const b = JSON.parse(String(init.body)) as { text: string; reply_markup?: unknown }
      pings.push({ text: b.text, markup: b.reply_markup })
      return Response.json({ ok: true })
    }
    return new Response('unexpected', { status: 500 })
  })
}

const L = (id: string, model: string, storage: string, grade: string, qty: number, cost: number): OfferLine => ({ id, model, storage, grade, qty, unitCostCents: Math.round(cost * 100), sourceText: '', note: null })
const nov12 = [L('a1a1a1', 'iPhone 14', '128GB', 'AP Grade A+', 200, 248.87), L('b2b2b2', 'iPhone 15', '128GB', 'A GradeA+', 100, 362.63), L('c3c3c3', 'Samsung S25 Ultra', '256GB', 'Grade A+', 50, 617.67)]
const COST_FIGURES = ['24887', '36263', '61767', '248.87', '362.63', '617.67']

const clients = (): Client[] => seedClients().map((c) => (c.id === 'c_test' ? { ...c, offerEmails: ['buyer@example.test'] } : c.id === 'c_wave' ? { ...c, offerEmails: ['wave@example.test'] } : c))
const offer = (p: Partial<Offer> = {}): Offer => ({
  id: 'of_n12', status: 'ready', source: { gmailMessageId: 'n12', threadId: 't', rfcMessageId: null, from: 'Mobile One <supplier@example.test>', to: 'owner@example.test', subject: 'Offer', receivedAt: '2026-11-12T10:29:42Z' },
  text: '', lines: nov12, pricing: { clientId: 'c_test', marginCents: 700, overrides: { c3c3c3: 800 }, ackLow: false, pricedAt: '2026-11-13T12:00:00Z' }, createdAt: '', updatedAt: '', audit: [], ...p,
})

beforeEach(async () => {
  vi.resetModules()
  user.value = 'owner@example.test'
  pub.clear(); mails.length = 0; pings.length = 0; fail.gmail = false; fail.publicPut = false
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-send-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, {
    FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', FN_GMAIL_API_URL: GMAIL,
    OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: 'pub-token', OFFERS_WEBHOOK_TOKEN: WEBHOOK,
    TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '1', FN_TELEGRAM_API_URL: 'https://telegram.example.test',
  })
  delete process.env.OFFERS_ALLOW_REAL_SEND
  vi.stubGlobal('fetch', fakeFetch())
  const { getStore } = await import('@/lib/store')
  const store = getStore()
  await store.set('offers:clients', clients())
  await store.set('gmail:tokens', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'sender@example.test', scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' })
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

const store = async () => (await import('@/lib/store')).getStore()
const seed = async (o: Offer = offer()) => (await store()).set('offers', [o])
const stored = async () => (await (await import('@/lib/store')).getJson<Offer[]>(await store(), 'offers'))![0]
const send = async (o: Offer = offer(), p: { allowReal?: boolean; now?: Date; token?: () => string } = {}) => {
  await seed(o)
  const { sendOffer } = await import('@/lib/offers/send')
  const { sendGmail, gmailConfig } = await import('@/lib/gmail')
  const s = await store()
  return sendOffer(o.id, { store: s, allowReal: p.allowReal ?? false, now: p.now, token: p.token, mail: (m) => sendGmail(gmailConfig()!, { ...m, fromName: 'FoneNova' }, s) })
}
/** Both parts of the one email that was sent, decoded. */
const decode = (raw: string) => {
  const mime = Buffer.from(raw, 'base64url').toString('utf8')
  const parts = [...mime.matchAll(/Content-Type: (text\/\w+); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8'))
  return { headers: mime.split('\r\n\r\n')[0], text: parts[0] ?? '', html: parts[1] ?? '' }
}
const answerFor = (hash: string, decision: 'accept' | 'decline', remarks = '') => pub.set(`pub:answer:${hash}`, JSON.stringify({ decision, remarks, at: '2026-11-14T09:30:00.000Z', ip: '203.0.113.7', ua: 'TestBrowser/1.0' }))

describe('the email', () => {
  it('shows the sale prices, total, deadline and link, states no payment terms, and holds no cost', async () => {
    const { buildOfferEmail } = await import('@/lib/offers/email')
    const e = buildOfferEmail({ clientName: 'Wave <Phone> & Co', lines: [{ description: 'iPhone 14 128GB', qty: 200, unitSaleCents: 255_87 }], units: 200, totalCents: 51_174_00, expiresAt: '2026-11-15T10:45:00Z', test: true }, 'https://fonenova.com/offer/TOKEN')
    expect(e.subject).toBe('[TEST] Offer from FoneNova: 200 units, valid until Sun, 15 Nov 2026, 10:45 UK time')
    for (const t of ['€255.87', '€51,174.00', 'https://fonenova.com/offer/TOKEN', 'Subject to availability']) { expect(e.text, t).toContain(t); expect(e.html, t).toContain(t) }
    expect(e.html).toContain('Wave &lt;Phone&gt; &amp; Co') // names are escaped, never markup
    expect(e.html).toContain('Accept or decline')
    // The HTML's visible words (styling removed, since CSS has a "margin" property of its own).
    const visible = e.html.replace(/ style="[^"]*"/g, '').replace(/<[^>]+>/g, ' ').toLowerCase()
    for (const w of ['payment terms', 'cost', 'margin', 'profit', 'net 30', 'days']) { expect(e.text.toLowerCase(), w).not.toContain(w); expect(visible, w).not.toContain(w) }
  })
})

describe('sending an offer', () => {
  it('writes the client snapshot first, emails the link, and keeps only the hash', async () => {
    const { hashToken } = await import('@/lib/offers/public-store')
    const TOKEN = 'T'.repeat(43)
    const r = await send(offer(), { token: () => TOKEN, now: new Date('2026-11-14T10:45:00Z') })
    expect(r.ok).toBe(true)
    const hash = hashToken(TOKEN)
    const snapshot = JSON.parse(pub.get(`pub:offer:${hash}`)!)
    expect(snapshot).toMatchObject({ clientName: 'Test client (my own inbox)', units: 350, totalCents: 119_420_50, test: true, status: 'open', expiresAt: '2026-11-15T10:45:00.000Z' })
    expect(snapshot.lines.map((l: { unitSaleCents: number }) => l.unitSaleCents)).toEqual([255_87, 369_63, 625_67])
    expect(Object.keys(snapshot.lines[0]).sort()).toEqual(['description', 'qty', 'unitSaleCents'])
    for (const c of [...COST_FIGURES, 'margin', 'profit', 'cost']) expect(JSON.stringify(snapshot).toLowerCase(), c).not.toContain(c)

    expect(mails).toHaveLength(1)
    const m = decode(mails[0])
    expect(m.headers).toContain('To: buyer@example.test')
    expect(m.headers).toContain('<sender@example.test>')
    expect(Buffer.from(m.headers.match(/From: =\?UTF-8\?B\?(\S+)\?=/)![1], 'base64').toString()).toBe('FoneNova')
    expect(m.text).toContain(`https://fonenova.com/offer/${TOKEN}`)
    for (const c of COST_FIGURES) { expect(m.text, c).not.toContain(c); expect(m.html, c).not.toContain(c) }

    const o = await stored()
    expect(o.status).toBe('sent')
    expect(o.sends).toHaveLength(1)
    expect(o.sends![0]).toMatchObject({ clientId: 'c_test', to: ['buyer@example.test'], tokenHash: hash, tokenHint: 'TTTTTT', test: true, outcome: 'pending', gmailMessageId: 'gm1', totalCents: 119_420_50, units: 350 })
    expect(JSON.stringify(o)).not.toContain(TOKEN) // the full link is never kept
    expect(o.audit.at(-1)!.what).toContain('Sent to Test client (my own inbox) (buyer@example.test): 350 units, €119,420.50 [test]')
  })

  it('refuses unless the offer is reviewed, priced, for a client with an address, and not already sent', async () => {
    expect(await send(offer({ status: 'needs_review' }))).toMatchObject({ ok: false, error: expect.stringContaining('reviewed') })
    expect(await send(offer({ pricing: undefined }))).toMatchObject({ ok: false, error: expect.stringContaining('Price the offer') })
    await (await store()).set('offers:clients', seedClients()) // the test client has no address yet
    expect(await send(offer())).toMatchObject({ ok: false, error: expect.stringContaining('Add your own email address') })
    await (await store()).set('offers:clients', clients())
    expect((await send(offer())).ok).toBe(true)
    const again = await send(await stored())
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('already been sent') })
    expect(mails).toHaveLength(1) // one email only
  })

  it('keeps real clients switched off until allowed, then sends to them', async () => {
    const wave = offer({ pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, pricedAt: '' } })
    const off = await send(wave)
    expect(off).toMatchObject({ ok: false, error: expect.stringContaining('real clients') })
    expect(mails).toHaveLength(0)
    expect(pub.size).toBe(0)
    expect((await stored()).status).toBe('ready')
    expect((await send(wave, { allowReal: true })).ok).toBe(true)
    expect(decode(mails[0]).headers).toContain('To: wave@example.test')
    expect(decode(mails[0]).text).not.toContain('[TEST]')
  })

  it('sends nothing and says so when the public store is not set up', async () => {
    delete process.env.OFFERS_PUBLIC_REDIS_URL
    expect(await send(offer())).toMatchObject({ ok: false, error: expect.stringContaining('public offers store is not set up') })
    expect(mails).toHaveLength(0)
  })

  it('undoes everything if the email fails: back to reviewed, snapshot deleted, nothing sent', async () => {
    fail.gmail = true
    const r = await send(offer())
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Not sent') })
    expect([...pub.keys()].filter((k) => k.startsWith('pub:offer:'))).toEqual([])
    const o = await stored()
    expect([o.status, o.sends]).toEqual(['ready', []])
    expect(o.audit.at(-1)!.what).toContain('nothing was sent')
    fail.gmail = false
    expect((await send(await stored())).ok).toBe(true) // and it can be sent again
  })

  it('sends no email at all if the snapshot cannot be saved', async () => {
    fail.publicPut = true
    expect((await send(offer())).ok).toBe(false)
    expect(mails).toHaveLength(0)
    expect((await stored()).status).toBe('ready')
  })

  it('locks a sent offer: no edits, no repricing, no status change', async () => {
    await send(offer())
    const { applyEdit } = await import('@/lib/offers/edit')
    const o = await stored()
    for (const e of [{ action: 'save', id: o.id, lines: o.lines }, { action: 'unprice', id: o.id }, { action: 'status', id: o.id, status: 'dismissed' }] as const) {
      expect(applyEdit(o, e, '2026-11-14T10:00:00Z', clients())).toMatchObject({ error: expect.stringContaining('sent') })
    }
  })
})

describe('the client answers', () => {
  const sent = async () => {
    const { hashToken } = await import('@/lib/offers/public-store')
    const TOKEN = 'T'.repeat(43)
    await send(offer(), { token: () => TOKEN, now: new Date('2026-11-14T10:45:00Z') })
    pings.length = 0
    return hashToken(TOKEN)
  }
  const call = async (body: unknown, auth: string | null = `Bearer ${WEBHOOK}`) => {
    const { POST } = await import('@/app/api/offers/answered/route')
    return POST(new Request('https://dashboard.example.test/api/offers/answered', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) }))
  }

  it('the webhook needs the shared secret, and is off without it', async () => {
    const hash = await sent()
    answerFor(hash, 'accept', 'Please ship Monday')
    expect((await call({ hash }, null)).status).toBe(401)
    expect((await call({ hash }, 'Bearer wrong')).status).toBe(401)
    expect((await call({ hash }, `Bearer ${WEBHOOK.slice(0, 20)}`)).status).toBe(401)
    expect((await stored()).status).toBe('sent') // nothing changed
    delete process.env.OFFERS_WEBHOOK_TOKEN
    expect((await call({ hash })).status).toBe(503)
  })

  it('reads the answer from the public store, records it with time, IP and browser, and pings Telegram', async () => {
    const hash = await sent()
    answerFor(hash, 'accept', 'Please ship Monday')
    const r = await call({ hash })
    expect([r.status, await r.json()]).toEqual([200, { ok: true, changed: true }])
    const o = await stored()
    expect(o.status).toBe('accepted')
    expect(o.sends![0]).toMatchObject({ outcome: 'accepted', answer: { decision: 'accept', remarks: 'Please ship Monday', at: '2026-11-14T09:30:00.000Z', ip: '203.0.113.7', ua: 'TestBrowser/1.0' } })
    expect(o.audit.at(-1)!.what).toContain('ACCEPTED at 2026-11-14T09:30:00.000Z (IP 203.0.113.7, TestBrowser/1.0). Remarks: Please ship Monday')
    expect(pings).toHaveLength(1)
    expect(pings[0].text).toContain('[TEST] Test client (my own inbox) ACCEPTED the offer: 350 units, €119,420.50.')
    expect(pings[0].text).toContain('Remarks: Please ship Monday')
    expect(JSON.stringify(pings[0].markup)).toContain('https://dashboard.example.test/offers?id=of_n12')
  })

  it('is told once only: a repeat call changes nothing and sends no second ping', async () => {
    const hash = await sent()
    answerFor(hash, 'decline', 'price too high on S25')
    expect((await (await call({ hash })).json()).changed).toBe(true)
    expect((await (await call({ hash })).json()).changed).toBe(false)
    expect(pings).toHaveLength(1)
    expect(pings[0].text).toContain('DECLINED')
    expect((await stored()).status).toBe('declined')
  })

  it('trusts the store, not the call: a forged call with no answer behind it changes nothing', async () => {
    const hash = await sent()
    expect((await (await call({ hash })).json()).changed).toBe(false)
    expect((await (await call({ hash: 'f'.repeat(64) })).json()).changed).toBe(false)
    expect((await call({ hash: 'not-a-hash' })).status).toBe(400)
    expect((await call({ hash: 'x'.repeat(64), answer: { decision: 'accept' } })).status).toBe(400)
    const o = await stored()
    expect([o.status, pings.length]).toEqual(['sent', 0])
  })

  it('the proxy lets only this one offers route through without a Google sign-in', async () => {
    const { config } = await import('@/proxy')
    const re = new RegExp(`^${config.matcher[0]}$`)
    expect(re.test('/api/offers/answered')).toBe(false) // excluded: has its own bearer lock
    for (const p of ['/api/offers', '/api/offers/clients', '/offers', '/offers/clients']) expect(re.test(p), p).toBe(true)
  })
})

describe('the 5-minute check', () => {
  const sweep = async (now: Date) => {
    const { sweepSends } = await import('@/lib/offers/resolve')
    const { notify } = await import('@/lib/offers/telegram')
    return sweepSends({ store: await store(), notify, now, dashboardUrl: 'https://dashboard.example.test' })
  }
  const sentAt = async (at: string) => {
    const { hashToken } = await import('@/lib/offers/public-store')
    await send(offer(), { token: () => 'S'.repeat(43), now: new Date(at) })
    pings.length = 0
    return hashToken('S'.repeat(43))
  }

  it('picks up an answer the public site could not report', async () => {
    const hash = await sentAt('2026-11-14T09:00:00Z')
    answerFor(hash, 'accept', 'ok')
    expect(await sweep(new Date('2026-11-14T09:05:00Z'))).toEqual({ answered: 1, expired: 0, rolledBack: 0 })
    expect((await stored()).status).toBe('accepted')
    expect(pings).toHaveLength(1)
  })

  it('leaves a waiting offer alone, and expires it at the deadline with a ping', async () => {
    await sentAt('2026-11-14T09:00:00Z')
    expect(await sweep(new Date('2026-11-15T08:59:00Z'))).toEqual({ answered: 0, expired: 0, rolledBack: 0 })
    expect((await stored()).status).toBe('sent')
    expect(await sweep(new Date('2026-11-15T09:00:00Z'))).toEqual({ answered: 0, expired: 1, rolledBack: 0 })
    const o = await stored()
    expect([o.status, o.sends![0].outcome]).toEqual(['expired', 'expired'])
    expect(pings[0].text).toContain('did not answer the offer')
    expect(pings[0].text).toContain('unlocked')
    expect(await sweep(new Date('2026-11-15T09:10:00Z'))).toEqual({ answered: 0, expired: 0, rolledBack: 0 }) // not again
    expect(pings).toHaveLength(1)
  })

  it('an answer that arrived just before the deadline wins over expiry', async () => {
    const hash = await sentAt('2026-11-14T09:00:00Z')
    answerFor(hash, 'decline')
    expect(await sweep(new Date('2026-11-15T09:30:00Z'))).toMatchObject({ answered: 1, expired: 0 })
    expect((await stored()).status).toBe('declined')
  })

  it('rolls back a send that never completed (reserved, no confirmation from Gmail)', async () => {
    await seed(offer({ status: 'sent', sends: [{ clientId: 'c_test', clientName: 'Test client (my own inbox)', to: ['buyer@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'aaaaaa', sentAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T09:00:00.000Z', totalCents: 1, units: 1, test: true, gmailMessageId: null, outcome: 'pending' } satisfies OfferSend] }))
    expect(await sweep(new Date('2026-11-14T09:05:00Z'))).toMatchObject({ rolledBack: 0 }) // give it ten minutes
    expect(await sweep(new Date('2026-11-14T09:11:00Z'))).toMatchObject({ rolledBack: 1 })
    const o = await stored()
    expect([o.status, o.sends]).toEqual(['ready', []])
  })

  it('the cron route sweeps even when Gmail cannot read mail', async () => {
    const hash = await sentAt('2026-11-14T09:00:00Z')
    answerFor(hash, 'accept')
    // Gmail connected send-only: the offers pickup cannot read, but the sweep must still run.
    await (await store()).set('gmail:tokens', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'sender@example.test', scope: 'openid email https://www.googleapis.com/auth/gmail.send' })
    process.env.CRON_SECRET = 'cron-secret-0123456789'
    const { POST } = await import('@/app/api/cron/offers/route')
    const r = await POST(new Request('https://dashboard.example.test/api/cron/offers', { method: 'POST', headers: { authorization: 'Bearer cron-secret-0123456789' } }))
    const body = await r.json()
    expect(body.swept).toEqual({ answered: 1, expired: 0, rolledBack: 0 })
    expect((await stored()).status).toBe('accepted')
  })
})

describe('withdraw and unlock', () => {
  const withdraw = async () => {
    const { withdrawOffer } = await import('@/lib/offers/send')
    const { applyAnswer } = await import('@/lib/offers/resolve')
    const { notify } = await import('@/lib/offers/telegram')
    const s = await store()
    return withdrawOffer('of_n12', { store: s }, (hash) => applyAnswer(hash, { store: s, notify }))
  }

  it('withdraws a waiting offer: the public page stops answering, and the offer can be sent again', async () => {
    const { hashToken } = await import('@/lib/offers/public-store')
    await send(offer(), { token: () => 'W'.repeat(43) })
    const r = await withdraw()
    expect(r.ok).toBe(true)
    expect(JSON.parse(pub.get(`pub:offer:${hashToken('W'.repeat(43))}`)!).status).toBe('withdrawn')
    const o = await stored()
    expect([o.status, o.sends![0].outcome]).toEqual(['ready', 'withdrawn'])
    expect((await send(o, { token: () => 'X'.repeat(43) })).ok).toBe(true)
    expect((await stored()).sends).toHaveLength(2) // both sends stay in the history
  })

  it('if the client answered first, that answer stands and the withdraw is refused', async () => {
    const { hashToken } = await import('@/lib/offers/public-store')
    await send(offer(), { token: () => 'W'.repeat(43) })
    answerFor(hashToken('W'.repeat(43)), 'accept', 'yes')
    const r = await withdraw()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('already answered') })
    expect((await stored()).status).toBe('accepted')
  })

  it('unlocks a declined or expired offer, keeping its price, but not a waiting or accepted one', async () => {
    const { unlockOffer } = await import('@/lib/offers/send')
    for (const status of ['sent', 'accepted', 'ready'] as const) {
      await seed(offer({ status }))
      expect(await unlockOffer('of_n12', { store: await store() })).toMatchObject({ ok: false })
    }
    for (const status of ['declined', 'expired'] as const) {
      await seed(offer({ status }))
      const r = await unlockOffer('of_n12', { store: await store() })
      expect(r.ok).toBe(true)
      const o = await stored()
      expect([o.status, o.pricing?.clientId, o.audit.at(-1)!.what]).toEqual(['ready', 'c_test', 'Unlocked to reprice'])
    }
  })

  it('the offers route runs send, withdraw and unlock for the signed-in owner only', async () => {
    await seed()
    const { PUT } = await import('@/app/api/offers/route')
    const put = (body: unknown, origin = 'https://dashboard.example.test') => PUT(new Request('https://dashboard.example.test/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }))
    expect((await put({ action: 'send', id: 'of_n12' }, 'https://evil.example')).status).toBe(403)
    user.value = false
    expect((await put({ action: 'send', id: 'of_n12' })).status).toBe(401)
    user.value = 'owner@example.test'
    const sentRes = await put({ action: 'send', id: 'of_n12' })
    expect([sentRes.status, (await sentRes.json()).ok]).toEqual([200, true])
    expect(mails).toHaveLength(1)
    expect((await put({ action: 'send', id: 'of_n12' })).status).toBe(409) // never twice
    expect(mails).toHaveLength(1)
    expect((await put({ action: 'withdraw', id: 'of_n12' })).status).toBe(200)
    expect((await put({ action: 'unlock', id: 'of_n12' })).status).toBe(409) // it is ready again, nothing to unlock
    await (await store()).del('gmail:tokens')
    const noGmail = await put({ action: 'send', id: 'of_n12' })
    expect([noGmail.status, (await noGmail.json()).error]).toEqual([409, expect.stringContaining('Gmail is not connected')])
  })
})

describe('keeping the two sides in step', () => {
  it('the dashboard and fonenova.com agree on the shape of an offer and how a link is hashed', () => {
    const fields = (src: string, name: string) => [...(src.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '').matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]).sort()
    const mine = fs.readFileSync(path.join(process.cwd(), 'lib/offers/public-store.ts'), 'utf8')
    const theirs = fs.readFileSync(path.join(process.cwd(), '..', 'lib/offers-public.ts'), 'utf8')
    for (const name of ['PublicOffer', 'PublicAnswer']) {
      expect(fields(mine, name).length).toBeGreaterThan(4)
      expect(fields(mine, name), name).toEqual(fields(theirs, name))
    }
    for (const src of [mine, theirs]) expect(src).toContain("createHash('sha256').update(token).digest('hex')")
    expect(fields(mine, 'PublicOffer')).not.toEqual(expect.arrayContaining(['cost']))
    for (const bad of ['cost', 'margin', 'profit']) expect(fields(mine, 'PublicOffer').join(' ')).not.toContain(bad)
  })
})

describe('the Send panel', () => {
  const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
  const setup = { allowReal: false, publicStore: true, gmail: true }
  const send1 = (p: Partial<OfferSend> = {}): OfferSend => ({ clientId: 'c_test', clientName: 'Test client (my own inbox)', to: ['buyer@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abc123', sentAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T09:00:00.000Z', totalCents: 119_420_50, units: 350, test: true, gmailMessageId: 'gm1', outcome: 'pending', ...p })

  it('previews exactly what the client sees, with sale prices only, and asks before sending', async () => {
    const { SendPanel } = await import('@/components/offers/send-panel')
    const html = render(h(SendPanel, { offer: offer(), clients: clients(), setup }))
    for (const t of ['Send to Test client (my own inbox)', '€255.87', '€625.67', '€119,420.50', 'buyer@example.test', 'valid for 24 hours', '[TEST]']) expect(html, t).toContain(t)
    for (const c of COST_FIGURES) expect(html, c).not.toContain(c)
    expect(html).not.toContain('data-testid="send-blocked"')
    expect(html).not.toContain('Yes, send it') // the confirmation only appears after the first click
  })

  it('explains why it cannot send: real client, no store, no Gmail, no address', async () => {
    const { SendPanel } = await import('@/components/offers/send-panel')
    const wave = offer({ pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, pricedAt: '' } })
    expect(render(h(SendPanel, { offer: wave, clients: clients(), setup }))).toContain('real clients are switched on with the next phase')
    expect(render(h(SendPanel, { offer: wave, clients: clients(), setup: { ...setup, allowReal: true } }))).not.toContain('send-blocked')
    expect(render(h(SendPanel, { offer: offer(), clients: clients(), setup: { ...setup, publicStore: false } }))).toContain('public offers store is not set up')
    expect(render(h(SendPanel, { offer: offer(), clients: clients(), setup: { ...setup, gmail: false } }))).toContain('Gmail is not connected')
    expect(render(h(SendPanel, { offer: offer(), clients: seedClients(), setup }))).toContain('Add your own email address')
  })

  it('shows waiting, answered and expired states with remarks escaped, and Unlock only where it applies', async () => {
    const { SendPanel } = await import('@/components/offers/send-panel')
    const waiting = render(h(SendPanel, { offer: offer({ status: 'sent', sends: [send1()] }), clients: clients(), setup }))
    for (const t of ['Waiting for Test client (my own inbox)', 'Withdraw this offer', 'abc123…']) expect(waiting, t).toContain(t)
    expect(waiting).not.toContain('Unlock')
    const declined = render(h(SendPanel, { offer: offer({ status: 'declined', sends: [send1({ outcome: 'declined', answer: { decision: 'decline', remarks: 'too high <b>S25</b>', at: '2026-11-14T09:30:00.000Z', ip: '203.0.113.7', ua: 'x' } })] }), clients: clients(), setup }))
    expect(declined).toContain('declined')
    expect(declined).toContain('too high &lt;b&gt;S25&lt;/b&gt;')
    expect(declined).toContain('Unlock to reprice')
    const accepted = render(h(SendPanel, { offer: offer({ status: 'accepted', sends: [send1({ outcome: 'accepted' })] }), clients: clients(), setup }))
    expect(accepted).toContain('Nothing else happens for a test')
    expect(accepted).not.toContain('Unlock')
    expect(render(h(SendPanel, { offer: offer({ status: 'expired', sends: [send1({ outcome: 'expired' })] }), clients: clients(), setup }))).toContain('did not answer before it expired')
  })
})
