'use client'
import { useMemo, useState } from 'react'
import { ChevronDown, FlaskConical } from 'lucide-react'
import { Select } from '@/components/ui/select'
import {
  allocateCredits, cashPosition, concentration, creditTotals, customerRows, filterOrders, netBusinessProfit, profitAfterCredits,
  marginSchemeVat, overdueClients, reconcileLedger, supplierRows, timeSeries, totals, unitsByOrder,
} from '@/lib/metrics'
import { useSection, type Section } from '@/lib/sections'
import { PartiesTable } from './parties-table'
import { MatchingPanel } from './matching'
import { CreditNotesTable } from './credit-notes'
import { ChecksList } from './reconcile-badge'
import {
  comparisonFor, coverageFor, formatDate, formatRange, presetRange, PRESETS, type DateRange, type Granularity, type PresetId,
} from '@/lib/periods'
import type { ExpenseLog, ExpenseOverrides, FxResult, Ledger, Overhead } from '@/lib/types'
import { CurrencyProvider, useMoney } from '@/components/currency'
import { OverheadsPanel } from './overheads-panel'
import { ExpensesPanel } from './expenses-panel'
import { CashCalendarPanel } from './cash-calendar'
import { XeroBar } from './xero-bar'
import { AutoRefresh } from './auto-refresh'
import type { SourceStatus } from '@/lib/sync-core'
import type { AppSettings, OneDriveState, XeroState } from '@/lib/data-source'
import { draftsAwaiting } from '@/lib/xero/pairing'
import { liveView } from '@/lib/live-view'
import { money as formatMoney } from '@/lib/format'
import { fxProfits, fxTotals, type FxProfit } from '@/lib/fx-profit'
import { makeNeedsAttention, type MakeStatus } from '@/lib/make'
import type { WeeklyEmailState } from '@/lib/weekly'
import type { AskState } from '@/lib/ask/data'
import type { HealthCheck } from '@/lib/health'
import { DealChecker } from './deal-checker'
import { AskCard, WatchdogCard, DraftsList, MakeCard, MarginVatCard, WeeklyEmailCard } from './automations'
import { AskBar } from './ask-bar'
import { CurrencyNote, CurrencySwitch } from './currency-switch'
import { CashPositionPanel } from './cash-position'
import { ConcentrationPanel } from './concentration'
import { Kpis } from './kpis'
import { NeedsAttention, TodayList } from './needs-attention'
import { Headline } from './headline'
import { StatusPill, TopBar } from './topbar'
import { OrderDrawer } from './order-drawer'
import { OrdersTable } from './orders-table'
import { PeriodControl } from './period-control'
import { TrendChart } from './trend-chart'

interface Props {
  ledger: Ledger
  today: string
  fx: FxResult
  overheads: Overhead[]
  overheadsSaved: boolean
  overheadsError: string | null
  overheadsWritable: boolean
  xero: XeroState
  notice: string | null
  expenses: ExpenseLog | null
  expenseOverrides: ExpenseOverrides
  expensesError: string | null
  sources: SourceStatus[]
  oneDrive: OneDriveState
  oneDriveNotice: string | null
  hosted: boolean
  settings: AppSettings
  make: MakeStatus | null
  weekly: WeeklyEmailState
  askState: AskState
  health: HealthCheck[]
  gmailNotice: string | null
}

export function Dashboard(props: Props) {
  return (
    <CurrencyProvider fx={props.fx}>
      <DashboardBody {...props} />
    </CurrencyProvider>
  )
}

function minutesAgo(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  return m < 1 ? 'just refreshed' : m < 60 ? `refreshed ${m} min ago` : `refreshed ${Math.round(m / 60)} h ago`
}

const TITLES: Record<Section, string> = {
  overview: 'Profit overview',
  orders: 'Orders',
  matching: 'Invoice matching',
  'deal-check': 'Check a deal',
  customers: 'Customers',
  suppliers: 'Suppliers',
  'credit-notes': 'Credit notes',
  exceptions: 'Exceptions',
  expenses: 'Expenses',
  settings: 'Settings',
}

