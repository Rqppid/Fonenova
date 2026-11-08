'use client'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowRight, CircleCheck, Download, OctagonAlert, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet } from '@/components/ui/sheet'
import { parseEuro } from '@/lib/deal'
import { eur } from '@/lib/format'
import { formatDate } from '@/lib/periods'
import { TRACKERS, type ExceptionItem, type Invoice, type PaymentsResult, type PaymentsState, type Suggestion } from '@/lib/payments-types'
import { cn } from '@/lib/utils'

export type PartyTotal = { party: string; remainingCents: number; open: number }

const day = (d: string | null) => (d ? formatDate(d.slice(0, 10)) : 'no date')
const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const
const STATE: Record<Invoice['state'], { label: string; tone: 'neutral' | 'gain' | 'warn' | 'loss' }> = {
  not_paid: { label: 'Not paid', tone: 'loss' },
  partly_paid: { label: 'Part paid', tone: 'warn' },
  fully_paid: { label: 'Paid', tone: 'gain' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
const SOURCE: Record<string, string> = { historic: 'From history', auto: 'Matched automatically', approved: 'Allocated by you' }

/** A balance with its meaning in words, so a negative never relies on colour alone. */
function Remaining({ inv }: { inv: Pick<Invoice, 'remaining_cents' | 'credits_cents'> }) {
  const r = inv.remaining_cents
  if (r < 0) return <span className="tabular-nums">{eur(r)} <span className="text-[12px] font-normal text-ink-2">({inv.credits_cents > 0 ? 'credited' : 'overpaid'})</span></span>
  if (r === 0) return <span className="tabular-nums text-ink-2">{eur(0)} <span className="text-[12px]">(settled)</span></span>
  return <span className="tabular-nums">{eur(r)}</span>
}

// ---------------------------------------------------------------------------
// Whole page
// ---------------------------------------------------------------------------

export function PaymentsView({ result, totals }: { result: PaymentsResult<PaymentsState>; totals: { customers: PartyTotal[]; supplier: PartyTotal[] } | null }) {
  if (result.kind === 'not-configured') return <NotConfigured />
  if (result.kind !== 'ok' || !totals) return <ServiceError message={result.kind === 'error' ? result.message : result.kind === 'refused' ? result.error : 'Unknown problem'} />
  const s = result.data
  return (
    <div className="space-y-4">
      <Freshness state={s} />
      <Exceptions items={s.exceptions} customerInvoices={s.customer_invoices} supplierInvoices={s.supplier_invoices} />
      <InvoiceGroups title="Customers" subtitle="What each customer still owes. Click an invoice to see each payment." invoices={s.customer_invoices} totals={totals.customers} owingWord="owes you" />
      <InvoiceGroups title="Mobile One" subtitle="What you still owe Mobile One, per bill. Click a bill to see each payment and credit." invoices={s.supplier_invoices} totals={totals.supplier} owingWord="you owe" />
      <HeldSurplus items={s.held_surplus} />
      <Trackers />
    </div>
  )
}

export function NotConfigured() {
  return (
    <section role="status" className="rounded-lg border border-line bg-surface px-5 py-6">
      <h2 className="text-[15px] font-semibold text-ink">Payments service not configured</h2>
      <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">
        This deployment has no connection to the payments service (PAYMENTS_API_URL and PAYMENTS_API_TOKEN are set in Production only), so no payment data is shown here. Nothing is wrong with your payments; open dashboard.fonenova.com to see them.
      </p>
    </section>
  )
}

export function ServiceError({ message }: { message: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <section role="alert" className="rounded-lg border border-loss/40 bg-surface px-5 py-6">
      <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-loss"><OctagonAlert className="h-4 w-4" aria-hidden />Payments service unreachable</h2>
      <p className="mt-1 text-[13.5px] text-ink-2">{message} No figures are shown, so nothing here can be mistaken for real balances.</p>
      <Button className="mt-3" onClick={() => { setBusy(true); router.refresh(); setTimeout(() => setBusy(false), 1500) }} disabled={busy}>
        <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} aria-hidden />Retry
      </Button>
    </section>
  )
}

/** How fresh the matching is. Never hides stale data: it says so, in words. */
export function Freshness({ state }: { state: Pick<PaymentsState, 'health' | 'generated_at'> }) {
  const h = state.health
  const stale = !h.ok || h.minutes_ago === null || h.minutes_ago > 30
  const ago = h.minutes_ago === null ? 'never' : h.minutes_ago < 1 ? 'just now' : h.minutes_ago < 90 ? `${h.minutes_ago} minute${h.minutes_ago === 1 ? '' : 's'} ago` : `${Math.round(h.minutes_ago / 60)} hours ago`
  return (
    <section aria-label="Payments data status" data-stale={stale} className={cn('flex flex-wrap items-start gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-[13.5px]', stale ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface')}>
      {stale ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /> : <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className={cn('font-medium', stale ? 'text-warn' : 'text-ink')}>{stale ? 'Possibly out of date: ' : ''}Bank matching updated {ago}</p>
        {h.last_error && <p className="text-[13px] text-warn">Last problem: {h.last_error}</p>}
        <p className="text-[12.5px] text-ink-2">Revolut EUR account, matched by the payments service. Data as of {new Date(state.generated_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Exceptions, with approve and dismiss
// ---------------------------------------------------------------------------

type Action = { item: ExceptionItem; mode: 'approve'; invoice: string; remaining: number | null } | { item: ExceptionItem; mode: 'dismiss' }

export function Exceptions({ items, customerInvoices, supplierInvoices }: { items: ExceptionItem[]; customerInvoices: Invoice[]; supplierInvoices: Invoice[] }) {
  const [action, setAction] = useState<Action | null>(null)
  const sorted = useMemo(() => [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.created_at.localeCompare(a.created_at)), [items])
  return (
    <section aria-labelledby="pay-attn" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="pay-attn" className="text-[15px] font-semibold text-ink">Needs attention <span className="ml-1 font-normal text-ink-2">{items.length}</span></h2>
        <p className="mt-0.5 text-[13px] text-ink-2">Payments the service could not match on its own. Suggestions are only suggestions: nothing is allocated until you confirm.</p>
      </div>
      {sorted.length === 0 && <p className="px-5 py-6 text-center text-[13.5px] text-ink-2">No open exceptions. Every payment is matched.</p>}
      <ul className="divide-y divide-line">
        {sorted.map((e) => (
          <li key={e.id} data-severity={e.severity} className={cn('px-5 py-4', e.severity === 'HIGH' && 'border-l-4 border-l-loss bg-loss-soft/40')}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={e.severity === 'HIGH' ? 'loss' : e.severity === 'MEDIUM' ? 'warn' : 'neutral'}>{e.severity === 'HIGH' ? 'High' : e.severity === 'MEDIUM' ? 'Medium' : 'Low'}</Badge>
              <span className="text-[12px] text-ink-3">{e.code}</span>
            </div>
            <p className="mt-1 text-[14px] text-ink">{e.detail}</p>
            {e.bank_event ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-subtle px-3 py-2 text-[13px] sm:grid-cols-4">
                <div><dt className="text-[11.5px] text-ink-3">Date</dt><dd className="text-ink">{day(e.bank_event.date)}</dd></div>
                <div><dt className="text-[11.5px] text-ink-3">Amount</dt><dd className="font-semibold tabular-nums text-ink">{eur(e.bank_event.amount_cents)}</dd></div>
                <div className="min-w-0"><dt className="text-[11.5px] text-ink-3">Payer / payee</dt><dd className="truncate text-ink">{e.bank_event.description || '—'}</dd></div>
                <div className="min-w-0"><dt className="text-[11.5px] text-ink-3">Reference</dt><dd className="truncate text-ink">{e.bank_event.reference || '—'}</dd></div>
              </dl>
            ) : <p className="mt-2 text-[13px] text-ink-3">No bank transaction attached.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {e.suggestions.map((s: Suggestion, i) => (
                <Button key={s.invoice_id} variant={i === 0 ? 'primary' : 'default'} size="sm" onClick={() => setAction({ item: e, mode: 'approve', invoice: s.invoice, remaining: s.remaining_cents })} title={s.why}>
                  Allocate to {s.invoice} · remaining {eur(s.remaining_cents)}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => setAction({ item: e, mode: 'approve', invoice: '', remaining: null })}>Another invoice…</Button>
              <Button size="sm" variant="ghost" onClick={() => setAction({ item: e, mode: 'dismiss' })}>Dismiss</Button>
            </div>
            {e.suggestions.length > 0 && <p className="mt-1.5 text-[12px] text-ink-3">Why: {e.suggestions.map((s) => `${s.invoice}: ${s.why}`).join(' · ')}</p>}
          </li>
        ))}
      </ul>
      <ActionSheet action={action} onClose={() => setAction(null)} invoices={action && /^X-OUT/.test(action.item.code) ? supplierInvoices : customerInvoices} />
    </section>
  )
}

/** The confirmation step: says exactly what will happen, then calls the dashboard's own route. */
function ActionSheet({ action, onClose, invoices }: { action: Action | null; onClose: () => void; invoices: Invoice[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [part, setPart] = useState('')
  const [reason, setReason] = useState('')
  const [chosen, setChosen] = useState('')
  const open = invoices.filter((i) => i.remaining_cents > 0 && i.state !== 'cancelled')
  const close = () => { setError(null); setPart(''); setReason(''); setChosen(''); onClose() }
  if (!action) return <Sheet open={false} onOpenChange={() => {}} title="">{null}</Sheet>

  const ev = action.item.bank_event
  const invoice = action.mode === 'approve' ? action.invoice || chosen : ''
  const remaining = action.mode === 'approve' ? action.remaining ?? open.find((i) => i.number === invoice)?.remaining_cents ?? null : null
  const partCents = part.trim() ? parseEuro(part) : null
  const partBad = part.trim() !== '' && (partCents === null || partCents <= 0)

  async function submit() {
    if (!action) return
    setBusy(true)
    setError(null)
    const body = action.mode === 'approve'
      ? { exception_id: action.item.id, invoice, ...(partCents ? { amount_cents: partCents } : {}) }
      : { exception_id: action.item.id, dismiss_reason: reason }
    const res = await fetch(action.mode === 'approve' ? '/api/payments/approve' : '/api/payments/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) {
      close()
      router.refresh()
    } else {
      setError(out?.error ?? 'Could not reach the dashboard. Check your connection and try again.')
    }
  }

  return (
    <Sheet open onOpenChange={(o) => { if (!o && !busy) close() }} title={action.mode === 'approve' ? 'Allocate this payment' : 'Dismiss this exception'} className="max-w-[520px]">
      <div className="space-y-4 p-5 text-[14px]">
        {action.mode === 'approve' ? (
          <>
            {!action.invoice && (
              <label className="block">
                <span className="mb-1 block text-[12.5px] font-medium text-ink-2">Invoice</span>
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} className="h-10 w-full rounded-md border border-line bg-surface px-2 text-[14px]">
                  <option value="">Choose an open invoice…</option>
                  {open.map((i) => <option key={i.number} value={i.number}>{i.number} · {i.party} · remaining {eur(i.remaining_cents)}</option>)}
                </select>
              </label>
            )}
            <p className="rounded-md bg-subtle px-3 py-2.5 leading-relaxed text-ink" data-testid="confirm-text">
              {invoice ? <>Allocate <strong>{partCents && !partBad ? eur(partCents) : ev ? eur(ev.amount_cents) : 'the payment'}</strong>{ev ? <> {/^X-OUT/.test(action.item.code) ? 'paid to' : 'received from'} <strong>{ev.description || 'unknown'}</strong> on {day(ev.date)}</> : null} to invoice <strong>{invoice}</strong>{remaining !== null ? <>, which has <strong>{eur(remaining)}</strong> remaining</> : null}.</> : 'Choose the invoice this payment belongs to.'}
            </p>
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-ink-2">Only part of it? Amount in € (optional)</span>
              <input inputMode="decimal" value={part} onChange={(e) => setPart(e.target.value)} placeholder={ev ? `Leave empty for ${eur(ev.amount_cents)}` : 'Leave empty for the full payment'} className="h-10 w-full rounded-md border border-line bg-surface px-2.5 text-[14px]" />
              {partBad && <span className="mt-1 block text-[12.5px] text-loss">Enter a positive amount, e.g. 12500 or 12,500.00</span>}
            </label>
          </>
        ) : (
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-medium text-ink-2">Why dismiss it? (required)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} placeholder="e.g. Refund from Revolut, not a customer payment" className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-[14px]" />
            <span className="mt-1 block text-[12.5px] text-ink-3">The exception closes with this reason. No money is moved and no invoice changes.</span>
          </label>
        )}
        {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13.5px] text-loss">Not done: {error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={submit} disabled={busy || (action.mode === 'approve' ? !invoice || partBad : reason.trim().length < 3)}>
            {busy ? 'Saving…' : action.mode === 'approve' ? 'Confirm allocation' : 'Dismiss exception'}
          </Button>
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Invoices, each payment on its own line
// ---------------------------------------------------------------------------

export function InvoiceGroups({ title, subtitle, invoices, totals, owingWord }: { title: string; subtitle: string; invoices: Invoice[]; totals: PartyTotal[]; owingWord: string }) {
  const [settled, setSettled] = useState(false)
  const [open, setOpen] = useState<Invoice | null>(null)
  const parties = totals.map((t) => t.party)
  const shown = invoices.filter((i) => settled || i.state === 'not_paid' || i.state === 'partly_paid' || i.remaining_cents < 0)
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>
        </div>
        <label className="flex items-center gap-1.5 text-[13px] text-ink-2"><input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} />Show settled and cancelled</label>
      </div>
      {parties.length === 0 && <p className="px-5 py-6 text-center text-[13.5px] text-ink-2">No invoices.</p>}
      {parties.map((party) => {
        const t = totals.find((x) => x.party === party)!
        const rows = shown.filter((i) => i.party === party)
        return (
          <div key={party} className="border-b border-line last:border-b-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-3">
              <h3 className="text-[14px] font-semibold text-ink">{party}</h3>
              <p className="text-[13.5px] text-ink-2">
                {owingWord === 'you owe' ? 'You owe' : 'Owes you'} <strong className="tabular-nums text-ink">{eur(t.remainingCents)}</strong>
                {t.remainingCents < 0 && <span> ({owingWord === 'you owe' ? 'in your favour: credits or overpayment' : 'overpaid or credited'})</span>} · {t.open} open
              </p>
            </div>
            {rows.length === 0 ? <p className="px-5 pb-3 pt-1 text-[13px] text-ink-3">Nothing open.</p> : (<>
              {/* Phone: one card per invoice, the remaining balance always in view. */}
              <ul className="divide-y divide-line px-5 pb-2 sm:hidden">
                {rows.map((i) => (
                  <li key={i.number}>
                    <button type="button" onClick={() => setOpen(i)} className="flex w-full items-start justify-between gap-3 py-2.5 text-left">
                      <span className="min-w-0">
                        <span className="block font-medium text-accent">{i.number}</span>
                        <span className="block text-[12.5px] text-ink-3">{day(i.date)} · total {eur(i.total_cents)}</span>
                      </span>
                      <span className="text-right">
                        <span className="block text-[14px] font-semibold"><Remaining inv={i} /></span>
                        <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto px-2 pb-2 sm:block">
                <table className="w-full min-w-[620px] text-[13.5px]">
                  <thead className="text-left text-[12px] text-ink-3">
                    <tr><th className="px-3 py-2 font-medium">Invoice</th><th className="px-3 py-2 font-medium">Date</th><th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 text-right font-medium">Paid</th><th className="px-3 py-2 text-right font-medium">Credits</th><th className="px-3 py-2 text-right font-medium">Remaining</th><th className="px-3 py-2 font-medium">State</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => (
                      <tr key={i.number} onClick={() => setOpen(i)} className="cursor-pointer border-t border-line hover:bg-subtle">
                        <td className="px-3 py-2"><button type="button" className="font-medium text-accent hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(i) }}>{i.number}</button></td>
                        <td className="px-3 py-2 text-ink-2">{day(i.date)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{eur(i.total_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{eur(i.paid_cents)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{i.credits_cents ? eur(i.credits_cents) : '—'}</td>
                        <td className="px-3 py-2 text-right font-semibold"><Remaining inv={i} /></td>
                        <td className="px-3 py-2"><Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>)}
          </div>
        )
      })}
      <InvoiceDrawer invoice={open} onClose={() => setOpen(null)} />
    </section>
  )
}

/** One invoice: every payment on its own row, credits on their own line. Nothing is added up here. */
export function InvoiceDrawer({ invoice: i, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  return (
    <Sheet open={!!i} onOpenChange={(o) => { if (!o) onClose() }} title={i ? `Invoice ${i.number}` : ''} description={i ? `${i.party} · ${day(i.date)}` : undefined} className="max-w-[640px]">
      {i && <InvoiceDetail invoice={i} />}
    </Sheet>
  )
}

export function InvoiceDetail({ invoice: i }: { invoice: Invoice }) {
  return (
    <div className="space-y-4 p-5 text-[13.5px]">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div><dt className="text-[12px] text-ink-3">Total</dt><dd className="font-semibold tabular-nums">{eur(i.total_cents)}</dd></div>
        <div><dt className="text-[12px] text-ink-3">Credits applied</dt><dd className="font-semibold tabular-nums">{eur(i.credits_cents)}</dd></div>
        <div><dt className="text-[12px] text-ink-3">Remaining</dt><dd className="font-semibold"><Remaining inv={i} /></dd></div>
        <div><dt className="text-[12px] text-ink-3">State</dt><dd><Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge></dd></div>
      </dl>
      <div>
        <h3 className="mb-1.5 text-[13px] font-semibold text-ink">Payments <span className="font-normal text-ink-3">{i.payments.length}</span></h3>
        {i.payments.length === 0 ? <p className="text-ink-3">No payments yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead className="text-left text-[12px] text-ink-3"><tr><th className="py-1.5 pr-3 font-medium">Date</th><th className="py-1.5 pr-3 text-right font-medium">Amount</th><th className="py-1.5 pr-3 text-right font-medium">Fee</th><th className="py-1.5 pr-3 font-medium">How</th><th className="py-1.5 font-medium">Remark</th></tr></thead>
              <tbody>
                {i.payments.map((p, n) => (
                  <tr key={`${p.bank_event_id ?? 'x'}-${n}`} data-testid="payment-row" className="border-t border-line align-top">
                    <td className="py-2 pr-3 whitespace-nowrap">{day(p.date)}</td>
                    <td className="py-2 pr-3 text-right font-semibold tabular-nums">{eur(p.amount_cents)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-ink-2">{p.fee_cents ? eur(p.fee_cents) : '—'}</td>
                    <td className="py-2 pr-3"><div>{p.method ?? '—'}</div><div className="text-[12px] text-ink-3">{SOURCE[p.source] ?? p.source}</div></td>
                    <td className="py-2 text-ink-2">{p.remark ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {i.credits_cents !== 0 && <p className="rounded-md bg-subtle px-3 py-2">Credit notes applied to this invoice: <strong className="tabular-nums">{eur(i.credits_cents)}</strong></p>}
      <p className="text-[12px] text-ink-3">Remaining is the payments service&apos;s own figure (total, less payments and credits); the dashboard does not recalculate it.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Held surplus and downloads
// ---------------------------------------------------------------------------

export function HeldSurplus({ items }: { items: PaymentsState['held_surplus'] }) {
  return (
    <section aria-labelledby="held" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-5 py-3">
        <h2 id="held" className="text-[15px] font-semibold text-ink">Held surplus</h2>
        <p className="mt-0.5 text-[13px] text-ink-2">Customer overpayments the service is holding, not applied to any invoice.</p>
      </div>
      {items.length === 0 ? <p className="px-5 py-4 text-[13.5px] text-ink-2">None held.</p> : (
        <ul className="divide-y divide-line">
          {items.map((h) => <li key={h.bank_event_id} className="flex justify-between gap-3 px-5 py-2.5 text-[13.5px]"><span className="text-ink">{h.party}</span><span className="font-semibold tabular-nums">{eur(h.amount_cents)}</span></li>)}
        </ul>
      )}
    </section>
  )
}

function Trackers() {
  return (
    <section aria-labelledby="trackers" className="rounded-lg border border-line bg-surface px-5 py-4">
      <h2 id="trackers" className="text-[15px] font-semibold text-ink">Trackers</h2>
      <p className="mt-0.5 text-[13px] text-ink-2">The payment trackers as Excel files, straight from the payments service.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {TRACKERS.map((t) => (
          <a key={t.key} href={`/api/payments/tracker?key=${t.key}`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-[13.5px] font-medium text-ink hover:bg-subtle">
            <Download className="h-4 w-4" aria-hidden />Download Excel: {t.label}<ArrowRight className="sr-only" />
          </a>
        ))}
      </div>
    </section>
  )
}
