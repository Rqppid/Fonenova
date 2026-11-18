import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoInvoiceOf, backfillClientDefaults, chargeFor, clientsFrom, seedClients, shippingBasisOf, type Client } from '@/lib/offers/clients'

// A client list saved before the two settings were explicit.
const legacy = (): Client[] => seedClients().map(({ shippingBasis: _b, autoInvoice: _a, ...c }) => ({ ...c, termsConfirmed: true }) as Client)

describe('every client is an ordinary record', () => {
  it('a new client has plain defaults: Mobile One x multiplier, automatic off', () => {
    const fresh = { id: 'c_newone', name: 'New', xeroContactId: null, offerEmails: [], invoiceEmails: [], margin: { type: 'manual' }, terms: { days: 30 }, termsConfirmed: true, shippingMultiplier: 3, autoApprove: false, folder: 'other', test: false } as Client
    expect(shippingBasisOf(fresh)).toBe('mobile_one')
    expect(autoInvoiceOf(fresh)).toBe(false)
    expect(chargeFor(fresh, 10_000)).toBe(30_000)
    expect(chargeFor({ ...fresh, shippingBasis: 'own_dhl' }, 10_000)).toBe(10_000)
  })
  it('old saved lists keep what Wave, EU Telecoms and the test client effectively had, and the migration is idempotent', () => {
    const once = backfillClientDefaults(legacy())
    const [wave, eu, test] = once
    expect([shippingBasisOf(wave), autoInvoiceOf(wave)]).toEqual(['mobile_one', true])
    expect([shippingBasisOf(eu), autoInvoiceOf(eu)]).toEqual(['own_dhl', true])
    expect([shippingBasisOf(test), autoInvoiceOf(test)]).toEqual(['mobile_one', true])
    expect(backfillClientDefaults(once)).toEqual(once)
    // an unknown extra client in an old list gets the plain defaults
    const extra = { ...legacy()[0], id: 'c_extra', name: 'Extra' } as Client
    const r = backfillClientDefaults([...legacy(), extra]).find((c) => c.id === 'c_extra')!
    expect([r.shippingBasis, r.autoInvoice]).toEqual(['mobile_one', false])
  })
  it('explicit settings always win over the migration', () => {
    const l = legacy()
    l[1] = { ...l[1], shippingBasis: 'mobile_one', autoInvoice: false }
    const eu = backfillClientDefaults(l)[1]
    expect([eu.shippingBasis, eu.autoInvoice]).toEqual(['mobile_one', false])
    expect(clientsFrom(null).find((c) => c.id === 'c_eutelecoms')!.shippingBasis).toBe('own_dhl')
  })
  it('no code treats a client specially by id, except the one migration', () => {
    const roots = ['lib', 'components', 'app']
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e.name) && /c_eutelecoms|c_wave/.test(fs.readFileSync(p, 'utf8'))) hits.push(p)
      }
    }
    for (const r of roots) walk(path.join(process.cwd(), r))
    expect(hits.map((h) => path.relative(process.cwd(), h))).toEqual(['lib/offers/clients.ts'])
  })
})
