'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, ExternalLink, Mail, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { useMoney } from '@/components/currency'
import { formatDate } from '@/lib/periods'
import { xeroLink } from '@/lib/xero/pairing'
import type { MakeStatus } from '@/lib/make'
import type { WeeklyEmailState } from '@/lib/weekly'
import type { AskState } from '@/lib/ask/data'
import type { HealthCheck } from '@/lib/health'
import type { XeroInvoice } from '@/lib/types'
import { cn } from '@/lib/utils'

const when = (iso: string) => `${formatDate(iso.slice(0, 10))}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`

/** Synced invoices and bills still DRAFT in Xero, each one click from approving. */
export function DraftsList({ drafts }: { drafts: XeroInvoice[] }) {
  const { money } = useMoney()
  if (drafts.length === 0) return null
  return (
    <section aria-labelledby="drafts-title" className="rounded-lg border border-warn/30 bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="drafts-title" className="text-[15px] font-semibold text-ink">Drafts to approve in Xero <span className="ml-1 font-normal text-warn">{drafts.length}</span></h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">Created by the Make syncs. Check each against the agreed order, then Approve in Xero (never email it from Xero). They already count on the dashboard, flagged as drafts.</p>
      </div>
      <ul className="divide-y divide-line">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5">
            <span className="w-16 text-[12px] font-medium uppercase tracking-wide text-ink-3">{d.kind === 'sale' ? 'Invoice' : 'Bill'}</span>
            <span className="min-w-0 flex-1 text-[13.5px] text-ink"><span className="font-medium">{d.number || d.reference}</span> · {d.contactName} · {d.date ? formatDate(d.date) : 'no date'}</span>
            <span className="text-[13.5px] font-semibold text-ink">{d.currency === 'EUR' ? money(d.totalCents) : `${(d.totalCents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })} ${d.currency}`}</span>
            <a href={xeroLink(d)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">Open in Xero<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Are the Make.com syncs on, did they last run cleanly, and how many free credits are left. */
export function MakeCard({ make }: { make: MakeStatus | null }) {
  return (
    <section aria-labelledby="make-title" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="make-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink"><Workflow className="h-4 w-4 text-ink-3" aria-hidden />Automations (Make.com)</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">Invoice2Go invoices and Mobile One bills reach Xero through these two scenarios. A run that stops at a filter is not an error; if a document is missing, check that scenario&apos;s History in Make.</p>
      </div>
      {!make ? (
        <p className="px-5 py-3 text-[13px] text-ink-2">
          Not shown yet: add <code>MAKE_API_TOKEN</code> (Make → Profile → API, read-only scopes), <code>MAKE_ZONE=eu1</code>, <code>MAKE_ORG_ID=9377699</code> and <code>MAKE_SCENARIOS=8112915,8119866</code> in Vercel → Settings → Environment Variables (or <code>.env.local</code> on your PC), then redeploy.
        </p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {make.scenarios.map((s) => {
              const bad = !s.active || s.lastRunOk === false
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[13.5px]">
                  {bad ? <CircleAlert className="h-4 w-4 text-loss" aria-hidden /> : <CircleCheck className="h-4 w-4 text-gain" aria-hidden />}
                  <span className="font-medium text-ink">{s.name}</span>
                  <span className={cn(s.active ? 'text-ink-2' : 'font-medium text-loss')}>{s.active ? 'on' : 'OFF'}</span>
                  <span className="text-ink-2">{s.lastRunAt ? `last run ${when(s.lastRunAt)}` : 'no runs yet'}</span>
                  {s.lastError && <span className="basis-full pl-7 text-[13px] text-loss">{s.lastError}</span>}
                </li>
              )
            })}
          </ul>
          <div className="border-t border-line px-5 py-2.5 text-[13px] text-ink-2">
            {make.creditsUsed !== null && make.creditsLimit !== null ? (
              <>Credits this period: <span className={cn('font-semibold', make.creditsUsed >= make.creditsLimit * 0.9 ? 'text-loss' : 'text-ink')}>{make.creditsUsed.toLocaleString('en-GB')} of {make.creditsLimit.toLocaleString('en-GB')}</span> used (about 9 per document).</>
            ) : (
              <>Credits: not reported by Make&apos;s API. Check Make → Organisation → Usage.</>
            )}
            {make.problems.map((p) => <div key={p} className="text-warn">{p}</div>)}
            <div className="text-ink-3">Anthropic credit balance can&apos;t be read through an API; its console emails when it runs low.</div>
          </div>
        </>
      )}
    </section>
  )
}

/** The margin-scheme VAT switch. Off until the accountant confirms it applies. */
export function MarginVatCard({ enabled, writable, vatEurCents }: { enabled: boolean; writable: boolean; vatEurCents: number }) {
  const router = useRouter()
  const { money } = useMoney()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function toggle() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ marginSchemeVat: !enabled }) }).catch(() => null)
    if (!res || !res.ok) setError((await res?.json().catch(() => null))?.error ?? 'Could not save')
    router.refresh()
    setBusy(false)
  }
  return (
    <section aria-labelledby="vat-title" className="rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-80">
          <h2 id="vat-title" className="text-[15px] font-semibold text-ink">Margin-scheme VAT</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-2">
            Under the margin scheme, VAT is 1/6 of each sale&apos;s margin. When on, net business profit deducts it ({money(vatEurCents)} in the selected period) and shows it on its own line. Estimate: HMRC uses the sterling margin at each sale&apos;s date, and losses are not offset. Confirm with your accountant that it is due on these sales (EU exports may be treated differently).
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={!writable || busy}
          onClick={toggle}
          className={cn('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', enabled ? 'bg-navy' : 'bg-line-strong')}
        >
          <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', enabled ? 'translate-x-6' : 'translate-x-1')} />
          <span className="sr-only">Deduct margin-scheme VAT</span>
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[13px] text-loss">{error}</p>}
    </section>
  )
}

