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
const GOOGLE_TOKEN = 'https://google.example.test/token'
const GOOD_TOKEN = 'pub-token-0123456789abcdefghijklmnop'
const WEBHOOK = 'webhook-token-0123456789abcdefghij'
const env = { ...process.env }
let dir: string
const pub = new Map<string, string>()
const pings: string[] = []
const mails: string[] = []

function fakeFetch() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input.startsWith(PUB)) {
      const [op, key, ...rest] = JSON.parse(String(init.body)) as [string, string, ...(string | number)[]]
      if (op === 'GET') return Response.json({ result: pub.get(key) ?? null })
      if (op === 'DEL') return Response.json({ result: pub.delete(key) ? 1 : 0 })
      if (op === 'SET') { pub.set(key, String(rest[0])); return Response.json({ result: 'OK' }) }
      return Response.json({ error: 'unknown' })
    }
    if (input.startsWith(GMAIL)) { mails.push(Buffer.from((JSON.parse(String(init.body)) as { raw: string }).raw, 'base64url').toString('utf8')); return Response.json({ id: 'gm1' }) }
    if (input.startsWith(GOOGLE_TOKEN)) return new Response('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}', { status: 400 })
    if (input.startsWith('https://telegram.example.test')) { pings.push((JSON.parse(String(init.body)) as { text: string }).text); return Response.json({ ok: true }) }
    return new Response('unexpected', { status: 500 })
  })
}

