import { NextResponse, type NextRequest } from 'next/server'
import { authBypassed, authConfig, cookieOptions, createSession, readSession, safeNext, SESSION_COOKIE, SESSION_TTL_SECONDS, sessionNeedsRenewal } from '@/lib/auth'

/**
 * Gate every request behind the owner's session. The page re-checks the session itself,
 * so this is the first of two locks, not the only one.
 */
export async function proxy(req: NextRequest) {
  if (authBypassed()) return NextResponse.next()

  const cfg = authConfig()
  const session = cfg.ok ? await readSession(req.cookies.get(SESSION_COOKIE)?.value, cfg.config) : null
  if (session) {
    const res = NextResponse.next()
    res.headers.set('Cache-Control', 'private, no-store')
    // Using the dashboard keeps you signed in: a session a day old gets a fresh 30 days.
    if (cfg.ok && sessionNeedsRenewal(session)) res.cookies.set(SESSION_COOKIE, await createSession(session.email, cfg.config), cookieOptions(SESSION_TTL_SECONDS))
    return res
  }

  if (req.method === 'GET' && req.headers.get('accept')?.includes('text/html')) {
    // Remember where they were going (a Telegram link to one offer), so sign-in brings them back to it.
    const next = safeNext(req.nextUrl.pathname + req.nextUrl.search)
    return NextResponse.redirect(new URL(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`, req.url))
  }
  return new NextResponse('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } })
}

export const config = {
  // Everything except the sign-in flow itself, robots.txt, Next's static build assets
  // (hashed JS/CSS with no data in them), the scheduled sync, which checks its own
  // CRON_SECRET bearer token instead and returns no figures, and the OneDrive tracker routes for
  // the payments service, which check their own ONEDRIVE_WRITE_TOKEN bearer token, and the one
  // route where the public offer site says "an answer arrived" (OFFERS_WEBHOOK_TOKEN bearer; it
  // only makes the dashboard re-read the answer, so a forged call changes nothing).
  matcher: ['/((?!login|auth/|api/cron/|api/onedrive/|api/offers/answered|robots\\.txt|manifest\\.webmanifest|apple-icon|icon-192|icon-512|_next/static|_next/image|favicon\\.ico|icon\\.svg).*)'],
}
