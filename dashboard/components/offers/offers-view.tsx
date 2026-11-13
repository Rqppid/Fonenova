'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Inbox, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
}

interface Setup {
  gmail: { connected: boolean; email: string | null; canRead: boolean } | null
  telegram: boolean
  schedule: boolean
}

export function OffersView({ offers, status, setup, selected }: { offers: Offer[]; status: OffersStatus | null; setup: Setup; selected: string | null }) {
  const [openId, setOpenId] = useState<string | null>(selected ?? offers.find((o) => o.status === 'needs_review')?.id ?? null)
  const [showDismissed, setShowDismissed] = useState(false)
  const list = offers.filter((o) => showDismissed || o.status !== 'dismissed')
  const open = offers.find((o) => o.id === openId) ?? null
  const waiting = offers.filter((o) => o.status === 'needs_review').length
  return (
    <div className="space-y-4">
      <SetupNotes setup={setup} status={status} />
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section aria-labelledby="offers-list" className="rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 id="offers-list" className="text-[15px] font-semibold text-ink">Offers <span className="ml-1 font-normal text-ink-2">{waiting ? `${waiting} to review` : 'all reviewed'}</span></h2>
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2"><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />Show not offers</label>
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
                      <span className="truncate text-[13.5px] font-medium text-ink">{o.source.subject || '(no subject)'}</span>
                      <Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge>
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-ink-2">
                      {when(o.source.receivedAt)} · {o.lines.length} line{o.lines.length === 1 ? '' : 's'} · {offerUnits(o.lines)} units · {eur(offerCostCents(o.lines))}
                    </div>
                    {flagged > 0 && <div className="mt-0.5 flex items-center gap-1 text-[12.5px] text-loss"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />{flagged} line{flagged === 1 ? '' : 's'} to check</div>}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
        {open ? <OfferDetail key={open.id + open.updatedAt} offer={open} /> : <section className="rounded-lg border border-line bg-surface px-5 py-10 text-center text-[13.5px] text-ink-2">Choose an offer to review it.</section>}
      </div>
    </div>
  )
}

