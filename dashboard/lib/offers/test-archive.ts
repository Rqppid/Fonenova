/**
 * Clearing test offers off the list. Only a TEST offer can be cleared, never a real one. Nothing is deleted:
 * the offer stays on file, so its order reference (TEST-0xx) is never handed out again (a new test reusing a
 * reference would "find" the old Demo draft with that reference). It is only hidden, and can be shown again
 * with "Show finished test offers". Nothing in Xero is touched.
 */
import { getJson, type Store } from '../store'
import { log } from './fulfil'
import type { Offer } from './types'

export interface ArchiveResult { ok: boolean; archived: number; skipped: number; message: string }

/** One test offer (by id) or every test offer not already cleared. One waiting to be invoiced automatically is skipped: press Hold first. */
export async function archiveTestOffers(store: Store, which: { id: string } | 'all', now: Date = new Date()): Promise<ArchiveResult> {
  return store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const at = now.toISOString()
    let archived = 0
    let skipped = 0
    if (which !== 'all') {
      const o = offers.find((x) => x.id === which.id)
      if (!o) return { ok: false, archived: 0, skipped: 0, message: 'That offer does not exist.' }
      if (!o.testOnly) return { ok: false, archived: 0, skipped: 0, message: 'Only a test offer can be cleared. A real offer is never removed.' }
    }
    const next = offers.map((o) => {
      if (!o.testOnly || o.archived) return o
      if (which !== 'all' && o.id !== which.id) return o
      const a = o.fulfilment?.auto?.state
      if (a === 'scheduled' || a === 'running') { skipped++; return o }
      archived++
      return { ...o, archived: true, updatedAt: at, audit: log(o, at, 'Test offer cleared from the list') }
    })
    if (archived > 0) await store.set('offers', next)
    const message = which !== 'all' && archived === 0 && skipped > 0 ? 'It is waiting to be invoiced automatically. Press Hold on it first.'
      : `${archived} test offer${archived === 1 ? '' : 's'} cleared${skipped ? `; ${skipped} waiting to be invoiced were left (press Hold first)` : ''}.`
    return { ok: which === 'all' || archived > 0, archived, skipped, message }
  })
}
