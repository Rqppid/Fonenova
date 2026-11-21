import { applyEdit, checkEdit } from '@/lib/offers/edit'
import type { Offer } from '@/lib/offers/types'
import { makeTestOffer, openTestOffers, TEST_OFFER_CAP } from '@/lib/offers/test-offer'
import { liveXeroReady } from '@/lib/xero/live-gate'
import { gmailConfig, gmailConnected, sendGmail } from '@/lib/gmail'
import { loadClients } from '@/lib/offers/store'
import { approveReply, retryFulfilment } from '@/lib/offers/fulfil'
import { fulfilDeps, fulfilThenAuto, invoiceDeps } from '@/lib/offers/fulfil-server'
import { holdAuto, resumeAuto, scheduleAuto } from '@/lib/offers/auto-invoice'
import { archiveTestOffers } from '@/lib/offers/test-archive'
import { setOrderShipping } from '@/lib/offers/shipping'
import { acceptByEmail } from '@/lib/offers/manual-accept'
import { deleteOffer } from '@/lib/offers/delete'
import { confirmSentGuess, dismissSentGuess } from '@/lib/offers/sent-detect'
import { answerManualSend, markSentManually, undoManualSend } from '@/lib/offers/manual-send'
import { linkInvoice2go, updateOrderNotes } from '@/lib/offers/invoice2go'
import { loadSnapshot } from '@/lib/xero/client'
import { deletePublicOffer, publicStoreConfigured } from '@/lib/offers/public-store'
import { approveInvoice, confirmBill, fileInvoice, recheckDraft, sendInvoice } from '@/lib/offers/invoice-flow'
import { attachImeiFiles, clearImeiFiles, findImeiFiles, sendImeiFollowUp } from '@/lib/offers/imei'
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
  if (e.action === 'invoice_approve' || e.action === 'invoice_send' || e.action === 'invoice_file' || e.action === 'draft_recheck' || e.action === 'bill_confirm') {
    const d = invoiceDeps(store)
    const r = e.action === 'invoice_approve' ? await approveInvoice(e.id, d, { confirm: e.confirm })
      : e.action === 'invoice_send' ? await sendInvoice(e.id, d, { confirm: e.confirm, via: e.via })
      : e.action === 'invoice_file' ? await fileInvoice(e.id, d)
      : e.action === 'draft_recheck' ? await recheckDraft(e.id, d)
      : await confirmBill(e.id, e.billId, d)
    // Re-checking can clear what blocked an automatic invoice (an address added, the right Xero organisation chosen).
    if (e.action === 'draft_recheck' && r.ok) await scheduleAuto(e.id, d).catch(() => {})
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'sent_manual' || e.action === 'manual_answer' || e.action === 'manual_undo') {
    const d = fulfilDeps(store)
    const r = e.action === 'sent_manual' ? await markSentManually(e.id, d, { totalCents: e.totalCents, sentAt: e.sentAt, note: e.note })
      : e.action === 'manual_undo' ? await undoManualSend(e.id, d)
      : await answerManualSend(e.id, { ...d, fulfil: (id) => fulfilThenAuto(id, store) }, { decision: e.decision, note: e.note })
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'sent_guess_confirm' || e.action === 'sent_guess_dismiss') {
    const d = fulfilDeps(store)
    const r = e.action === 'sent_guess_confirm' ? await confirmSentGuess(e.id, d) : await dismissSentGuess(e.id, d)
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'order_update') {
    const r = await updateOrderNotes(e.id, fulfilDeps(store), { goodsArrived: e.goodsArrived, dhlCostCents: e.dhlCostCents })
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'invoice2go_link') {
    const snap = await loadSnapshot().catch(() => null)
    const r = await linkInvoice2go(e.id, fulfilDeps(store), { number: e.number, xeroInvoiceId: e.xeroInvoiceId }, (snap?.invoices ?? []).filter((i) => i.kind === 'sale'))
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'delete_offer') {
    if (!e.confirm) return json({ error: 'Confirm the delete first.' }, 400)
    const r = await deleteOffer(store, e.id, { removePublic: publicStoreConfigured() ? (h) => deletePublicOffer(h) : undefined })
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'accept_manual') {
    const r = await acceptByEmail(e.id, { ...fulfilDeps(store), fulfil: (id) => fulfilThenAuto(id, store) }, { totalCents: e.totalCents, note: e.note, confirm: e.confirm })
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'shipping_set') {
    const r = await setOrderShipping(e.id, fulfilDeps(store), { cents: e.cents, none: e.none })
    // The draft exists now: start the automatic invoice (10 minutes, with Hold) if the client is automatic.
    if (r.ok) await scheduleAuto(e.id, invoiceDeps(store)).catch(() => {})
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'archive_test' || e.action === 'archive_all_tests') {
    const r = await archiveTestOffers(store, e.action === 'archive_test' ? { id: e.id } : 'all')
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'auto_hold' || e.action === 'auto_resume') {
    const r = e.action === 'auto_hold' ? await holdAuto(e.id, fulfilDeps(store)) : await resumeAuto(e.id, fulfilDeps(store))
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'imei_find' || e.action === 'imei_attach' || e.action === 'imei_clear' || e.action === 'imei_send') {
    const d = invoiceDeps(store)
    if (e.action === 'imei_find') {
      const r = await findImeiFiles(e.id, d, { thread: e.thread })
      return r.ok ? json({ ok: true, message: r.message, threadId: r.threadId, candidates: r.candidates }) : json({ error: r.message }, 409)
    }
    const r = e.action === 'imei_attach' ? await attachImeiFiles(e.id, d, { thread: e.thread, picks: e.picks })
      : e.action === 'imei_clear' ? await clearImeiFiles(e.id, d)
      : await sendImeiFollowUp(e.id, d, { confirm: e.confirm })
    return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
  }
  if (e.action === 'reply_ok' || e.action === 'fulfil_retry') {
    const d = fulfilDeps(store)
    if (e.action === 'reply_ok') {
      const r = await approveReply(e.id, d)
      return r.ok ? json({ ok: true, message: r.message }) : json({ error: r.message }, 409)
    }
    await retryFulfilment(e.id, d)
    await scheduleAuto(e.id, invoiceDeps(store)).catch(() => {})
    return json({ ok: true })
  }
  if (e.action === 'send' || e.action === 'withdraw' || e.action === 'unlock') {
    const dashboardUrl = process.env.AUTH_URL?.replace(/\/$/, '')
    const r =
      e.action === 'unlock' ? await unlockOffer(e.id, { store })
      : e.action === 'withdraw' ? await withdrawOffer(e.id, { store }, (hash) => applyAnswer(hash, { store, notify, email: ownerEmail(store), dashboardUrl, fulfil: (id) => fulfilThenAuto(id, store) }))
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
