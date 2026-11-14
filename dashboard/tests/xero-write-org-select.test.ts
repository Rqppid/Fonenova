import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { XeroWriteCard } from '@/components/dashboard/xero-write-card'
import { OffersView } from '@/components/offers/offers-view'
import { DEFAULT_DRAFT_SETTINGS, raiseDraft, type DraftBody, type XeroApi } from '@/lib/offers/draft'
import { checkClients, seedClients } from '@/lib/offers/clients'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))

const DEMO = 'd0d0d0d0-1111-2222-3333-444455556666'
const LIVE = '11111111-aaaa-bbbb-cccc-ddddeeeeffff'
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

const env = { ...process.env }
let dir: string
type Conn = { id: string; authEventId: string; tenantId: string; tenantName: string; tenantType: string; createdDateUtc: string; updatedDateUtc: string }
const conn = (tenantId: string, name: string, authEventId: string, when: string): Conn => ({ id: `c-${tenantId.slice(0, 4)}`, authEventId, tenantId, tenantName: name, tenantType: 'ORGANISATION', createdDateUtc: when, updatedDateUtc: when })
const state = { connections: [] as Conn[], accessToken: jwt({ authentication_event_id: 'evt-live' }), posts: 0, headers: [] as (string | null)[], orgIdFor: {} as Record<string, string> }

beforeEach(async () => {
  vi.resetModules()
  user.value = 'owner@example.test'
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-orgsel-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test', XERO_WRITE_CLIENT_ID: 'client-id' })
  state.connections = [conn(DEMO, 'Demo Company (UK)', 'evt-demo', '2026-11-14T10:00:00Z'), conn(LIVE, 'Fonenova Ltd', 'evt-live', '2026-11-15T10:00:00Z')]
  state.accessToken = jwt({ authentication_event_id: 'evt-live' })
  state.posts = 0
  state.headers = []
  state.orgIdFor = {}
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url)
    if (u.hostname === 'identity.xero.com') return Response.json({ access_token: state.accessToken, refresh_token: 'refresh-1', expires_in: 1800 })
    if (u.pathname === '/connections') return Response.json(state.connections)
    const tenant = new Headers(init.headers).get('xero-tenant-id')
    state.headers.push(tenant)
    if (u.pathname.endsWith('/Organisation')) return Response.json({ Organisations: [{ OrganisationID: state.orgIdFor[tenant ?? ''] ?? tenant, Name: tenant === DEMO ? 'Demo Company (UK)' : 'Fonenova Ltd', IsDemoCompany: tenant === DEMO }] })
    if ((init.method ?? 'GET') === 'POST') { state.posts++; return Response.json({ Invoices: [{ InvoiceID: 'i1', InvoiceNumber: '2026048', Status: 'DRAFT' }] }) }
    return Response.json({})
  }))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }) })

const mods = async () => ({ w: await import('@/lib/xero/write'), s: await import('@/lib/store') })
const finish = async () => { const { w } = await mods(); return w.finishXeroWriteAuth({ clientId: 'client-id', redirectUri: 'https://dashboard.example.test/xero-write/callback', scopes: 'x' }, 'code', 'verifier') }
const saved = async () => { const { s } = await mods(); return s.getJson<Record<string, unknown>>(s.getStore(), 'xero-write:tokens') }
const seed = async (tenantId: string | null, name: string | null, isDemo: boolean | null) => { const { s } = await mods(); await s.getStore().set('xero-write:tokens', { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, tenantId, tenantName: name, isDemo, orgs: [{ tenantId: DEMO, name: 'Demo Company (UK)', isDemo: true }, { tenantId: LIVE, name: 'Fonenova Ltd', isDemo: false }] }) }

