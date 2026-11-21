'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ukTime } from '@/lib/format-uk'
import type { Client } from '@/lib/offers/clients'
import { priceOffer, pricingInputOf } from '@/lib/offers/pricing'
import type { Offer, OfferSend } from '@/lib/offers/types'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function put(body: object): Promise<{ ok: boolean; message: string }> {
  const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
  const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string } | null
  return res?.ok && out?.ok ? { ok: true, message: out.message ?? 'Saved.' } : { ok: false, message: out?.error ?? 'Could not do that. Check your connection and try again.' }
}

/** "Offer sent manually by email": for an offer copied into an ordinary email to the client, outside the dashboard. */
export function ManualSentPanel({ offer, client }: { offer: Offer; client: Client | null }) {
  const router = useRouter()
  const [total, setTotal] = useState('')
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const blocker = offer.status === 'needs_review' ? 'Mark the offer reviewed first (the Mark reviewed button).'
    : !offer.pricing || !client ? 'Choose the client and mark it priced first (the Price panel below).'
    : null
  const dash = !blocker && client ? (() => { const r = priceOffer(offer.lines, client, pricingInputOf(offer)); return r.ok ? r.totals.saleCents : null })() : null
  const t = total.trim().replace(/^€/, '').replace(/,/g, '')
  const cents = /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null
  async function go() {
    setBusy(true)
    setMsg(null)
    const r = await put({ action: 'sent_manual', id: offer.id, totalCents: cents, sentAt: when ? new Date(when).toISOString() : null, note })
    setBusy(false)
    setMsg({ ok: r.ok, text: r.message })
    if (r.ok) router.refresh()
  }
  return (
    <div className="space-y-2 rounded-md border border-line bg-subtle p-3 text-[13px]" data-testid="manual-sent-panel">
      <p className="font-medium text-ink">Offer sent manually by email</p>
      <p className="text-ink-2">Use this when you or your dad copied the offer into an ordinary email to the client. Nothing is sent from here. It makes the offer show as sent, so you can then record their answer.</p>
      {blocker ? <p className="text-warn" data-testid="manual-sent-blocker">{blocker}</p> : (<>
        <p className="text-ink-2">Sent to <strong className="text-ink">{client!.name}</strong>. The dashboard price is {dash !== null ? <strong className="text-ink">{eur(dash)}</strong> : 'not valid yet'} (items only, no shipping). The total you sent must match it to the cent: change the margin above if it does not.</p>
        <label className="flex flex-wrap items-center gap-2"><span className="text-ink-2">Total you sent, €</span><input aria-label="Total you sent, euros" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder={dash !== null ? (dash / 100).toFixed(2) : ''} className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-right text-[13px]" /></label>
        <label className="flex flex-wrap items-center gap-2"><span className="text-ink-2">Sent on (optional, default now)</span><input aria-label="Date and time sent" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="h-9 rounded-md border border-line bg-surface px-2 text-[13px]" /></label>
        <label className="block"><span className="mb-1 block text-ink-2">Note (optional)</span><input aria-label="Note about the email" value={note} onChange={(e) => setNote(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]" /></label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} /><span>I emailed this offer to {client!.name} at this total.</span></label>
        <Button size="sm" variant="primary" disabled={busy || cents === null || !tick} onClick={go} data-testid="manual-sent-go">{busy ? 'Saving…' : 'Mark as sent'}</Button>
      </>)}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-gain' : 'text-loss'} data-testid="manual-sent-msg">{msg.text}</p>}
    </div>
  )
}

/** A manually sent offer is waiting for the client's reply by email. */
export function ManualAnswerPanel({ offer, send }: { offer: Offer; send: OfferSend }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  async function go(action: 'manual_answer' | 'manual_undo', extra: object = {}) {
    setBusy(action + JSON.stringify(extra))
    setMsg(null)
    const r = await put({ action, id: offer.id, note, ...extra })
    setBusy(null)
    setMsg({ ok: r.ok, text: r.message })
    if (r.ok) router.refresh()
  }
  return (
    <section aria-labelledby="manual-answer-title" className="space-y-3 rounded-md border border-line p-4" data-testid="manual-answer-panel">
      <h3 id="manual-answer-title" className="text-[14px] font-semibold text-ink">Sent to {send.clientName} by email, waiting for their answer</h3>
      <p className="text-[13px] text-ink-2">Marked as sent {ukTime(send.sentAt)}: {send.units} units, {eur(send.totalCents)} (items only). It was emailed outside the dashboard. When {send.clientName} replies, record it here.</p>
      <label className="block text-[13px]"><span className="mb-1 block text-ink-2">Note about their reply (optional)</span><input aria-label="Note about their reply" value={note} onChange={(e) => setNote(e.target.value)} className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]" /></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => go('manual_answer', { decision: 'accept' })} data-testid="manual-accept-button">Client accepted by email</Button>
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => go('manual_answer', { decision: 'decline' })} data-testid="manual-decline-button">Client declined</Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => go('manual_undo')} data-testid="manual-undo-button">Undo: not sent after all</Button>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'text-gain' : 'text-loss'}>{msg.text}</p>}
    </section>
  )
}
