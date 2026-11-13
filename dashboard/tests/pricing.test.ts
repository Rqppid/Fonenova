import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkClients, seedClients, type Client } from '@/lib/offers/clients'
import { priceOffer, publicLines } from '@/lib/offers/pricing'
import type { Offer, OfferLine } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const wave = seedClients().find((c) => c.id === 'c_wave')!
const eu = seedClients().find((c) => c.id === 'c_eutelecoms')!
const L = (id: string, model: string, storage: string, grade: string, qty: number, cost: number, extra: Partial<OfferLine> = {}): OfferLine => ({ id, model, storage, grade, qty, unitCostCents: Math.round(cost * 100), sourceText: '', note: null, ...extra })

/** The 12 Nov offer, as invoiced on 2026047 (plus shipping, which is not on offers). */
const nov12 = [L('a1a1a1', 'iPhone 14', '128GB', 'AP Grade A+', 200, 248.87), L('b2b2b2', 'iPhone 15', '128GB', 'A GradeA+', 100, 362.63), L('c3c3c3', 'Samsung S25 Ultra', '256GB', 'Grade A+', 50, 617.67)]
const input = (p: Partial<{ clientId: string; marginCents: number | null; overrides: Record<string, number>; ackLow: boolean }> = {}) => ({ clientId: 'c_wave', marginCents: null, overrides: {}, ackLow: false, ...p })

describe('pricing an offer', () => {
  it('reproduces invoice 2026047 to the cent: +€7 on the iPhones, +€8 on the S25 Ultra', () => {
    const r = priceOffer(nov12, wave, input({ marginCents: 700, overrides: { c3c3c3: 800 } }))
    expect(r.ok).toBe(true)
    expect(r.lines.map((l) => l.saleCents)).toEqual([255_87, 369_63, 625_67]) // the unit prices on the invoice
    expect(r.lines.map((l) => l.lineSaleCents)).toEqual([51_174_00, 36_963_00, 31_283_50])
    expect(r.totals).toEqual({ units: 350, costCents: 116_920_50, saleCents: 119_420_50, profitCents: 2_500_00, profitPerUnitCents: 714 })
    expect(r.totals.saleCents + 640_00).toBe(120_060_50) // plus the €640 shipping line = the invoice total
    expect(r.lines.map((l) => l.overridden)).toEqual([false, false, true])
  })

  it('EU Telecoms is exactly cost + €4.00 on every line, and a locked margin refuses per-line changes', () => {
    const r = priceOffer(nov12, eu, input({ clientId: 'c_eutelecoms' }))
    expect(r.ok).toBe(true)
    expect(r.lines.map((l) => l.marginCents)).toEqual([400, 400, 400])
    expect(r.totals.profitCents).toBe(350 * 400)
    expect(r.lowCount).toBe(0) // exactly €4.00 is not "under"
    const bad = priceOffer(nov12, eu, input({ clientId: 'c_eutelecoms', overrides: { a1a1a1: 100 } }))
    expect(bad.ok).toBe(false)
    expect(bad.errors.join(' ')).toContain('locked')
    expect(bad.lines.map((l) => l.marginCents)).toEqual([400, 400, 400]) // the override is ignored, never applied
  })

  it('a manual client needs a margin for the offer, and refuses nonsense', () => {
    expect(priceOffer(nov12, wave, input()).ok).toBe(false)
    expect(priceOffer(nov12, wave, input()).errors.join(' ')).toContain('Enter the margin per unit')
    for (const m of [0, -5, 1.5, 50_001, Number.NaN]) expect(priceOffer(nov12, wave, input({ marginCents: m })).ok, String(m)).toBe(false)
    expect(priceOffer(nov12, wave, input({ marginCents: 700, overrides: { zzzzzz: 700 } })).ok).toBe(false)
    expect(priceOffer(nov12, wave, input({ marginCents: 700, overrides: { a1a1a1: 0 } })).ok).toBe(false)
  })

  it('flags a line under €4.00 and only allows it after the tick box', () => {
    const typo = priceOffer(nov12, wave, input({ marginCents: 70 })) // 0.70 typed for 7.00
    expect(typo.lowCount).toBe(3)
    expect(typo.needsAck).toBe(true)
    expect(typo.ok).toBe(false)
    expect(typo.lines.every((l) => l.low)).toBe(true)
    expect(priceOffer(nov12, wave, input({ marginCents: 70, ackLow: true })).ok).toBe(true)
    const one = priceOffer(nov12, wave, input({ marginCents: 700, overrides: { b2b2b2: 399 } }))
    expect(one.lines.map((l) => l.low)).toEqual([false, true, false])
    expect(one.lowCount).toBe(1)
  })

  it('will not price a line the review flagged (unknown model, price out of range)', () => {
    const lines = [...nov12, L('d4d4d4', 'iPhone 7 Pro', '256GB', '', 300, 854)]
    const r = priceOffer(lines, wave, input({ marginCents: 700 }))
    expect(r.ok).toBe(false)
    expect(r.lines[3].blocked).toContain('iPhone 7 Pro')
    expect(r.errors.join(' ')).toContain('1 line need fixing')
    expect(priceOffer([], wave, input({ marginCents: 700 })).ok).toBe(false)
  })

  it('works in whole cents, with no rounding drift on big totals', () => {
    const r = priceOffer([L('e5e5e5', 'iPhone 17', '256GB', '', 300, 650.01)], wave, input({ marginCents: 333 }))
    expect(r.lines[0]).toMatchObject({ saleCents: 653_34, lineSaleCents: 300 * 653_34, lineProfitCents: 300 * 333 })
    expect(Number.isInteger(r.totals.saleCents)).toBe(true)
  })

  it('the figures for the public offer carry description, quantity and sale price only, never cost or margin', () => {
    const r = priceOffer(nov12, wave, input({ marginCents: 700 }))
    const pub = publicLines(nov12, r)
    expect(pub[0]).toEqual({ description: 'iPhone 14 128GB AP Grade A+', qty: 200, unitSaleCents: 255_87 })
    for (const p of pub) expect(Object.keys(p).sort()).toEqual(['description', 'qty', 'unitSaleCents'])
    const json = JSON.stringify(pub)
    for (const secret of ['24887', '36263', '61767', 'cost', 'margin', 'profit']) expect(json).not.toContain(secret)
  })
})

