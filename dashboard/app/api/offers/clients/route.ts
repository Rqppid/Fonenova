import { checkClients } from '@/lib/offers/clients'
import { loadClients, loadOffers } from '@/lib/offers/store'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const stop = await guard(req, { write: false })
  if (stop) return stop
  return json({ clients: await loadClients() })
}

/** Save the whole client list. Signed-in, same-origin, every field checked. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const body = (await req.json().catch(() => null)) as { clients?: unknown } | null
  const checked = checkClients(body?.clients)
  if (!checked.ok) return json({ error: checked.error }, 400)
  const keep = new Set(checked.value.map((c) => c.id))
  const gone = (await loadOffers()).find((o) => o.pricing && !keep.has(o.pricing.clientId))
  if (gone) return json({ error: `A client cannot be removed while "${gone.source.subject || 'an offer'}" is priced for them. Remove that price first.` }, 409)
  await getStore().set('offers:clients', checked.value)
  return json({ ok: true, clients: checked.value })
}
