import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { TopBar } from '@/components/dashboard/topbar'
import { OffersView } from '@/components/offers/offers-view'
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
  const [offers, status, gmail, params] = await Promise.all([
    getJson<Offer[]>(store, 'offers'),
    getJson<OffersStatus>(store, 'offers:status'),
    gmailConfig() ? gmailConnected(store).catch(() => ({ connected: false, email: null, canRead: false })) : Promise.resolve(null),
    searchParams,
  ])
  return (
    <Shell email={user}>
      <TopBar title="Offers" subtitle="Mobile One's offers, read from your email. Check each one before it is priced for a client." status={null} />
      <OffersView
        offers={offers ?? []}
        status={status}
        setup={{ gmail, telegram: telegramConfigured(), schedule: !!process.env.CRON_SECRET }}
        selected={params.id ?? null}
      />
    </Shell>
  )
}
