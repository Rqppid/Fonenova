import { NextResponse } from 'next/server'
import { cronAuthorised } from '@/lib/cron'
import { getMessage, gmailConfig, gmailConnected, listMessageIds } from '@/lib/gmail'
import { ingestOffers } from '@/lib/offers/ingest'
import { readOffer } from '@/lib/offers/parse'
import { notify } from '@/lib/offers/telegram'
import { getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Picks up new Mobile One offers. Called every 5 minutes by Upstash QStash with
 * `Authorization: Bearer <CRON_SECRET>` (forwarded via Upstash-Forward-Authorization). Answers
 * counts only, never mail content.
 */
async function run(req: Request) {
  if (!cronAuthorised(req.headers.get('authorization'), process.env.CRON_SECRET)) return new NextResponse('Unauthorized', { status: 401 })
  const c = gmailConfig()
  if (!c) return NextResponse.json({ ok: true, skipped: 'Gmail is not set up' })
  const store = getStore()
  const g = await gmailConnected(store)
  if (!g.connected || !g.canRead) {
    await store.set('offers:status', { lastRunAt: new Date().toISOString(), ok: false, checked: 0, added: 0, error: g.connected ? 'Gmail is connected send-only: connect it again in Settings to read offers' : 'Gmail is not connected' })
    return NextResponse.json({ ok: false, skipped: 'Gmail cannot read mail yet' })
  }
  try {
    const r = await ingestOffers({
      store,
      list: (q) => listMessageIds(c, q, store),
      get: (id) => getMessage(c, id, store),
      read: (text, subject) => readOffer(text, subject),
      notify,
      dashboardUrl: process.env.AUTH_URL?.replace(/\/$/, ''),
    })
    return NextResponse.json({ ok: r.errors.length === 0, checked: r.checked, added: r.added.length, skipped: r.skipped, errors: r.errors.length })
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : 'Offer check failed'
    await store.set('offers:status', { lastRunAt: new Date().toISOString(), ok: false, checked: 0, added: 0, error: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = run
export const POST = run
