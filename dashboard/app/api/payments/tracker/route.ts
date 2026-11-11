import { NextResponse } from 'next/server'
import { trackerFile } from '@/lib/payments-source'
import { guard, paymentsJson } from '@/lib/payments-guard'
import { checkTracker } from '@/lib/payments-validate'
import { KNOWN_TRACKERS } from '@/lib/payments-types'

export const dynamic = 'force-dynamic'

/** Pass the service's Excel tracker through, behind the dashboard sign-in. */
export async function GET(req: Request) {
  const stop = await guard(req, { write: false })
  if (stop) return stop
  const key = checkTracker(new URL(req.url).searchParams.get('key'))
  if (!key.ok) return paymentsJson({ error: key.error }, 400)
  const r = await trackerFile(key.value)
  if (r.kind === 'not-configured') return paymentsJson({ error: 'The payments service is not configured here.' }, 503)
  if (r.kind === 'refused') return paymentsJson({ error: r.error }, r.status)
  if (r.kind === 'error') return paymentsJson({ error: r.message }, 502)
  const date = new Date().toISOString().slice(0, 10)
  return new NextResponse(r.data.body, {
    headers: {
      'Content-Type': r.data.headers.get('content-type') ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${KNOWN_TRACKERS[key.value] ?? key.value} payments ${date}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
