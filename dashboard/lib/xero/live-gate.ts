/**
 * Live Xero is its own switch. Drafts in a live organisation need BOTH a live organisation
 * connected and XERO_WRITE_ALLOW_LIVE=true. Sending offers to real clients is a different switch
 * (OFFERS_ALLOW_REAL_SEND). Neither implies the other; a real client needs both.
 */
import 'server-only'
import type { Store } from '../store'
import { xeroWriteStatus } from './write'

export const liveXeroAllowed = () => process.env.XERO_WRITE_ALLOW_LIVE === 'true'

export async function liveXeroReady(store: Store): Promise<boolean> {
  if (!liveXeroAllowed()) return false
  const s = await xeroWriteStatus(store)
  return s.connected && s.isDemo === false
}
