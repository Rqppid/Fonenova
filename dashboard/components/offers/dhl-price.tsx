'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DhlQuote } from '@/lib/offers/dhl'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dec = (t: string): number | null => { const s = t.trim().replace(',', '.'); return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : null }
const box = 'h-9 w-20 rounded-md border border-line bg-surface px-2 text-right text-[13px]'

/** Prices a parcel with DHL and offers the result. It only fills the cost box through `onPick`: a person still presses "Make the draft invoice". */
export function DhlPrice({ offerId, onPick }: { offerId: string; onPick: (cents: number) => void }) {
  const [t, setT] = useState({ w: '', l: '', wd: '', h: '' })
  const [o, setO] = useState({ countryCode: '', postalCode: '', city: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsOrigin, setNeedsOrigin] = useState(false)
  const [quotes, setQuotes] = useState<DhlQuote[] | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const weight = dec(t.w), length = dec(t.l), width = dec(t.wd), height = dec(t.h)
  const ready = weight !== null && length !== null && width !== null && height !== null

  async function call(body: object) {
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; needsOrigin?: boolean; quotes?: DhlQuote[] } | null
    return { ok: !!(res?.ok && out?.ok), out }
  }
  async function price() {
    setBusy(true); setError(null); setQuotes(null); setPicked(null)
    const { ok, out } = await call({ action: 'dhl_quote', id: offerId, parcel: { weightKg: weight, lengthCm: length, widthCm: width, heightCm: height } })
    setBusy(false)
    if (ok && out?.quotes) { setNeedsOrigin(false); setQuotes(out.quotes); return }
    setNeedsOrigin(out?.needsOrigin === true)
    setError(out?.error ?? 'Could not get a DHL price. Check your connection and try again.')
  }
  async function saveOrigin() {
    setBusy(true); setError(null)
    const { ok, out } = await call({ action: 'dhl_origin_set', origin: o })
    setBusy(false)
    if (ok) { setNeedsOrigin(false); await price() } else setError(out?.error ?? 'Could not save that.')
  }
  const field = (label: string, k: keyof typeof t) => <label className="flex flex-col gap-0.5 text-[12px] text-ink-2">{label}<input aria-label={label} inputMode="decimal" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} className={box} /></label>

  return (
    <div className="space-y-1.5 rounded-md bg-subtle p-2.5" data-testid="dhl-price">
      <p className="text-[12.5px] font-medium text-ink">Get the DHL price from the parcel</p>
      <div className="flex flex-wrap items-end gap-2">
        {field('Weight, kg', 'w')}{field('Length, cm', 'l')}{field('Width, cm', 'wd')}{field('Height, cm', 'h')}
        <Button size="sm" variant="outline" disabled={busy || !ready} onClick={price} data-testid="dhl-get">{busy ? 'Asking DHL…' : 'Get DHL price'}</Button>
      </div>
      {needsOrigin && (
        <div className="space-y-1" data-testid="dhl-origin">
          <p className="text-[12.5px] text-ink-2">Where are parcels collected from? This is saved once and used for every quote.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5 text-[12px] text-ink-2">Country (2 letters)<input aria-label="Origin country" maxLength={2} value={o.countryCode} onChange={(e) => setO({ ...o, countryCode: e.target.value })} className={box} /></label>
            <label className="flex flex-col gap-0.5 text-[12px] text-ink-2">Postcode<input aria-label="Origin postcode" value={o.postalCode} onChange={(e) => setO({ ...o, postalCode: e.target.value })} className="h-9 w-28 rounded-md border border-line bg-surface px-2 text-[13px]" /></label>
            <label className="flex flex-col gap-0.5 text-[12px] text-ink-2">City<input aria-label="Origin city" value={o.city} onChange={(e) => setO({ ...o, city: e.target.value })} className="h-9 w-40 rounded-md border border-line bg-surface px-2 text-[13px]" /></label>
            <Button size="sm" variant="primary" disabled={busy || !o.countryCode || !o.postalCode || !o.city} onClick={saveOrigin}>Save and get the price</Button>
          </div>
        </div>
      )}
      {quotes && (
        <ul className="space-y-1" data-testid="dhl-quotes">
          {quotes.map((q, i) => (
            <li key={`${q.productCode ?? q.service}-${i}`} className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
              <Button size="sm" variant={picked === i ? 'primary' : 'outline'} onClick={() => { setPicked(i); onPick(q.cents) }} data-testid="dhl-use">Use {eur(q.cents)}</Button>
              <span><strong className="text-ink">{q.service}</strong> · {q.currency}{q.billableWeightKg !== null ? ` · billable weight ${q.billableWeightKg} kg` : ''}{q.actualWeightKg !== null && q.volumetricWeightKg !== null ? ` (actual ${q.actualWeightKg} kg, volumetric ${q.volumetricWeightKg} kg)` : ''}</span>
            </li>
          ))}
          <li className="text-[12px] text-ink-2">Compare with your own DHL screen. Using a price only fills the box above; nothing is saved or invoiced until you press Make the draft invoice.</li>
        </ul>
      )}
      {error && <p role="alert" className="text-[12.5px] text-loss" data-testid="dhl-error">{error}</p>}
    </div>
  )
}
