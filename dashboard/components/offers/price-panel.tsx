'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { multiplierOf, ruleText, shippingBasisOf, type Client } from '@/lib/offers/clients'
import { MIN_MARGIN_CENTS, priceOffer } from '@/lib/offers/pricing'
import type { Offer } from '@/lib/offers/types'
import { parseEuro } from '@/lib/deal'
import { cn } from '@/lib/utils'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const cents = (v: string) => (v.trim() ? parseEuro(v) : null)

/**
 * "Price for a client": pick one client, set the margin where the client's rule says so, see the
 * sale price and profit per line and in total, then mark it priced. The figures come from the same
 * function the server uses, and the server checks them again on save.
 */
export function PricePanel({ offer, clients }: { offer: Offer; clients: Client[] }) {
  const router = useRouter()
  const saved = offer.pricing
  const [clientId, setClientId] = useState(saved?.clientId ?? '')
  const [margin, setMargin] = useState(saved?.marginCents ? (saved.marginCents / 100).toFixed(2) : '')
  const [over, setOver] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(saved?.overrides ?? {}).map(([k, v]) => [k, (v / 100).toFixed(2)])))
  const [ack, setAck] = useState(saved?.ackLow ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = clients.find((c) => c.id === clientId) ?? null
  const locked = !!client && client.margin.type === 'fixed' && client.margin.locked

  const marginBad = margin.trim() !== '' && cents(margin) === null
  const input = {
    clientId,
    marginCents: client?.margin.type === 'manual' ? cents(margin) : null,
    overrides: Object.fromEntries(Object.entries(over).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, cents(v) ?? 0])),
    ackLow: ack,
    shippingCents: null,
    mobileShipping: { cents: null, none: false },
    shippingLater: true,
  }
  const result = client ? priceOffer(offer.lines, client, input) : null

  async function put(body: object) {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) router.refresh()
    else setError(out?.error ?? 'Could not save. Check your connection and try again.')
  }

  return (
    <section aria-labelledby="price-title" className="space-y-3 rounded-md border border-line p-4" data-testid="price-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="price-title" className="text-[14px] font-semibold text-ink">Price for a client</h3>
        {saved && <span className="text-[12.5px] font-medium text-gain" data-testid="priced-badge">Priced for {clients.find((c) => c.id === saved.clientId)?.name ?? 'a client'}</span>}
      </div>

      <label className="block text-[13px]">
        <span className="mb-1 block font-medium text-ink-2">Client (one per offer)</span>
        <select value={clientId} onChange={(e) => { setClientId(e.target.value); setMargin(''); setOver({}); setAck(false) }} className="h-9 w-full max-w-sm rounded-md border border-line bg-surface px-2 text-[13px]">
          <option value="">Choose a client…</option>
          {(offer.testOnly ? clients.filter((c) => c.test) : clients).map((c) => <option key={c.id} value={c.id}>{c.name}{c.test ? ' (test)' : ''}</option>)}
        </select>
      </label>

      {client && (
        <>
          <p className="text-[13px] text-ink-2" data-testid="rule">{ruleText(client)}.</p>
          {client.margin.type === 'manual' && (
            <label className="block text-[13px]">
              <span className="mb-1 block font-medium text-ink-2">Margin per unit, € (the whole offer)</span>
              <input aria-label="Margin per unit" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="e.g. 7.00" className={cn('h-9 w-40 rounded-md border bg-surface px-2 text-right text-[13px]', marginBad ? 'border-loss' : 'border-line')} />
              {marginBad && <span className="ml-2 text-[12.5px] text-loss">Enter an amount like 7.00</span>}
            </label>
          )}

          {result && (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] max-sm:block sm:min-w-[560px]">
                <thead className="text-left text-[12px] text-ink-3 max-sm:hidden">
                  <tr><th className="py-1.5 pr-2 font-medium">Line</th><th className="px-2 py-1.5 text-right font-medium">Cost</th><th className="px-2 py-1.5 text-right font-medium">Margin €</th><th className="px-2 py-1.5 text-right font-medium">Sale</th><th className="px-2 py-1.5 text-right font-medium">Line sale</th><th className="px-2 py-1.5 text-right font-medium">Profit</th></tr>
                </thead>
                <tbody className="max-sm:block">
                  {offer.lines.map((l, i) => {
                    const p = result.lines[i]
                    return (
                      <tr key={l.id} className={cn('border-t border-line max-sm:mb-3 max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 max-sm:rounded-md max-sm:border max-sm:p-3', p.low && 'bg-loss-soft/40')} data-testid="price-line" data-low={p.low}>
                        <td className="py-1.5 pr-2 max-sm:col-span-2 max-sm:p-0 font-medium sm:font-normal">{[l.model, l.storage, l.grade].filter(Boolean).join(' ')} <span className="text-ink-3">× {l.qty}</span></td>
                        <td data-label="Cost" className="px-2 py-1.5 text-right tabular-nums max-sm:p-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(l.unitCostCents)}</td>
                        <td data-label="Margin €" className="px-2 py-1.5 text-right max-sm:p-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">
                          {locked ? <span className="tabular-nums">{p.marginCents === null ? '—' : (p.marginCents / 100).toFixed(2)}</span> : (
                            <input aria-label={`Margin for line ${i + 1}`} inputMode="decimal" value={over[l.id] ?? ''} onChange={(e) => setOver({ ...over, [l.id]: e.target.value })} placeholder={p.marginCents === null ? '' : (p.marginCents / 100).toFixed(2)} className={cn('h-8 w-24 rounded border bg-surface px-2 text-right text-[13px]', p.overridden ? 'border-accent' : 'border-line')} />
                          )}
                        </td>
                        <td data-label="Sale" className="px-2 py-1.5 text-right tabular-nums max-sm:p-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{p.saleCents === null ? '—' : eur(p.saleCents)}</td>
                        <td data-label="Line sale" className="px-2 py-1.5 text-right tabular-nums max-sm:p-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{p.lineSaleCents === null ? '—' : eur(p.lineSaleCents)}</td>
                        <td data-label="Profit" className={cn('px-2 py-1.5 text-right tabular-nums max-sm:p-0 max-sm:text-left '+'max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]', p.low && 'font-semibold text-loss')}>{p.lineProfitCents === null ? '—' : eur(p.lineProfitCents)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot className="max-sm:block">
                  <tr className="border-t border-line font-semibold max-sm:flex max-sm:flex-wrap max-sm:gap-x-4 max-sm:pt-2" data-testid="price-totals">
                    <td className="py-2 max-sm:w-full" colSpan={3}>Total · {result.totals.units} units · cost {eur(result.totals.costCents)}</td>
                    <td className="max-sm:hidden" />
                    <td data-label="Sale" className="px-2 py-2 text-right tabular-nums max-sm:px-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.saleCents)}</td>
                    <td data-label="Profit" className="px-2 py-2 text-right tabular-nums max-sm:px-0 max-sm:text-left max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.profitCents)}</td>
                  </tr>
                  {result.totals.shippingCents > 0 && <tr data-testid="price-shipping" className="max-sm:flex max-sm:flex-wrap max-sm:gap-x-4"><td className="py-1" colSpan={4}>Shipping</td><td data-label="Charged" className="px-2 py-1 text-right tabular-nums max-sm:px-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.shippingCents)}</td><td data-label="Profit" className="px-2 py-1 text-right tabular-nums max-sm:px-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.shippingProfitCents)}</td></tr>}
                  <tr className="font-semibold max-sm:flex max-sm:flex-wrap max-sm:gap-x-4" data-testid="price-grand"><td className="py-1 max-sm:w-full" colSpan={4}>Total to the client</td><td data-label="Total" className="px-2 py-1 text-right tabular-nums max-sm:px-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.grandCents)}</td><td data-label="Profit" className="px-2 py-1 text-right tabular-nums max-sm:px-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-[12px] max-sm:before:text-ink-3 max-sm:before:content-[attr(data-label)]">{eur(result.totals.profitCents + result.totals.shippingProfitCents)}</td></tr>
                  {result.totals.profitPerUnitCents !== null && <tr><td colSpan={6} className="pb-1 text-right text-[12.5px] text-ink-2">Profit per unit on average {eur(result.totals.profitPerUnitCents)}</td></tr>}
                </tfoot>
              </table>
            </div>
          )}

          {result && (
            <div className="space-y-1.5 rounded-md bg-subtle p-3 text-[13px]" data-testid="shipping-box">
              <p className="font-medium text-ink">Shipping</p>
              <p className="text-ink-2" data-testid="shipping-later-note">The offer goes out without shipping and says it is added to the invoice. Once the client accepts, you enter the shipping ({client && shippingBasisOf(client) === 'own_dhl' ? 'our own DHL cost, no mark-up' : `Mobile One's, charged × ${multiplierOf(client!)}`}) and the draft invoice is made with it.</p>
            </div>
          )}
          {result && result.errors.length > 0 && (margin.trim() !== '' || client.margin.type === 'fixed') && (
            <ul className="space-y-0.5 text-[12.5px] text-warn" data-testid="price-errors">{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
          {result && result.needsAck && (
            <label className="flex items-start gap-2 rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss" data-testid="ack">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1"><input type="checkbox" className="mr-2" checked={ack} onChange={(e) => setAck(e.target.checked)} />I know {result.lowCount} line{result.lowCount === 1 ? ' is' : 's are'} under {eur(MIN_MARGIN_CENTS)} per unit.</span>
            </label>
          )}
        </>
      )}

      {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">Not saved: {error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy || !client || !result?.ok} onClick={() => put({ action: 'price', id: offer.id, ...input })}>{busy ? 'Saving…' : saved ? 'Update price' : 'Mark priced'}</Button>
        {saved && <Button size="sm" variant="ghost" disabled={busy} onClick={() => put({ action: 'unprice', id: offer.id })}>Remove price</Button>}
      </div>
      {saved && <p className="text-[12.5px] text-ink-2">Priced. Send it to the client from the panel below.</p>}
    </section>
  )
}
