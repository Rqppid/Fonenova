import { NextResponse } from 'next/server'
import { authConfig, cookieOptions, OAUTH_COOKIE, safeNext, startOAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const cfg = authConfig()
  if (!cfg.ok) return NextResponse.redirect(new URL('/login?error=config', req.url))
  const { url, cookie } = await startOAuth(cfg.config, safeNext(new URL(req.url).searchParams.get('next')))
  const res = NextResponse.redirect(url)
  res.cookies.set(OAUTH_COOKIE, cookie, cookieOptions(600))
  res.headers.set('Cache-Control', 'no-store')
  return res
}
