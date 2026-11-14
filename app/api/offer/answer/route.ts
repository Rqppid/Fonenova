import { after } from 'next/server'
import { allow, answerOnce, cleanRemarks, clientAgent, clientIp, getAnswer, getOffer, hashToken, notifyDashboard, offerState, publicStoreConfigured, validToken, type PublicAnswer } from '@/lib/offers-public'

export const dynamic = 'force-dynamic'

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' } })

/**
 * A client accepts or declines their offer. Single use: the answer is written with SET NX, so
 * of two answers arriving together exactly one is saved and the other is told it is answered.
 * Every unknown or malformed token gets the same plain "invalid" answer.
 */
export async function POST(req: Request) {
  if (!publicStoreConfigured()) return json({ error: 'unavailable' }, 503)
  const body = (await req.json().catch(() => null)) as { token?: unknown; decision?: unknown; remarks?: unknown; confirmed?: unknown } | null
  if (!body) return json({ error: 'invalid' }, 400)
  const ip = clientIp(req.headers)
  try {
    if (!(await allow(`ans:ip:${ip}`, 12, 600))) return json({ error: 'rate' }, 429)
    if (!validToken(body.token)) return json({ error: 'invalid' }, 404)
    const hash = hashToken(body.token)
    if (!(await allow(`ans:tok:${hash}`, 30, 3600))) return json({ error: 'rate' }, 429)

    const decision = body.decision
    if (decision !== 'accept' && decision !== 'decline') return json({ error: 'invalid' }, 400)
    const remarks = cleanRemarks(body.remarks)
    if (remarks === null) return json({ error: 'remarks' }, 400)
    if (decision === 'accept' && body.confirmed !== true) return json({ error: 'confirm' }, 400)

    const offer = await getOffer(hash)
    if (!offer) return json({ error: 'invalid' }, 404)
    const existing = await getAnswer(hash)
    const state = offerState(offer, existing)
    if (state === 'answered') return json({ error: 'answered' }, 409)
    if (state !== 'open') return json({ error: state }, 409)

    const answer: PublicAnswer = { decision, remarks, at: new Date().toISOString(), ip, ua: clientAgent(req.headers) }
    if (!(await answerOnce(hash, answer))) return json({ error: 'answered' }, 409)
    after(() => notifyDashboard(hash))
    return json({ ok: true, decision, at: answer.at })
  } catch {
    return json({ error: 'unavailable' }, 503)
  }
}
