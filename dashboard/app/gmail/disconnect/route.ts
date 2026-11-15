import { NextResponse } from 'next/server'
import { disconnectGmail } from '@/lib/gmail'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

/** Forgets the Gmail sign-in, which stops Mobile One offers being read and emails being sent until it is connected again. */
export async function POST() {
  if ((await currentUser()) === false) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  await disconnectGmail()
  return NextResponse.json({ ok: true })
}
