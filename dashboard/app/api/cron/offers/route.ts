import { NextResponse } from 'next/server'
import { cronAuthorised } from '@/lib/cron'
import { getMessage, gmailConfig, gmailConnected, hasReplied, listMessageIds } from '@/lib/gmail'
import { ingestOffers } from '@/lib/offers/ingest'
import { publicStoreConfigured } from '@/lib/offers/public-store'
import { ownerEmail } from '@/lib/offers/owner-email'
import { sweepSends } from '@/lib/offers/resolve'
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
  const store = getStore()
  // First, offers already sent to clients: answers missed, deadlines passed. This needs only the
  // public store, so it runs even when Gmail cannot read mail.
  let swept: Awaited<ReturnType<typeof sweepSends>> | null = null
  if (publicStoreConfigured()) {
    swept = await sweepSends({ store, notify, email: ownerEmail(store), dashboardUrl: process.env.AUTH_URL?.replace(/\/$/, '') }).catch(() => null)
  }
  const c = gmailConfig()
  if (!c) return NextResponse.json({ ok: true, skipped: 'Gmail is not set up', swept })
  const g = await gmailConnected(store)
  if (!g.connected || !g.canRead) {
    await store.set('offers:status', { lastRunAt: new Date().toISOString(), ok: false, checked: 0, added: 0, error: g.connected ? 'Gmail is connected send-only: connect it again in Settings to read offers' : (g.message ?? 'Gmail is not connected') })
    return NextResponse.json({ ok: false, skipped: 'Gmail cannot read mail yet', swept })
  }
  try {
    const r = await ingestOffers({
      store,
      list: (q) => listMessageIds(c, q, store),
      get: (id) => getMessage(c, id, store),
      read: (text, subject) => readOffer(text, subject),
      replied: (threadId, afterIso) => hasReplied(c, threadId, afterIso, store),
      notify,
      dashboardUrl: process.env.AUTH_URL?.replace(/\/$/, ''),
    })
    return NextResponse.json({ ok: r.errors.length === 0, checked: r.checked, added: r.added.length, skipped: r.skipped, errors: r.errors.length, swept })
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 200) : 'Offer check failed'
    await store.set('offers:status', { lastRunAt: new Date().toISOString(), ok: false, checked: 0, added: 0, error: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export const GET = run
export const POST = run
