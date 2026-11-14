'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, Clock, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Offer } from '@/lib/offers/types'
import { cn } from '@/lib/utils'

type Tone = 'ok' | 'wait' | 'bad'
const ICON = { ok: CircleCheck, wait: Clock, bad: CircleAlert }
const TONE: Record<Tone, string> = { ok: 'text-gain', wait: 'text-ink-2', bad: 'text-warn' }

function Row({ tone, title, children, testId }: { tone: Tone; title: string; children: React.ReactNode; testId: string }) {
  const Icon = ICON[tone]
  return (
    <li className="flex gap-2 py-2 text-[13px]" data-testid={testId}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE[tone])} aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <div className="text-ink-2">{children}</div>
      </div>
    </li>
  )
}

/** What follows an acceptance: the reply to Mobile One and the DRAFT invoice in Xero. */
export function AfterAcceptance({ offer }: { offer: Offer }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const f = offer.fulfilment

  async function act(action: 'reply_ok' | 'fulfil_retry') {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: offer.id }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (!(res?.ok && out?.ok)) setError(out?.error ?? 'Could not do that. Check your connection and try again.')
    router.refresh()
  }

  if (!f) {
    return (
      <div className="space-y-2 rounded-md bg-subtle p-3" data-testid="after-acceptance">
        <p className="text-[13px] text-ink-2">This offer was accepted before replies and draft invoices were automatic, so nothing was started for it. You can start them now.</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act('fulfil_retry')}>{busy ? 'Working…' : 'Start reply and draft invoice'}</Button>
        {error && <p role="alert" className="text-[13px] text-loss">{error}</p>}
      </div>
    )
  }

  const r = f.reply
  const d = f.draft
  const replyTone: Tone = r.state === 'sent' ? 'ok' : r.state === 'held' || r.state === 'failed' ? 'bad' : 'wait'
  const draftTone: Tone = d.state === 'done' ? 'ok' : d.state === 'blocked' || d.state === 'failed' ? 'bad' : 'wait'
  const replyWhere = f.test ? 'your own inbox (a test: nothing goes to Mobile One)' : 'Mobile One, in their thread'
  const stuck = r.state === 'failed' || d.state === 'failed' || d.state === 'blocked'

  return (
    <div className="space-y-2" data-testid="after-acceptance">
      <h4 className="text-[13px] font-semibold text-ink">After acceptance · order {f.orderRef}{f.test && <span className="ml-1.5 rounded bg-subtle px-1.5 py-0.5 text-[11.5px] font-normal text-ink-2">test</span>}</h4>
      <ul className="divide-y divide-line">
        <Row tone={replyTone} title="Reply to Mobile One" testId="step-reply">
          {r.state === 'sent' && <p>Sent to {replyWhere}.</p>}
          {(r.state === 'pending' || r.state === 'sending') && <p>Sending to {replyWhere}…</p>}
          {r.state === 'held' && (
            <>
              <p>Waiting for your OK: {r.reason}</p>
              <p className="mt-0.5 text-[12.5px]">The reply says: &quot;We accept the offer. Please proceed with the invoice.&quot; Check the thread in Gmail first.</p>
              <Button size="sm" variant="primary" className="mt-1.5" disabled={busy} onClick={() => act('reply_ok')}>{busy ? 'Sending…' : 'OK, send the reply'}</Button>
            </>
          )}
          {r.state === 'failed' && <p>Did not send (try {r.attempts}): {r.reason}. It tries again every 5 minutes.</p>}
        </Row>
        <Row tone={draftTone} title="Draft invoice in Xero" testId="step-draft">
          {d.state === 'done' && (
            <p>
              Draft <strong className="text-ink">{d.invoiceNumber}</strong> created{d.org ? ` in ${d.org}` : ''}. It is a draft only: approve and send it in Xero for now.{' '}
              {d.invoiceId && <a className="inline-flex items-center gap-0.5 text-navy underline" href={`https://go.xero.com/app/invoicing/view/${encodeURIComponent(d.invoiceId)}`} target="_blank" rel="noreferrer">Open in Xero<ExternalLink className="h-3 w-3" aria-hidden /></a>}
            </p>
          )}
          {(d.state === 'pending' || d.state === 'working') && <p>Creating the draft…</p>}
          {d.state === 'blocked' && <p>Needs you: {d.reason}</p>}
          {d.state === 'failed' && <p>Did not work (try {d.attempts}): {d.reason}. It tries again every 5 minutes.</p>}
        </Row>
      </ul>
      {stuck && <Button size="sm" variant="outline" disabled={busy} onClick={() => act('fulfil_retry')}>{busy ? 'Working…' : 'Try again now'}</Button>}
      {error && <p role="alert" className="text-[13px] text-loss">{error}</p>}
    </div>
  )
}
