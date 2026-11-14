import 'server-only'
import { gmailConfig, sendGmail } from '../gmail'
import type { Store } from '../store'
import type { NotifyEmail } from './notify-email'

/** Sends an email to the owner (the dashboard's own address) from the connected Gmail, or undefined if Gmail is not set up. */
export function ownerEmail(store: Store): ((m: NotifyEmail) => Promise<unknown>) | undefined {
  const c = gmailConfig()
  return c ? (m) => sendGmail(c, { ...m, fromName: 'FoneNova' }, store) : undefined
}
