'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, Clock, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ukTime } from '@/lib/format-uk'
import { InvoiceSteps, type InvoiceSetup } from '@/components/offers/invoice-steps'
import type { BillCandidate } from '@/lib/offers/invoice-flow'
import { xeroDraftUrl } from '@/lib/offers/xero-url'
import { multiplierOf, shippingBasisOf, type Client } from '@/lib/offers/clients'
import { acceptedItemsCents, invoiceAmount, isInvoice2goNumber, type InvoiceMatch } from '@/lib/offers/order-note'
import type { Offer } from '@/lib/offers/types'
import { cn } from '@/lib/utils'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const eurText = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

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
export function AfterAcceptance({ offer, invoice, bills, client, matches }: { offer: Offer; invoice?: InvoiceSetup; bills?: BillCandidate[]; client?: Client | null; matches?: InvoiceMatch[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shipText, setShipText] = useState('')
  const f = offer.fulfilment

  async function act(action: 'reply_ok' | 'fulfil_retry' | 'shipping_set' | 'order_update' | 'invoice2go_link', extra: object = {}) {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: offer.id, ...extra }) }).catch(() => null)
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
  const own = client ? shippingBasisOf(client) === 'own_dhl' : false
  const mult = client ? multiplierOf(client) : 2
  const shipCents = (() => { const t = shipText.trim().replace(/^€/, '').replace(/,/g, ''); if (!/^\d+(\.\d{1,2})?$/.test(t)) return null; const c = Math.round(Number(t) * 100); return c >= 1 && c <= 10_000_000 ? c : null })()
  const sh = f.shipping
  const draftTone: Tone = d.state === 'done' ? 'ok' : d.state === 'blocked' || d.state === 'failed' ? 'bad' : 'wait'
  const replyWhere = f.test ? 'your own inbox (a test: nothing goes to Mobile One)' : 'Mobile One, in their thread'
  const stuck = r.state === 'failed' || d.state === 'failed' || d.state === 'blocked'
  const i2g = invoice?.invoicing === false

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
        {!i2g && offer.pricing?.shippingLater === true && (
          <Row tone={sh ? 'ok' : 'wait'} title="Shipping" testId="step-shipping">
            {sh ? (
              <p data-testid="shipping-done">
                {sh.source === 'none' ? 'No shipping on this order.' : <>{eur(sh.cents)} charged{sh.mobileOneCents != null ? ` (Mobile One ${eur(sh.mobileOneCents)} × ${mult})` : own ? ' (our own DHL cost, no mark-up)' : ''}.</>}
                {sh.source === 'email' && ' Read from the offer email.'}
                {sh.source === 'invoice' && " Read from Mobile One's invoice."}
              </p>
            ) : d.state === 'waiting' ? (
              <div className="space-y-1.5" data-testid="shipping-waiting">
                <p>{own ? 'This client pays our own DHL cost with no mark-up. Enter it once the label is made.' : `Enter Mobile One's shipping from their invoice. The client is charged it × ${mult}.`}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5"><span className="text-ink-2">€</span><input aria-label={own ? 'Our DHL cost, euros' : "Mobile One's shipping, euros"} inputMode="decimal" value={shipText} onChange={(e) => setShipText(e.target.value)} placeholder="e.g. 120.00" className="h-9 w-32 rounded-md border border-line bg-surface px-2 text-right text-[13px]" /></label>
                  <Button size="sm" variant="primary" disabled={busy || shipCents === null} onClick={() => act('shipping_set', { cents: shipCents })} data-testid="shipping-save">{busy ? 'Saving…' : 'Make the draft invoice'}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act('shipping_set', { none: true })} data-testid="shipping-none">No shipping on this order</Button>
                </div>
                {shipCents !== null && <p className="text-[12.5px]">The client will be charged {eur(own ? shipCents : Math.round(shipCents * mult))}.</p>}
              </div>
            ) : <p>Not entered.</p>}
          </Row>
        )}
        {!i2g && <Row tone={draftTone} title="Draft invoice in Xero" testId="step-draft">
          {d.state === 'done' && (
            <p>
              Draft <strong className="text-ink">{d.invoiceNumber}</strong> created{d.org ? ` in ${d.org}` : ''}. It is a draft only: approve and send it in Xero for now.{' '}
              {d.invoiceId && <a className="inline-flex items-center gap-0.5 text-navy underline" href={xeroDraftUrl(d.invoiceId)} target="_blank" rel="noreferrer">Open in Xero<ExternalLink className="h-3 w-3" aria-hidden /></a>}
              {(d.warnings ?? []).map((w, i) => <span key={i} className="ml-2 inline-block rounded bg-warn-soft px-1.5 py-0.5 text-[12px] font-medium text-warn" data-testid="draft-warning">{w}</span>)}
            </p>
          )}
          {(d.state === 'pending' || d.state === 'working') && <p>Creating the draft…</p>}
          {d.state === 'waiting' && <p data-testid="draft-waiting">Waiting for the shipping cost (see Shipping below). No invoice number is used until it is entered.</p>}
          {d.debug && (d.state === 'blocked' || d.state === 'failed') && (
            <details className="mt-1 text-[12px]" data-testid="draft-debug">
              <summary className="cursor-pointer">Technical detail (what was sent to Xero and what came back)</summary>
              <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-subtle p-2 font-mono text-[11.5px] text-ink">{JSON.stringify(d.debug, null, 2)}</pre>
            </details>
          )}
          {d.state === 'blocked' && (
            <>
              <p>Needs you: {d.reason}</p>
              {d.field && <p className="mt-0.5 text-[12.5px]" data-testid="draft-field">Field: <strong className="text-ink">{d.field}</strong></p>}
              {d.details && d.details.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12.5px]" data-testid="draft-details">
                  {d.details.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              )}
            </>
          )}
          {d.state === 'failed' && <p>Did not work (try {d.attempts}): {d.reason}. It tries again every 5 minutes.</p>}
        </Row>}
      </ul>
      {i2g ? <Invoice2goCard offer={offer} client={client ?? null} matches={matches ?? []} busy={busy} error={error} act={act} /> : <InvoiceSteps offer={offer} setup={invoice} bills={bills} />}
      {!i2g && stuck && <Button size="sm" variant="outline" disabled={busy} onClick={() => act('fulfil_retry')}>{busy ? 'Working…' : 'Try again now'}</Button>}
      {error && <p role="alert" className="text-[13px] text-loss">{error}</p>}
    </div>
  )
}