const L = (id: string, model: string, storage: string, grade: string, qty: number, cost: number): OfferLine => ({ id, model, storage, grade, qty, unitCostCents: Math.round(cost * 100), sourceText: '', note: null })
const nov12 = [L('a1a1a1', 'iPhone 14', '128GB', 'AP Grade A+', 200, 248.87), L('b2b2b2', 'iPhone 15', '128GB', 'A GradeA+', 100, 362.63), L('c3c3c3', 'Samsung S25 Ultra', '256GB', 'Grade A+', 50, 617.67)]
const COST_FIGURES = ['24887', '36263', '61767', '248.87', '362.63', '617.67']
const clients = (): Client[] => seedClients().map((c) => (c.id === 'c_test' ? { ...c, offerEmails: ['buyer@example.test'] } : c))
const send1 = (p: Partial<OfferSend> = {}): OfferSend => ({ clientId: 'c_test', clientName: 'Test client (my own inbox)', to: ['buyer@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abc123', sentAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T09:00:00.000Z', totalCents: 119_420_50, units: 350, test: true, gmailMessageId: 'gm1', outcome: 'pending', ...p })
const offer = (p: Partial<Offer> = {}): Offer => ({
  id: 'of_n12', status: 'sent', source: { gmailMessageId: 'n12', threadId: 't', rfcMessageId: null, from: 'Mobile One <supplier@example.test>', to: 'owner@example.test', subject: 'Offer', receivedAt: '2026-11-12T10:29:42Z' },
  text: '', lines: nov12, pricing: { clientId: 'c_test', marginCents: 700, overrides: { c3c3c3: 800 }, ackLow: false, pricedAt: '2026-11-13T12:00:00Z' }, sends: [send1()], createdAt: '', updatedAt: '', audit: [], ...p,
})

beforeEach(async () => {
  vi.resetModules()
  user.value = 'owner@example.test'
  pub.clear(); pings.length = 0; mails.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-follow-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, {
    FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', FN_GMAIL_API_URL: GMAIL, FN_GOOGLE_TOKEN_URL: GOOGLE_TOKEN,
    OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: GOOD_TOKEN, OFFERS_WEBHOOK_TOKEN: WEBHOOK,
    TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '1', FN_TELEGRAM_API_URL: 'https://telegram.example.test',
  })
  vi.stubGlobal('fetch', fakeFetch())
  const { getStore } = await import('@/lib/store')
  await getStore().set('offers:clients', clients())
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})
const store = async () => (await import('@/lib/store')).getStore()
const stored = async () => (await (await import('@/lib/store')).getJson<Offer[]>(await store(), 'offers'))![0]
const gmailTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'sender@example.test', scope: 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly' }

describe('checking the Offers variables', () => {
  it('accepts well-formed values, including a token that ends in base64 padding', async () => {
    const { checkPublicStoreEnv, offersEnvProblems } = await import('@/lib/offers/env-check')
    expect(checkPublicStoreEnv({ OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: GOOD_TOKEN })).toEqual({ configured: true, problem: null })
    expect(checkPublicStoreEnv({ OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: `${GOOD_TOKEN}==` }).configured).toBe(true)
    expect(offersEnvProblems({ OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: GOOD_TOKEN, OFFERS_WEBHOOK_TOKEN: WEBHOOK })).toEqual([])
    expect(offersEnvProblems({})).toEqual([]) // nothing set: sending is simply not set up, no noise
  })

  it('catches the real mistakes: a pasted .env block as the token, a half address, quotes, spaces', async () => {
    const { checkPublicStoreEnv, urlProblem, tokenProblem, webhookProblem } = await import('@/lib/offers/env-check')
    const block = `Bearer UPSTASH_REDIS_REST_URL=${PUB}\nUPSTASH_REDIS_REST_TOKEN=${GOOD_TOKEN}`
    expect(tokenProblem(block)).toBe('OFFERS_PUBLIC_REDIS_TOKEN looks malformed: paste only the token itself, with no name, "Bearer", quotes or spaces.')
    for (const bad of [`UPSTASH_REDIS_REST_TOKEN=${GOOD_TOKEN}`, `"${GOOD_TOKEN}"`, `${GOOD_TOKEN} `, `${GOOD_TOKEN}\n`, 'short', `a=b${GOOD_TOKEN}`]) expect(tokenProblem(bad), bad).toContain('looks malformed')
    for (const bad of ['public-store.example.test', 'http://public-store.example.test', `"${PUB}"`, `UPSTASH_REDIS_REST_URL=${PUB}`, `${PUB} `, 'https://', 'https://localhost']) expect(urlProblem(bad), bad).toContain('OFFERS_PUBLIC_REDIS_URL looks malformed')
    expect(webhookProblem('short')).toContain('OFFERS_WEBHOOK_TOKEN looks malformed')
    expect(webhookProblem(`${WEBHOOK} x`)).toContain('looks malformed')
    expect(checkPublicStoreEnv({ OFFERS_PUBLIC_REDIS_URL: PUB })).toMatchObject({ configured: false, problem: expect.stringContaining('OFFERS_PUBLIC_REDIS_TOKEN is not set') })
  })

  it('never puts a value in a message', async () => {
    const { offersEnvProblems } = await import('@/lib/offers/env-check')
    const secret = 'SuperSecretValue1234567890abcdef=notpadding'
    const all = offersEnvProblems({ OFFERS_PUBLIC_REDIS_URL: `"${secret}"`, OFFERS_PUBLIC_REDIS_TOKEN: secret, OFFERS_WEBHOOK_TOKEN: `x ${secret}` }).join('\n')
    expect(all).toContain('looks malformed')
    expect(all).not.toContain('SuperSecret')
    expect(all).not.toContain('notpadding')
  })

  it('tells the owner on the Send panel and in the watchdog, naming the variable and not the value', async () => {
    const bad = `Bearer UPSTASH_REDIS_REST_URL=${PUB} UPSTASH_REDIS_REST_TOKEN=${GOOD_TOKEN}`
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = bad
    const { publicStoreProblem } = await import('@/lib/offers/public-store')
    const problem = publicStoreProblem()!
    expect(problem).toContain('OFFERS_PUBLIC_REDIS_TOKEN looks malformed')
    expect(problem).not.toContain(GOOD_TOKEN)
    const { healthChecks } = await import('@/lib/health')
    const { offersEnvProblems } = await import('@/lib/offers/env-check')
    const c = healthChecks({ now: new Date('2026-11-14T10:00:00Z'), today: '2026-11-14', sources: [], xero: { configured: false, connected: false, snapshot: null }, oneDrive: { configured: false, connected: false }, make: null, makeConfigured: true, gmail: { configured: false, connected: false }, watchdogConfigured: true, ignoredInvoiceNumbers: [], offersConfig: offersEnvProblems(process.env) }).find((x) => x.id === 'offers-config')!
    expect(c).toMatchObject({ level: 'amber', title: 'Offers settings look wrong' })
    expect(c.detail).toContain('OFFERS_PUBLIC_REDIS_TOKEN looks malformed')
    expect(JSON.stringify(c)).not.toContain(GOOD_TOKEN)
  })
})

describe('errors never echo a secret', () => {
  const seedReady = async () => (await store()).set('offers', [offer({ status: 'ready', sends: undefined })])
  const run = async () => {
    const { sendOffer } = await import('@/lib/offers/send')
    return sendOffer('of_n12', { store: await store(), allowReal: false, mail: async () => ({ id: 'x' }) })
  }

  it('a pasted block as the token: a plain sentence, nothing sent, the value never shown', async () => {
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = `Bearer UPSTASH_REDIS_REST_URL=${PUB} UPSTASH_REDIS_REST_TOKEN=${GOOD_TOKEN}`
    await seedReady()
    const r = await run()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('OFFERS_PUBLIC_REDIS_TOKEN looks malformed') })
    expect(JSON.stringify(r)).not.toContain('UPSTASH_REDIS_REST')
    expect(JSON.stringify(r)).not.toContain(GOOD_TOKEN)
    expect((await stored()).status).toBe('ready')
  })

  it('a malformed address: the same', async () => {
    process.env.OFFERS_PUBLIC_REDIS_URL = 'not a url at all'
    await seedReady()
    const r = await run()
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('OFFERS_PUBLIC_REDIS_URL looks malformed') })
    expect(JSON.stringify(r)).not.toContain('not a url')
  })

  it('even when the network layer itself throws with the value in its message, the sentence is plain', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`Headers.append: "Bearer ${GOOD_TOKEN}" is an invalid header value; Failed to parse URL from ${PUB}`) }))
    const { getPublicOffer } = await import('@/lib/offers/public-store')
    const err = await getPublicOffer('a'.repeat(64)).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('The public offers store could not be reached. Check OFFERS_PUBLIC_REDIS_URL and OFFERS_PUBLIC_REDIS_TOKEN in Vercel.')
    await seedReady()
    const r = await run()
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(GOOD_TOKEN)
    expect(JSON.stringify(r)).not.toContain('public-store.example.test')
    expect((await stored()).status).toBe('ready') // and it was undone
  })

  it('a refused token and a slow store get their own plain sentences', async () => {
    const { getPublicOffer } = await import('@/lib/offers/public-store')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 401 })))
    expect(await getPublicOffer('a'.repeat(64)).catch((e: Error) => e.message)).toBe('The public offers store refused the token. Check OFFERS_PUBLIC_REDIS_TOKEN in Vercel.')
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }) }))
    expect(await getPublicOffer('a'.repeat(64)).catch((e: Error) => e.message)).toBe('The public offers store did not answer in time.')
  })

  it('a malformed webhook token turns the webhook off instead of half working, and the panel only warns', async () => {
    process.env.OFFERS_WEBHOOK_TOKEN = `"${WEBHOOK}"`
    const { POST } = await import('@/app/api/offers/answered/route')
    const res = await POST(new Request('https://dashboard.example.test/api/offers/answered', { method: 'POST', headers: { authorization: `Bearer "${WEBHOOK}"`, 'content-type': 'application/json' }, body: JSON.stringify({ hash: 'a'.repeat(64) }) }))
    expect(res.status).toBe(503)
    const { webhookProblem } = await import('@/lib/offers/env-check')
    const { SendPanel } = await import('@/components/offers/send-panel')
    const html = renderToString(h(SendPanel, { offer: offer({ status: 'ready', sends: undefined }), clients: clients(), setup: { allowReal: false, storeProblem: null, gmailProblem: null, webhookWarning: webhookProblem(process.env.OFFERS_WEBHOOK_TOKEN) } })).replace(/<!-- -->/g, '')
    expect(html).toContain('OFFERS_WEBHOOK_TOKEN looks malformed')
    expect(html).not.toContain('send-blocked') // it warns; sending still works
    expect(html).not.toContain(WEBHOOK)
  })

  it('the public site shows a plain page for a malformed variable and never echoes it', async () => {
    const mod = await import('../../lib/offers-public')
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = `Bearer ${GOOD_TOKEN}`
    expect(mod.publicStoreConfigured()).toBe(false)
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = GOOD_TOKEN
    expect(mod.publicStoreConfigured()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`Invalid header Bearer ${GOOD_TOKEN}`) }))
    const err = await mod.getOffer('a'.repeat(64)).catch((e: Error) => e.message)
    expect(err).toBe('The offers store could not be reached')
  })
})

