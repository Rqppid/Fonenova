/** The real connections behind lib/offers/dhl.ts: Xero (the client's address) and DHL (the rate). */
import 'server-only'
import { xeroWriteApi, xeroWriteConfig } from '../xero/write'
import type { Store } from '../store'
import type { DhlDeps } from './dhl'
import { myDhlConfig, myDhlRater } from './dhl-mydhl'

export function dhlDeps(store: Store): DhlDeps {
  const cfg = myDhlConfig()
  return { store, xero: () => (xeroWriteConfig() ? xeroWriteApi(store) : null), rater: cfg ? myDhlRater(cfg) : null }
}
