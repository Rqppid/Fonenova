import { NextResponse } from 'next/server'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { refreshXeroWriteOrgs } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

/** Re-list the organisations the write app is connected to. Signed-in and same-origin only. Changes no selection that is still valid. */
export async function POST(req: Request): Promise<NextResponse> {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  try {
    return json({ ok: true, status: await refreshXeroWriteOrgs() })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached' }, 502)
  }
}
