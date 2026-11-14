/** "Sat, 14 Nov 2026, 10:45 UK time": the same wording as the client's offer page. */
export function ukTime(iso: string): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${day}, ${time} UK time`
}
