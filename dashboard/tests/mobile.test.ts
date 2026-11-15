import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import manifest from '@/app/manifest'
import { config as proxyConfig, proxy } from '@/proxy'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSession, finishOAuth, safeNext, sessionNeedsRenewal, sign, startOAuth, verify, readSession, type AuthConfig } from '@/lib/auth'
import { OfferDetail } from '@/components/offers/offers-view'
import { Shell } from '@/components/shell'
import { makeTestOffer } from '@/lib/offers/test-offer'
import { seedClients } from '@/lib/offers/clients'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => '/offers' }))

const C: AuthConfig = { secret: 'x'.repeat(48), allowedEmail: 'owner@example.com', clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh', origin: 'https://dashboard.example.com' }
const DAY = 24 * 60 * 60

describe('staying signed in on a phone', () => {
  it('a session lasts 30 days', async () => {
    expect(SESSION_TTL_SECONDS).toBe(30 * DAY)
    const s = await readSession(await createSession('owner@example.com', C), C)
    expect(s!.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * DAY)
  })
  it('is renewed once it is a day old, not before', () => {
    const now = 1_800_000_000
    expect(sessionNeedsRenewal({ email: 'a', exp: now + SESSION_TTL_SECONDS }, now)).toBe(false)
    expect(sessionNeedsRenewal({ email: 'a', exp: now + SESSION_TTL_SECONDS - 3600 }, now)).toBe(false)
    expect(sessionNeedsRenewal({ email: 'a', exp: now + SESSION_TTL_SECONDS - DAY - 1 }, now)).toBe(true)
    expect(sessionNeedsRenewal({ email: 'a', exp: now + 5 * DAY }, now)).toBe(true)
  })
})

describe('where to go after signing in', () => {
  it('takes only a path on this site', () => {
    expect(safeNext('/offers?id=of_abc')).toBe('/offers?id=of_abc')
    expect(safeNext('/payments')).toBe('/payments')
    for (const bad of ['//evil.example', 'https://evil.example/x', 'javascript:alert(1)', '/\\evil.example', '\\\\evil', 'offers', '', '/a\nb', '/a\u0000b', '/login', '/auth/callback', 'x'.repeat(600), null, undefined]) {
      expect(safeNext(bad as string)).toBe('/')
    }
  })
  it('is carried through Google and back, and a forged one is ignored', async () => {
    const { url, cookie } = await startOAuth(C, '/offers?id=of_abc')
    const st = (await verify<{ state: string; nonce: string; exp: number; next?: string }>(cookie, C.secret))!
    expect(st.next).toBe('/offers?id=of_abc')
    const claims = { iss: 'https://accounts.google.com', aud: C.clientId, exp: Math.floor(Date.now() / 1000) + 300, nonce: st.nonce, email: 'owner@example.com', email_verified: true }
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const f = (async () => new Response(JSON.stringify({ id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig` }))) as typeof fetch
    expect(await finishOAuth(C, new URLSearchParams({ code: 'c', state: st.state }), cookie, f)).toEqual({ ok: true, email: 'owner@example.com', next: '/offers?id=of_abc' })
    expect(new URL(url).searchParams.get('state')).toBe(st.state)
    // Nothing asked for: no next at all, so the home page.
    const plain = await startOAuth(C, 'https://evil.example')
    expect((await verify<{ exp: number; next?: string }>(plain.cookie, C.secret))!.next).toBeUndefined()
    // Even a cookie signed with a bad next (it cannot be, but) is cleaned again at the callback.
    const forged = await sign({ state: 's', nonce: 'n', verifier: 'v', exp: Math.floor(Date.now() / 1000) + 300, next: '//evil.example' }, C.secret)
    const g = (async () => new Response(JSON.stringify({ id_token: `${b64({ alg: 'RS256' })}.${b64({ ...claims, nonce: 'n' })}.sig` }))) as typeof fetch
    const r = await finishOAuth(C, new URLSearchParams({ code: 'c', state: 's' }), forged, g)
    expect(r).toMatchObject({ ok: true, next: '/' })
  })
})

describe('the gate (proxy.ts)', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SECRET', C.secret)
    vi.stubEnv('AUTH_ALLOWED_EMAIL', C.allowedEmail)
    vi.stubEnv('GOOGLE_CLIENT_ID', C.clientId)
    vi.stubEnv('GOOGLE_CLIENT_SECRET', C.clientSecret)
    vi.stubEnv('AUTH_URL', C.origin)
  })
  afterEach(() => vi.unstubAllEnvs())
  const req = (p: string, cookie?: string) => new NextRequest(`https://dashboard.example.com${p}`, { headers: { accept: 'text/html', ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) } })

  it('sends someone signed out to sign-in, remembering the offer link they came in on', async () => {
    const res = await proxy(req('/offers?id=of_abc'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://dashboard.example.com/login?next=%2Foffers%3Fid%3Dof_abc')
    expect((await proxy(req('/'))).headers.get('location')).toBe('https://dashboard.example.com/login')
  })
  it('renews a session that is a day old and leaves a fresh one alone', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = await sign({ email: C.allowedEmail, exp: now + 10 * DAY }, C.secret)
    const renewed = await proxy(req('/offers', old))
    expect(renewed.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)
    expect(renewed.headers.get('set-cookie')).toContain('HttpOnly')
    expect(renewed.headers.get('set-cookie')).toContain(`Max-Age=${SESSION_TTL_SECONDS}`)
    const fresh = await proxy(req('/offers', await createSession(C.allowedEmail, C)))
    expect(fresh.headers.get('set-cookie')).toBeNull()
  })
  it('never renews a session for someone else or one that is forged', async () => {
    const now = Math.floor(Date.now() / 1000)
    const other = await sign({ email: 'someone@else.example', exp: now + 10 * DAY }, C.secret)
    expect((await proxy(req('/offers', other))).status).toBe(307)
    expect((await proxy(req('/offers', 'forged.value'))).status).toBe(307)
  })
  it('lets the manifest and icons through without a session, and nothing private', () => {
    const re = new RegExp(`^${proxyConfig.matcher[0]}$`)
    for (const open of ['/manifest.webmanifest', '/apple-icon.png', '/icon-192.png', '/icon-512.png', '/icon.svg', '/login', '/auth/callback']) expect(re.test(open), open).toBe(false)
    for (const gated of ['/', '/offers', '/payments', '/api/offers', '/manifest-secrets']) expect(re.test(gated), gated).toBe(true)
  })
})

describe('adding it to the home screen', () => {
  it('has a manifest that opens the offers full screen, with icons that exist', () => {
    const m = manifest()
    expect(m).toMatchObject({ display: 'standalone', start_url: '/offers', scope: '/' })
    expect(m.name).toContain('QuayPilot')
    for (const icon of m.icons ?? []) expect(fs.existsSync(path.join(process.cwd(), 'public', icon.src.replace(/^\//, ''))), icon.src).toBe(true)
    expect(fs.existsSync(path.join(process.cwd(), 'app', 'apple-icon.png'))).toBe(true)
  })
})

describe('the screens on a phone', () => {
  const html = renderToString(h(Shell, { children: h('p', null, 'x'), email: 'o@x.example' })).replace(/<!-- -->/g, '')
  it('has a bottom bar with Overview, Offers, Payments and Menu, and bigger menu taps', () => {
    expect(html).toContain('data-testid="bottom-nav"')
    for (const label of ['Overview', 'Offers', 'Payments', 'Menu']) expect(html).toContain(label)
    expect(html).toContain('lg:hidden')
    expect(html).toContain('h-11 w-11')
  })
  it('an offer has a way back to the list and shows its lines as cards on a phone', () => {
    const clients = seedClients()
    const o = makeTestOffer(new Date('2026-11-15T10:00:00Z').toISOString())
    const out = renderToString(h(OfferDetail, { offer: o, clients, send: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
    expect(out).toContain('data-testid="back-to-list"')
    expect(out).toContain('href="#offers-list"')
    expect(out).toContain('data-label="Unit cost €"')
    expect(out).toContain('max-sm:grid')
    expect(out).not.toContain('min-w-[600px] ')
  })
})
