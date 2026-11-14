import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AfterAcceptance } from '@/components/offers/after-acceptance'
import { XeroWriteCard } from '@/components/dashboard/xero-write-card'
import { checkDraftSettings, DEFAULT_DRAFT_SETTINGS } from '@/lib/offers/draft'
import { checkEdit } from '@/lib/offers/edit'
import type { Fulfilment, Offer } from '@/lib/offers/types'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const base: Offer = { id: 'o1', status: 'accepted', source: { gmailMessageId: 'm', threadId: 't', rfcMessageId: null, from: 'x', to: 'y', subject: 's', receivedAt: '2026-11-14T00:00:00Z' }, text: '', lines: [], createdAt: '', updatedAt: '', audit: [] }
const f = (o: Partial<Fulfilment> = {}): Fulfilment => ({ orderRef: 'FN-ORD-016', test: false, startedAt: '', reply: { state: 'sent', attempts: 1, to: 'bv@mobileone.info' }, draft: { state: 'done', attempts: 1, invoiceId: 'abc-123', invoiceNumber: '2026048', org: 'Fonenova Ltd' }, ...o })
const render = (fulfilment?: Fulfilment) => renderToString(h(AfterAcceptance, { offer: { ...base, fulfilment } }))

describe('After acceptance panel', () => {
  it('shows both steps done with the invoice number and a link to the draft', () => {
    const html = render(f())
    expect(html).toContain('FN-ORD-016')
    expect(html).toContain('Mobile One, in their thread')
    expect(html).toContain('2026048')
    expect(html).toContain('https://go.xero.com/app/invoicing/view/abc-123')
    expect(html).toContain('draft only')
    expect(html).not.toContain('Try again now')
  })
  it('shows a held reply with its reason and the OK button', () => {
    const html = render(f({ reply: { state: 'held', attempts: 1, reason: "Mobile One's offer is more than 48 hours old." } }))
    expect(html).toContain('Waiting for your OK')
    expect(html).toContain('more than 48 hours old')
    expect(html).toContain('OK, send the reply')
  })
  it('says a test reply goes to your inbox, not Mobile One', () => {
    const html = render(f({ test: true, orderRef: 'TEST-001' }))
    expect(html).toContain('nothing goes to Mobile One')
    expect(html).toContain('TEST-001')
  })
  it('a blocked draft says what is needed and offers Try again', () => {
    const html = render(f({ draft: { state: 'blocked', attempts: 0, reason: 'The Xero write connection is not set up.' } }))
    expect(html).toContain('Needs you')
    expect(html).toContain('Try again now')
  })
  it('an offer accepted before this existed can start the work', () => {
    expect(render(undefined)).toContain('Start reply and draft invoice')
  })
})

describe('Xero draft settings', () => {
  const state = { configured: true, connected: true, orgName: 'Demo Company (UK)', isDemo: true, settings: DEFAULT_DRAFT_SETTINGS }
  it('the card says which organisation and whether it is a demo, and holds no secret', () => {
    const html = renderToString(h(XeroWriteCard, { state, notice: 'connected-demo' }))
    expect(html).toContain('Demo Company (UK)')
    expect(html).toContain('test offers only')
    expect(html).toContain('Test offers can now create')
  })
  it('when not set up it names the variable to add', () => {
    expect(renderToString(h(XeroWriteCard, { state: { ...state, configured: false, connected: false, orgName: null, isDemo: null }, notice: null }))).toContain('XERO_WRITE_CLIENT_ID')
  })
  it('checks the saved values', () => {
    expect(checkDraftSettings({ taxType: 'none', accountCode: '200', brandingThemeId: '' })).toEqual({ ok: true, value: { taxType: 'NONE', accountCode: '200', brandingThemeId: null } })
    expect(checkDraftSettings({ taxType: 'NO NE', accountCode: '200' }).ok).toBe(false)
    expect(checkDraftSettings({ taxType: 'NONE', accountCode: '2 00' }).ok).toBe(false)
    expect(checkDraftSettings({ taxType: 'NONE', accountCode: '200', brandingThemeId: 'not-a-uuid' }).ok).toBe(false)
  })
})

describe('the new actions', () => {
  it('reply_ok and fulfil_retry are accepted by the edit check', () => {
    expect(checkEdit({ action: 'reply_ok', id: 'of_n1' }).ok).toBe(true)
    expect(checkEdit({ action: 'fulfil_retry', id: 'of_n1' }).ok).toBe(true)
  })
})