describe('1. the consent flow stores the organisation the user chose in THIS flow', () => {
  it('finds it from the authEventId, not from the first (demo) connection in the list', async () => {
    const r = await finish()
    expect(r.chosen.map((o) => o.name)).toEqual(['Fonenova Ltd'])
    expect(r.orgs.map((o) => o.name).sort()).toEqual(['Demo Company (UK)', 'Fonenova Ltd'])
    const t = await saved()
    expect(t!.chosenTenantIds).toEqual([LIVE])
    expect((t!.orgs as unknown[]).length).toBe(2)
  })
  it('works whichever order Xero lists them in', async () => {
    state.connections.reverse()
    expect((await finish()).chosen.map((o) => o.name)).toEqual(['Fonenova Ltd'])
  })
  it('without the claim in the token, the newest connection is the one chosen', async () => {
    state.accessToken = jwt({})
    expect((await finish()).chosen.map((o) => o.name)).toEqual(['Fonenova Ltd'])
    state.accessToken = 'not-a-jwt'
    expect((await finish()).chosen.map((o) => o.name)).toEqual(['Fonenova Ltd'])
  })
  it('a demo chosen on a fresh connection is selected; a live one never is, by consent alone', async () => {
    state.accessToken = jwt({ authentication_event_id: 'evt-demo' })
    const demo = await finish()
    expect(demo.selected?.name).toBe('Demo Company (UK)')
    expect((await saved())!.tenantId).toBe(DEMO)
    const { s } = await mods()
    await s.getStore().del('xero-write:tokens')
    state.accessToken = jwt({ authentication_event_id: 'evt-live' })
    const live = await finish()
    expect(live.selected).toBeNull()
    expect((await saved())!.tenantId).toBeNull()
  })
  it('an organisation already selected stays selected when another is connected, and the new one is recorded', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const r = await finish()
    expect(r.selected?.name).toBe('Demo Company (UK)')
    const { w } = await mods()
    const st = await w.xeroWriteStatus()
    expect(st.orgs).toEqual([
      { tenantId: DEMO, name: 'Demo Company (UK)', isDemo: true, selected: true, justConnected: false },
      { tenantId: LIVE, name: 'Fonenova Ltd', isDemo: false, selected: false, justConnected: true },
    ])
  })
  it('two organisations chosen in one flow are both recorded and neither is guessed', async () => {
    state.connections = [conn(DEMO, 'Demo Company (UK)', 'evt-live', '2026-11-15T10:00:00Z'), conn(LIVE, 'Fonenova Ltd', 'evt-live', '2026-11-15T10:00:01Z')]
    const r = await finish()
    expect(r.chosen).toHaveLength(2)
    expect(r.selected).toBeNull()
  })
  it('the callback says which organisation was connected in this flow', async () => {
    const { GET } = await import('@/app/xero-write/callback/route')
    const call = () => GET(new NextRequest('https://dashboard.example.test/xero-write/callback?code=abc&state=st', { headers: { cookie: `fn_xero_write_oauth=${encodeURIComponent(JSON.stringify({ state: 'st', verifier: 'v' }))}` } }))
    const live = await call()
    expect(live.headers.get('location')).toContain('xerowrite=connected-live')
    state.accessToken = jwt({ authentication_event_id: 'evt-demo' })
    const { s } = await mods()
    await s.getStore().del('xero-write:tokens')
    expect((await call()).headers.get('location')).toContain('xerowrite=connected-demo')
  })
})

describe('2. choosing where drafts go is a separate, explicit step', () => {
  it('a demo can be chosen directly; a live one needs its own confirmation on top', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const { w } = await mods()
    const noConfirm = await w.selectXeroWriteOrg(LIVE)
    expect(noConfirm).toMatchObject({ ok: false, error: expect.stringContaining('own confirmation') })
    expect((await saved())!.tenantId).toBe(DEMO) // nothing changed
    expect(await w.selectXeroWriteOrg(LIVE, { confirmLive: true })).toMatchObject({ ok: true, org: { name: 'Fonenova Ltd', isDemo: false } })
    expect(await saved()).toMatchObject({ tenantId: LIVE, tenantName: 'Fonenova Ltd', isDemo: false })
    expect(await w.selectXeroWriteOrg(DEMO)).toMatchObject({ ok: true })
    expect((await saved())!.tenantId).toBe(DEMO)
  })
  it('refuses an organisation that is not connected (any more)', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const { w } = await mods()
    expect(await w.selectXeroWriteOrg('99999999-aaaa-bbbb-cccc-ddddeeeeffff', { confirmLive: true })).toMatchObject({ ok: false, error: expect.stringContaining('not connected') })
    state.connections = state.connections.filter((c) => c.tenantId === DEMO)
    expect(await w.selectXeroWriteOrg(LIVE, { confirmLive: true })).toMatchObject({ ok: false })
  })
  it('the route needs the owner, the dashboard origin, a real tenant id, and the live confirmation', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const { POST } = await import('@/app/xero-write/select/route')
    const post = (body: unknown, origin = 'https://dashboard.example.test') => POST(new Request('https://dashboard.example.test/xero-write/select', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    expect((await post({ tenantId: LIVE }, 'https://evil.example.test')).status).toBe(403)
    expect((await post({ tenantId: 'nope' })).status).toBe(400)
    expect((await post({ tenantId: LIVE })).status).toBe(409)
    user.value = false
    expect((await post({ tenantId: LIVE, confirmLive: true })).status).toBe(401)
    user.value = 'owner@example.test'
    const ok = await post({ tenantId: LIVE, confirmLive: true })
    expect(ok.status).toBe(200)
    expect((await saved())!.tenantId).toBe(LIVE)
  })
  it('the refresh picks up a newly connected organisation without changing a valid selection', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const { s } = await mods()
    await s.getStore().set('xero-write:tokens', { ...(await saved()), orgs: [{ tenantId: DEMO, name: 'Demo Company (UK)', isDemo: true }] })
    const { w } = await mods()
    const st = await w.refreshXeroWriteOrgs()
    expect(st.orgs.map((o) => o.name)).toEqual(['Demo Company (UK)', 'Fonenova Ltd'])
    expect(st.selectedTenantId).toBe(DEMO)
  })
})

