import { describe, expect, it, vi } from 'vitest'
import { imeiLine, kindOf } from '@/lib/offers/imei'
import { splitCandidates } from '@/lib/offers/imei-pure'
import type { ImeiPack } from '@/lib/offers/types'

vi.mock('server-only', () => ({}))

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
