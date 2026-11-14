/** Pure helpers shared by the offer page (browser) and the server code. No Node imports, so the browser bundle can use it. */

export const MAX_REMARKS = 500
export type OfferState = 'open' | 'answered' | 'expired' | 'withdrawn'

export const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "Sat 14 Nov 2026, 10:45 UK time", the same wording in the email and on the page. */
export function ukTime(iso: string): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${day}, ${time} UK time`
}