describe('3. what the screens show', () => {
  const base = { configured: true, connected: true, settings: DEFAULT_DRAFT_SETTINGS, orgs: [{ tenantId: DEMO, name: 'Demo Company (UK)', isDemo: true, selected: false, justConnected: false }, { tenantId: LIVE, name: 'Fonenova Ltd', isDemo: false, selected: true, justConnected: true }] }
  const card = (s: object, notice: string | null = null) => renderToString(h(XeroWriteCard, { state: { ...base, orgName: 'Fonenova Ltd', isDemo: false, ...s } as never, notice })).replace(/<!-- -->/g, '')
  it('a red banner when live is selected, exactly "LIVE: drafts go to Fonenova Ltd"', () => {
    const html = card({})
    expect(html).toContain('data-testid="live-banner"')
    expect(html).toContain('LIVE: drafts go to Fonenova Ltd')
    expect(html).toContain('bg-loss')
  })
  it('no banner when a demo is selected, and a live organisation is offered only behind its own tick box', () => {
    const html = card({ orgName: 'Demo Company (UK)', isDemo: true, orgs: [{ ...base.orgs[0], selected: true }, { ...base.orgs[1], selected: false }] })
    expect(html).not.toContain('data-testid="live-banner"')
    expect(html).toContain('Use Fonenova Ltd (live)')
    expect(html).toContain('Drafts will be created in my LIVE Xero')
    expect(html).toMatch(/data-testid="use-live"[^>]*disabled|disabled[^>]*data-testid="use-live"/) // disabled until the box is ticked
  })
  it('lists every connected organisation with a DEMO or LIVE tag, which one drafts go to, and which was just connected', () => {
    const html = card({ orgName: 'Demo Company (UK)', isDemo: true, orgs: [{ ...base.orgs[0], selected: true }, { ...base.orgs[1], selected: false }] })
    expect(html).toContain('>DEMO<')
    expect(html).toContain('>LIVE<')
    expect(html).toContain('Drafts go here')
    expect(html).toContain('chosen in your latest sign-in')
    expect(html).toContain('Refresh the list from Xero')
  })
  it('connected but nothing chosen says so, and creates nothing until chosen', () => {
    const html = card({ orgName: null, isDemo: null, orgs: base.orgs.map((o) => ({ ...o, selected: false })) })
    expect(html).toContain('no organisation is chosen for drafts yet')
    expect(html).not.toContain('data-testid="live-banner"')
  })
  it('connecting a live organisation says that connecting is not choosing', () => {
    expect(card({ orgName: 'Demo Company (UK)', isDemo: true }, 'connected-live')).toContain('Connecting is not choosing')
  })
  it('the Offers page shows the same red banner', () => {
    const view = (liveTarget: string | null) => renderToString(h(OffersView, { offers: [], status: null, setup: { gmail: null, telegram: false, schedule: true }, selected: null, clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null }, liveTarget })).replace(/<!-- -->/g, '')
    expect(view('Fonenova Ltd')).toContain('LIVE: drafts go to Fonenova Ltd')
    expect(view(null)).not.toContain('LIVE: drafts go to')
  })
})

