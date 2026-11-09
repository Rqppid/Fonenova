/**
 * The checks every payments route runs before anything else: a signed-in owner (the same
 * session as the rest of the dashboard), and for changes, a request from the dashboard's own
 * origin. proxy.ts has already turned away anyone without a session; this is the second lock.
 */
import 'server-only'
import { NextResponse } from 'next/server'
import { currentUser } from './session'

const NO_STORE = { 'Cache-Control': 'no-store' }

export function paymentsJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

/** The dashboard's public origin: AUTH_URL when set, else the request's own (local dev). */
function ownOrigin(req: Request): string {
  try {
    return new URL(process.env.AUTH_URL ?? req.url).origin
  } catch {
    return new URL(req.url).origin
  }
}

/** Null when the request may go on, else the response to send instead. */
export async function guard(req: Request, opts: { write: boolean }): Promise<NextResponse | null> {
  if ((await currentUser()) === false) return paymentsJson({ error: 'Not signed in' }, 401)
  if (opts.write) {
    const origin = req.headers.get('origin')
    if (!origin || origin !== ownOrigin(req)) return paymentsJson({ error: 'This request did not come from the dashboard' }, 403)
  }
  return null
}