const GMAIL_NOTICE: Record<string, string> = {
  connected: 'Gmail connected. Offers are read every 5 minutes. The Friday email stays off unless you switch it on below.',
  declined: 'Google sign-in was cancelled.',
  state: 'The Google sign-in expired or was opened in another browser. Try again.',
  'wrong-account': 'That Google account is not the dashboard’s account. Sign in with the allowed address.',
  failed: 'Google did not accept the connection. Try again; if it repeats, check the Gmail API is enabled.',
  'not-configured': 'Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and online storage first.',
}

/** The Friday cash email: is Gmail connected, who gets it, when it last went, and a test button. */
export function WeeklyEmailCard({ state, notice }: { state: WeeklyEmailState; notice: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState<'test' | 'off' | 'friday' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  async function toggleFriday() {
    setBusy('friday')
    setResult(null)
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fridayEmail: !state.enabled }) }).catch(() => null)
    if (!res || !res.ok) setResult({ ok: false, text: (await res?.json().catch(() => null))?.error ?? 'Could not save' })
    router.refresh()
    setBusy(null)
  }
  async function test() {
    setBusy('test')
    setResult(null)
    const res = await fetch('/api/digest', { method: 'POST' }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { ok?: boolean; message?: string; to?: string } | null
    setResult(body?.ok ? { ok: true, text: `Sent to ${body.to}. Check the inbox (and spam, the first time).` } : { ok: false, text: body?.message ?? 'Could not send' })
    router.refresh()
    setBusy(null)
  }
  async function disconnect() {
    setBusy('off')
    await fetch('/gmail/disconnect', { method: 'POST' }).catch(() => null)
    router.refresh()
    setBusy(null)
  }
  const last = state.last
  return (
    <section aria-labelledby="weekly-title" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="weekly-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink"><Mail className="h-4 w-4 text-ink-3" aria-hidden />Gmail</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">One connection to info@fonenova.com. It reads Mobile One’s offers (read-only: it never changes or deletes mail) and, only if you switch it on below, sends the Friday cash email.</p>
      </div>
      <div className="space-y-2 px-5 py-3 text-[13.5px]">
        {notice && GMAIL_NOTICE[notice] && <p role="status" className={cn('rounded-md px-3 py-2 text-[13px]', notice === 'connected' ? 'bg-gain-soft text-gain' : 'bg-warn-soft text-warn')}>{GMAIL_NOTICE[notice]}</p>}
        {!state.configured ? (
          <p className="text-ink-2">Not set up: needs the Google sign-in variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).</p>
        ) : !state.connected ? (
          <div className="flex flex-wrap items-center gap-3">
            <a href="/gmail/connect" className="inline-flex h-9 items-center rounded-md bg-navy px-3 text-[13px] font-medium text-white hover:bg-navy-2">Connect Gmail</a>
            <span className="text-[13px] text-ink-2">Goes to {state.to}.</span>
          </div>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-ink"><CircleCheck className="h-4 w-4 text-gain" aria-hidden />Connected as <strong className="font-medium">{state.from}</strong> · {state.canRead ? 'reads offers' : <span className="text-warn">send-only: disconnect and connect again to read offers</span>}</p>
            <div className="flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <div className="min-w-0">
                <p className="font-medium text-ink">Friday cash email</p>
                <p className="text-[13px] leading-snug text-ink-2">
                  {state.enabled ? <>On: every Friday about 16:00 UK to {state.to}: who is late paying, what you must pay in the next 14 days against what should come in, Xero problems and drafts to approve.</> : 'Off: nothing is sent on Fridays.'}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-2">
                  {last ? <>Last {last.test ? 'test ' : ''}send: {when(last.at)} · <span className={last.ok ? 'text-gain' : 'text-loss'}>{last.ok ? 'sent' : last.message}</span></> : 'Nothing sent yet.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={state.enabled}
                disabled={busy !== null}
                onClick={toggleFriday}
                className={cn('relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', state.enabled ? 'bg-navy' : 'bg-line-strong')}
              >
                <span className={cn('inline-block h-5 w-5 rounded-full bg-white shadow transition-transform', state.enabled ? 'translate-x-6' : 'translate-x-1')} />
                <span className="sr-only">Send the Friday cash email</span>
              </button>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" onClick={test} disabled={busy !== null} className="inline-flex h-9 items-center rounded-md bg-navy px-3 text-[13px] font-medium text-white hover:bg-navy-2 disabled:opacity-50">{busy === 'test' ? 'Sending…' : 'Send test email now'}</button>
              <button type="button" onClick={disconnect} disabled={busy !== null} className="inline-flex h-9 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink-2 hover:text-ink disabled:opacity-50" title="Also stops Mobile One offers being read">Disconnect</button>
            </div>
            {result && <p role="status" className={cn('text-[13px]', result.ok ? 'text-gain' : 'text-loss')}>{result.text}</p>}
          </>
        )}
      </div>
    </section>
  )
}

