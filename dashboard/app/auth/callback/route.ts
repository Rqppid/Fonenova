import { NextResponse, type NextRequest } from 'next/server'
import { authConfig, cookieOptions, createSession, finishOAuth, OAUTH_COOKIE, safeNext, SESSION_COOKIE, SESSION_TTL_SECONDS } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const cfg = authConfig()
  if (!cfg.ok) return NextResponse.redirect(new URL('/login?error=config', req.url))
  const c = cfg.config

  const result = await finishOAuth(c, req.nextUrl.searchParams, req.cookies.get(OAUTH_COOKIE)?.value)
  const res = result.ok
    ? NextResponse.redirect(new URL(safeNext(result.next), c.origin))
    : NextResponse.redirect(new URL(`/login?error=${result.reason}`, c.origin))
  res.cookies.set(OAUTH_COOKIE, '', cookieOptions(0))
  if (result.ok) res.cookies.set(SESSION_COOKIE, await createSession(result.email, c), cookieOptions(SESSION_TTL_SECONDS))
  res.headers.set('Cache-Control', 'no-store')
  return res
}
