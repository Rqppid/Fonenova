import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OfferDetail } from '@/components/offers/offers-view'
import { seedClients } from '@/lib/offers/clients'
import { nextStep } from '@/lib/offers/next-step'
import type { Fulfilment, Offer, OfferSend } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const eu = seedClients().find((c) => c.id === 'c_eutelecoms')!
const send = (over: Partial<OfferSend> = {}): OfferSend => ({ clientId: 'c_eutelecoms', clientName: 'EU', to: [], tokenHash: 'a'.repeat(64), tokenHint: 'abc', sentAt: '2026-11-20T10:00:00Z', expiresAt: '2026-11-21T10:00:00Z', totalCents: 1_000_000, units: 10, test: false, gmailMessageId: 'g', outcome: 'pending', ...over })
const offer = (over: Partial<Offer> = {}): Offer => ({ id: 'o1', status: 'ready', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'x', to: 'y', subject: 's', receivedAt: '2026-11-20T09:00:00Z' }, text: '', lines: [{ id: 'l', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 1, unitCostCents: 45_000, sourceText: '', note: null }], createdAt: '', updatedAt: '', audit: [], ...over })
const f = (over: Partial<Fulfilment> = {}): Fulfilment => ({ orderRef: 'FN-ORD-017', test: false, startedAt: '', reply: { state: 'sent', attempts: 1 }, draft: { state: 'off', attempts: 0 }, ...over })
const pricing = { clientId: 'c_eutelecoms', marginCents: 500, overrides: {}, ackLow: false, shippingLater: true as const, pricedAt: '' }

describe('the next step, for every state', () => {
  it('before sending', () => {
    expect(nextStep(offer({ status: 'needs_review' }), null, false)).toContain('Mark reviewed')
    expect(nextStep(offer(), null, false)).toContain('Mark priced')
    expect(nextStep(offer({ pricing }), eu, false)).toContain('Send it from the Send panel')
    expect(nextStep(offer({ pricing }), eu, false)).toContain('Offer sent manually by email')
  })
  it('out with the client', () => {
    expect(nextStep(offer({ status: 'sent', sends: [send()] }), eu, false)).toContain('Telegram')
    expect(nextStep(offer({ status: 'sent', sends: [send({ tokenHint: 'manual' })] }), eu, false)).toContain('Client accepted by email')
  })
  it('after the answer', () => {
    expect(nextStep(offer({ status: 'declined' }), eu, false)).toContain('Unlock')
    expect(nextStep(offer({ status: 'expired' }), eu, false)).toContain('expired')
    expect(nextStep(offer({ status: 'dismissed' }), eu, false)).toContain('Restore')
  })
  it('accepted, while Invoice2go makes the invoices: goods, then the DHL cost, then the invoice, then done', () => {
    const base = { status: 'accepted' as const, pricing, sends: [send({ outcome: 'accepted' })] }
    expect(nextStep(offer({ ...base, fulfilment: f({ reply: { state: 'held', attempts: 0 } }) }), eu, false)).toContain('OK, send the reply')
    expect(nextStep(offer({ ...base, fulfilment: f({ reply: { state: 'failed', attempts: 2 } }) }), eu, false)).toContain('failing')
    expect(nextStep(offer({ ...base, fulfilment: f() }), eu, false)).toContain('Goods arrived')
    expect(nextStep(offer({ ...base, fulfilment: f({ order: { goodsArrivedAt: 'x' } }) }), eu, false)).toContain('our DHL cost')
    expect(nextStep(offer({ ...base, fulfilment: f({ order: { goodsArrivedAt: 'x', dhlCostCents: 8_550 } }) }), eu, false)).toContain('Create the invoice in Invoice2go for €10,085.50')
    expect(nextStep(offer({ ...base, fulfilment: f({ order: { goodsArrivedAt: 'x', dhlCostCents: 8_550, invoice2go: { number: '2026049', linkedAt: '' } } }) }), eu, false)).toContain('2026049')
  })
  it('accepted, in dashboard invoicing mode (dormant)', () => {
    const base = { status: 'accepted' as const, pricing, sends: [send({ outcome: 'accepted' })] }
    expect(nextStep(offer({ ...base, fulfilment: f({ draft: { state: 'waiting', attempts: 0 } }) }), eu, true)).toContain('Shipping box')
    expect(nextStep(offer({ ...base, fulfilment: f({ draft: { state: 'blocked', attempts: 0 } }) }), eu, true)).toContain('Try again')
    expect(nextStep(offer({ ...base, fulfilment: f({ draft: { state: 'done', attempts: 0 } }) }), eu, true)).toContain('Check the draft invoice')
  })
  it('is shown at the top of every offer', () => {
    const html = renderToString(h(OfferDetail, { offer: offer({ status: 'needs_review' }), clients: seedClients() })).replace(/<!-- -->/g, '')
    expect(html).toContain('data-testid="next-step"')
    expect(html).toContain('Mark reviewed')
  })
})
