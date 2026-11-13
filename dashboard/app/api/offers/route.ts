import { applyEdit, checkEdit } from '@/lib/offers/edit'
import type { Offer } from '@/lib/offers/types'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getJson, getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** Save Hamza's review of an offer: edited lines, or its status. Signed-in, same-origin only. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const checked = checkEdit(await req.json().catch(() => null))
  if (!checked.ok) return json({ error: checked.error }, 400)
  const store = getStore()
  const out = await store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.id === checked.value.id)
    if (i < 0) return { error: 'That offer no longer exists', status: 404 }
    const next = applyEdit(offers[i], checked.value, new Date().toISOString())
    if ('error' in next) return { error: next.error, status: 409 }
    offers[i] = next
    await store.set('offers', offers)
    return { offer: next }
  })
  return 'error' in out ? json({ error: out.error }, out.status) : json({ ok: true, offer: out.offer })
}
