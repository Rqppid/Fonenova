'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, FilePlus2 } from 'lucide-react'
import type { DraftSettings } from '@/lib/offers/draft'
import { cn } from '@/lib/utils'

export interface XeroWriteState {
  configured: boolean
  connected: boolean
  orgName: string | null
  isDemo: boolean | null
  /** Every organisation the write app is connected to, which one drafts go to, and which was chosen in the latest consent. */
  orgs?: { tenantId: string; name: string; isDemo: boolean; selected: boolean; justConnected: boolean }[]
  /** XERO_WRITE_ALLOW_LIVE is on: drafts in a live organisation are allowed. Its own switch, apart from real client sending. */
  liveAllowed?: boolean
  settings: DraftSettings
}

const NOTICE: Record<string, { text: string; good: boolean }> = {
  'connected-demo': { text: 'Connected to a Xero Demo Company. Test offers can now create their draft invoices there.', good: true },
  'connected-live': { text: 'A live Xero organisation is now connected. Connecting is not choosing: drafts keep going to the organisation marked "Drafts go here" until you choose the live one below, as a separate step.', good: true },
  declined: { text: 'The Xero sign-in was cancelled.', good: false },
  state: { text: 'The Xero sign-in expired or was opened in another browser. Try again.', good: false },
  failed: { text: 'Xero did not accept the connection. Check the app has the invoice, contacts and settings permissions, then try again.', good: false },
  'not-configured': { text: 'Needs XERO_WRITE_CLIENT_ID and online storage first.', good: false },
}

const field = 'h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-ink'

/** The second Xero connection, used only to create DRAFT invoices for accepted offers. */
/**
 * The card keeps what you are typing (tax type, account, theme) in its own state. It is rebuilt whenever the
 * organisation drafts go to, or the saved settings, change, so it never keeps showing (or saving) the previous
 * organisation's branding theme after you switch organisation.
 */
export function XeroWriteCard({ state, notice }: { state: XeroWriteState; notice: string | null }) {
  const key = `${state.orgs?.find((o) => o.selected)?.tenantId ?? 'none'}|${state.settings.taxType}|${state.settings.accountCode}|${state.settings.brandingThemeId ?? ''}`
  return <XeroWriteCardBody key={key} state={state} notice={notice} />
}

