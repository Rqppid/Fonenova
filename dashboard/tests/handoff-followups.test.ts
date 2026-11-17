import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OffersView } from '@/components/offers/offers-view'
import { seedClients } from '@/lib/offers/clients'
import { invoiceGaps } from '@/lib/health'
import { makeTestOffer } from '@/lib/offers/test-offer'
import type { Offer } from '@/lib/offers/types'
import type { XeroInvoice } from '@/lib/types'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', async () => ({ useRouter: () => ({ refresh: () => {} }), redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }) } }))

describe('/settings', () => {
  it('lands on the Settings section of the home page instead of a 404', async () => {
    const { default: Page } = await import('@/app/settings/page')
    let to = ''
    try { Page() } catch (e) { to = (e as { to?: string }).to ?? '' }
    expect(to).toBe('/#settings')
  })
})

describe('finished test offers are tucked away', () => {
  const NOW = '2026-11-15T10:00:00.000Z'
  const view = (offers: Offer[], selected: string | null = null) => renderToString(h(OffersView, { offers, status: null, setup: { gmail: null, telegram: false, schedule: true }, selected, clients: seedClients(), send: { allowReal: false, storeProblem: null, gmailProblem: null } })).replace(/<!-- -->/g, '')
  const open = makeTestOffer(NOW)
  const done = { ...makeTestOffer(NOW), id: 'of_test_done', status: 'declined' as const }
  const real: Offer = { ...makeTestOffer(NOW), id: 'of_real1', testOnly: undefined, status: 'accepted', source: { ...open.source, subject: 'Real offer from Mobile One' } }
  it('hides an answered test offer by default but keeps open test offers and real ones', () => {
    const html = view([open, done, real])
    expect(html.match(/data-testid="offer-item"/g)).toHaveLength(2)
    expect(html).toContain('Real offer from Mobile One')
    expect(html).toContain('Show finished test offers (1)')
  })
  it('shows nothing extra when there are no finished test offers', () => {
    expect(view([open, real])).not.toContain('Show finished test offers')
  })
  it('an offer that is open in the detail view is never hidden from the list', () => {
    expect(view([open, done], 'of_test_done').match(/data-testid="offer-item"/g)).toHaveLength(2)
  })
})

describe('the invoice-number watchdog and the numbers that were tested away', () => {
  const inv = (number: string, status: string): XeroInvoice => ({ id: number, number, reference: '', kind: 'sale', status, contactName: 'x', currency: 'EUR', date: '2026-11-15', dueDate: null, totalCents: 1, amountDueCents: 0, amountPaidCents: 0, payments: [] })
  it('a voided invoice that still exists counts as used, so 2026049 is no gap', () => {
    expect(invoiceGaps([inv('2026047', 'PAID'), inv('2026049', 'VOIDED'), inv('2026051', 'AUTHORISED')], ['2026048', '2026050'])).toEqual([])
  })
  it('deleted drafts are gaps until marked "not used" in Settings', () => {
    const list = [inv('2026047', 'PAID'), inv('2026049', 'VOIDED'), inv('2026051', 'AUTHORISED')]
    expect(invoiceGaps(list)).toEqual(['2026048', '2026050'])
    expect(invoiceGaps(list, ['2026048'])).toEqual(['2026050'])
  })
})
