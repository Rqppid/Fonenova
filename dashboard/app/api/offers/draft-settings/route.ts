import { checkDraftSettings } from '@/lib/offers/draft'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** Save how draft invoices are built (tax type, sales account, branding theme). Signed-in, same-origin only. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const checked = checkDraftSettings(await req.json().catch(() => null))
  if (!checked.ok) return json({ error: checked.error }, 400)
  await getStore().set('offers:draft-settings', checked.value)
  return json({ ok: true, settings: checked.value })
}
