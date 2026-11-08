import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { AutoRefresh } from '@/components/dashboard/auto-refresh'
import { TopBar } from '@/components/dashboard/topbar'
import { PaymentsView } from '@/components/payments/payments-view'
import { getState, partyTotals } from '@/lib/payments-source'
import { currentUser } from '@/lib/session'

// Bank data: fetched on every request, never cached (proxy.ts also sends private, no-store).
export const dynamic = 'force-dynamic'

export default async function PaymentsPage() {
  // Second lock: proxy.ts already gates this route, but bank data never loads without a session here either.
  const user = await currentUser()
  if (user === false) redirect('/login')
  const result = await getState()
  const totals = result.kind === 'ok'
    ? { customers: partyTotals(result.data.customer_invoices), supplier: partyTotals(result.data.supplier_invoices) }
    : null
  return (
    <Shell email={user}>
      <AutoRefresh />
      <TopBar title="Payments" subtitle="Customer payments and payments to Mobile One, matched to invoices from the Revolut EUR account." status={null} />
      <PaymentsView result={result} totals={totals} />
    </Shell>
  )
}
