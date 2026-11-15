/**
 * The Gmail connection's state for Settings and the Offers page. (The Friday cash email that this
 * module once sent has been removed completely: nothing here can send an email.)
 */
import { gmailConfig, gmailConnected, type GmailState } from './gmail'

export interface WeeklyEmailState {
  configured: boolean
  connected: boolean
  /** The connection can read mail (Offers needs it). */
  canRead: boolean
  /** Whether the saved login works, and if not exactly why. */
  state: GmailState
  message: string | null
  from: string | null
  to: string | null
}

export async function loadWeeklyEmailState(): Promise<WeeklyEmailState> {
  const c = gmailConfig()
  if (!c) return { configured: false, connected: false, canRead: false, state: 'not_connected', message: null, from: null, to: null }
  const g = await gmailConnected()
  return { configured: true, connected: g.connected, canRead: g.canRead, state: g.state, message: g.message, from: g.email, to: c.to }
}
