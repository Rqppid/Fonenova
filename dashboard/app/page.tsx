import { redirect } from 'next/navigation'
import { FileWarning } from 'lucide-react'
import { Dashboard } from '@/components/dashboard/dashboard'
import { Shell } from '@/components/shell'
import { currentUser } from '@/lib/session'
import { after } from 'next/server'
import { lastSources, syncSources } from '@/lib/sync'
import { getDataSource, isHosted, loadExpenses, loadFxRate, loadOneDriveState, loadOverheads, loadSettings, loadXeroState, overheadsWritable, toClientLedger } from '@/lib/data-source'
import { loadMakeStatus } from '@/lib/make'
import { loadWeeklyEmailState } from '@/lib/weekly'
import { loadAskState } from '@/lib/ask/data'
import { loadHealth } from '@/lib/watchdog'
import { todayIso } from '@/lib/periods'
import { attentionItems } from '@/lib/attention'
import { allocateCredits, expenseSummary } from '@/lib/metrics'
import { draftsAwaiting } from '@/lib/xero/pairing'
import { liveView } from '@/lib/live-view'

// Read the ledger on every request so a fresh import shows without a rebuild.
export const dynamic = 'force-dynamic'
// A visit can run a full import (first OneDrive read, a newly saved tracker); allow up to 300s on Hobby.
export const maxDuration = 300

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams
  const notice = params.xero ?? null
  const oneDriveNotice = params.onedrive ?? null
  const gmailNotice = params.gmail ?? null
  // Second lock: proxy.ts already gates this route, but the data never loads without a session here either.
  const user = await currentUser()
  if (user === false) redirect('/login')
  const email = user

  // Show the stored data straight away and sync after the response, so the page never waits on
  // OneDrive or Xero; the next refresh (AutoRefresh, every minute) shows anything new. Straight
  // after connecting Xero or OneDrive, sync first instead, so the page shows the new connection.
  const connecting = !!(notice || oneDriveNotice)
  const sources = connecting ? await syncSources({ force: true }) : await lastSources()
  if (!connecting) after(() => syncSources().then(() => undefined, () => undefined))
  const source = getDataSource()
  const [result, fx, oh, xero, exp, oneDrive, settings, make, weekly, askState, health] = await Promise.all([source.load(), loadFxRate(), loadOverheads(), loadXeroState(), loadExpenses(), loadOneDriveState(), loadSettings(), loadMakeStatus(), loadWeeklyEmailState(), loadAskState(), loadHealth(sources).catch(() => [])])

  if (!result.ok) {
    return (
      <Shell email={email}>
        <div className="mx-auto mt-24 max-w-lg rounded-lg border border-line bg-surface p-6" role="alert">
          <div className="flex items-center gap-2 text-loss">
            <FileWarning className="h-5 w-5" aria-hidden />
            <h1 className="text-[15px] font-semibold">{result.title}</h1>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{result.detail}</p>
          {sources.some((x) => !x.ok && x.configured) && (
            <ul className="mt-3 space-y-1 text-[13px] text-loss">{sources.filter((x) => !x.ok && x.configured).map((x) => <li key={x.source}>{x.label}: {x.message}</li>)}</ul>
          )}
          {oneDrive.configured && !oneDrive.connected && (
            <a href="/onedrive/connect" className="mt-4 inline-flex h-9 items-center rounded-md bg-navy px-3 text-sm font-medium text-white hover:bg-navy-2">Connect OneDrive (read-only)</a>
          )}
          <p className="mt-4 text-[13px] text-ink-3">Data source: {source.name}. No figures are shown until the data loads, so nothing on screen is a guess.</p>
        </div>
      </Shell>
    )
  }

  const { ledger } = result
  // Work waiting, for the sidebar. Recomputed on every load, so a decided row drops off at once.
  // Same view the dashboard shows: ledger plus Xero orders, with the live Xero checks.
  const merged = liveView(ledger, xero.snapshot, xero.pairs, todayIso())
  const high = attentionItems(merged.ledger, allocateCredits(merged.ledger.creditNotes), merged.checks).filter((i) => i.priority === 'HIGH').length
  const toReview = exp.log ? expenseSummary(exp.log, exp.overrides, oh.overheads, null).rows.filter((r) => r.cls === 'review').length : 0
  const toMatch = (merged.matching?.suggestions.length ?? 0) + draftsAwaiting(xero.snapshot).length
  const badges = {
    matching: { count: toMatch, title: 'to match or approve', tone: 'warn' as const },
    exceptions: { count: high, title: 'high priority', tone: 'loss' as const },
    expenses: { count: toReview, title: 'to review', tone: 'warn' as const },
  }
  return (
    <Shell email={email} badges={badges}>
      <Dashboard ledger={toClientLedger(ledger)} today={todayIso()} fx={fx} overheads={oh.overheads} overheadsSaved={oh.saved} overheadsError={oh.error ?? null} overheadsWritable={overheadsWritable()} xero={xero} notice={notice} expenses={exp.log} expenseOverrides={exp.overrides} expensesError={exp.error ?? null} sources={sources} oneDrive={oneDrive} oneDriveNotice={oneDriveNotice} hosted={isHosted()} settings={settings} make={make} weekly={weekly} gmailNotice={gmailNotice} askState={askState} health={health} />
    </Shell>
  )
}