describe('Gmail says what is wrong', () => {
  it('connected, not connected, unreadable and check-failed are different states with their own words', async () => {
    const { gmailConnected, GMAIL_MESSAGES } = await import('@/lib/gmail')
    const s = await store()
    expect(await gmailConnected(s)).toMatchObject({ connected: false, state: 'not_connected', message: GMAIL_MESSAGES.not_connected })
    await s.set('gmail:tokens', gmailTokens)
    expect(await gmailConnected(s)).toMatchObject({ connected: true, state: 'connected', canRead: true, message: null, email: 'sender@example.test' })
    fs.writeFileSync(path.join(dir, 'gmail', 'tokens.json'), '{ this is not json')
    expect(await gmailConnected(s)).toMatchObject({ connected: false, state: 'unreadable', message: GMAIL_MESSAGES.unreadable })
    const broken = { ...s, get: async () => { throw new Error('Online store GET failed (500)') } } as unknown as typeof s
    const down = await gmailConnected(broken)
    expect(down).toMatchObject({ connected: false, state: 'check_failed', message: GMAIL_MESSAGES.check_failed })
    expect(down.message).toContain('Nothing was disconnected') // a hiccup is not "not connected"
  })

  it('every message says how to fix it, and the wording matches the buttons on the card', async () => {
    const { GMAIL_MESSAGES } = await import('@/lib/gmail')
    expect(GMAIL_MESSAGES.not_connected).toContain('Press Connect Gmail')
    expect(GMAIL_MESSAGES.unreadable).toContain('Press Reconnect Gmail')
    expect(GMAIL_MESSAGES.needs_reconnect).toContain('Press Reconnect Gmail')
    expect(GMAIL_MESSAGES.check_failed).toContain('refresh in a minute')
  })

  it('when Google stops accepting the login (invalid_grant) it is remembered, so every screen says reconnect', async () => {
    const s = await store()
    await s.set('gmail:tokens', { ...gmailTokens, expiresAt: Date.now() - 1000 })
    const { sendGmail, gmailConfig, gmailConnected, GMAIL_MESSAGES } = await import('@/lib/gmail')
    await expect(sendGmail(gmailConfig()!, { subject: 's', text: 't', html: 'h', to: 'x@example.test' }, s)).rejects.toThrow(GMAIL_MESSAGES.needs_reconnect)
    expect(await gmailConnected(s)).toMatchObject({ connected: false, state: 'needs_reconnect', message: GMAIL_MESSAGES.needs_reconnect })
    expect(mails).toHaveLength(0)
    // Connecting again replaces the saved login and clears it.
    await s.set('gmail:tokens', gmailTokens)
    expect((await gmailConnected(s)).state).toBe('connected')
  })

  it('the 5-minute check records the specific reason', async () => {
    process.env.CRON_SECRET = 'cron-secret-0123456789'
    const s = await store()
    await s.set('gmail:tokens', { ...gmailTokens, needsReconnect: true })
    const { POST } = await import('@/app/api/cron/offers/route')
    await POST(new Request('https://dashboard.example.test/api/cron/offers', { method: 'POST', headers: { authorization: 'Bearer cron-secret-0123456789' } }))
    const { getJson } = await import('@/lib/store')
    expect(await getJson<{ error: string }>(s, 'offers:status')).toMatchObject({ error: expect.stringContaining('Google no longer accepts the saved Gmail login') })
  })

  it('the offers page and the watchdog show the reason, and a stale one is "waiting" once Gmail works', async () => {
    const { healthChecks } = await import('@/lib/health')
    const base = { now: new Date('2026-11-14T10:00:00Z'), today: '2026-11-14', sources: [], xero: { configured: false, connected: false, snapshot: null }, oneDrive: { configured: false, connected: false }, make: null, makeConfigured: true, watchdogConfigured: true, ignoredInvoiceNumbers: [] }
    const status = (error: string) => ({ lastRunAt: '2026-11-14T09:58:00Z', ok: false, checked: 0, added: 0, error })
    const off = (error: string, gmail: unknown) => healthChecks({ ...base, gmail, offers: status(error) } as never).find((c) => c.id === 'offers')!
    const { GMAIL_MESSAGES } = await import('@/lib/gmail')
    for (const m of [GMAIL_MESSAGES.not_connected, GMAIL_MESSAGES.check_failed, GMAIL_MESSAGES.unreadable, GMAIL_MESSAGES.needs_reconnect]) {
      expect(off(m, { configured: true, connected: true, canRead: true }).level, m).toBe('amber')
      expect(off(m, { configured: true, connected: false, canRead: false }).level, m).toBe('red')
    }
  })
})

