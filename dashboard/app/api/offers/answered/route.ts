import { NextResponse } from 'next/server'
import { bearerOk } from '@/lib/bearer'
import { webhookProblem } from '@/lib/offers/env-check'
import { ownerEmail } from '@/lib/offers/owner-email'
import { applyAnswer } from '@/lib/offers/resolve'
import { notify } from '@/lib/offers/telegram'
import { getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Called by fonenova.com when a client answers an offer, with `Authorization: Bearer
 * OFFERS_WEBHOOK_TOKEN` and only `{ hash }`. The answer itself is read from the public store here,
 * never taken from the call, so a forged call can at most make this look again. Outside the
 * Google sign-in (proxy.ts), so the bearer token is its only lock.
 */
export async function POST(req: Request) {
  // Unset, or set to something mistyped: treated as not configured (the 5-minute check still picks answers up).
  if (!process.env.OFFERS_WEBHOOK_TOKEN || webhookProblem(process.env.OFFERS_WEBHOOK_TOKEN)) return json({ error: 'not configured' }, 503)
  if (!bearerOk(req.headers.get('authorization'), process.env.OFFERS_WEBHOOK_TOKEN)) return json({ error: 'unauthorized' }, 401)
  const body = (await req.json().catch(() => null)) as { hash?: unknown } | null
  if (!body || typeof body.hash !== 'string' || !/^[0-9a-f]{64}$/.test(body.hash)) return json({ error: 'invalid' }, 400)
  try {
    const store = getStore()
    const r = await applyAnswer(body.hash, { store, notify, email: ownerEmail(store), dashboardUrl: process.env.AUTH_URL?.replace(/\/$/, '') })
    return json({ ok: true, changed: r.changed })
  } catch {
    return json({ error: 'unavailable' }, 503) // the 5-minute check will pick the answer up
  }
}
