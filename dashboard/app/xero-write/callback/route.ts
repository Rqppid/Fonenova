import { NextResponse, type NextRequest } from 'next/server'
import { currentUser } from '@/lib/session'
import { finishXeroWriteAuth, xeroWriteConfig } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'
const COOKIE = 'fn_xero_write_oauth'

export async function GET(req: NextRequest) {
  if ((await currentUser()) === false) return NextResponse.redirect(new URL('/login', req.url))
  const c = xeroWriteConfig()
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/?xerowrite=${q}#settings`, req.url))
    res.cookies.set(COOKIE, '', { path: '/xero-write', maxAge: 0 })
    return res
  }
  if (!c) return back('not-configured')
  let saved: { state?: string; verifier?: string } = {}
  try {
    saved = JSON.parse(req.cookies.get(COOKIE)?.value ?? '{}')
  } catch {}
  const code = req.nextUrl.searchParams.get('code')
  if (req.nextUrl.searchParams.get('error')) return back('declined')
  if (!code || !saved.state || !saved.verifier || req.nextUrl.searchParams.get('state') !== saved.state) return back('state')
  try {
    const org = await finishXeroWriteAuth(c, code, saved.verifier)
    return back(org.isDemo ? 'connected-demo' : 'connected-live')
  } catch (e) {
    console.error('Xero write sign-in failed:', e instanceof Error ? e.message : 'unknown')
    return back('failed')
  }
}
