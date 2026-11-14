import { NextResponse } from 'next/server'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { selectXeroWriteOrg, xeroWriteStatus } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

/**
 * Choose which connected organisation drafts go to. Signed-in and same-origin only. Choosing a live
 * organisation needs `confirmLive: true` on top: a separate, deliberate step from connecting it.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const b = (await req.json().catch(() => null)) as { tenantId?: unknown; confirmLive?: unknown } | null
  if (!b || typeof b.tenantId !== 'string' || !/^[0-9a-f-]{20,40}$/i.test(b.tenantId)) return json({ error: 'Choose an organisation from the list.' }, 400)
  const r = await selectXeroWriteOrg(b.tenantId, { confirmLive: b.confirmLive === true })
  if (!r.ok) return json({ error: r.error }, 409)
  return json({ ok: true, status: await xeroWriteStatus() })
}