/** While Invoice2go makes the invoices: a hand-kept checklist and the figure to type into Invoice2go. Creates nothing. */
function Invoice2goCard({ offer, client, matches, busy, error, act }: { offer: Offer; client: Client | null; matches: InvoiceMatch[]; busy: boolean; error: string | null; act: (a: 'order_update' | 'invoice2go_link', extra?: object) => Promise<void> }) {
  const note = offer.fulfilment?.order
  const [dhl, setDhl] = useState(note?.dhlCostCents !== undefined ? (note.dhlCostCents / 100).toFixed(2) : '')
  const [num, setNum] = useState('')
  const t = dhl.trim().replace(/^€/, '').replace(/,/g, '')
  const dhlCents = /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : null
  const items = acceptedItemsCents(offer)
  const amount = items !== null && client ? invoiceAmount(items, client, dhlCents ?? note?.dhlCostCents ?? null) : null
  const linked = note?.invoice2go
  return (
    <div className="space-y-3 rounded-md bg-subtle p-3 text-[13px]" data-testid="invoice2go-card">
      <p className="font-medium text-ink" data-testid="invoice2go-banner">Invoices are made in Invoice2go for now.</p>
      <p className="text-ink-2">Create and send the invoice there once the goods have arrived and the DHL cost is known. This card only keeps your notes; it creates nothing.</p>
      <label className="flex items-start gap-2" data-testid="goods-arrived"><input type="checkbox" checked={!!note?.goodsArrivedAt} disabled={busy} onChange={(e) => act('order_update', { goodsArrived: e.target.checked })} /><span>Goods arrived in Belfast{note?.goodsArrivedAt ? <span className="block text-[12.5px] text-ink-3">{ukTime(note.goodsArrivedAt)}</span> : null}</span></label>
      <div className="space-y-1.5">
        <label className="flex flex-wrap items-center gap-2"><span className="text-ink-2">{client?.shippingBasis === 'own_dhl' ? 'Our DHL cost, euros' : "Mobile One's shipping, euros"}</span><input aria-label="DHL cost, euros" inputMode="decimal" value={dhl} onChange={(e) => setDhl(e.target.value)} placeholder="e.g. 120.00" className="h-9 w-32 rounded-md border border-line bg-surface px-2 text-right text-[13px]" />
          <Button size="sm" variant="outline" disabled={busy || dhlCents === null} onClick={() => act('order_update', { dhlCostCents: dhlCents })} data-testid="dhl-save">Save</Button>
          {note?.dhlCostCents !== undefined && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDhl(''); act('order_update', { dhlCostCents: null }) }}>Clear</Button>}
        </label>
        {amount && <p data-testid="invoice-amount" className="text-ink"><strong>Invoice amount for Invoice2go:</strong> {amount.working}</p>}
      </div>
      {linked ? (
        <p data-testid="invoice2go-linked">Linked to Invoice2go invoice <strong className="text-ink">{linked.number}</strong>{linked.xeroInvoiceId ? ' (matched to its Xero invoice)' : ''}.</p>
      ) : (
        <div className="space-y-1.5">
          <label className="flex flex-wrap items-center gap-2"><span className="text-ink-2">Invoice2go number</span><input aria-label="Invoice2go number" inputMode="numeric" value={num} onChange={(e) => setNum(e.target.value)} placeholder="e.g. 2026049" className="h-9 w-32 rounded-md border border-line bg-surface px-2 text-[13px]" />
            <Button size="sm" variant="primary" disabled={busy || !isInvoice2goNumber(num)} onClick={() => act('invoice2go_link', { number: num.trim(), xeroInvoiceId: null })} data-testid="link-number">Link this number</Button>
          </label>
          {matches.length > 0 && (
            <div data-testid="invoice-matches" className="space-y-1">
              <p className="text-ink-2">Possible matches in Xero (read only):</p>
              {matches.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-2"><span>{m.number} · {m.status.toLowerCase()} · {eurText(m.totalCents)}{m.exact ? ' · matches the amount' : ''}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => act('invoice2go_link', { number: m.number, xeroInvoiceId: m.id })}>Link</Button></div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p role="alert" className="text-loss">{error}</p>}
    </div>
  )
}
