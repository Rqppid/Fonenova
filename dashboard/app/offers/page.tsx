import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { TopBar } from '@/components/dashboard/topbar'
import { OffersTabs } from '@/components/offers/offers-tabs'
import { OffersView } from '@/components/offers/offers-view'
import { loadClients } from '@/lib/offers/store'
import { gmailConfig, gmailConnected } from '@/lib/gmail'
import { envValue, webhookProblem } from '@/lib/offers/env-check'
import { liveXeroReady } from '@/lib/xero/live-gate'
import { filingDirs } from '@/lib/onedrive-invoice'
import { loadSnapshot } from '@/lib/xero/client'
import { loadXeroPairs } from '@/lib/data-source'
import { suggestBills } from '@/lib/offers/invoice-flow'
import { xeroWriteStatus } from '@/lib/xero/write'
import { publicStoreProblem } from '@/lib/offers/public-store'
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
    gmailConfig() ? gmailConnected(store) : Promise.resolve(null),
    searchParams,
    loadClients(),
  ])
  const xw = await xeroWriteStatus(store)
  // Mobile One's unpaired bills that come to about what each real order cost, for the "Mobile One's bill" step.
  const [snap, pairs] = await Promise.all([loadSnapshot().catch(() => null), loadXeroPairs().catch(() => [])])
  const bills = (snap?.invoices ?? []).filter((i) => i.kind === 'bill')
  const billSuggestions = Object.fromEntries((offers ?? []).filter((o) => o.status === 'accepted' && o.fulfilment?.draft.state === 'done' && !o.fulfilment.bill && /^FN-ORD-\d{3,}$/.test(o.fulfilment.orderRef)).map((o) => [o.id, suggestBills(o, bills, pairs)]))
  return (
    <Shell email={user}>
      <TopBar title="Offers" subtitle="Mobile One's offers, read from your email. Check each one before it is priced for a client." status={null} />
      <OffersTabs active="offers" />
      <OffersView
        liveTarget={xw.connected && xw.isDemo === false ? xw.orgName : null}
        clients={clients}
        send={{
          allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true',
          liveXeroReady: await liveXeroReady(store),
          invoice: { allowApprove: process.env.OFFERS_ALLOW_APPROVE === 'true', allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true', allowLiveXero: process.env.XERO_WRITE_ALLOW_LIVE === 'true', filingConfigured: !!filingDirs(), orgIsLive: xw.isDemo === null ? null : !xw.isDemo },
          bills: billSuggestions,
          storeProblem: publicStoreProblem(),
          gmailProblem: !gmail ? 'Gmail is not set up on the dashboard (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).' : gmail.connected ? null : gmail.message,
          webhookWarning: !envValue(process.env.OFFERS_WEBHOOK_TOKEN) ? 'OFFERS_WEBHOOK_TOKEN is not set: you will hear of answers within 5 minutes instead of at once.' : webhookProblem(process.env.OFFERS_WEBHOOK_TOKEN),
        }}
        offers={offers ?? []}
        status={status}
        setup={{ gmail, telegram: telegramConfigured(), schedule: !!process.env.CRON_SECRET }}
        selected={params.id ?? null}
      />
    </Shell>
  )
}
