'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, Circle } from 'lucide-react'
import type { Check } from '@/lib/offers/golive'
import { MANUAL_ITEMS } from '@/lib/offers/golive'
import { cn } from '@/lib/utils'

const GROUPS: { key: Check['group']; title: string; note: string }[] = [
  { key: 'system', title: 'The system', note: 'Checked from what is switched on and connected right now.' },
  { key: 'clients', title: 'Real clients', note: 'Each real client needs everything below before an offer goes to them.' },
  { key: 'manual', title: 'Only you can confirm these', note: 'Tick each one when it is true; it is remembered.' },
]

/** The go-live checklist. Nothing here switches anything on: the switches stay where they are, each its own step. */
export function GoLiveView({ checks, ready }: { checks: Check[]; ready: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function tick(id: string, done: boolean) {
    setBusy(id)
    setError(null)
    const res = await fetch('/api/offers/golive', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, done }) }).catch(() => null)
    setBusy(null)
    if (res?.ok) router.refresh()
    else setError('Could not save that. Check your connection and try again.')
  }
  const todo = checks.filter((c) => c.status === 'todo').length
  return (
    <div className="space-y-4">
      <p className={cn('rounded-lg px-4 py-3 text-[14px] font-medium', ready ? 'bg-gain-soft text-gain' : 'bg-subtle text-ink')} data-testid="golive-summary">
        {ready ? 'Everything except the final switch is in place. Real client sending (OFFERS_ALLOW_REAL_SEND) is the last step, and it is yours to take.' : `${todo} thing${todo === 1 ? '' : 's'} still to do before real clients get offers from here.`}
      </p>
      {error && <p role="alert" className="rounded-md bg-loss-soft px-3 py-2 text-[13px] text-loss">{error}</p>}
      {GROUPS.map((g) => (
        <section key={g.key} className="rounded-lg border border-line bg-surface" aria-label={g.title}>
          <div className="border-b border-line px-5 py-3">
            <h2 className="text-[15px] font-semibold text-ink">{g.title}</h2>
            <p className="text-[12.5px] text-ink-2">{g.note}</p>
          </div>
          <ul className="divide-y divide-line">
            {checks.filter((c) => c.group === g.key).map((c) => (
              <li key={c.id} className="flex gap-3 px-5 py-3 text-[13.5px]" data-testid="golive-check" data-status={c.status}>
                {g.key === 'manual' ? (
                  <input type="checkbox" aria-label={c.title} className="mt-1" checked={c.status === 'ok'} disabled={busy === c.id} onChange={(e) => tick(c.id, e.target.checked)} />
                ) : c.status === 'ok' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden /> : c.status === 'warn' ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />}
                <div className="min-w-0">
                  <p className="font-medium text-ink">{c.title}</p>
                  <p className={cn('text-[12.5px]', c.status === 'warn' ? 'text-warn' : 'text-ink-2')}>{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-[12.5px] text-ink-3">{MANUAL_ITEMS.length} items are yours to confirm. The three switches (live drafts, approving, real sending) are Vercel settings and stay separate on purpose.</p>
    </div>
  )
}
