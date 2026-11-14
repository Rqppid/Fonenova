import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/session'
import { startXeroWriteAuth, xeroWriteAvailable, xeroWriteConfig } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'
const COOKIE = 'fn_xero_write_oauth'

export async function GET(req: Request) {
  if ((await currentUser()) === false) return NextResponse.redirect(new URL('/login', req.url))
  const c = xeroWriteConfig()
  if (!c || !xeroWriteAvailable()) return NextResponse.redirect(new URL('/?xerowrite=not-configured#settings', req.url))
  const { url, state, verifier } = startXeroWriteAuth(c)
  const res = NextResponse.redirect(url)
  res.cookies.set(COOKIE, JSON.stringify({ state, verifier }), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/xero-write', maxAge: 600 })
  return res
}
