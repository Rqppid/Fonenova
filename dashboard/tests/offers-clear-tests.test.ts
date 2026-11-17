import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OfferDetail, OffersView } from '@/components/offers/offers-view'
import { applyEdit, checkEdit } from '@/lib/offers/edit'
import { seedClients } from '@/lib/offers/clients'
import { archiveTestOffers } from '@/lib/offers/test-archive'
import { makeTestOffer } from '@/lib/offers/test-offer'
import type { Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = '2026-11-18T10:00:00.000Z'
function mem(initial: Offer[]): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>([['offers', initial]])
  const tails = new Map<string, Promise<unknown>>()
  return { name: 'mem', data, async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(n: string, fn: () => Promise<T>) { const prev = tails.get(n) ?? Promise.resolve(); const run = prev.then(fn, fn); tails.set(n, run.catch(() => {})); return run } }
}
const test = (id: string, over: Partial<Offer> = {}): Offer => ({ ...makeTestOffer(NOW), id, status: 'accepted', ...over })
const real = (id: string): Offer => ({ ...makeTestOffer(NOW), id, testOnly: undefined, status: 'accepted' })
const offersOf = (s: ReturnType<typeof mem>) => s.data.get('offers') as Offer[]

describe('clearing test offers', () => {
  it('clears every test offer, keeps them on file, never touches a real one', async () => {
    const s = mem([test('of_t1'), test('of_t2'), real('of_r1')])
    const r = await archiveTestOffers(s, 'all', new Date(NOW))
    expect(r).toMatchObject({ ok: true, archived: 2, skipped: 0, message: '2 test offers cleared.' })
    const o = offersOf(s)
    expect(o).toHaveLength(3) // nothing deleted: their order references stay used
    expect(o.find((x) => x.id === 'of_t1')!.archived).toBe(true)
    expect(o.find((x) => x.id === 'of_r1')!.archived).toBeUndefined()
    expect(o.find((x) => x.id === 'of_t1')!.audit.at(-1)!.what).toContain('cleared')
  })
  it('clears one test offer by id, and refuses a real offer or one that does not exist', async () => {
    const s = mem([test('of_t1'), test('of_t2'), real('of_r1')])
    expect(await archiveTestOffers(s, { id: 'of_t1' })).toMatchObject({ ok: true, archived: 1 })
    expect(offersOf(s).filter((x) => x.archived).map((x) => x.id)).toEqual(['of_t1'])
    expect(await archiveTestOffers(s, { id: 'of_r1' })).toMatchObject({ ok: false, message: expect.stringContaining('A real offer is never removed') })
    expect(await archiveTestOffers(s, { id: 'of_missing' })).toMatchObject({ ok: false })
    expect(offersOf(s).find((x) => x.id === 'of_r1')!.archived).toBeUndefined()
  })
  it('leaves one that is waiting to be invoiced automatically, and says to press Hold', async () => {
    const waiting = test('of_t3', { fulfilment: { orderRef: 'TEST-003', test: true, startedAt: NOW, reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1 }, auto: { state: 'scheduled', dueAt: NOW } } })
    const s = mem([test('of_t1'), waiting])
    const all = await archiveTestOffers(s, 'all')
    expect(all).toMatchObject({ ok: true, archived: 1, skipped: 1, message: expect.stringContaining('press Hold first') })
    expect(await archiveTestOffers(s, { id: 'of_t3' })).toMatchObject({ ok: false, message: expect.stringContaining('Press Hold') })
    expect(offersOf(s).find((x) => x.id === 'of_t3')!.archived).toBeUndefined()
  })
  it('clearing again does nothing and invents no work', async () => {
    const s = mem([test('of_t1')])
    await archiveTestOffers(s, 'all')
    expect(await archiveTestOffers(s, 'all')).toMatchObject({ ok: true, archived: 0, message: '0 test offers cleared.' })
  })
  it('the edit checker accepts the two actions and keeps them out of the normal save path', () => {
    expect(checkEdit({ action: 'archive_all_tests' })).toEqual({ ok: true, value: { action: 'archive_all_tests' } })
    expect(checkEdit({ action: 'archive_test', id: 'of_test_abc' })).toEqual({ ok: true, value: { action: 'archive_test', id: 'of_test_abc' } })
    expect(checkEdit({ action: 'archive_test', id: '../x' })).toMatchObject({ ok: false })
    expect(applyEdit(test('of_t1', { status: 'ready' }), { action: 'archive_test', id: 'of_t1' }, NOW)).toMatchObject({ error: expect.stringContaining('handled separately') })
  })
})

describe('what the screen shows', () => {
  const view = (offers: Offer[]) => renderToString(h(OffersView, { offers, status: null, setup: { gmail: null, telegram: false, schedule: true }, selected: null, clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
  const items = (html: string) => (html.match(/data-testid="offer-item"/g) ?? []).length
  it('a cleared test offer is out of the list but counted under "Show finished test offers"', () => {
    const html = view([test('of_t1', { archived: true }), test('of_t2', { archived: true }), real('of_r1')])
    expect(items(html)).toBe(1)
    expect(html).toContain('Show finished test offers (2)')
    expect(html).not.toContain('clear-tests-button') // nothing left to clear
  })
  it('shows "Clear all test offers (N)" while there are test offers, and never for real ones alone', () => {
    const html = view([test('of_t1'), test('of_t2'), real('of_r1')])
    expect(html).toContain('clear-tests-button')
    expect(html).toContain('Clear all test offers (2)')
    expect(view([real('of_r1')])).not.toContain('clear-tests-button')
  })
  it('a test offer has its own remove button; a real one does not', () => {
    const detail = (o: Offer) => renderToString(h(OfferDetail, { offer: o, clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
    expect(detail(test('of_t1'))).toContain('clear-test-button')
    expect(detail(test('of_t1', { archived: true }))).not.toContain('clear-test-button')
    expect(detail(real('of_r1'))).not.toContain('clear-test-button')
  })
})
