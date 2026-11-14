import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/session'
import { disconnectXeroWrite } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

export async function POST() {
  if ((await currentUser()) === false) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  await disconnectXeroWrite()
  return NextResponse.json({ ok: true })
}