function DashboardBody({ ledger: rawLedger, today, overheads, overheadsSaved, overheadsError, overheadsWritable, xero, notice, expenses, expenseOverrides, expensesError, sources, oneDrive, oneDriveNotice, hosted, settings, make, weekly, gmailNotice, askState, health }: Props) {
  const { fx } = useMoney()
  const [section, go] = useSection()
  // Reconcile against the untouched ledger; everything else uses Xero's live statuses where found.
  const checks = useMemo(() => reconcileLedger(rawLedger), [rawLedger])
  // Ledger orders (with Xero's live status), plus orders from confirmed Xero invoice and bill pairs,
  // plus the live Xero checks. The same function feeds the Friday email and the AI bar.
  const merged = useMemo(() => liveView(rawLedger, xero.snapshot, xero.pairs, today), [rawLedger, xero.snapshot, xero.pairs, today])
  const ledger = merged.ledger
  const matching = merged.matching
  const xchecks = merged.checks
  // Profit in pounds per order, from Xero's own exchange rates.
  const fxByOrder = useMemo(() => (xero.snapshot ? fxProfits(ledger.orders, xero.snapshot.invoices) : null), [ledger.orders, xero.snapshot])
  // With Xero connected the data is as of its last refresh, not the spreadsheet's snapshot.
  const asOf = xero.snapshot ? xero.snapshot.fetchedAt.slice(0, 10) : ledger.meta.snapshotDate
  const coverage = useMemo(() => coverageFor(ledger.orders.map((o) => o.date), asOf), [ledger, asOf])
  const units = useMemo(() => unitsByOrder(ledger.lines), [ledger])
  const allocation = useMemo(() => allocateCredits(ledger.creditNotes), [ledger])

  const [preset, setPreset] = useState<PresetId>('all')
  const [custom, setCustom] = useState<DateRange>({ start: coverage.start, end: coverage.end })
  const [customerId, setCustomerId] = useState<string>('')
  const [granularity, setGranularity] = useState<Granularity>('month')
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)

  const range: DateRange = useMemo(
    () => (preset === 'custom' ? custom : presetRange(preset, today, coverage)),
    [preset, custom, today, coverage],
  )
  const comparison = useMemo(() => comparisonFor(preset, range, coverage), [preset, range, coverage])
  const customer = customerId || null

  const view = useMemo(() => {
    const current = filterOrders(ledger.orders, { range, customerId: customer })
    const t = totals(current, units)
    const credits = creditTotals(ledger.creditNotes, ledger.orders, { range, customerId: customer })
    let previous = null
    if (comparison.valid) {
      const prevOrders = filterOrders(ledger.orders, { range: comparison.previous, customerId: customer })
      const pt = totals(prevOrders, units)
      const pc = creditTotals(ledger.creditNotes, ledger.orders, { range: comparison.previous, customerId: customer })
      previous = { totals: pt, credits: pc, afterCreditsCents: profitAfterCredits(pt.grossProfitCents, pc) }
    }
    return {
      orders: current,
      totals: t,
      credits,
      afterCreditsCents: profitAfterCredits(t.grossProfitCents, credits),
      previous,
      series: timeSeries(current, range, granularity),
      // Concentration ignores the customer filter: shares only mean something against all customers.
      shares: concentration(filterOrders(ledger.orders, { range })),
      cash: cashPosition(current),
      // Customers ignores the customer filter (it lists them all); suppliers respect it.
      customerRows: customerRows(filterOrders(ledger.orders, { range }), units, ledger.creditNotes, range),
      supplierRows: supplierRows(current, units, ledger.creditNotes, range),
    }
  }, [ledger, units, range, comparison, customer, granularity])

  // Overheads are company-wide, so net profit is only meaningful without a customer filter.
  // Margin-scheme VAT on the period's orders: always worked out for the Settings card, deducted only when switched on.
  const marginVat = useMemo(() => marginSchemeVat(view.orders), [view.orders])
  const net = useMemo(
    () => netBusinessProfit({ grossAfterCreditsEurCents: view.afterCreditsCents, overheads, range, today, fx: fx.ok ? fx.fx : null, expenses, overrides: expenseOverrides, marginVatEurCents: settings.marginSchemeVat ? marginVat : 0 }),
    [view.afterCreditsCents, overheads, range, today, fx, expenses, expenseOverrides, settings.marginSchemeVat, marginVat],
  )
  const drafts = useMemo(() => draftsAwaiting(xero.snapshot), [xero.snapshot])
  const makeAlert = makeNeedsAttention(make)
  // Watchdog reds, except sync lines the pill already counts as sources needing attention.
  const reds = health.filter((c) => c.level === 'red' && !c.id.startsWith('sync-'))

  // Overdue is the state now, not a period figure: every order, only the customer filter applies.
  const overdue = useMemo(() => overdueClients(filterOrders(ledger.orders, { customerId: customer }), today), [ledger.orders, customer, today])

  const openOrder = openOrderId ? ledger.orders.find((o) => o.id === openOrderId) ?? null : null
  const presetLabel = PRESETS.find((p) => p.id === preset)?.label ?? ''
  const customerName = ledger.customers.find((c) => c.id === customerId)?.name
  const snapshot = xero.snapshot
    ? `${formatDate(xero.snapshot.fetchedAt.slice(0, 10))} ${new Date(xero.snapshot.fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (live, Xero)`
    : formatDate(ledger.meta.snapshotDate)

  const xeroNote = xero.snapshot
    ? `Xero ${minutesAgo(xero.snapshot.fetchedAt)}${matching?.suggestions.length ? ` · ${matching.suggestions.length} to match` : ''}${drafts.length ? ` · ${drafts.length} draft${drafts.length > 1 ? 's' : ''} to approve` : ''}`
    : null
  const xeroBar = (
    <XeroBar sources={sources} xero={xero} summary={merged.summary} ledgerImported={formatDate(ledger.meta.importedAt.slice(0, 10))} ledgerSnapshot={formatDate(ledger.meta.snapshotDate)} notice={notice} oneDrive={oneDrive} oneDriveNotice={oneDriveNotice} hosted={hosted} />
  )
  const subtitle = section === 'settings'
    ? 'Data sources, monthly overheads, and the checks every import must pass.'
    : section === 'deal-check'
      ? 'Before you commit: the margin after shipping, margin-scheme VAT and an FX cushion.'
    : section === 'expenses'
      ? <>{preset === 'all' ? 'All time: every expense row' : `${presetLabel}: ${formatRange(range)}`} · amounts in GBP, as logged</>
      : <>{presetLabel}: {formatRange(range)} · {customerName ?? 'All customers'}<CurrencyNote /></>

  return (
    <>
      <AutoRefresh />
      {ledger.meta.isSample && (
        <div role="status" className="mt-4 flex items-center gap-2 rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
          <span><strong className="font-semibold">Sample data.</strong> Every figure on this screen is fake. Import the real ledger with <code>npm run import</code>.</span>
        </div>
      )}

      <TopBar
        title={TITLES[section]}
        subtitle={subtitle}
        search={<AskBar orders={ledger.orders} customers={ledger.customers} aiReady={askState.configured} onOpenOrder={setOpenOrderId} onPickCustomer={(id) => { setCustomerId(id); go('orders') }} go={go} />}
        status={section === 'settings' ? null : <StatusPill sources={sources} checks={checks} note={xeroNote} alert={reds.length ? `${reds.length} problem${reds.length > 1 ? 's' : ''} found: see Settings` : makeAlert ? 'A Make sync needs attention' : null}>{xeroBar}</StatusPill>}
        controls={section === 'settings' || section === 'deal-check' ? undefined : (
          <>
            <CurrencySwitch />
            <label className="sr-only" htmlFor="customer-filter">Customer</label>
            <Select id="customer-filter" value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="min-w-0 sm:w-52">
              <option value="">All customers</option>
              {ledger.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <PeriodControl
              preset={preset}
              range={range}
              coverage={coverage}
              onPreset={setPreset}
              onCustom={(r) => { setCustom(r); setPreset('custom') }}
            />
          </>
        )}
      />

      {section === 'overview' && (
        <div className="space-y-4">
          <Headline
            totals={view.totals}
            afterCreditsCents={view.afterCreditsCents}
            net={customer ? { status: 'filtered' } : net}
            cash={view.cash}
            overdue={overdue}
            snapshot={formatDate(asOf)}
            onSettings={() => go('settings')}
            onExceptions={() => go('exceptions')}
          />

          <TodayList
            ledger={ledger}
            customerId={customer}
            allocation={allocation}
            checks={xchecks}
            onOpenOrder={setOpenOrderId}
            onSeeAll={() => go('exceptions')}
            extra={[
              ...(makeAlert ? [{ id: 'make', label: 'A Make.com sync needs attention', sub: 'A scenario is off, its last run failed, or credits are nearly used. See Settings.', onClick: () => go('settings') }] : []),
              ...(drafts.length ? [{ id: 'drafts', label: `Approve ${drafts.length} synced draft${drafts.length > 1 ? 's' : ''} in Xero`, sub: drafts.slice(0, 3).map((d) => `${d.kind === 'sale' ? 'invoice' : 'bill'} ${d.number}`).join(', '), amountCents: drafts.filter((d) => d.currency === 'EUR').reduce((n, d) => n + d.totalCents, 0), onClick: () => go('matching') }] : []),
              ...(matching?.suggestions.length ? [{ id: 'match', label: `Match ${matching.suggestions.length} new invoice${matching.suggestions.length > 1 ? 's' : ''} to their bills`, sub: matching.suggestions.slice(0, 3).map((x) => `invoice ${x.invoice.number}`).join(', '), amountCents: matching.suggestions.reduce((n, x) => n + x.invoice.totalCents, 0), onClick: () => go('matching') }] : []),
            ]}
          />

          <TrendChart
            series={view.series}
            granularity={granularity}
            onGranularity={setGranularity}
            empty={view.orders.length === 0}
            range={range}
            coverageEnd={coverage.end}
            onShowAllTime={() => setPreset('all')}
          />

          <div className="grid gap-4 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-5">
              <ConcentrationPanel shares={view.shares} highlightId={customer} customerOrder={ledger.customers.map((c) => c.id)} />
            </div>
            <div className="min-w-0 xl:col-span-7">
              <CashPositionPanel cash={view.cash} snapshot={snapshot} supplierName={ledger.suppliers[0]?.name ?? 'supplier'} filtered={preset !== 'all' || !!customer} onOpenOrder={setOpenOrderId} />
            </div>
          </div>

          <CashCalendarPanel orders={ledger.orders} overheads={overheads} today={today} snapshot={xero.snapshot} onOpenOrder={setOpenOrderId} />

          <details className="group rounded-lg border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-3.5 text-[15px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
              <span>More figures <span className="ml-1 font-normal text-ink-2">sales, cost, units, margin split, credit notes, period comparison</span></span>
              <ChevronDown className="h-4 w-4 text-ink-3 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="border-t border-line p-4">
              <Kpis
                totals={view.totals}
                credits={view.credits}
                afterCreditsCents={view.afterCreditsCents}
                previous={view.previous}
                comparison={comparison}
                previousLabel={comparison.valid ? formatRange(comparison.previous) : null}
                net={customer ? { status: 'filtered' } : net}
              />
              {fxByOrder && <FxPeriod list={view.orders.map((o) => fxByOrder.get(o.id)).filter((f): f is FxProfit => !!f)} />}
            </div>
          </details>
        </div>
      )}

      {section === 'orders' && (
        <OrdersTable
          orders={view.orders}
          totalInLedger={ledger.orders.length}
          units={units}
          exceptions={ledger.exceptions}
          customers={ledger.customers}
          customerId={customerId}
          onCustomer={setCustomerId}
          onOpenOrder={setOpenOrderId}
          periodEmpty={view.orders.length === 0}
        />
      )}

      {section === 'matching' && drafts.length > 0 && <div className="mb-4"><DraftsList drafts={drafts} /></div>}
      {section === 'matching' && (
        <MatchingPanel matching={matching} connected={xero.connected} pairs={xero.pairs} orders={ledger.orders} writable={overheadsWritable} onSettings={() => go('settings')} onOpenOrder={setOpenOrderId} />
      )}

      {section === 'deal-check' && (
        <DealChecker customers={customerRows(ledger.orders, units, ledger.creditNotes, null)} orders={ledger.orders} today={today} marginVat={settings.marginSchemeVat} />
      )}

      {section === 'customers' && (
        <PartiesTable kind="customer" rows={view.customerRows} periodLabel={`${presetLabel}, ${formatRange(range)}`} onPick={(id) => { setCustomerId(id); go('orders') }} />
      )}

      {section === 'suppliers' && (
        <PartiesTable kind="supplier" rows={view.supplierRows} periodLabel={`${presetLabel}, ${formatRange(range)}${customerName ? `, ${customerName} orders only` : ''}`} />
      )}

      {section === 'credit-notes' && (
        <CreditNotesTable notes={view.credits.notes} periodLabel={`${presetLabel}, ${formatRange(range)}${customerName ? `, ${customerName} only` : ''}`} onOpenOrder={setOpenOrderId} />
      )}

      {section === 'exceptions' && (
        <NeedsAttention ledger={ledger} customerId={customer} allocation={allocation} checks={xchecks} snapshot={formatDate(asOf)} onOpenOrder={setOpenOrderId} expanded />
      )}

      {section === 'expenses' && (
        // "All time" means every expense row: the ledger's last order date must not hide later receipts.
        <ExpensesPanel log={expenses} overrides={expenseOverrides} overheads={overheads} range={preset === 'all' ? null : range} error={expensesError} writable={overheadsWritable} />
      )}

      {section === 'settings' && (
        <div className="space-y-4">
          <section aria-labelledby="sources-title">
            <h2 id="sources-title" className="mb-2 text-[15px] font-semibold text-ink">Data sources</h2>
            {xeroBar}
          </section>
          <WatchdogCard checks={health} ignored={settings.ignoredInvoiceNumbers} writable={overheadsWritable} />
          <MakeCard make={make} />
          <WeeklyEmailCard state={weekly} notice={gmailNotice} />
          <AskCard state={askState} />
          <OverheadsPanel overheads={overheads} saved={overheadsSaved} loadError={overheadsError} writable={overheadsWritable} today={today} />
          <MarginVatCard enabled={settings.marginSchemeVat} writable={overheadsWritable} vatEurCents={marginVat} />
          <ChecksList checks={checks} />
          <section aria-labelledby="about-title" className="rounded-lg border border-line bg-surface px-5 py-4 text-[13px] leading-relaxed text-ink-2">
            <h2 id="about-title" className="mb-1 text-[15px] font-semibold text-ink">About these figures</h2>
            <p>All trade in the ledger is in EUR. Fone Nova&apos;s books are kept in GBP, so exchange-rate movement between invoice and payment is a real risk. With Xero connected, each order&apos;s drawer and More figures show the profit in pounds at Xero&apos;s own rates, booked and realised; bank and conversion fees are not included.</p>
            <p className="mt-1">Net business profit covers the overheads you enter and the expense rows marked Business. Fone Nova&apos;s own shipping beyond the invoices, and bank, FX and payment fees, are not in the order data.</p>
          </section>
        </div>
      )}

      <OrderDrawer
        order={openOrder}
        ledger={ledger}
        units={units}
        allocation={allocation}
        snapshot={snapshot}
        ledgerSnapshot={formatDate(ledger.meta.snapshotDate)}
        fx={fxByOrder}
        onClose={() => setOpenOrderId(null)}
      />
    </>
  )
}

/** Currency effect over the period's settled orders: booked in pounds at invoice time vs realised. */
function FxPeriod({ list }: { list: FxProfit[] }) {
  const t = fxTotals(list)
  if (!t.settled) return null
  const gbp = (p: number) => formatMoney(p, 'GBP')
  return (
    <div className="mt-4 rounded-md border border-line px-4 py-3 text-[13px]">
      <div className="font-semibold text-ink">Currency effect, in pounds</div>
      <p className="mt-0.5 text-ink-2">
        {t.settled} settled order{t.settled > 1 ? 's' : ''}: booked {gbp(t.bookedGbpCents)} at Xero&apos;s invoice-day rates, realised {gbp(t.realisedGbpCents)} at the payment-day rates.{' '}
        <span className={t.effectGbpCents < 0 ? 'font-semibold text-loss' : 'font-semibold text-gain'}>{t.effectGbpCents < 0 ? 'Lost' : 'Gained'} {gbp(Math.abs(t.effectGbpCents))}</span> to exchange-rate moves.
        {t.pending ? ` ${t.pending} more not counted until fully paid in cash.` : ''}
      </p>
    </div>
  )
}
