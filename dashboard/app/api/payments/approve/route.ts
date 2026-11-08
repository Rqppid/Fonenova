import { approve } from '@/lib/payments-source'
import { guard, paymentsJson } from '@/lib/payments-guard'
import { checkApprove } from '@/lib/payments-validate'

export const dynamic = 'force-dynamic'

/** Allocate an exception's payment to the invoice the owner chose. Nothing is allocated otherwise. */
export async function POST(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const checked = checkApprove(await req.json().catch(() => null))
  if (!checked.ok) return paymentsJson({ error: checked.error }, 400)
  const r = await approve(checked.value)
  if (r.kind === 'ok') return paymentsJson({ ok: true })
  if (r.kind === 'refused') return paymentsJson({ error: r.error }, r.status)
  if (r.kind === 'not-configured') return paymentsJson({ error: 'The payments service is not configured here.' }, 503)
  return paymentsJson({ error: r.message }, 502)
}
