'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Link2, RefreshCw, Unlink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { OneDriveState, XeroState } from '@/lib/data-source'
import type { LiveSummary } from '@/lib/metrics'
import type { SourceStatus } from '@/lib/sync-core'
import { formatDate } from '@/lib/periods'
import { cn } from '@/lib/utils'

const NOTICE: Record<string, string> = {
  connected: 'Xero connected.',
  declined: 'Xero sign-in was cancelled.',
  state: 'The Xero sign-in expired or was opened in another browser. Try again.',
  failed: 'Xero sign-in failed. Check the client ID and redirect address in your Xero app.',
  'not-configured': 'Xero is not set up on this computer yet.',
}

const ONEDRIVE_NOTICE: Record<string, string> = {
  connected: 'OneDrive connected and synced.',
  declined: 'OneDrive sign-in was cancelled.',
  state: 'The OneDrive sign-in expired or was opened in another browser. Try again.',
  failed: 'OneDrive sign-in failed. Check the Microsoft app\'s client ID and redirect address.',
  'not-configured': 'OneDrive is not set up yet: add MS_CLIENT_ID, and online storage when hosted.',
}

export function XeroBar({ xero, summary, ledgerImported, ledgerSnapshot, notice, sources, oneDrive, oneDriveNotice, hosted }: {
  sources: SourceStatus[]
  oneDrive: OneDriveState
  oneDriveNotice: string | null
  hosted: boolean
  xero: XeroState
  summary: LiveSummary | null
  ledgerImported: string
  ledgerSnapshot: string
  notice: string | null
}) {
  const router = useRouter()
  // A sign-in notice ("OneDrive sign-in failed", "Xero connected", …) comes in the address once.
  // Take it out of the address after showing it, so a reload or a bookmark never shows an old one.
  useEffect(() => {
    if (!notice && !oneDriveNotice) return
    const url = new URL(window.location.href)
    url.searchParams.delete('onedrive')
    url.searchParams.delete('xero')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
  }, [notice, oneDriveNotice])
  const [busy, setBusy] = useState<'refresh' | 'disconnect' | 'onedrive-disconnect' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const snap = xero.snapshot

  async function post(path: string, kind: NonNullable<typeof busy>) {
    setBusy(kind)
    setError(null)
    try {
      const res = await fetch(path, { method: 'POST' })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setError(body.error ?? `Failed (${res.status})`)
      router.refresh()
    } catch {
      setError('Could not reach the dashboard server')
    } finally {
      setBusy(null)
    }
  }

  const refreshed = snap ? `${formatDate(snap.fetchedAt.slice(0, 10))}, ${new Date(snap.fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : null
  const problems = snap?.problems ?? []

  return (
    <div className="mb-3 rounded-lg border border-line bg-surface text-[12.5px]" role="status">
      <ul className="divide-y divide-line">
        {(sources.length ? sources.filter((x) => x.source !== 'xero') : []).map((x) => <SourceLine key={x.source} s={x} />)}
        {sources.length === 0 && <li className="px-3 py-1.5 text-ink-3">Ledger imported {ledgerImported} (snapshot {ledgerSnapshot}), from the FN_LEDGER_BR setting. Automatic sync is off.</li>}
      </ul>
      {oneDrive.relevant && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2">
          <span className="font-medium text-ink-2">OneDrive</span>
          {!oneDrive.configured ? (
            <span className="text-ink-3">Not set up: add <code>MS_CLIENT_ID</code>{hosted && ' and online storage'} in the {hosted ? 'Vercel project settings' : <code>.env.local</code>}.</span>
          ) : !oneDrive.connected ? (
            <>
              <span className="text-ink-2">Not connected, so the ledger and tracker are not read from OneDrive.</span>
              <a href="/onedrive/connect" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-navy px-2.5 font-medium text-white hover:bg-navy-2">
                <Link2 className="h-4 w-4" aria-hidden />Connect OneDrive
              </a>
            </>
          ) : (
            <>
              <span className="font-medium text-gain">Connected{oneDrive.accountName ? ` (${oneDrive.accountName})` : ''}</span>
              <span className="text-ink-3" data-testid="onedrive-access">{oneDrive.canWrite ? 'read and write (payments trackers)' : 'read-only'}</span>
              {hosted && <span className="text-ink-3">checked on each visit and daily at 06:00 UTC</span>}
              <Button size="sm" variant="ghost" onClick={() => post('/onedrive/disconnect', 'onedrive-disconnect')} disabled={busy !== null}>
                <Unlink className="h-3.5 w-3.5" aria-hidden />Disconnect
              </Button>
            </>
          )}
          {oneDriveNotice && ONEDRIVE_NOTICE[oneDriveNotice] && <span className={cn(oneDriveNotice === 'connected' ? 'text-gain' : 'text-loss')}>{ONEDRIVE_NOTICE[oneDriveNotice]}</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2">
      <span className="font-medium text-ink-2">Xero</span>
      {!xero.configured ? (
        <span className="text-ink-3">Not set up: add <code>XERO_CLIENT_ID</code>{hosted ? ' (and online storage) in the Vercel project settings' : <> to <code>.env.local</code></>}. Statuses come from the ledger snapshot.</span>
      ) : !xero.connected ? (
        <>
          <span className="text-ink-2">Not connected. Statuses come from the ledger snapshot.</span>
          <a href="/xero/connect" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-navy px-2.5 font-medium text-white hover:bg-navy-2">
            <Link2 className="h-4 w-4" aria-hidden />Connect Xero (read-only)
          </a>
        </>
      ) : (
        <>
          <span className={cn('font-medium', problems.length ? 'text-warn' : 'text-gain')}>
            Live from Xero{xero.tenantName ? ` (${xero.tenantName})` : ''}
          </span>
          <span className="text-ink-2">{refreshed ? `last refreshed ${refreshed}` : 'not refreshed yet'}</span>
          {summary && (
            <Popover>
              <PopoverTrigger className="inline-flex items-center gap-1 text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
                {summary.clientMatched}/{summary.orders} client invoices, {summary.billMatched}/{summary.orders} bills matched
                {problems.length > 0 && `, ${problems.length} problem${problems.length > 1 ? 's' : ''}`}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </PopoverTrigger>
              <PopoverContent className="w-[min(460px,calc(100vw-24px))] p-0">
                <div className="border-b border-line px-3 py-2 text-[12.5px] text-ink-2">
                  Orders whose invoices were found in Xero use Xero&apos;s live status, balance, due date and payments. The rest keep the ledger snapshot. Sales and costs always come from the ledger.
                </div>
                {problems.length > 0 && (
                  <ul className="border-b border-line px-3 py-2 text-[12px] text-warn">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                )}
                <ul className="relative max-h-64 overflow-y-auto px-3 py-2 text-[12px]">
                  {summary.gaps.length === 0 ? <li className="text-gain">Every order matched.</li> : summary.gaps.map((g) => (
                    <li key={g.orderId} className="py-0.5"><span className="font-medium text-ink">{g.orderId}</span> <span className="text-ink-3">{g.problem}</span></li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
          <Button size="sm" onClick={() => post('/xero/refresh', 'refresh')} disabled={busy !== null}>
            <RefreshCw className={cn('h-3.5 w-3.5', busy === 'refresh' && 'animate-spin')} aria-hidden />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => post('/xero/disconnect', 'disconnect')} disabled={busy !== null}>
            <Unlink className="h-3.5 w-3.5" aria-hidden />Disconnect
          </Button>
        </>
      )}
      {(error || (notice && NOTICE[notice])) && <span className={cn(error || notice !== 'connected' ? 'text-loss' : 'text-gain')}>{error ?? NOTICE[notice!]}</span>}
      </div>
    </div>
  )
}

const time = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return `${formatDate(iso.slice(0, 10))}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

function SourceLine({ s }: { s: SourceStatus }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5">
      <span className={cn('h-2 w-2 shrink-0 translate-y-[-1px] rounded-full', s.ok ? 'bg-gain' : s.configured ? 'bg-loss' : 'bg-line-strong')} aria-hidden />
      <span className="font-medium text-ink-2">{s.label}</span>
      {s.fileName && <span className="text-ink-3" title={s.fileName}>{s.fileName}</span>}
      {s.fileSavedAt && <span className="text-ink-3">saved {time(s.fileSavedAt)}</span>}
      {s.importedAt && <span className="text-ink-3">imported {time(s.importedAt)}</span>}
      {s.checkedAt && <span className="text-ink-3">checked {time(s.checkedAt)}</span>}
      <span className={cn(s.ok ? 'text-ink-2' : s.configured ? 'text-loss' : 'text-ink-3')}>{s.changed ? 'Just synced: ' : ''}{s.message}</span>
    </li>
  )
}
