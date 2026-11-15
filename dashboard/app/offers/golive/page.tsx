import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { TopBar } from '@/components/dashboard/topbar'
import { GoLiveView } from '@/components/offers/golive-view'
import { OffersTabs } from '@/components/offers/offers-tabs'
import { gmailConfig, gmailConnected } from '@/lib/gmail'
import { oneDriveConnected } from '@/lib/onedrive'
import { filingDirs } from '@/lib/onedrive-invoice'
import { loadDraftSettings } from '@/lib/offers/draft'
import { goLiveChecks, readyToGoLive } from '@/lib/offers/golive'
import { loadClients } from '@/lib/offers/store'
import { telegramConfigured } from '@/lib/offers/telegram'
import type { Offer } from '@/lib/offers/types'
import { currentUser } from '@/lib/session'
import { getJson, getStore } from '@/lib/store'
import { xeroWriteStatus } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

export default async function GoLivePage() {
  const user = await currentUser()
  if (user === false) redirect('/login')
  const store = getStore()
  const [xw, gmail, drive, settings, clients, offers, ticks] = await Promise.all([
    xeroWriteStatus(store),
    gmailConfig() ? gmailConnected(store) : Promise.resolve(null),
    oneDriveConnected(store).catch(() => ({ connected: false, accountName: null, canWrite: false })),
    loadDraftSettings(store),
    loadClients(),
    getJson<Offer[]>(store, 'offers'),
    getJson<Record<string, string>>(store, 'offers:golive'),
  ])
  const checks = goLiveChecks({
    xero: { configured: xw.configured, connected: xw.connected, isDemo: xw.isDemo, orgName: xw.orgName },
    flags: { allowLiveXero: process.env.XERO_WRITE_ALLOW_LIVE === 'true', allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true', allowApprove: process.env.OFFERS_ALLOW_APPROVE === 'true', filingConfigured: !!filingDirs() },
    gmail: { connected: !!gmail?.connected, canRead: !!gmail?.canRead },
    oneDrive: { connected: drive.connected, canWrite: drive.canWrite },
    telegram: telegramConfigured(),
    settings,
    clients,
    offers: offers ?? [],
    ticks: ticks ?? {},
  })
  return (
    <Shell email={user}>
      <TopBar title="Offers" subtitle="Go-live checklist: what has to be true before real clients get offers and invoices from here." status={null} />
      <OffersTabs active="golive" />
      <GoLiveView checks={checks} ready={readyToGoLive(checks)} />
    </Shell>
  )
}
