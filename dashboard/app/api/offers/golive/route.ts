import { MANUAL_ITEMS } from '@/lib/offers/golive'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getJson, getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** Tick or untick one of the things only the owner can confirm. Signed-in, same-origin only. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const b = (await req.json().catch(() => null)) as { id?: unknown; done?: unknown } | null
  const item = MANUAL_ITEMS.find((m) => m.id === b?.id)
  if (!b || !item || typeof b.done !== 'boolean') return json({ error: 'Unknown checklist item' }, 400)
  const store = getStore()
  const out = await store.withLock('offers:golive', async () => {
    const ticks = { ...((await getJson<Record<string, string>>(store, 'offers:golive')) ?? {}) }
    if (b.done) ticks[item.id] = new Date().toISOString()
    else delete ticks[item.id]
    await store.set('offers:golive', ticks)
    return ticks
  })
  return json({ ok: true, ticks: out })
}
