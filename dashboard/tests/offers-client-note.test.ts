import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ClientsView } from '@/components/offers/clients-view'
import { buildDraftBody, DEFAULT_DRAFT_SETTINGS, isPricedLine } from '@/lib/offers/draft'
import { checkClients, seedClients } from '@/lib/offers/clients'
import { imeiLine, kindOf } from '@/lib/offers/imei'
import { splitCandidates } from '@/lib/offers/imei-pure'
import type { ImeiPack } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-18T10:00:00Z')
const WORDING = 'Margin scheme – Second-hand goods'
const base = { number: '2026053', reference: 'FN-ORD-017', contactId: 'a7401e62-a54e-495e-98cd-85f3c6c027b8', lines: [{ description: 'iPhone 16 128GB A', qty: 10, unitSaleCents: 45_700 }] as never, shippingCents: 24_000, terms: { days: 60 } as const, now: NOW, settings: DEFAULT_DRAFT_SETTINGS }
const total = (b: ReturnType<typeof buildDraftBody>) => b.LineItems.reduce((n, l) => n + (isPricedLine(l) ? l.Quantity * l.UnitAmount : 0), 0)

describe('a client\'s own line on the invoice', () => {
  it('is a text-only line after the items and shipping, and changes no total', () => {
    const plain = buildDraftBody(base)
    const noted = buildDraftBody({ ...base, note: `  ${WORDING}  ` })
    expect(noted.LineItems).toHaveLength(plain.LineItems.length + 1)
    const last = noted.LineItems[noted.LineItems.length - 1]
    expect(last).toEqual({ Description: WORDING })
    expect(Object.keys(last)).toEqual(['Description']) // no quantity, amount, account or tax
    expect(total(noted)).toBe(total(plain))
    expect(noted.LineItems.slice(0, -1)).toEqual(plain.LineItems)
  })
  it('is absent for a client without one, for an empty one and for blanks', () => {
    for (const note of [undefined, null, '', '   ']) expect(buildDraftBody({ ...base, note }).LineItems.every(isPricedLine)).toBe(true)
  })
  it('is saved by the client check, trimmed, and left out when empty', () => {
    const [wave, eu] = seedClients().map((c) => ({ ...c, termsConfirmed: true }))
    const ok = checkClients([{ ...eu, invoiceNote: `  ${WORDING} ` }, wave], [eu, wave])
    expect(ok.ok && ok.value[0].invoiceNote).toBe(WORDING)
    expect(ok.ok && 'invoiceNote' in ok.value[1]).toBe(false)
    const empty = checkClients([{ ...eu, invoiceNote: '   ' }], [eu])
    expect(empty.ok && 'invoiceNote' in empty.value[0]).toBe(false)
  })
  it('refuses a note that is too long, not text, or has a line break', () => {
    const eu = { ...seedClients()[1], termsConfirmed: true }
    expect(checkClients([{ ...eu, invoiceNote: 'x'.repeat(201) }], [eu])).toMatchObject({ ok: false, error: expect.stringContaining('200') })
    expect(checkClients([{ ...eu, invoiceNote: 5 }], [eu])).toMatchObject({ ok: false })
    expect(checkClients([{ ...eu, invoiceNote: 'one\nline' }], [eu])).toMatchObject({ ok: false, error: expect.stringContaining('one line') })
  })
  it('has a box on the Clients screen', () => {
    const eu = { ...seedClients()[1], invoiceNote: WORDING }
    const html = renderToString(h(ClientsView, { clients: [eu], usedBy: {} })).replace(/<!-- -->/g, '')
    expect(html).toContain('Line printed under the items on every invoice')
    expect(html).toContain('Margin scheme')
  })
})

describe('the IMEI finder', () => {
  const c = (filename: string, kind: 'imei' | 'label' | 'other') => ({ filename, kind })
  it('shows the IMEI lists first and keeps the label and invoice for "Show other files"', () => {
    const { imei, other } = splitCandidates([c('IMEI_2026050047.xlsx', 'imei'), c('DHL Label_2026050047.pdf', 'label'), c('2026050047.pdf', 'other')])
    expect(imei.map((x) => x.filename)).toEqual(['IMEI_2026050047.xlsx'])
    expect(other.map((x) => x.filename)).toEqual(['DHL Label_2026050047.pdf', '2026050047.pdf'])
    expect(kindOf('stock.csv', '')).toBe('imei')
    expect(kindOf('DHL Label_1.pdf', 'application/pdf')).toBe('label')
  })
  it('the email says IMEI list, and mentions other files only when the owner ticked one', () => {
    const f = (filename: string, kind: 'imei' | 'label') => ({ messageId: 'a', partId: '0.1', filename, mime: 'x', size: 1, kind })
    const pack = (files: ImeiPack['files']): ImeiPack => ({ threadId: 't', chosenAt: 'x', files })
    expect(imeiLine(pack([f('IMEI.xlsx', 'imei')]))).toBe('The IMEI list is attached: IMEI.xlsx.')
    expect(imeiLine(pack([f('a.xlsx', 'imei'), f('b.xlsx', 'imei')]))).toBe('The IMEI lists are attached: a.xlsx, b.xlsx.')
    expect(imeiLine(pack([f('IMEI.xlsx', 'imei'), f('label.pdf', 'label')]))).toContain('and the other files')
    expect(imeiLine(pack([f('IMEI.xlsx', 'imei')]))).not.toContain('shipping')
  })
})
