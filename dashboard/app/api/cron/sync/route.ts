import { NextResponse } from 'next/server'
import { cronAuthorised } from '@/lib/cron'
import { syncSources } from '@/lib/sync'
import { loadHealth, reportHealth } from '@/lib/watchdog'
import type { HealthCheck } from '@/lib/health'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Hobby with Fluid compute allows up to 300s; a full import can pass 60s

/**
 * The daily scheduled sync and watchdog (vercel.json). Vercel sends CRON_SECRET as a bearer token; this
 * route is outside the Google sign-in, so that token is its only lock. Returns statuses only,
 * never figures.
 */
export async function GET(req: Request) {
  if (!cronAuthorised(req.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }
  const sources = await syncSources({ force: true })
  // Then the watchdog: report every check to the outside monitor, which emails on any red, or
  // when this daily ping stops arriving at all.
  const health = await loadHealth(sources).catch((e): HealthCheck[] => [
    { id: 'watchdog-error', level: 'red', title: 'The daily check could not run', detail: e instanceof Error ? e.message.slice(0, 200) : String(e), fix: 'Open the dashboard; if it shows an error, the online store or a connection is down.' },
  ])
  const monitor = await reportHealth(health)
  return NextResponse.json(
    { ok: sources.every((s) => s.ok || !s.configured), monitor, red: health.filter((c) => c.level === 'red').map((c) => c.id), sources: sources.map(({ source, ok, changed, message }) => ({ source, ok, changed, message })) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