/** The AI bar: is it set up, how many questions are left today, and what leaves the dashboard. */
export function AskCard({ state }: { state: AskState }) {
  return (
    <section aria-labelledby="ask-title" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="ask-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink"><Sparkles className="h-4 w-4 text-ink-3" aria-hidden />AI questions (search bar)</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">Typing an order, invoice, customer or page finds it straight away, free. A question goes to Claude Haiku, which looks the answer up with read-only tools over this dashboard&apos;s data. About $0.002 a question.</p>
      </div>
      <div className="space-y-1.5 px-5 py-3 text-[13.5px]">
        {state.configured ? (
          <p className="flex items-center gap-1.5 text-ink"><CircleCheck className="h-4 w-4 text-gain" aria-hidden />On · {state.usedToday} of {state.limit} questions used today (resets at midnight UTC)</p>
        ) : (
          <p className="text-ink-2">Not set up: create an API key at console.anthropic.com in its own workspace with a monthly spend limit (e.g. $5), then add it in Vercel as <code>ANTHROPIC_API_KEY</code> (Sensitive) and redeploy. <code>AI_DAILY_LIMIT</code> changes the daily cap (default 50).</p>
        )}
        <p className="text-[12.5px] text-ink-3">Each question and the figures the tools return are sent to Anthropic&apos;s API, which does not train on API data by default. Nothing can be changed through it.</p>
      </div>
    </section>
  )
}

/** The watchdog: every check that could catch data quietly not arriving, with the fix for each. */
export function WatchdogCard({ checks, ignored, writable }: { checks: HealthCheck[]; ignored: string[]; writable: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const bad = checks.filter((c) => c.level !== 'ok').sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1))
  const good = checks.filter((c) => c.level === 'ok')
  async function notUsed(numbers: string[]) {
    setBusy(true)
    await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ignoredInvoiceNumbers: [...ignored, ...numbers] }) }).catch(() => null)
    router.refresh()
    setBusy(false)
  }
  return (
    <section aria-labelledby="watchdog-title" className={cn('rounded-lg border bg-surface', bad.some((c) => c.level === 'red') ? 'border-loss/40' : 'border-line')}>
      <div className="border-b border-line px-5 py-3">
        <h2 id="watchdog-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink"><ShieldCheck className="h-4 w-4 text-ink-3" aria-hidden />Watchdog{bad.length ? <span className={cn('ml-1 font-normal', bad.some((c) => c.level === 'red') ? 'text-loss' : 'text-warn')}>{bad.length} to look at</span> : <span className="ml-1 font-normal text-gain">all clear</span>}</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">Checked every morning: every connection, both Make scenarios, whether invoices and bills are still arriving, and gaps in your invoice numbers. A red item is emailed to you by the outside monitor (Healthchecks.io), which also emails if this check stops running, so you don&apos;t need to look here.</p>
      </div>
      <ul className="divide-y divide-line">
        {bad.map((c) => (
          <li key={c.id} className="px-5 py-3 text-[13.5px]">
            <p className={cn('flex items-center gap-1.5 font-medium', c.level === 'red' ? 'text-loss' : 'text-warn')}><CircleAlert className="h-4 w-4 shrink-0" aria-hidden />{c.title}</p>
            <p className="mt-0.5 pl-[22px] text-[13px] text-ink-2">{c.detail}</p>
            {c.fix && <p className="mt-0.5 pl-[22px] text-[12.5px] text-ink-3"><span className="font-medium text-ink-2">Fix:</span> {c.fix}</p>}
            {c.numbers && writable && (
              <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[22px]">
                {c.numbers.map((n) => <button key={n} type="button" disabled={busy} onClick={() => notUsed([n])} className="h-7 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:text-ink disabled:opacity-50">{n} was never used</button>)}
              </div>
            )}
          </li>
        ))}
      </ul>
      {good.length > 0 && (
        <details className="border-t border-line px-5 py-2.5 text-[13px] text-ink-2">
          <summary className="cursor-pointer">{good.length} check{good.length > 1 ? 's' : ''} passing</summary>
          <ul className="mt-1.5 space-y-1">{good.map((c) => <li key={c.id} className="flex items-center gap-1.5"><CircleCheck className="h-3.5 w-3.5 text-gain" aria-hidden /><span className="font-medium text-ink">{c.title}</span> · {c.detail}</li>)}</ul>
        </details>
      )}
    </section>
  )
}
