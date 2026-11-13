'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { parseEuro } from '@/lib/deal'
import { FOLDERS, ruleText, type Client, type Folder } from '@/lib/offers/clients'
import { cn } from '@/lib/utils'

const list = (v: string) => v.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
const input = 'h-9 w-full rounded-md border border-line bg-surface px-2 text-[13px]'

/** Every client with its margin rule, terms and contacts. Saved all at once; the server checks every field again. */
export function ClientsView({ clients, usedBy }: { clients: Client[]; usedBy: Record<string, number> }) {
  const router = useRouter()
  const [rows, setRows] = useState<Client[]>(clients)
  const [text, setText] = useState<Record<string, { offer: string; invoice: string; fixed: string; days: string }>>(() =>
    Object.fromEntries(clients.map((c) => [c.id, { offer: c.offerEmails.join(', '), invoice: c.invoiceEmails.join(', '), fixed: c.margin.type === 'fixed' ? (c.margin.perUnitCents / 100).toFixed(2) : '', days: c.terms === 'upfront' ? '' : String(c.terms.days) }])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const patch = (id: string, p: Partial<Client>) => { setRows(rows.map((c) => (c.id === id ? { ...c, ...p } : c))); setSaved(false) }
  const t = (id: string, k: 'offer' | 'invoice' | 'fixed' | 'days', v: string) => { setText({ ...text, [id]: { ...text[id], [k]: v } }); setSaved(false) }

  function build(): Client[] {
    return rows.map((c) => {
      const x = text[c.id]
      const fixed = parseEuro(x.fixed)
      return {
        ...c,
        offerEmails: list(x.offer),
        invoiceEmails: list(x.invoice),
        margin: c.margin.type === 'fixed' ? { type: 'fixed', perUnitCents: fixed ?? 0, locked: c.margin.locked } : { type: 'manual' },
        terms: c.terms === 'upfront' ? 'upfront' : { days: Number(x.days) },
      }
    })
  }

  async function save() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/offers/clients', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clients: build() }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) { setSaved(true); router.refresh() }
    else setError(out?.error ?? 'Could not save. Check your connection and try again.')
  }

  function add() {
    const id = `c_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
    setRows([...rows, { id, name: '', xeroContactId: null, offerEmails: [], invoiceEmails: [], margin: { type: 'manual' }, terms: { days: 30 }, autoApprove: false, folder: 'other', test: false }])
    setText({ ...text, [id]: { offer: '', invoice: '', fixed: '', days: '30' } })
    setSaved(false)
  }

  return (
    <div className="space-y-4">
      {rows.map((c) => {
        const x = text[c.id]
        return (
          <section key={c.id} className="space-y-3 rounded-lg border border-line bg-surface p-5" data-testid="client" aria-label={c.name || 'New client'}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-[15px] font-semibold text-ink">{c.name || 'New client'}{c.test && <span className="ml-2 rounded bg-subtle px-1.5 py-0.5 text-[11.5px] font-medium text-ink-2">test</span>}</h2>
                <p className="text-[12.5px] text-ink-2">{ruleText(c)} · {c.terms === 'upfront' ? 'pays upfront' : `${c.terms.days} days`}</p>
              </div>
              <button type="button" disabled={(usedBy[c.id] ?? 0) > 0} title={(usedBy[c.id] ?? 0) > 0 ? 'An offer is priced for this client' : 'Remove client'} aria-label={`Remove ${c.name || 'client'}`} onClick={() => { setRows(rows.filter((r) => r.id !== c.id)); setSaved(false) }} className="rounded p-1.5 text-ink-3 hover:bg-subtle hover:text-loss disabled:opacity-30"><Trash2 className="h-4 w-4" aria-hidden /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Name</span><input className={input} value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} /></label>
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Xero ContactID (optional for now)</span><input className={input} value={c.xeroContactId ?? ''} onChange={(e) => patch(c.id, { xeroContactId: e.target.value.trim() || null })} placeholder="a1b2c3d4-…" /></label>
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Offer emails (comma separated)</span><input className={input} value={x.offer} onChange={(e) => t(c.id, 'offer', e.target.value)} /></label>
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Invoice emails (comma separated)</span><input className={input} value={x.invoice} onChange={(e) => t(c.id, 'invoice', e.target.value)} /></label>
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Margin rule</span>
                <select className={input} value={c.margin.type} onChange={(e) => patch(c.id, { margin: e.target.value === 'fixed' ? { type: 'fixed', perUnitCents: 400, locked: false } : { type: 'manual' } })}>
                  <option value="manual">I set it per offer</option>
                  <option value="fixed">Fixed per unit</option>
                </select>
              </label>
              {c.margin.type === 'fixed' && (
                <div className="flex items-end gap-3 text-[13px]">
                  <label className="flex-1"><span className="mb-1 block font-medium text-ink-2">Fixed margin per unit, €</span><input aria-label="Fixed margin per unit" inputMode="decimal" className={cn(input, 'text-right')} value={x.fixed} onChange={(e) => t(c.id, 'fixed', e.target.value)} /></label>
                  <label className="mb-2 flex items-center gap-1.5"><input type="checkbox" checked={c.margin.locked} onChange={(e) => patch(c.id, { margin: { type: 'fixed', perUnitCents: c.margin.type === 'fixed' ? c.margin.perUnitCents : 400, locked: e.target.checked } })} />Locked (no per-line changes)</label>
                </div>
              )}
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Payment terms</span>
                <div className="flex items-center gap-2">
                  <select className={cn(input, 'w-32')} value={c.terms === 'upfront' ? 'upfront' : 'days'} onChange={(e) => patch(c.id, { terms: e.target.value === 'upfront' ? 'upfront' : { days: Number(x.days) || 30 } })}>
                    <option value="days">Days</option>
                    <option value="upfront">Upfront</option>
                  </select>
                  {c.terms !== 'upfront' && <input aria-label="Payment days" inputMode="numeric" className={cn(input, 'w-24 text-right')} value={x.days} onChange={(e) => t(c.id, 'days', e.target.value)} />}
                </div>
              </label>
              <label className="text-[13px]"><span className="mb-1 block font-medium text-ink-2">Invoice PDF folder</span>
                <select className={input} value={c.folder} onChange={(e) => patch(c.id, { folder: e.target.value as Folder })}>{FOLDERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
              </label>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.test} onChange={(e) => patch(c.id, { test: e.target.checked })} />Test client (never a real customer)</label>
              <label className="flex items-center gap-1.5 opacity-60" title="Arrives with the approve step"><input type="checkbox" disabled checked={false} />Approve invoices automatically (not available yet)</label>
            </div>
          </section>
        )
      })}
      {error && <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-[13px] text-loss">Not saved: {error}</p>}
      {saved && <p role="status" className="rounded-md bg-gain-soft px-3 py-2 text-[13px] text-gain">Saved.</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={add}><Plus className="h-4 w-4" aria-hidden />Add client</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save clients'}</Button>
      </div>
    </div>
  )
}
