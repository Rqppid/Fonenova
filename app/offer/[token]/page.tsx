import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { OfferView, type OfferViewData } from '@/components/offer-view'
import { allow, clientIp, getAnswer, getOffer, hashToken, offerState, publicStoreConfigured, validToken } from '@/lib/offers-public'

// Private to one client: never cached, never indexed, and the token in the address is not shared onward.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
  title: { absolute: 'Your offer | FoneNova' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
  referrer: 'no-referrer',
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <main className="min-h-screen bg-background px-6 py-24 text-foreground">
      <div className="mx-auto max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <h1 className="font-mono text-xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </main>
  )
}

export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const invalid = <Notice title="This link is not valid" text="Check the link in your email, or contact us at info@fonenova.com." />
  if (!publicStoreConfigured()) return <Notice title="Not available right now" text="Please try again in a few minutes, or contact info@fonenova.com." />
  try {
    // Page views are limited per visitor, so the page can't be used to hammer the store or guess links.
    if (!(await allow(`view:ip:${clientIp(await headers())}`, 60, 60))) return <Notice title="Too many requests" text="Please wait a minute and try again." />
    if (!validToken(token)) return invalid
    const hash = hashToken(token)
    const [offer, answer] = await Promise.all([getOffer(hash), getAnswer(hash)])
    if (!offer) return invalid
    const state = offerState(offer, answer)
    const data: OfferViewData = {
      token,
      state,
      clientName: offer.clientName,
      lines: offer.lines,
      units: offer.units,
      totalCents: offer.totalCents,
      expiresAt: offer.expiresAt,
      test: offer.test,
      answer: answer ? { decision: answer.decision, at: answer.at, remarks: answer.remarks } : null,
    }
    return <OfferView data={data} />
  } catch {
    return <Notice title="Not available right now" text="Please try again in a few minutes, or contact info@fonenova.com." />
  }
}
