import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfferDetail, OffersView } from '@/components/offers/offers-view'
import { applyEdit, checkEdit } from '@/lib/offers/edit'
import { seedClients, type Client } from '@/lib/offers/clients'
import { makeTestOffer, openTestOffers, TEST_OFFER_CAP, TEST_SUBJECT } from '@/lib/offers/test-offer'
import type { Offer } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))

const NOW = '2026-11-15T10:00:00.000Z'
const clients: Client[] = seedClients().map((c) => (c.id === 'c_test' ? { ...c, offerEmails: ['buyer@example.test'] } : c))
const env = { ...process.env }
let dir: string

beforeEach(() => {
  vi.resetModules()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-testoffer-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', OFFERS_PUBLIC_REDIS_URL: 'https://public-store.example.test', OFFERS_PUBLIC_REDIS_TOKEN: 'pub-token-0123456789abcdefghijklmnop' })
  user.value = 'owner@example.test'
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the test offer itself', () => {
  const o = makeTestOffer(NOW)
  it('is reviewed, unpriced and clearly a test', () => {
    expect(o).toMatchObject({ status: 'ready', testOnly: true })
    expect(o.pricing).toBeUndefined()
    expect(o.source.subject).toBe(TEST_SUBJECT)
    expect(o.source.subject).toContain('[TEST]')
    expect(o.source.from).toContain('example.invalid')
    expect(o.text).toContain('TEST OFFER')
    expect(o.audit[0].what).toContain('Test offer created')
    expect(o.lines).toHaveLength(3)
  })
  it('has an id and lines the rest of the system accepts', () => {
    expect(o.id).toMatch(/^of_[A-Za-z0-9_-]+$/)
    expect(checkEdit({ action: 'status', id: o.id, status: 'ready' }).ok).toBe(true)
    expect(checkEdit({ action: 'save', id: o.id, lines: o.lines }).ok).toBe(true)
  })
  it('create_test needs no id', () => {
    expect(checkEdit({ action: 'create_test' })).toEqual({ ok: true, value: { action: 'create_test' } })
  })
  it('counts only unanswered test offers against the cap', () => {
    const open = [makeTestOffer(NOW), makeTestOffer(NOW)]
    expect(openTestOffers(open)).toBe(2)
    expect(openTestOffers([...open, { ...makeTestOffer(NOW), status: 'accepted' }, { ...makeTestOffer(NOW), status: 'dismissed' }, { ...o, testOnly: undefined }])).toBe(2)
  })
})

describe('it can never reach a real client', () => {
  it('refuses to be priced for a real client, accepts the test client', () => {
    const o = makeTestOffer(NOW)
    const real = applyEdit(o, { action: 'price', id: o.id, input: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false } }, NOW, clients)
    expect(real).toEqual({ error: 'This is a test offer: it can only be priced for a test client.' })
    const test = applyEdit(o, { action: 'price', id: o.id, input: { clientId: 'c_test', marginCents: 700, overrides: {}, ackLow: false } }, NOW, clients)
    expect('error' in test).toBe(false)
    expect((test as Offer).pricing?.clientId).toBe('c_test')
  })

  it('and the send step refuses again even if the price was forced onto a real client, with real sending on', async () => {
    const { getStore } = await import('@/lib/store')
    const store = getStore()
    await store.set('offers:clients', clients)
    const forced: Offer = { ...makeTestOffer(NOW), pricing: { clientId: 'c_wave', marginCents: 700, overrides: {}, ackLow: false, pricedAt: NOW } }
    await store.set('offers', [forced])
    const fetchSpy = vi.fn(async () => new Response('should not be called', { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { sendOffer } = await import('@/lib/offers/send')
    const mail = vi.fn(async () => ({ id: 'x' }))
    const r = await sendOffer(forced.id, { store, allowReal: true, mail })
    expect(r).toEqual({ ok: false, error: 'This is a test offer: it can only be sent to a test client.' })
    expect(mail).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the button behind it', () => {
  const put = async (body: unknown) => {
    const { PUT } = await import('@/app/api/offers/route')
    return PUT(new Request('https://dashboard.example.test/api/offers', { method: 'PUT', headers: { origin: 'https://dashboard.example.test', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  }
  it('creates one, keeps the others, and refuses a fourth unanswered one', async () => {
    const { getStore, getJson } = await import('@/lib/store')
    for (let i = 0; i < TEST_OFFER_CAP; i++) {
      const r = await put({ action: 'create_test' })
      expect(r.status).toBe(200)
      expect(((await r.json()) as { offer: Offer }).offer).toMatchObject({ testOnly: true, status: 'ready' })
    }
    const r = await put({ action: 'create_test' })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: string }).error).toContain('unanswered test offers')
    expect(((await getJson<Offer[]>(getStore(), 'offers')) ?? []).length).toBe(TEST_OFFER_CAP)
  })
  it('needs a signed-in owner and a request from the dashboard itself', async () => {
    user.value = false
    expect((await put({ action: 'create_test' })).status).toBe(401)
    user.value = 'owner@example.test'
    const { PUT } = await import('@/app/api/offers/route')
    const foreign = await PUT(new Request('https://dashboard.example.test/api/offers', { method: 'PUT', headers: { origin: 'https://evil.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create_test' }) }))
    expect(foreign.status).toBe(403)
  })
})

describe('what the screen shows', () => {
  const render = (o: Offer) => renderToString(h(OfferDetail, { offer: o, clients }))
  it('a banner on the test offer, none on a real one', () => {
    const t = makeTestOffer(NOW)
    expect(render(t)).toContain('data-testid="test-banner"')
    expect(render(t)).toContain('never a real client')
    expect(render({ ...t, testOnly: undefined })).not.toContain('data-testid="test-banner"')
  })
  it('the price panel lists only test clients for it', () => {
    const html = render(makeTestOffer(NOW))
    expect(html).toContain('Test client (my own inbox)')
    expect(html).not.toContain('Wave Phone B.V.')
    expect(html).not.toContain('EU Telecoms')
  })
  it('the list has the button and a TEST badge on the test offer', () => {
    const html = renderToString(h(OffersView, { offers: [makeTestOffer(NOW)], status: null, setup: { gmail: null, telegram: false, schedule: true }, selected: null, clients, send: { allowReal: false, storeProblem: null, gmailProblem: null } }))
    expect(html).toContain('data-testid="new-test-offer"')
    expect(html).toContain('New test offer')
    expect(html).toContain('data-testid="test-badge"')
  })
})

describe('a new test offer starts with no shipping', () => {
  it('so the order waits for it, like a real one', () => {
    expect(makeTestOffer('2026-11-18T10:00:00Z').shipping).toBeUndefined()
  })
})