describe('4. the tenant guard: a draft only ever goes to the selected organisation', () => {
  it('with nothing chosen no request is made', async () => {
    await seed(null, null, null)
    const { w } = await mods()
    await expect(w.xeroWriteApi().organisation()).rejects.toThrow('No Xero organisation is chosen')
    expect(state.headers).toEqual([])
  })
  it('every request carries the selected tenant, and only that one', async () => {
    await seed(LIVE, 'Fonenova Ltd', false)
    const { w } = await mods()
    const api = w.xeroWriteApi()
    await api.organisation()
    await api.invoiceNumbers()
    await api.findByReference('FN-ORD-016')
    expect(new Set(state.headers)).toEqual(new Set([LIVE]))
  })
  it('refuses when Xero reports the selected tenant as a different organisation', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    state.orgIdFor[DEMO] = LIVE
    const { w } = await mods()
    await expect(w.xeroWriteApi().organisation()).rejects.toThrow('different organisation')
  })
  it('if the selection is changed while a draft is being made, the draft is not sent anywhere', async () => {
    await seed(DEMO, 'Demo Company (UK)', true)
    const { w, s } = await mods()
    const api = w.xeroWriteApi()
    await api.organisation() // the run is now working in the demo
    await s.getStore().set('xero-write:tokens', { ...(await saved()), tenantId: LIVE, tenantName: 'Fonenova Ltd', isDemo: false }) // someone switches to live meanwhile
    const body = { Type: 'ACCREC', Status: 'DRAFT', InvoiceNumber: '2026001', Reference: 'TEST-001', Contact: { ContactID: 'c' }, Date: '2026-11-15', DueDate: '2026-11-22', CurrencyCode: 'EUR', LineAmountTypes: 'Exclusive', LineItems: [] } as DraftBody
    await expect(api.createDraft(body, 'k')).rejects.toThrow('changed while this draft was being made')
    expect(state.posts).toBe(0)
    expect(state.headers.every((t) => t === DEMO)).toBe(true)
  })
})

describe('3b. the test client stays in the Demo Company unless a live test contact is mapped', () => {
  function mem(): Store {
    const data = new Map<string, unknown>()
    return { name: 'mem', async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: data.get(k) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, v) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(_n: string, fn: () => Promise<T>) { return fn() } }
  }
  const fake = (isDemo: boolean) => {
    const bodies: DraftBody[] = []
    const api: XeroApi = {
      async organisation() { return { name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo } },
      async invoiceNumbers() { return isDemo ? [] : ['2026047'] },
      async findByReference() { return null },
      async createDraft(b) { bodies.push(b); return { id: 'i', number: b.InvoiceNumber, status: 'DRAFT' } },
    }
    return { api, bodies }
  }
  const testClient = { ...seedClients()[2], xeroContactId: '11111111-2222-3333-4444-555555555555' }
  const run = (x: ReturnType<typeof fake>, client: typeof testClient & { liveTestContactId?: string | null }, test = true) => raiseDraft({ api: x.api, store: mem(), reference: 'TEST-001', client, test, lines: [{ description: 'x', qty: 1, unitSaleCents: 100 }], settings: DEFAULT_DRAFT_SETTINGS, now: new Date('2026-11-15T10:00:00Z'), allowLive: true })
  it('refused in a live organisation without a live test contact: nothing created', async () => {
    const x = fake(false)
    const r = await run(x, testClient)
    expect(r).toMatchObject({ ok: false, retry: false })
    expect((r as { error: string }).error).toContain('live test contact')
    expect(x.bodies).toHaveLength(0)
  })
  it('with a live test contact mapped it goes to the live organisation using THAT contact, never the demo contact', async () => {
    const x = fake(false)
    const LIVE_CONTACT = '99999999-aaaa-bbbb-cccc-ddddeeeeffff'
    const r = await run(x, { ...testClient, liveTestContactId: LIVE_CONTACT })
    expect(r).toMatchObject({ ok: true, number: '2026048' })
    expect(x.bodies[0].Contact.ContactID).toBe(LIVE_CONTACT)
  })
  it('in the Demo Company it uses the demo contact, whatever is mapped for live', async () => {
    const x = fake(true)
    await run(x, { ...testClient, liveTestContactId: '99999999-aaaa-bbbb-cccc-ddddeeeeffff' })
    expect(x.bodies[0].Contact.ContactID).toBe('11111111-2222-3333-4444-555555555555')
  })
  it('the live test contact is validated and belongs to a test client only', () => {
    const saved = seedClients()
    const t = (p: Record<string, unknown>) => checkClients(saved.map((c) => (c.test ? { ...c, ...p } : c)), saved)
    expect(t({ liveTestContactId: '99999999-aaaa-bbbb-cccc-ddddeeeeffff' })).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ liveTestContactId: '99999999-aaaa-bbbb-cccc-ddddeeeeffff' })]) })
    expect(t({ liveTestContactId: 'abc' })).toMatchObject({ ok: false, error: expect.stringContaining('live test contact id') })
    expect(checkClients(saved.map((c) => (c.id === 'c_wave' ? { ...c, liveTestContactId: '99999999-aaaa-bbbb-cccc-ddddeeeeffff' } : c)), saved)).toMatchObject({ ok: false, error: expect.stringContaining('test client only') })
  })
})