describe('clients', () => {
  it('the first-run list is valid and has Wave (manual), EU Telecoms (fixed €4.00, locked) and a test client', () => {
    const s = seedClients()
    expect(checkClients(s)).toEqual({ ok: true, value: s })
    expect(s.map((c) => c.name)).toEqual(['Wave Phone B.V.', 'EU Telecoms BL EOOD', 'Test client (my own inbox)'])
    expect(s[0].margin).toEqual({ type: 'manual' })
    expect(s[1].margin).toEqual({ type: 'fixed', perUnitCents: 400, locked: true })
    expect(s[2].test).toBe(true)
    expect(s.every((c) => c.autoApprove === false)).toBe(true)
    expect(s[0].xeroContactId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('checks every field and says which client is wrong', () => {
    const c = (p: Partial<Client> | Record<string, unknown>) => checkClients([{ ...seedClients()[0], ...p }])
    expect(c({ name: '' })).toMatchObject({ ok: false })
    expect(c({ offerEmails: ['not-an-email'] })).toMatchObject({ ok: false, error: expect.stringContaining('not a valid email') })
    expect(c({ invoiceEmails: ['a@b.test', 'x'] })).toMatchObject({ ok: false })
    expect(c({ xeroContactId: 'abc' })).toMatchObject({ ok: false, error: expect.stringContaining('ContactID') })
    expect(c({ margin: { type: 'fixed', perUnitCents: 0, locked: true } })).toMatchObject({ ok: false })
    expect(c({ margin: { type: 'fixed', perUnitCents: 50_001, locked: false } })).toMatchObject({ ok: false })
    expect(c({ margin: { type: 'percent' } })).toMatchObject({ ok: false })
    expect(c({ terms: { days: 181 } })).toMatchObject({ ok: false })
    expect(c({ terms: 'upfront' })).toMatchObject({ ok: true })
    expect(c({ folder: 'desktop' })).toMatchObject({ ok: false })
    expect(c({ autoApprove: true })).toMatchObject({ ok: false, error: expect.stringContaining('auto-approve') })
    expect(checkClients([seedClients()[0], seedClients()[0]])).toMatchObject({ ok: false, error: expect.stringContaining('twice') })
    expect(checkClients('x')).toMatchObject({ ok: false })
  })
})

describe('saving prices and clients', () => {
  const env = { ...process.env }
  let dir: string
  beforeEach(() => {
    vi.resetModules()
    user.value = 'owner@example.test'
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-price-'))
    for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
    Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test' })
  })
  afterEach(() => {
    process.env = { ...env }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const offer = (p: Partial<Offer> = {}): Offer => ({ id: 'of_n12', status: 'ready', source: { gmailMessageId: 'n12', threadId: 't', rfcMessageId: null, from: 'Mobile One <supplier@example.test>', to: 'owner@example.test', subject: 'Offer', receivedAt: '2026-11-12T10:29:42Z' }, text: '', lines: nov12, createdAt: '', updatedAt: '', audit: [], ...p })
  const put = async (url: string, body: unknown, origin = 'https://dashboard.example.test') => {
    const route = url.endsWith('clients') ? await import('@/app/api/offers/clients/route') : await import('@/app/api/offers/route')
    return route.PUT(new Request(`https://dashboard.example.test${url}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }))
  }
  const stored = async () => (await (await import('@/lib/store')).getJson<Offer[]>((await import('@/lib/store')).getStore(), 'offers'))![0]

  it('prices a reviewed offer on the server from the cost it holds, and records who it is priced for', async () => {
    await (await import('@/lib/store')).getStore().set('offers', [offer()])
    const r = await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 700, overrides: { c3c3c3: 800 }, ackLow: false, saleCents: 1 })
    expect(r.status).toBe(200)
    const o = await stored()
    expect(o.pricing).toMatchObject({ clientId: 'c_wave', marginCents: 700, overrides: { c3c3c3: 800 }, ackLow: false })
    expect(o.audit.at(-1)!.what).toBe('Priced for Wave Phone B.V.: sale €119,420.50, profit €2,500.00')
    expect(JSON.stringify(o.pricing)).not.toContain('saleCents') // nothing the browser sends about prices is kept
  })

  it('refuses an unreviewed offer, a missing margin, an unticked low margin, and an unknown client', async () => {
    const { getStore } = await import('@/lib/store')
    await getStore().set('offers', [offer({ status: 'needs_review' })])
    expect((await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 700 })).status).toBe(409)
    await getStore().set('offers', [offer()])
    expect((await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: null })).status).toBe(409)
    const low = await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 70, ackLow: false })
    expect([low.status, (await low.json()).error]).toEqual([409, expect.stringContaining('under the minimum')])
    expect((await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_gone99', marginCents: 700 })).status).toBe(409)
    expect((await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 'seven' })).status).toBe(400)
    expect((await stored()).pricing).toBeUndefined()
    expect((await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 70, ackLow: true })).status).toBe(200)
  })

  it('removes a saved price when the lines or the status change, and on request', async () => {
    const { getStore } = await import('@/lib/store')
    await getStore().set('offers', [offer()])
    await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_eutelecoms' })
    expect((await stored()).pricing?.clientId).toBe('c_eutelecoms')
    const lines = nov12.map(({ sourceText: _s, ...l }) => ({ ...l, qty: l.qty + 1 }))
    await put('/api/offers', { action: 'save', id: 'of_n12', lines })
    const edited = await stored()
    expect(edited.pricing).toBeUndefined()
    expect(edited.audit.at(-1)!.what).toBe('Lines edited (3). Price removed: price it again')
    await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_eutelecoms' })
    await put('/api/offers', { action: 'status', id: 'of_n12', status: 'needs_review' })
    expect((await stored()).pricing).toBeUndefined()
    expect((await put('/api/offers', { action: 'unprice', id: 'of_n12' })).status).toBe(409) // nothing to remove
  })

  it('saves clients, and refuses to remove one that an offer is priced for', async () => {
    const { getStore, getJson } = await import('@/lib/store')
    await getStore().set('offers', [offer()])
    await put('/api/offers', { action: 'price', id: 'of_n12', clientId: 'c_wave', marginCents: 700 })
    const without = seedClients().filter((c) => c.id !== 'c_wave')
    const refused = await put('/api/offers/clients', { clients: without })
    expect([refused.status, (await refused.json()).error]).toEqual([409, expect.stringContaining('priced for them')])
    const edited = seedClients().map((c) => (c.id === 'c_wave' ? { ...c, terms: 'upfront' as const } : c))
    expect((await put('/api/offers/clients', { clients: edited })).status).toBe(200)
    expect((await getJson<Client[]>(getStore(), 'offers:clients'))![0].terms).toBe('upfront')
    expect((await put('/api/offers/clients', { clients: [{ id: 'c_x1', name: 'X', margin: { type: 'manual' } }] })).status).toBe(400)
  })

  it('needs the signed-in owner and the dashboard origin', async () => {
    expect((await put('/api/offers/clients', { clients: seedClients() }, 'https://evil.example')).status).toBe(403)
    expect((await put('/api/offers', { action: 'unprice', id: 'of_n12' }, 'https://evil.example')).status).toBe(403)
    user.value = false
    expect((await put('/api/offers/clients', { clients: seedClients() })).status).toBe(401)
    const { GET } = await import('@/app/api/offers/clients/route')
    expect((await GET(new Request('https://dashboard.example.test/api/offers/clients'))).status).toBe(401)
  })
})

describe('the price panel and the clients screen', () => {
  const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, '')
  const base: Offer = { id: 'of_n12', status: 'ready', source: { gmailMessageId: 'n12', threadId: 't', rfcMessageId: null, from: 'Mobile One <supplier@example.test>', to: 'owner@example.test', subject: 'Offer', receivedAt: '2026-11-12T10:29:42Z' }, text: '', lines: nov12, createdAt: '', updatedAt: '', audit: [] }
  const now = '2026-11-13T12:00:00Z'

  it('shows EU Telecoms at cost + €4.00 with sale, profit and totals per line', async () => {
    const { PricePanel } = await import('@/components/offers/price-panel')
    const html = render(h(PricePanel, { offer: { ...base, pricing: { clientId: 'c_eutelecoms', marginCents: null, overrides: {}, ackLow: false, pricedAt: now } }, clients: seedClients() }))
    for (const t of ['Fixed €4.00 per unit, locked', 'Priced for EU Telecoms BL EOOD', '€252.87', '€366.63', '€621.67', '€1,400.00', 'Update price']) expect(html, t).toContain(t)
    expect(html.match(/data-testid="price-line"/g)).toHaveLength(3)
    expect(html).not.toContain('Margin for line') // locked: no per-line inputs
  })

  it('shows Wave with an empty margin box and per-line overrides, and the red tick box for a typo', async () => {
    const { PricePanel } = await import('@/components/offers/price-panel')
    const typo = render(h(PricePanel, { offer: { ...base, pricing: { clientId: 'c_wave', marginCents: 70, overrides: {}, ackLow: false, pricedAt: now } }, clients: seedClients() }))
    expect(typo).toContain('You set the margin per offer')
    expect(typo).toContain('aria-label="Margin for line 1"')
    expect(typo).toContain('I know 3 lines are under €4.00 per unit.')
    expect(typo.match(/data-low="true"/g)).toHaveLength(3)
    const none = render(h(PricePanel, { offer: base, clients: seedClients() }))
    expect(none).not.toContain('price-line')
    expect(none).toContain('Choose a client…')
  })

  it('lists every client with its rule, and disables removing one that is in use', async () => {
    const { ClientsView } = await import('@/components/offers/clients-view')
    const html = render(h(ClientsView, { clients: seedClients(), usedBy: { c_wave: 1 } }))
    for (const t of ['Wave Phone B.V.', 'Fixed €4.00 per unit, locked', 'You set the margin per offer', 'Add client', 'Save clients', 'An offer is priced for this client']) expect(html, t).toContain(t)
    expect(html.match(/data-testid="client"/g)).toHaveLength(3)
    expect(html).toMatch(/disabled=""[^>]*title="An offer is priced for this client"|title="An offer is priced for this client"[^>]*disabled=""/)
  })
})
