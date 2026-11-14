'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ukTime } from '@/lib/format-uk'
import type { Client } from '@/lib/offers/clients'
import { priceOffer, publicLines } from '@/lib/offers/pricing'
import type { Offer, OfferSend } from '@/lib/offers/types'
import { cn } from '@/lib/utils'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface SendSetup {
  /** Offers to real (non-test) clients are switched on. */
  allowReal: boolean
  /** Why the public offers store cannot be used (not set up, or a variable looks mistyped), or null. Never contains a value. */
  storeProblem: string | null
  /** Why Gmail cannot send (and how to fix it), or null when it is connected. */
  gmailProblem: string | null
  /** A note about OFFERS_WEBHOOK_TOKEN, which does not block sending. */
  webhookWarning?: string | null
}

function SendRow({ s }: { s: OfferSend }) {
  const tone = s.outcome === 'accepted' ? 'text-gain' : s.outcome === 'declined' ? 'text-loss' : 'text-ink-2'
  const label = { pending: 'waiting for an answer', accepted: 'accepted', declined: 'declined', expired: 'expired, no answer', withdrawn: 'withdrawn' }[s.outcome]
  return (
    <li className="py-2 text-[13px]" data-testid="send-row">
      <p className="text-ink">{s.clientName}{s.test && <span className="ml-1.5 rounded bg-subtle px-1.5 py-0.5 text-[11.5px] text-ink-2">test</span>}: {s.units} units, {eur(s.totalCents)} · sent {ukTime(s.sentAt)} · <span className={cn('font-medium', tone)}>{label}</span></p>
      {s.answer && (
        <p className="mt-0.5 text-ink-2">
          Answered {ukTime(s.answer.at)}.{s.answer.remarks ? <> Remarks: <span className="whitespace-pre-wrap text-ink">{s.answer.remarks}</span></> : ' No remarks.'}
        </p>
      )}
    </li>
  )
}

/**
 * Sending the priced offer, and following it: a preview of exactly what the client will see, a
 * confirmation, then (once sent) the waiting, withdraw, answer and unlock states.
 */