describe('telling the owner by email as well as Telegram', () => {
  const resolveDeps = async (extra: Record<string, unknown> = {}) => {
    const { notify } = await import('@/lib/offers/telegram')
    const sent: { subject: string; text: string; html: string }[] = []
    return { sent, deps: { store: await store(), notify, dashboardUrl: 'https://dashboard.example.test', email: async (m: { subject: string; text: string; html: string }) => { sent.push(m) }, ...extra } }
  }
  const seedSent = async () => (await store()).set('offers', [offer()])
  const answer = (decision: 'accept' | 'decline', remarks = '') => ({ decision, remarks, at: '2026-11-14T09:30:00.000Z', ip: '203.0.113.7', ua: 'TestBrowser/1.0' })

  it('an acceptance emails the client name, total, items at sale prices, time and remarks, with no costs', async () => {
    await seedSent()
    const { applyAnswer } = await import('@/lib/offers/resolve')
    const { sent, deps } = await resolveDeps({ getAnswer: async () => answer('accept', 'Please ship Monday <b>please</b>') })
    expect(await applyAnswer('a'.repeat(64), deps)).toEqual({ changed: true })
    expect(sent).toHaveLength(1)
    const m = sent[0]
    expect(m.subject).toBe('[TEST] ACCEPTED: Test client (my own inbox) accepted the offer (€119,420.50)')
    for (const t of ['350 units, €119,420.50', 'Answered: Sat, 14 Nov 2026, 09:30 UK time', 'iPhone 14 128GB AP Grade A+: 200 x €255.87 = €51,174.00', 'Samsung S25 Ultra 256GB Grade A+: 50 x €625.67 = €31,283.50', 'Remarks: Please ship Monday <b>please</b>', 'https://dashboard.example.test/offers?id=of_n12', 'This was a test']) expect(m.text, t).toContain(t)
    expect(m.html).toContain('Please ship Monday &lt;b&gt;please&lt;/b&gt;') // escaped
    for (const c of [...COST_FIGURES, 'margin', 'profit']) { expect(m.text.toLowerCase(), c).not.toContain(c); expect(m.html.toLowerCase().replace(/ style="[^"]*"/g, ''), c).not.toContain(c) }
    expect(pings).toHaveLength(1) // Telegram still went
    expect((await stored()).status).toBe('accepted')
  })

  it('a decline and an expiry email too', async () => {
    await seedSent()
    const { applyAnswer, sweepSends } = await import('@/lib/offers/resolve')
    const a = await resolveDeps({ getAnswer: async () => answer('decline', 'price too high on S25') })
    await applyAnswer('a'.repeat(64), a.deps)
    expect(a.sent[0].subject).toContain('DECLINED: Test client (my own inbox) declined the offer')
    expect(a.sent[0].text).toContain('Remarks: price too high on S25')
    expect(a.sent[0].text).toContain('unlocked')
    await seedSent()
    const b = await resolveDeps({ getAnswer: async () => null, now: new Date('2026-11-15T09:00:00Z') })
    expect(await sweepSends(b.deps)).toMatchObject({ expired: 1 })
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0].subject).toContain('EXPIRED: Test client (my own inbox) did not answer the offer')
    expect(b.sent[0].text).toContain('No answer was received.')
    expect(b.sent[0].text).toContain('Deadline passed: Sun, 15 Nov 2026, 09:00 UK time')
  })

  it('a failed email never stops the status update or the Telegram message, and is noted', async () => {
    await seedSent()
    const { applyAnswer } = await import('@/lib/offers/resolve')
    const { deps } = await resolveDeps({ getAnswer: async () => answer('accept'), email: async () => { throw new Error('Gmail answered 500') } })
    expect(await applyAnswer('a'.repeat(64), deps)).toEqual({ changed: true })
    const o = await stored()
    expect(o.status).toBe('accepted')
    expect(o.audit.map((a) => a.what).join(' | ')).toContain('Notification email to you was not sent (Telegram was)')
    expect(pings).toHaveLength(1)
    expect(pings[0]).toContain('ACCEPTED')
  })

  it('works through the real webhook with the real Gmail sender, and a Gmail that is not connected changes nothing else', async () => {
    const s = await store()
    await s.set('offers', [offer()])
    await s.set('gmail:tokens', gmailTokens)
    pub.set(`pub:answer:${'a'.repeat(64)}`, JSON.stringify(answer('accept', 'ok')))
    const { POST } = await import('@/app/api/offers/answered/route')
    const call = () => POST(new Request('https://dashboard.example.test/api/offers/answered', { method: 'POST', headers: { authorization: `Bearer ${WEBHOOK}`, 'content-type': 'application/json' }, body: JSON.stringify({ hash: 'a'.repeat(64) }) }))
    const r = await call()
    expect([r.status, (await r.json()).changed]).toEqual([200, true])
    expect(mails).toHaveLength(1)
    expect(mails[0]).toContain('To: ') // goes to the dashboard's own address
    expect(mails[0]).toContain('Subject: ')
    // Now with Gmail not connected: status and Telegram are unaffected.
    pings.length = 0; mails.length = 0
    await s.set('offers', [offer()])
    await s.del('gmail:tokens')
    const r2 = await call()
    expect([r2.status, (await r2.json()).changed]).toEqual([200, true])
    expect(mails).toHaveLength(0)
    expect((await stored()).status).toBe('accepted')
    expect(pings).toHaveLength(1)
  })
})

