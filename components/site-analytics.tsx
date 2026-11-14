"use client"

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next"

/**
 * Offer links carry a private token in the address. Analytics would record that address, so any
 * /offer/... URL is reduced to /offer/[redacted] (and its query dropped) before it is sent.
 */
export function redactOfferUrl<T extends BeforeSendEvent>(event: T): T {
  try {
    const u = new URL(event.url)
    if (u.pathname === "/offer" || u.pathname.startsWith("/offer/")) {
      u.pathname = "/offer/[redacted]"
      u.search = ""
      u.hash = ""
      return { ...event, url: u.toString() }
    }
  } catch {
    // an unparsable address is passed on unchanged
  }
  return event
}

export function SiteAnalytics() {
  return <Analytics beforeSend={redactOfferUrl} />
}