export function SendPanel({ offer, clients, setup }: { offer: Offer; clients: Client[]; setup: SendSetup }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sends = offer.sends ?? []
  const current = [...sends].reverse().find((s) => s.outcome === 'pending')
  const last = sends.at(-1)
  const client = offer.pricing ? clients.find((c) => c.id === offer.pricing!.clientId) ?? null : null

  async function act(action: 'send' | 'withdraw' | 'unlock') {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: offer.id }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    setConfirming(false)
    if (res?.ok && out?.ok) router.refresh()
    else {
      setError(out?.error ?? 'Could not do that. Check your connection and try again.')
      router.refresh()
    }
  }

  const history = sends.length > 0 && (
    <details className="text-[12.5px] text-ink-2" open={offer.status !== 'ready'}>
      <summary className="cursor-pointer">Sent to clients ({sends.length})</summary>
      <ul className="mt-1 divide-y divide-line">{[...sends].reverse().map((s) => <SendRow key={s.tokenHash} s={s} />)}</ul>
    </details>
  )
  const errorBox = error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">{error}</p>

  if (offer.status === 'sent') {
    return (
      <section aria-labelledby="send-title" className="space-y-3 rounded-md border border-line p-4" data-testid="send-panel">
        <h3 id="send-title" className="text-[14px] font-semibold text-ink">Waiting for {current?.clientName ?? 'the client'}</h3>
        {current && <p className="text-[13px] text-ink-2">Sent {ukTime(current.sentAt)} to {current.to.join(', ')}. Valid until <strong className="text-ink">{ukTime(current.expiresAt)}</strong>. You get a Telegram message when they answer or it expires. Link starts <code>{current.tokenHint}…</code></p>}
        {errorBox}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act('withdraw')}>{busy ? 'Working…' : 'Withdraw this offer'}</Button>
        {history}
      </section>
    )
  }

  if (offer.status === 'accepted' || offer.status === 'declined' || offer.status === 'expired') {
    const text = offer.status === 'accepted'
      ? `${last?.clientName ?? 'The client'} accepted${last?.test ? ' (test)' : ''}. ${last?.test ? 'Nothing else happens for a test.' : 'Reply to Mobile One and raise the invoice yourself for now; the next phase will do it.'}`
      : offer.status === 'declined' ? `${last?.clientName ?? 'The client'} declined.` : `${last?.clientName ?? 'The client'} did not answer before it expired.`
    return (
      <section aria-labelledby="send-title" className="space-y-3 rounded-md border border-line p-4" data-testid="send-panel">
        <h3 id="send-title" className="text-[14px] font-semibold text-ink capitalize">{offer.status}</h3>
        <p className="text-[13px] text-ink">{text}</p>
        {errorBox}
        {offer.status !== 'accepted' && <Button size="sm" variant="primary" disabled={busy} onClick={() => act('unlock')}>{busy ? 'Working…' : 'Unlock to reprice'}</Button>}
        {history}
      </section>
    )
  }

  // Ready: only once priced.
  if (offer.status !== 'ready' || !offer.pricing || !client) return history ? <section className="rounded-md border border-line p-4" data-testid="send-panel">{history}</section> : null
  const r = priceOffer(offer.lines, client, { clientId: client.id, marginCents: offer.pricing.marginCents, overrides: offer.pricing.overrides, ackLow: offer.pricing.ackLow })
  const pub = publicLines(offer.lines, r)
  const blocked = setup.storeProblem ? setup.storeProblem
    : setup.gmailProblem ? setup.gmailProblem
    : !client.test && !setup.allowReal ? 'Offers to real clients are switched on with the next phase. Price it for the test client to try the whole journey yourself.'
    : !client.offerEmails.length ? (client.test ? 'Add your own email address to the test client first (Offers, Clients).' : `${client.name} has no offer email address (Offers, Clients).`)
    : !r.ok ? 'The price needs attention. Update it above.'
    : null

  return (
    <section aria-labelledby="send-title" className="space-y-3 rounded-md border border-line p-4" data-testid="send-panel">
      <h3 id="send-title" className="text-[14px] font-semibold text-ink">Send to {client.name}</h3>
      <p className="text-[13px] text-ink-2">This is exactly what the client will see: sale prices only. It goes from info@fonenova.com and is valid for 24 hours from sending.</p>
      <div className="overflow-x-auto rounded-md bg-subtle p-3" data-testid="send-preview">
        <table className="w-full min-w-[420px] text-[13px]">
          <tbody>
            {pub.map((l, i) => <tr key={i}><td className="py-0.5 pr-2">{l.description}</td><td className="px-2 py-0.5 text-right tabular-nums">{l.qty.toLocaleString('en-GB')}</td><td className="px-2 py-0.5 text-right tabular-nums">{eur(l.unitSaleCents)}</td><td className="py-0.5 pl-2 text-right tabular-nums">{eur(l.qty * l.unitSaleCents)}</td></tr>)}
            <tr className="border-t border-line font-semibold"><td className="pt-1.5">Total</td><td className="px-2 pt-1.5 text-right tabular-nums">{r.totals.units.toLocaleString('en-GB')}</td><td /><td className="pt-1.5 pl-2 text-right tabular-nums">{eur(r.totals.saleCents)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="text-[13px] text-ink-2">To: <strong className="text-ink">{client.offerEmails.join(', ') || 'no address yet'}</strong>{client.test && ' (test client: the email is marked [TEST])'}</p>
      {blocked && <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn" data-testid="send-blocked">{blocked}</p>}
      {!blocked && setup.webhookWarning && <p className="text-[12.5px] text-ink-2" data-testid="send-webhook-note">{setup.webhookWarning}</p>}
      {errorBox}
      {!confirming ? (
        <Button size="sm" variant="primary" disabled={!!blocked || busy} onClick={() => setConfirming(true)}><Send className="h-4 w-4" aria-hidden />Send to {client.name}</Button>
      ) : (
        <div className="space-y-2 rounded-md border border-line bg-subtle p-3" data-testid="send-confirm">
          <p className="text-[13px] text-ink">Send this offer to <strong>{client.offerEmails.join(', ')}</strong> now? They can accept or decline until the deadline. You can withdraw it until they answer.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => act('send')}>{busy ? 'Sending…' : 'Yes, send it'}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {history}
    </section>
  )
}