describe('the Friday cash email is gone', () => {
  it('has no scheduled job and no wording on the card, and the route still refuses', async () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as { crons: { path: string }[] }
    expect(vercel.crons.map((c) => c.path)).toEqual(['/api/cron/sync'])
    process.env.CRON_SECRET = 'cron-secret-0123456789'
    const { GET } = await import('@/app/api/cron/digest/route')
    const r = await GET(new Request('https://dashboard.example.test/api/cron/digest', { headers: { authorization: 'Bearer cron-secret-0123456789' } }))
    expect(await r.json()).toEqual({ ok: true, message: 'switched off' })
    const src = fs.readFileSync(path.join(process.cwd(), 'components/dashboard/automations.tsx'), 'utf8')
    const card = src.slice(src.indexOf('export function GmailCard'), src.indexOf('/** The AI bar'))
    for (const w of ['Friday', 'weekly', 'cash email']) expect(card, w).not.toContain(w)
  })

  it('the price panel no longer says sending comes in the next phase', async () => {
    const { PricePanel } = await import('@/components/offers/price-panel')
    const html = renderToString(h(PricePanel, { offer: offer({ status: 'ready', sends: undefined }), clients: clients() })).replace(/<!-- -->/g, '')
    expect(html).toContain('Priced. Send it to the client from the panel below.')
    expect(html).not.toContain('next phase')
    expect(html).not.toContain('nothing leaves the dashboard')
  })
})
