import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { TopBar } from '@/components/dashboard/topbar'
import { ClientsView } from '@/components/offers/clients-view'
import { OffersTabs } from '@/components/offers/offers-tabs'
import { loadClients, loadOffers } from '@/lib/offers/store'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

export default async function ClientsPage() {
  const user = await currentUser()
  if (user === false) redirect('/login')
  const [clients, offers] = await Promise.all([loadClients(), loadOffers()])
  const usedBy: Record<string, number> = {}
  for (const o of offers) if (o.pricing) usedBy[o.pricing.clientId] = (usedBy[o.pricing.clientId] ?? 0) + 1
  return (
    <Shell email={user}>
      <TopBar title="Clients" subtitle="Who offers are priced for: margin rule, payment terms and contacts." status={null} />
      <OffersTabs active="clients" />
      <ClientsView clients={clients} usedBy={usedBy} />
    </Shell>
  )
}