function XeroWriteCardBody({ state, notice }: { state: XeroWriteState; notice: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ taxType: state.settings.taxType, accountCode: state.settings.accountCode, brandingThemeId: state.settings.brandingThemeId ?? '' })
  const [msg, setMsg] = useState<{ text: string; good: boolean } | null>(null)
  const [themes, setThemes] = useState<{ id: string; name: string }[] | null>(null)
  const [confirmLive, setConfirmLive] = useState<Record<string, boolean>>({})
  async function choose(tenantId: string, live: boolean) {
    setBusy(true)
    setMsg(null)
    const res = await fetch('/xero-write/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, confirmLive: live ? confirmLive[tenantId] === true : false }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) { setMsg({ text: 'Done. Drafts now go to the organisation marked "Drafts go here".', good: true }); router.refresh() }
    else setMsg({ text: out?.error ?? 'Could not change it. Check your connection and try again.', good: false })
  }
  async function refreshOrgs() {
    setBusy(true)
    setMsg(null)
    const res = await fetch('/xero-write/refresh', { method: 'POST' }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) router.refresh()
    else setMsg({ text: out?.error ?? 'Could not list the organisations. Check your connection and try again.', good: false })
  }
  async function loadThemes() {
    setBusy(true)
    setMsg(null)
    const res = await fetch('/api/offers/branding-themes').catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; themes?: { id: string; name: string }[] } | null
    setBusy(false)
    if (res?.ok && out?.ok && out.themes) setThemes(out.themes)
    else setMsg({ text: out?.error ?? 'Could not load the themes. Check your connection and try again.', good: false })
  }
  const dirty = form.taxType !== state.settings.taxType || form.accountCode !== state.settings.accountCode || form.brandingThemeId !== (state.settings.brandingThemeId ?? '')
  const button = 'inline-flex h-9 items-center rounded-md bg-navy px-3 text-[13px] font-medium text-white hover:bg-navy-2'

  async function disconnect() {
    setBusy(true)
    await fetch('/xero-write/disconnect', { method: 'POST' }).catch(() => null)
    router.refresh()
    setBusy(false)
  }
  async function save() {
    setBusy(true)
    setMsg(null)
    const res = await fetch('/api/offers/draft-settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) {
      setMsg({ text: 'Saved.', good: true })
      router.refresh()
    } else setMsg({ text: out?.error ?? 'Could not save. Check your connection and try again.', good: false })
  }

  const n = notice ? NOTICE[notice] : null
  return (
    <section aria-labelledby="xero-write-title" className="rounded-lg border border-line bg-surface" data-testid="xero-write-card">
      <div className="border-b border-line px-5 py-3">
        <h2 id="xero-write-title" className="flex items-center gap-1.5 text-[15px] font-semibold text-ink"><FilePlus2 className="h-4 w-4 text-ink-3" aria-hidden />Xero draft invoices</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-ink-2">A separate Xero connection, only for creating DRAFT invoices when a client accepts an offer. It never approves, emails or deletes anything. The read-only Xero connection above is not changed.</p>
      </div>
      <div className="space-y-3 px-5 py-3 text-[13.5px]">
        {state.connected && state.isDemo === false && <p role="alert" className="rounded-md bg-loss px-3 py-2 text-[14px] font-semibold text-white" data-testid="live-banner">LIVE: drafts go to {state.orgName}</p>}
        {n && <p role="status" className={cn('rounded-md px-3 py-2 text-[13px]', n.good ? 'bg-gain-soft text-gain' : 'bg-warn-soft text-warn')}>{n.text}</p>}
        {!state.configured ? (
          <p className="text-ink-2" data-testid="xero-write-state">Not set up: create a second Xero app with invoice, contacts and settings permissions, then add its client id in Vercel as <code>XERO_WRITE_CLIENT_ID</code> and redeploy.</p>
        ) : state.connected ? (
          <>
            {state.orgName ? (
              <p className="flex items-center gap-1.5 text-ink" data-testid="xero-write-state"><CircleCheck className="h-4 w-4 text-gain" aria-hidden />Drafts go to <strong className="font-medium">{state.orgName}</strong>{state.isDemo ? ' · Demo Company: test offers only' : ' · live organisation: real offers (a test client only with a live test contact)'}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-warn" data-testid="xero-write-state"><CircleAlert className="h-4 w-4" aria-hidden />Connected, but no organisation is chosen for drafts yet. Choose one below: nothing is created until you do.</p>
            )}
            {(state.orgs?.length ?? 0) > 0 && (
              <div className="space-y-2 rounded-md border border-line p-3" data-testid="xero-orgs">
                <p className="text-[12.5px] font-medium text-ink-2">Connected organisations (choose where drafts go)</p>
                <ul className="divide-y divide-line">
                  {state.orgs!.map((o) => (
                    <li key={o.tenantId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="xero-org">
                      <span className="min-w-0 text-ink">
                        {o.name}
                        <span className={cn('ml-2 rounded px-1.5 py-0.5 text-[11.5px] font-semibold', o.isDemo ? 'bg-subtle text-ink-2' : 'bg-loss text-white')}>{o.isDemo ? 'DEMO' : 'LIVE'}</span>
                        {o.selected && <span className="ml-2 rounded bg-gain-soft px-1.5 py-0.5 text-[11.5px] font-semibold text-gain" data-testid="org-selected">Drafts go here</span>}
                        {o.justConnected && <span className="ml-2 text-[12px] text-ink-3">chosen in your latest sign-in</span>}
                      </span>
                      {!o.selected && (
                        <span className="flex flex-wrap items-center gap-2">
                          {!o.isDemo && <label className="flex items-center gap-1.5 text-[12.5px] text-loss"><input type="checkbox" checked={confirmLive[o.tenantId] === true} onChange={(e) => setConfirmLive({ ...confirmLive, [o.tenantId]: e.target.checked })} />Drafts will be created in my LIVE Xero</label>}
                          <button type="button" disabled={busy || (!o.isDemo && confirmLive[o.tenantId] !== true)} onClick={() => choose(o.tenantId, !o.isDemo)} className={cn('inline-flex h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium disabled:opacity-50', o.isDemo ? 'border border-line text-ink hover:bg-subtle' : 'bg-loss text-white')} data-testid={o.isDemo ? 'use-demo' : 'use-live'}>{o.isDemo ? `Use ${o.name}` : `Use ${o.name} (live)`}</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={refreshOrgs} disabled={busy} className="inline-flex h-8 items-center rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink-2 hover:text-ink disabled:opacity-50">Refresh the list from Xero</button>
              </div>
            )}
            {state.isDemo === false && <p className={cn('rounded-md px-3 py-2 text-[13px]', state.liveAllowed ? 'bg-warn-soft text-warn' : 'bg-subtle text-ink-2')} data-testid="live-gate">{state.liveAllowed ? 'Live drafts are ON (XERO_WRITE_ALLOW_LIVE). Real client sending is a separate switch (OFFERS_ALLOW_REAL_SEND).' : 'This is a live organisation, but live drafts are OFF: nothing will be created in it. Turning them on is its own step (XERO_WRITE_ALLOW_LIVE in Vercel), separate from real client sending (OFFERS_ALLOW_REAL_SEND).'}</p>}
            <div className="flex flex-wrap gap-2">
              <a href="/xero-write/connect" className="inline-flex h-9 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink-2 hover:text-ink">Connect another organisation</a>
              <button type="button" onClick={disconnect} disabled={busy} className="inline-flex h-9 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink-2 hover:text-ink disabled:opacity-50">Disconnect</button>
            </div>
          </>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-warn" data-testid="xero-write-state"><CircleAlert className="h-4 w-4" aria-hidden />Not connected. Connect the Xero Demo Company first to try the whole journey with the test client.</p>
            <a href="/xero-write/connect" className={button}>Connect Xero</a>
          </>
        )}
        <div className="grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
          <label className="space-y-1 text-[12.5px] text-ink-2">Tax type on every line<input className={field} value={form.taxType} onChange={(e) => setForm({ ...form, taxType: e.target.value })} aria-label="Tax type" /></label>
          <label className="space-y-1 text-[12.5px] text-ink-2">Sales account code<input className={field} value={form.accountCode} onChange={(e) => setForm({ ...form, accountCode: e.target.value })} aria-label="Sales account code" /></label>
          <div className="space-y-1 text-[12.5px] text-ink-2">
            {themes ? (
              <label className="block space-y-1">Branding theme
                <select className={field} value={form.brandingThemeId} onChange={(e) => setForm({ ...form, brandingThemeId: e.target.value })} aria-label="Branding theme" data-testid="theme-select">
                  <option value="">Xero's default theme</option>
                  {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            ) : (
              <label className="block space-y-1">Branding theme id (optional)<input className={field} value={form.brandingThemeId} onChange={(e) => setForm({ ...form, brandingThemeId: e.target.value })} aria-label="Branding theme id" placeholder="Pick from Xero with Load themes" /></label>
            )}
            {state.connected && !themes && <button type="button" onClick={loadThemes} disabled={busy} className="inline-flex h-8 items-center rounded-md border border-line px-2.5 text-[12.5px] font-medium text-ink hover:bg-subtle disabled:opacity-50" data-testid="load-themes">Load themes from Xero</button>}
          </div>
        </div>
        <p className="text-[12.5px] text-ink-3">Check these against invoice 2026047 before the first real offer: the tax type and account must match how your sales are booked today. The branding theme is the one that says &quot;Sold under VAT Margin Scheme, ART 313&quot;: load the list from Xero and pick it by name (the id in the theme editor&apos;s page address is not always the id the API needs).</p>
        {msg && <p role="status" className={cn('rounded-md px-3 py-2 text-[13px]', msg.good ? 'bg-gain-soft text-gain' : 'bg-warn-soft text-warn')}>{msg.text}</p>}
        <button type="button" onClick={save} disabled={busy || !dirty} className="inline-flex h-9 items-center rounded-md border border-line px-3 text-[13px] font-medium text-ink hover:bg-subtle disabled:opacity-50">{busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </section>
  )
}
