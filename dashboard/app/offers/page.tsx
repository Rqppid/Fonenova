import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { TopBar } from '@/components/dashboard/topbar'
import { OffersTabs } from '@/components/offers/offers-tabs'
import { OffersView } from '@/components/offers/offers-view'
import { loadClients } from '@/lib/offers/store'
import { gmailConfig, gmailConnected } from '@/lib/gmail'
import { telegramConfigured } from '@/lib/offers/telegram'
import type { Offer, OffersStatus } from '@/lib/offers/types'
import { currentUser } from '@/lib/session'
import { getJson, getStore } from '@/lib/store'

export const dynamic = 'force-dynamic'

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const user = await currentUser()
  if (user === false) redirect('/login')
  const store = getStore()
  const [offers, status, gmail, params, clients] = await Promise.all([
    getJson<Offer[]>(store, 'offers'),
    getJson<OffersStatus>(store, 'offers:status'),
    gmailConfig() ? gmailConnected(store).catch(() => ({ connected: false, email: null, canRead: false })) : Promise.resolve(null),
    searchParams,
    loadClients(),
  ])
  return (
    <Shell email={user}>
      <TopBar title="Offers" subtitle="Mobile One's offers, read from your email. Check each one before it is priced for a client." status={null} />
      <OffersTabs active="offers" />
      <OffersView
        clients={clients}
        send={{ allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true', publicStore: !!(process.env.OFFERS_PUBLIC_REDIS_URL && process.env.OFFERS_PUBLIC_REDIS_TOKEN), gmail: !!gmail?.connected }}
        offers={offers ?? []}
        status={status}
        setup={{ gmail, telegram: telegramConfigured(), schedule: !!process.env.CRON_SECRET }}
        selected={params.id ?? null}
      />
    </Shell>
  )
}
