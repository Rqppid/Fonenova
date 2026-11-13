import { NextResponse } from 'next/server'
import { cronAuthorised } from '@/lib/cron'
import { loadSettings } from '@/lib/data-source'
import { sendDigest } from '@/lib/weekly'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * The Friday cash email (vercel.json, Fridays 16:00 UTC). Same lock as the daily sync: only
 * Vercel's CRON_SECRET bearer token gets in. Returns whether it sent, never figures. It only
 * sends when the owner has switched the Friday email on in Settings (off by default).
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!(await loadSettings()).fridayEmail) return NextResponse.json({ ok: true, message: 'switched off' }, { headers: { 'Cache-Control': 'no-store' } })
  const s = await sendDigest()
  return NextResponse.json({ ok: s.ok, message: s.ok ? 'sent' : s.message }, { status: s.ok ? 200 : 500, headers: { 'Cache-Control': 'no-store' } })
}
