import { applyEdit, checkEdit } from '@/lib/offers/edit'
import type { Offer } from '@/lib/offers/types'
import { makeTestOffer, openTestOffers, TEST_OFFER_CAP } from '@/lib/offers/test-offer'
import { liveXeroReady } from '@/lib/xero/live-gate'
import { gmailConfig, gmailConnected, sendGmail } from '@/lib/gmail'
import { loadClients } from '@/lib/offers/store'
import { approveReply, fulfilOffer, retryFulfilment } from '@/lib/offers/fulfil'
import { fulfilDeps } from '@/lib/offers/fulfil-server'
import { applyAnswer } from '@/lib/offers/resolve'
import { sendOffer, unlockOffer, withdrawOffer } from '@/lib/offers/send'
import { notify } from '@/lib/offers/telegram'
import { ownerEmail } from '@/lib/offers/owner-email'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getJson, getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

/** Save Hamza's review of an offer: edited lines, or its status. Signed-in, same-origin only. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const checked = checkEdit(await req.json().catch(() => null))
  if (!checked.ok) return json({ error: checked.error }, 400)
  const store = getStore()
  const e = checked.value
  if (e.action === 'create_test') {
    const out = await store.withLock('offers', async () => {
      const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
      if (openTestOffers(offers) >= TEST_OFFER_CAP) return { error: `There are already ${TEST_OFFER_CAP} unanswered test offers. Answer or dismiss one first.` }
      const made = makeTestOffer(new Date().toISOString())
      await store.set('offers', [...offers, made])
      return { offer: made }
    })
    return 'error' in out ? json({ error: out.error }, 409) : json({ ok: true, offer: out.offer })
  }
  if (e.action === 'reply_ok' || e.action === 'fulfil_retry') {
    const d = fulfilDeps(store)
    if (e.action === 'reply_ok') {
      const r = await approveReply(e.id, d)
      return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
    }
    await retryFulfilment(e.id, d)
    return json({ ok: true })
  }
  if (e.action === 'send' || e.action === 'withdraw' || e.action === 'unlock') {
    const dashboardUrl = process.env.AUTH_URL?.replace(/\/$/, '')
    const r =
      e.action === 'unlock' ? await unlockOffer(e.id, { store })
      : e.action === 'withdraw' ? await withdrawOffer(e.id, { store }, (hash) => applyAnswer(hash, { store, notify, email: ownerEmail(store), dashboardUrl, fulfil: (id) => fulfilOffer(id, fulfilDeps(store)) }))
      : await (async () => {
          const c = gmailConfig()
          if (!c) return { ok: false as const, error: 'Gmail is not set up on the dashboard (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).' }
          const g = await gmailConnected(store)
          if (!g.connected) return { ok: false as const, error: g.message ?? 'Gmail is not connected (Settings, Gmail).' }
          return sendOffer(e.id, { store, allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true', liveXeroReady: await liveXeroReady(store), mail: (m) => sendGmail(c, { ...m, fromName: 'FoneNova' }, store) })
        })()
    return r.ok ? json({ ok: true, offer: r.offer }) : json({ error: r.error }, 409)
  }
  const clients = e.action === 'price' ? await loadClients() : []
  const out = await store.withLock('offers', async () => {
    const offers = (await getJson<Offer[]>(store, 'offers')) ?? []
    const i = offers.findIndex((o) => o.id === e.id)
    if (i < 0) return { error: 'That offer no longer exists', status: 404 }
    const next = applyEdit(offers[i], e, new Date().toISOString(), clients)
    if ('error' in next) return { error: next.error, status: 409 }
    offers[i] = next
    await store.set('offers', offers)
    return { offer: next }
  })
  return 'error' in out ? json({ error: out.error }, out.status) : json({ ok: true, offer: out.offer })
}