function SetupNotes({ setup, status }: { setup: Setup; status: OffersStatus | null }) {
  const notes: { text: React.ReactNode; bad: boolean }[] = []
  if (!setup.gmail) notes.push({ bad: true, text: 'Gmail is not set up on the dashboard (GOOGLE_CLIENT_ID).' })
  else if (!setup.gmail.connected) notes.push({ bad: true, text: <>Gmail is not connected. <a className="font-medium text-accent hover:underline" href="/gmail/connect">Connect Gmail</a> with info@fonenova.com.</> })
  else if (!setup.gmail.canRead) notes.push({ bad: true, text: <>Gmail is connected send-only, so offers can&apos;t be read yet. <a className="font-medium text-accent hover:underline" href="/gmail/connect">Connect Gmail again</a> and allow reading.</> })
  if (!setup.schedule) notes.push({ bad: true, text: 'CRON_SECRET is not set, so the 5-minute check cannot run.' })
  if (!setup.telegram) notes.push({ bad: false, text: 'Telegram is not set up (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID): new offers show here, without a ping.' })
  if (status) notes.push({ bad: !status.ok, text: `Last check ${when(status.lastRunAt)}: ${status.ok ? `${status.checked} new email${status.checked === 1 ? '' : 's'} read, ${status.added} offer${status.added === 1 ? '' : 's'} added.` : `failed. ${status.error ?? ''}`}` })
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

export function OfferDetail({ offer }: { offer: Offer }) {
  const router = useRouter()
  const [rows, setRows] = useState<Draft[]>(() => offer.lines.map(toDraft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parsed = rows.map(fromDraft)
  const valid = parsed.every(Boolean)
  const lines = parsed.filter((l): l is OfferLine => !!l)
  const flags = offerFlags(lines)
  const dirty = JSON.stringify(lines.map(({ sourceText: _s, ...l }) => l)) !== JSON.stringify(offer.lines.map(({ sourceText: _s, ...l }) => l))
  const editable = offer.status !== 'dismissed'

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
    <section aria-labelledby="offer-title" className="min-w-0 space-y-4 rounded-lg border border-line bg-surface p-5" data-testid="offer-detail">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id="offer-title" className="text-[16px] font-semibold text-ink">{offer.source.subject || '(no subject)'}</h2>
          <p className="text-[12.5px] text-ink-2">From {offer.source.from} · to {offer.source.to} · {when(offer.source.receivedAt)}</p>
        </div>
        <Badge tone={STATUS[offer.status].tone}>{STATUS[offer.status].label}</Badge>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[600px] text-[13px]">
          <thead className="text-left text-[12px] text-ink-3">
            <tr><th className="py-1.5 pr-2 font-medium">Model</th><th className="px-2 py-1.5 font-medium">Storage</th><th className="px-2 py-1.5 font-medium">Grade / spec</th><th className="px-2 py-1.5 text-right font-medium">Qty</th><th className="px-2 py-1.5 text-right font-medium">Unit cost €</th><th className="px-2 py-1.5 text-right font-medium">Line cost</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const l = parsed[i]
              const f = l ? flags.get(l.id) ?? [] : [{ code: 'qty', level: 'error', message: 'Fill in model, a whole quantity and a price.' }]
              const input = 'h-8 w-full rounded border border-line bg-surface px-2 text-[13px] disabled:bg-subtle'
              return (
                <tr key={r.id} className="border-t border-line align-top" data-testid="offer-line">
                  <td className="py-1.5 pr-2"><input aria-label={`Model, line ${i + 1}`} disabled={!editable} className={cn(input, f.some((x) => x.code === 'model') && 'border-loss')} value={r.model} onChange={(e) => set(i, 'model', e.target.value)} />
                    {f.length > 0 && <ul className="mt-1 space-y-0.5">{f.map((x, k) => <li key={k} className={cn('text-[12px]', x.level === 'error' ? 'text-loss' : 'text-warn')}>{x.message}</li>)}</ul>}
                    {r.sourceText && <p className="mt-1 text-[11.5px] text-ink-3">Email: “{r.sourceText}”</p>}
                  </td>
                  <td className="px-2 py-1.5"><input aria-label={`Storage, line ${i + 1}`} disabled={!editable} className={input} value={r.storage} onChange={(e) => set(i, 'storage', e.target.value)} /></td>
                  <td className="px-2 py-1.5"><input aria-label={`Grade, line ${i + 1}`} disabled={!editable} className={input} value={r.grade} onChange={(e) => set(i, 'grade', e.target.value)} /></td>
                  <td className="px-2 py-1.5"><input aria-label={`Quantity, line ${i + 1}`} disabled={!editable} inputMode="numeric" className={cn(input, 'text-right')} value={r.qty} onChange={(e) => set(i, 'qty', e.target.value)} /></td>
                  <td className="px-2 py-1.5"><input aria-label={`Unit cost, line ${i + 1}`} disabled={!editable} inputMode="decimal" className={cn(input, 'text-right')} value={r.cost} onChange={(e) => set(i, 'cost', e.target.value)} /></td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l ? eur(l.qty * l.unitCostCents) : '—'}</td>
                  <td className="py-1.5 pl-1">{editable && <button type="button" aria-label={`Delete line ${i + 1}`} className="rounded p-1.5 text-ink-3 hover:bg-subtle hover:text-loss" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" aria-hidden /></button>}</td>
                </tr>
              )
            })}
          </tbody>
          <tfoot><tr className="border-t border-line font-semibold"><td className="py-2" colSpan={3}>{lines.length} line{lines.length === 1 ? '' : 's'}</td><td className="px-2 py-2 text-right tabular-nums">{offerUnits(lines)}</td><td /><td className="px-2 py-2 text-right tabular-nums">{eur(offerCostCents(lines))}</td><td /></tr></tfoot>
        </table>
      </div>

      {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">Not saved: {error}</p>}
      <div className="flex flex-wrap gap-2">
        {editable && <Button size="sm" variant="outline" onClick={() => setRows([...rows, { id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), model: '', storage: '', grade: '', qty: '', cost: '', sourceText: '', note: null }])}><Plus className="h-4 w-4" aria-hidden />Add line</Button>}
        {editable && <Button size="sm" variant="primary" disabled={busy || !dirty || !valid} onClick={() => put({ action: 'save', id: offer.id, lines })}>{busy ? 'Saving…' : 'Save changes'}</Button>}
        {offer.status === 'needs_review' && <Button size="sm" variant={dirty ? 'outline' : 'primary'} disabled={busy || dirty || !lines.length} title={dirty ? 'Save your changes first' : undefined} onClick={() => put({ action: 'status', id: offer.id, status: 'ready' })}>Mark reviewed</Button>}
        {offer.status === 'ready' && <Button size="sm" variant="outline" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'needs_review' })}>Back to review</Button>}
        {offer.status !== 'dismissed'
          ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'dismissed' })}>Not an offer</Button>
          : <Button size="sm" variant="outline" disabled={busy} onClick={() => put({ action: 'status', id: offer.id, status: 'needs_review' })}>Restore</Button>}
      </div>
      {offer.status === 'ready' && <p className="text-[12.5px] text-ink-2">Reviewed. Pricing for a client comes in the next phase.</p>}

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
