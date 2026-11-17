'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Inbox, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { AutoRefresh } from '@/components/dashboard/auto-refresh'
import { PricePanel } from '@/components/offers/price-panel'
import { SendPanel, type SendSetup } from '@/components/offers/send-panel'
import type { Client } from '@/lib/offers/clients'
import { Button } from '@/components/ui/button'
import { parseEuro } from '@/lib/deal'
import { offerCostCents, offerFlags, offerUnits } from '@/lib/offers/check'
import type { Offer, OfferLine, OffersStatus, OfferStatus } from '@/lib/offers/types'
import { cn } from '@/lib/utils'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const STATUS: Record<OfferStatus, { label: string; tone: 'warn' | 'gain' | 'neutral' }> = {
  needs_review: { label: 'Needs review', tone: 'warn' },
  ready: { label: 'Reviewed', tone: 'gain' },
  dismissed: { label: 'Not an offer', tone: 'neutral' },
  sent: { label: 'Sent', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'gain' },
  declined: { label: 'Declined', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
}

interface Setup {
  gmail: { connected: boolean; email: string | null; canRead: boolean; message?: string | null } | null
  telegram: boolean
  schedule: boolean
}

export function OffersView({ offers, status, setup, selected, clients, send, liveTarget = null }: { /** The live Xero organisation drafts go to, if that is where they go: shown as a red banner. */ liveTarget?: string | null; offers: Offer[]; status: OffersStatus | null; setup: Setup; selected: string | null; clients: Client[]; send: SendSetup }) {
  const [openId, setOpenId] = useState<string | null>(selected ?? offers.find((o) => o.status === 'needs_review')?.id ?? null)
  const [showDismissed, setShowDismissed] = useState(false)
  const router = useRouter()
  // On a phone the detail sits below the list: bring it into view when an offer is opened (a tap, or a link such as Telegram's).
  const detailRef = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  useEffect(() => {
    const deepLink = first.current && !!selected
    const tapped = !first.current
    first.current = false
    if ((deepLink || tapped) && openId && window.matchMedia('(max-width: 1023px)').matches) detailRef.current?.scrollIntoView({ block: 'start' })
  }, [openId, selected])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  async function createTest() {
    setCreating(true)
    setCreateError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create_test' }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; offer?: Offer } | null
    setCreating(false)
    if (res?.ok && out?.ok && out.offer) {
      setOpenId(out.offer.id)
      router.refresh()
    } else setCreateError(out?.error ?? 'Could not create it. Check your connection and try again.')
  }
  // Finished test offers (answered, expired or dismissed) are tucked away so they do not crowd the real ones.
  const [showTests, setShowTests] = useState(false)
  // An accepted test offer stays until its invoice has been emailed: there are still steps to do on it.
  const finishedTest = (o: Offer) => o.testOnly === true && (['declined', 'expired', 'dismissed'].includes(o.status) || (o.status === 'accepted' && o.fulfilment?.send?.state === 'done'))
  const hiddenTests = offers.filter(finishedTest).length
  const list = offers.filter((o) => (showDismissed || o.status !== 'dismissed') && (showTests || o.id === selected || o.id === openId || !finishedTest(o)))
  // Something is waiting on a client or on the invoice steps: look again every few seconds so it shows up without a refresh.
  const awaiting = offers.some((o) => o.status === 'sent' || (o.status === 'accepted' && (!o.fulfilment || ['pending', 'working'].includes(o.fulfilment.draft.state) || ['pending', 'sending'].includes(o.fulfilment.reply.state) || o.fulfilment.auto?.state === 'scheduled' || o.fulfilment.auto?.state === 'running')))
  const open = offers.find((o) => o.id === openId) ?? null
  const waiting = offers.filter((o) => o.status === 'needs_review').length
  return (
    <div className="space-y-4">
      <AutoRefresh everyMs={awaiting ? 6000 : 60_000} />
      {liveTarget && <p role="alert" className="rounded-lg bg-loss px-4 py-2.5 text-[14px] font-semibold text-white" data-testid="live-banner">LIVE: drafts go to {liveTarget}</p>}
      <SetupNotes setup={setup} status={status} />
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-labelledby="offers-list" className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id="offers-list" className="text-[15px] font-semibold text-ink">Offers <span className="ml-1 font-normal text-ink-2">{waiting ? `${waiting} to review` : 'all reviewed'}</span>{awaiting && <span className="ml-2 text-[12px] font-normal text-ink-3" data-testid="live-updating">updating automatically</span>}</h2>
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />Show not offers</label>
          </div>
          {hiddenTests > 0 || showTests ? (
            <div className="border-b border-line px-4 py-1.5">
              <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2" data-testid="show-finished-tests"><input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} />Show finished test offers ({hiddenTests})</label>
            </div>
          ) : null}
          <div className="border-b border-line px-4 py-2" data-testid="new-test-offer">
            <Button size="sm" variant="outline" disabled={creating} onClick={createTest}>{creating ? 'Creating…' : 'New test offer'}</Button>
            <p className="mt-1 text-[12px] text-ink-3">A made-up offer for the test client, to try pricing, sending, accepting and the Xero draft without a real email.</p>
            {createError && <p role="alert" className="mt-1 text-[12.5px] text-loss">{createError}</p>}
          </div>
          {list.length === 0 && (
            <div className="px-4 py-8 text-center text-[13px] text-ink-2">
              <Inbox className="mx-auto mb-2 h-6 w-6 text-ink-3" aria-hidden />
              No offers yet. New offers from bv@mobileone.info appear here within 5 minutes.
            </div>
          )}
          <ul className="divide-y divide-line">
            {list.map((o) => {
              const flagged = [...offerFlags(o.lines).values()].filter((f) => f.some((x) => x.level === 'error')).length
              return (
                <li key={o.id}>
                  <button type="button" onClick={() => setOpenId(o.id)} className={cn('w-full px-4 py-3 text-left hover:bg-subtle', o.id === openId && 'bg-subtle')} data-testid="offer-item">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13.5px] font-medium text-ink">{o.testOnly && <span className="mr-1.5 rounded bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold text-warn" data-testid="test-badge">TEST</span>}{o.source.subject || '(no subject)'}</span>
                      <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-ink-2">
                      {when(o.source.receivedAt)} · {o.lines.length} line{o.lines.length === 1 ? '' : 's'} · {offerUnits(o.lines)} units · {eur(offerCostCents(o.lines))}
                    </div>
                    {o.pricing && <div className="mt-0.5 text-[12.5px] font-medium text-gain">Priced for {clients.find((c) => c.id === o.pricing!.clientId)?.name ?? 'a client'}</div>}
                    {flagged > 0 && <div className="mt-0.5 flex items-center gap-1 text-[12.5px] text-loss"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />{flagged} line{flagged === 1 ? '' : 's'} to check</div>}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
        <div ref={detailRef} className="min-w-0 scroll-mt-14">
          {open ? <OfferDetail key={open.id + open.updatedAt} offer={open} clients={clients} send={send} /> : <section className="rounded-lg border border-line bg-surface px-5 py-10 text-center text-[13.5px] text-ink-2">Choose an offer to review it.</section>}
        </div>
      </div>
    </div>
  )
}

function SetupNotes({ setup, status }: { setup: Setup; status: OffersStatus | null }) {
  const notes: { text: React.ReactNode; bad: boolean }[] = []
  if (!setup.gmail) notes.push({ bad: true, text: 'Gmail is not set up on the dashboard (GOOGLE_CLIENT_ID).' })
  else if (!setup.gmail.connected) notes.push({ bad: true, text: <>{setup.gmail.message ?? 'Gmail is not connected.'} <a className="font-medium text-accent hover:underline" href="/gmail/connect">Open Gmail sign-in</a></> })
  else if (!setup.gmail.canRead) notes.push({ bad: true, text: <>Gmail is connected send-only, so offers can&apos;t be read yet. <a className="font-medium text-accent hover:underline" href="/gmail/connect">Connect Gmail again</a> and allow reading.</> })
  if (!setup.schedule) notes.push({ bad: true, text: 'CRON_SECRET is not set, so the 5-minute check cannot run.' })
  if (!setup.telegram) notes.push({ bad: false, text: 'Telegram is not set up (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID): new offers show here, without a ping.' })
  const staleGmail = !!status && !status.ok && /^(Gmail is|Could not check Gmail|The saved Gmail login|Google no longer accepts)/.test(status.error ?? '') && !!setup.gmail?.connected && setup.gmail.canRead
  if (staleGmail) notes.push({ bad: false, text: 'Gmail is connected now. The last check ran before that; the next one (within 5 minutes) replaces it.' })
  else if (status) notes.push({ bad: !status.ok, text: `Last check ${when(status.lastRunAt)}: ${status.ok ? `${status.checked} new email${status.checked === 1 ? '' : 's'} read, ${status.added} offer${status.added === 1 ? '' : 's'} added.` : `failed. ${status.error ?? ''}`}` })
  else if (setup.gmail?.canRead) notes.push({ bad: false, text: 'The 5-minute check has not run yet.' })
  if (!notes.length) return null
  return (
    <ul className="space-y-1 rounded-lg border border-line bg-surface px-4 py-3 text-[13px]" data-testid="offers-setup">
      {notes.map((n, i) => <li key={i} className={n.bad ? 'text-warn' : 'text-ink-2'}>{n.text}</li>)}
    </ul>
  )
}

type Draft = { id: string; model: string; storage: string; grade: string; qty: string; cost: string; sourceText: string; note: string | null }
const toDraft = (l: OfferLine): Draft => ({ id: l.id, model: l.model, storage: l.storage ?? '', grade: l.grade ?? '', qty: String(l.qty), cost: (l.unitCostCents / 100).toFixed(2), sourceText: l.sourceText, note: l.note })
const fromDraft = (d: Draft): OfferLine | null => {
  const qty = Number(d.qty.replace(/[,\s]/g, ''))
  const cost = parseEuro(d.cost)
  if (!d.model.trim() || !Number.isSafeInteger(qty) || qty < 1 || cost === null || cost < 1) return null
  return { id: d.id, model: d.model.trim(), storage: d.storage.trim() || null, grade: d.grade.trim() || null, qty, unitCostCents: cost, sourceText: d.sourceText, note: d.note }
}

export function OfferDetail({ offer, clients = [], send = { allowReal: false, storeProblem: 'The public offers store is not set up yet.', gmailProblem: null } }: { offer: Offer; clients?: Client[]; send?: SendSetup }) {
  const router = useRouter()
  const [rows, setRows] = useState<Draft[]>(() => offer.lines.map(toDraft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Mobile One's shipping for the whole offer: read from the email or typed here, never assumed.
  const [shipText, setShipText] = useState(offer.shipping?.source === 'none' || offer.shipping?.mobileOneCents == null ? '' : (offer.shipping.mobileOneCents / 100).toFixed(2))
  const [noShip, setNoShip] = useState(offer.shipping?.source === 'none')
  const shipCents = noShip || shipText.trim() === '' ? null : parseEuro(shipText)
  const shipBad = !noShip && shipText.trim() !== '' && (shipCents === null || shipCents < 1)
  const shipDirty = noShip !== (offer.shipping?.source === 'none') || (!noShip && shipCents !== (offer.shipping?.mobileOneCents ?? null))
  const parsed = rows.map(fromDraft)
  const valid = parsed.every(Boolean) && !shipBad
  const lines = parsed.filter((l): l is OfferLine => !!l)
  const flags = offerFlags(lines)
  const dirty = shipDirty || JSON.stringify(lines.map(({ sourceText: _s, ...l }) => l)) !== JSON.stringify(offer.lines.map(({ sourceText: _s, ...l }) => l))
  // Lines and prices can only change before the offer goes to a client.
  const editable = offer.status === 'needs_review' || offer.status === 'ready'

  async function put(body: object) {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) router.refresh()
    else setError(out?.error ?? 'Could not save. Check your connection and try again.')
  }
  const set = (i: number, k: keyof Draft, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)))

  return (
    <section aria-labelledby="offer-title" className="min-w-0 space-y-4 rounded-lg border border-line bg-surface p-4 sm:p-5" data-testid="offer-detail">
      <a href="#offers-list" className="inline-flex h-10 items-center text-[13.5px] font-medium text-accent lg:hidden" data-testid="back-to-list">← All offers</a>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="offer-title" className="text-[16px] font-semibold text-ink">{offer.source.subject || '(no subject)'}</h2>
          <p className="text-[12.5px] text-ink-2">From {offer.source.from} · to {offer.source.to} · {when(offer.source.receivedAt)}</p>
        </div>
        <Badge tone={STATUS[offer.status].tone}>{STATUS[offer.status].label}</Badge>
      </div>
      {offer.testOnly && <p className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn" data-testid="test-banner">TEST OFFER. Made here for testing, not from Mobile One. It can only be priced for and sent to the test client, never a real client.</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px] max-sm:block sm:min-w-[600px]">
          <thead className="text-left text-[12px] text-ink-3 max-sm:hidden">
            <tr><th className="py-1.5 pr-2 font-medium">Model</th><th className="px-2 py-1.5 font-medium">Storage</th><th className="px-2 py-1.5 font-medium">Grade / spec</th><th className="px-2 py-1.5 text-right font-medium">Qty</th><th className="px-2 py-1.5 text-right font-medium">Unit cost €</th><th className="px-2 py-1.5 text-right font-medium">Line cost</th><th className="w-8" /></tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((r, i) => {
              const l = parsed[i]
              const f = l ? flags.get(l.id) ?? [] : [{ code: 'qty', level: 'error', message: 'Fill in model, a whole quantity and a price.' }]
              const input = 'h-8 w-full rounded border border-line bg-surface px-2 text-[13px] disabled:bg-subtle'
              return (
                <tr key={r.id} className="border-t border-line align-top max-sm:mb-3 max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 max-sm:rounded-md max-sm:border max-sm:p-3" data-testid="offer-line">
                  <td data-label="Model" className="py-1.5 pr-2 max-sm:col-span-2 max-sm:py-0 max-sm:pr-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]"><input aria-label={`Model, line ${i + 1}`} disabled={!editable} className={cn(input, f.some((x) => x.code === 'model') && 'border-loss')} value={r.model} onChange={(e) => set(i, 'model', e.target.value)} />
                    {f.length > 0 && <ul className="mt-1 space-y-0.5">{f.map((x, k) => <li key={k} className={cn('text-[12px]', x.level === 'error' ? 'text-loss' : 'text-warn')}>{x.message}</li>)}</ul>}
                    {r.sourceText && <p className="mt-1 text-[11.5px] text-ink-3">Email: “{r.sourceText}”</p>}
                  </td>
                  <td data-label="Storage" className="px-2 py-1.5 max-sm:p-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]"><input aria-label={`Storage, line ${i + 1}`} disabled={!editable} className={input} value={r.storage} onChange={(e) => set(i, 'storage', e.target.value)} /></td>
                  <td data-label="Grade / spec" className="px-2 py-1.5 max-sm:p-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]"><input aria-label={`Grade, line ${i + 1}`} disabled={!editable} className={input} value={r.grade} onChange={(e) => set(i, 'grade', e.target.value)} /></td>
                  <td data-label="Qty" className="px-2 py-1.5 max-sm:p-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]"><input aria-label={`Quantity, line ${i + 1}`} disabled={!editable} inputMode="numeric" className={cn(input, 'text-right')} value={r.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
                  <td data-label="Unit cost €" className="px-2 py-1.5 max-sm:p-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]"><input aria-label={`Unit cost, line ${i + 1}`} disabled={!editable} inputMode="decimal" className={cn(input, 'text-right')} value={r.cost} onChange={(e) => set(i, 'cost', e.target.value)} /></td>
                  <td data-label="Line cost" className="px-2 py-1.5 text-right tabular-nums max-sm:p-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{l ? eur(l.qty * l.unitCostCents) : '—'}</td>
                  <td className="py-1.5 pl-1 max-sm:p-0 max-sm:text-right">{editable && <button type="button" aria-label={`Delete line ${i + 1}`} className="rounded p-1.5 text-ink-3 hover:bg-subtle hover:text-loss" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></button>}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot className="max-sm:block"><tr className="border-t border-line font-semibold max-sm:flex max-sm:flex-wrap max-sm:gap-x-4 max-sm:pt-2"><td className="py-2" colSpan={3}>{lines.length} line{lines.length === 1 ? '' : 's'}</td><td className="px-2 py-2 text-right tabular-nums max-sm:px-0">{offerUnits(lines)} units</td><td className="max-sm:hidden" /><td className="px-2 py-2 text-right tabular-nums max-sm:px-0">{eur(offerCostCents(lines))}</td><td className="max-sm:hidden" /></tr></tfoot>
        </table>
      </div>

      <div className="space-y-1.5 rounded-md border border-line p-3 text-[13px]" data-testid="shipping-review">
        <p className="font-medium text-ink">Mobile One&apos;s shipping (for the whole offer)</p>
        {editable ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2"><span className="text-ink-2">€</span><input aria-label="Mobile One shipping" inputMode="decimal" disabled={noShip} value={shipText} onChange={(e) => setShipText(e.target.value)} placeholder="e.g. 120.00" className={cn('h-9 w-32 rounded-md border bg-surface px-2 text-right text-[13px] disabled:opacity-50', shipBad ? 'border-loss' : 'border-line')} /></label>
              <label className="flex items-center gap-1.5 text-ink-2"><input type="checkbox" checked={noShip} onChange={(e) => setNoShip(e.target.checked)} />There is no shipping on this offer</label>
            </div>
            {shipBad && <p className="text-[12.5px] text-loss">Enter an amount like 120.00</p>}
          </>
        ) : (
          <p className="text-ink">{offer.shipping?.source === 'none' ? 'No shipping' : offer.shipping?.mobileOneCents != null ? eur(offer.shipping.mobileOneCents) : 'not entered'}</p>
        )}
        {offer.shipping?.source === 'email' && offer.shipping.sourceText && <p className="text-[12.5px] text-ink-2" data-testid="shipping-source">Read from the email: &quot;{offer.shipping.sourceText}&quot;</p>}
        {offer.shipping?.source === 'manual' && <p className="text-[12.5px] text-ink-2">Entered by you.</p>}
        {!noShip && shipCents === null && !shipBad && <p className="text-warn" data-testid="shipping-needed">The email did not state a shipping amount. Enter it (or confirm there is none) before this offer can be priced and sent. It is never assumed to be zero.</p>}
        {!noShip && shipCents !== null && <p className="text-[12.5px] text-ink-2">The client is charged this × their multiplier (2 unless set otherwise on the client). You can change that figure when you price the offer.</p>}
      </div>
      {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">Not saved: {error}</p>}
      <div className="flex flex-wrap gap-2">
        {editable && <Button size="sm" variant="outline" onClick={() => setRows([...rows, { id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), model: '', storage: '', grade: '', qty: '', cost: '', sourceText: '', note: null }])}><Plus className="h-4 w-4" aria-hidden />Add line</Button>}
        {editable && <Button size="sm" variant="primary" disabled={busy || !dirty || !valid} onClick={() => put({ action: 'save', id: offer.id, lines, shipping: { cents: shipCents, none: noShip } })}>{busy ? 'Saving…' : 'Save changes'}</Button>}
        {offer.status === 'needs_review' && <Button size="sm" variant={dirty ? 'outline' : 'primary'} disabled={busy || dirty || !lines.length} title={dirty ? 'Save your changes first' : undefined} onClick={() => put({ action: 'status', id: offer.id, status: 'ready' })}>Mark reviewed</Button>}
        {offer.status === 'ready' && <Button size="sm" variant="outline" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'needs_review' })}>Back to review</Button>}
        {editable && <Button size="sm" variant="ghost" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'dismissed' })}>Not an offer</Button>}
        {offer.status === 'dismissed' && <Button size="sm" variant="outline" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'needs_review' })}>Restore</Button>}
      </div>
      {offer.status === 'ready' && <PricePanel key={offer.updatedAt} offer={offer} clients={clients} />}
      {(offer.status === 'ready' || offer.status === 'sent' || offer.status === 'accepted' || offer.status === 'declined' || offer.status === 'expired') && <SendPanel key={`${offer.updatedAt}-send`} offer={offer} clients={clients} setup={send} />}

      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-ink-2">The email as received</summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-line px-3 py-2 font-sans text-[12.5px] text-ink">{offer.text}</pre>
      </details>
      <details className="text-[12.5px] text-ink-2">
        <summary className="cursor-pointer">History</summary>
        <ul className="mt-1 space-y-0.5">{offer.audit.map((a, i) => <li key={i}>{when(a.at)}: {a.what}</li>)}</ul>
      </details>
    </section>
  )
}
