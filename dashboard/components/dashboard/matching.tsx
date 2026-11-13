'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Link2, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMoney } from '@/components/currency'
import { pct } from '@/lib/format'
import { formatDate } from '@/lib/periods'
import { fit, type Matching } from '@/lib/xero/pairing'
import type { Order, XeroInvoice, XeroPair } from '@/lib/types'
import { cn } from '@/lib/utils'

function Doc({ d, side }: { d: XeroInvoice; side: 'Invoice' | 'Bill' }) {
  const { money } = useMoney()
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium uppercase tracking-wide text-ink-3">{side} {d.number || d.reference}</div>
      <div className="truncate text-[13.5px] font-medium text-ink">{d.contactName}</div>
      <div className="text-[12.5px] text-ink-2">{d.date ? formatDate(d.date) : 'no date'} · <span className="font-semibold text-ink">{money(d.totalCents)}</span>{d.status === 'DRAFT' && <span className="text-warn"> · draft in Xero</span>}</div>
    </div>
  )
}

/**
 * The invoice matcher: each Xero sales invoice that is not an order yet, with the bill that fits
 * it best. Confirming makes it an order everywhere on the dashboard.
 */
export function MatchingPanel({ matching, connected, pairs, orders, writable, onSettings, onOpenOrder }: {
  matching: Matching | null
  connected: boolean
  pairs: XeroPair[]
  orders: Order[]
  writable: boolean
  onSettings: () => void
  onOpenOrder: (id: string) => void
}) {
  const router = useRouter()
  const { money } = useMoney()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})

  async function send(key: string, body: object) {
    setBusy(key)
    setError(null)
    const res = await fetch('/api/xero-pairs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    if (!res || !res.ok) setError((await res?.json().catch(() => null))?.error ?? 'Could not save')
    router.refresh()
    setBusy(null)
  }

  if (!matching) {
    return (
      <section className="rounded-lg border border-line bg-surface px-5 py-6 text-center">
        <Link2 className="mx-auto h-6 w-6 text-ink-3" aria-hidden />
        <h2 className="mt-2 text-[15px] font-semibold text-ink">Invoice matching works from Xero</h2>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-ink-2">
          {connected ? 'Xero is connected but has not been read yet. Refresh it in Settings.' : 'Connect Xero in Settings. New invoices from Invoice2Go and bills from Mobile One then show up here to be paired into orders.'}
        </p>
        <Button className="mt-3" onClick={onSettings}>Go to Settings<ArrowRight className="h-4 w-4" aria-hidden /></Button>
      </section>
    )
  }

  const made = orders.filter((o) => o.source === 'xero')
  const confirmed = new Set(pairs.map((p) => p.orderId))
  const waiting = matching.suggestions.reduce((n, s) => n + s.invoice.totalCents, 0)
  // Bills not even suggested for an invoice: usually the invoice is missing from Xero.
  const suggested = new Set(matching.suggestions.map((s) => s.bill?.id).filter(Boolean))
  const lonely = matching.freeBills.filter((b) => !suggested.has(b.id))

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">{error}</p>}
      {!writable && <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">Saving pairs needs online storage: connect Upstash Redis and set FN_STORE_KEY in the Vercel project.</p>}

      <section aria-labelledby="tomatch-title" className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-5 py-3">
          <h2 id="tomatch-title" className="text-[15px] font-semibold text-ink">To match <span className="ml-1 font-normal text-ink-2">{matching.suggestions.length}{waiting ? ` · ${money(waiting)} invoiced` : ''}</span></h2>
          <p className="mt-0.5 text-[13px] leading-snug text-ink-2">
            Sales invoices in Xero that are not an order yet, each with the supplier bill that fits best: EUR, dated within 10 days, a little below the invoice total. Confirm to make it an order. Type the order number (e.g. FN-ORD-035) in both references and they pair themselves.
          </p>
        </div>
        {matching.suggestions.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-ink-2">Every Xero invoice is part of an order.</p>}
        <ul className="divide-y divide-line">
          {matching.suggestions.map((s) => {
            const options = matching.freeBills
              .map((b) => ({ b, f: fit(s.invoice, b) }))
              .sort((x, y) => (x.f?.score ?? 999) - (y.f?.score ?? 999))
            const chosenId = picked[s.invoice.id] ?? s.bill?.id ?? ''
            const chosen = matching.freeBills.find((b) => b.id === chosenId) ?? null
            const f = chosen ? fit(s.invoice, chosen) : null
            const margin = chosen && s.invoice.totalCents ? 1 - chosen.totalCents / s.invoice.totalCents : null
            return (
              <li key={s.invoice.id} className="grid gap-x-5 gap-y-3 px-5 py-4 lg:grid-cols-[1fr_auto_1fr_auto] lg:items-center">
                <Doc d={s.invoice} side="Invoice" />
                <ArrowRight className="hidden h-4 w-4 text-ink-3 lg:block" aria-hidden />
                <div className="min-w-0">
                  {matching.freeBills.length === 0 ? (
                    <p className="text-[13px] text-ink-2">No free supplier bill in Xero yet. It shows here once Mobile One&apos;s bill arrives.</p>
                  ) : (
                    <>
                      <label className="sr-only" htmlFor={`bill-${s.invoice.id}`}>Bill for invoice {s.invoice.number}</label>
                      <select
                        id={`bill-${s.invoice.id}`}
                        value={chosenId}
                        onChange={(e) => setPicked({ ...picked, [s.invoice.id]: e.target.value })}
                        className="h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px] text-ink"
                      >
                        {!s.bill && <option value="">Choose a bill…</option>}
                        {options.map(({ b, f: of }) => (
                          <option key={b.id} value={b.id}>
                            {b.number || b.reference} · {b.contactName} · {b.date ? formatDate(b.date) : 'no date'} · {money(b.totalCents)}{of ? '' : ' (does not fit)'}
                          </option>
                        ))}
                      </select>
                      {chosen && (
                        <p className={cn('mt-1 text-[12.5px]', f ? 'text-ink-2' : 'text-warn')}>
                          Margin {pct(margin)} · {f ? `${Math.round(f.dayGap)} day${Math.round(f.dayGap) === 1 ? '' : 's'} apart` : 'outside the usual range: check it is the right bill'}
                          {chosen.id === s.bill?.id && ' · best fit'}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <Button
                  variant="primary"
                  disabled={!chosen || !writable || busy !== null}
                  onClick={() => send(s.invoice.id, { action: 'confirm', invoiceId: s.invoice.id, billId: chosen!.id })}
                >
                  <Link2 className="h-4 w-4" aria-hidden />{busy === s.invoice.id ? 'Saving…' : 'Confirm pair'}
                </Button>
              </li>
            )
          })}
        </ul>
      </section>

      {lonely.length > 0 && (
        <section aria-labelledby="freebills-title" className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-5 py-3">
            <h2 id="freebills-title" className="text-[15px] font-semibold text-ink">Bills without an invoice <span className="ml-1 font-normal text-ink-2">{lonely.length}</span></h2>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-2">EUR supplier bills in Xero no order uses yet. Usually the invoice has not been sent, or did not sync from Invoice2Go.</p>
          </div>
          <ul className="divide-y divide-line">
            {lonely.map((b) => <li key={b.id} className="px-5 py-3"><Doc d={b} side="Bill" /></li>)}
          </ul>
        </section>
      )}

      {made.length > 0 && (
        <section aria-labelledby="made-title" className="rounded-lg border border-line bg-surface">
          <div className="border-b border-line px-5 py-3">
            <h2 id="made-title" className="text-[15px] font-semibold text-ink">Orders made from Xero <span className="ml-1 font-normal text-ink-2">{made.length}</span></h2>
            <p className="mt-0.5 text-[13px] leading-snug text-ink-2">These count everywhere on the dashboard. Unpair one to send both documents back to To match.</p>
          </div>
          <ul className="divide-y divide-line">
            {made.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <button type="button" onClick={() => onOpenOrder(o.id)} className="font-medium text-accent hover:underline">{o.id}</button>
                <span className="min-w-0 flex-1 text-[13px] text-ink-2">{o.customerName} · invoice {o.clientInvoiceNo} ↔ bill {o.supplierInvoiceNo} · {money(o.grossMarginCents)} profit</span>
                {confirmed.has(o.id) ? (
                  <Button size="sm" variant="ghost" disabled={!writable || busy !== null} onClick={() => send(o.id, { action: 'unpair', orderId: o.id })}>
                    <Unlink className="h-3.5 w-3.5" aria-hidden />{busy === o.id ? 'Saving…' : 'Unpair'}
                  </Button>
                ) : (
                  <span className="text-[12.5px] text-ink-3">Paired by reference in Xero</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * On the Orders page: Xero sales invoices that are not an order yet, so a new invoice is never
 * invisible there. They are not counted in profit until paired with their bill; confirming the
 * suggested bill makes them an order, exactly as on the Invoice matching page.
 */
export function NewInXero({ matching, writable, onMatch }: { matching: Matching | null; writable: boolean; onMatch: () => void }) {
  const router = useRouter()
  const { money } = useMoney()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = matching?.suggestions ?? []
  if (!list.length) return null

  async function confirm(invoiceId: string, billId: string) {
    setBusy(invoiceId)
    setError(null)
    const res = await fetch('/api/xero-pairs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', invoiceId, billId }) }).catch(() => null)
    if (!res || !res.ok) setError((await res?.json().catch(() => null))?.error ?? 'Could not save')
    router.refresh()
    setBusy(null)
  }

  const total = list.reduce((n, s) => n + s.invoice.totalCents, 0)
  return (
    <section aria-labelledby="new-in-xero" data-testid="new-in-xero" className="mb-4 rounded-lg border border-warn/40 bg-warn-soft/40">
      <div className="border-b border-line px-5 py-3">
        <h2 id="new-in-xero" className="text-[15px] font-semibold text-ink">New in Xero: not yet an order <span className="ml-1 font-normal text-ink-2">{list.length} · {money(total)} invoiced</span></h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">These sales invoices are in Xero but not in the ledger or a confirmed pair, so they are not in the orders or the profit below yet. Confirm the bill to make each one an order.</p>
      </div>
      {error && <p role="alert" className="mx-5 mt-3 rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">{error}</p>}
      <ul className="divide-y divide-line">
        {list.map((s) => (
          <li key={s.invoice.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3" data-testid="new-invoice">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-ink">Invoice {s.invoice.number || s.invoice.reference} · {s.invoice.contactName}</div>
              <div className="text-[12.5px] text-ink-2">
                {s.invoice.date ? formatDate(s.invoice.date) : 'no date'} · <span className="font-semibold text-ink">{money(s.invoice.totalCents)}</span>
                {s.invoice.dueDate && <> · due {formatDate(s.invoice.dueDate)}</>}
                {s.invoice.status === 'DRAFT' && <span className="text-warn"> · draft in Xero</span>}
              </div>
              <div className="text-[12.5px] text-ink-2">
                {s.bill
                  ? <>Best bill: {s.bill.number || s.bill.reference} · {s.bill.contactName} · {money(s.bill.totalCents)} · margin {pct(s.margin)} · {s.dayGap} day{s.dayGap === 1 ? '' : 's'} apart</>
                  : 'No supplier bill fits yet. It is suggested here once Mobile One’s bill is in Xero.'}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {s.bill && <Button size="sm" variant="primary" disabled={!writable || busy !== null} onClick={() => confirm(s.invoice.id, s.bill!.id)}>{busy === s.invoice.id ? 'Saving…' : 'Confirm pair'}</Button>}
              <Button size="sm" variant="ghost" onClick={onMatch}>{s.bill ? 'Choose another bill' : 'Match on Invoice matching'}</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
