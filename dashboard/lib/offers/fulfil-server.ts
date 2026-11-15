/** The real connections behind lib/offers/fulfil.ts: Gmail, the Xero write app, the ledger. */
import 'server-only'
import { gmailConfig, hasReplied, sendGmail } from '../gmail'
import { fileInvoicePdf, filingDirs } from '../onedrive-invoice'
import { loadSnapshot } from '../xero/client'
import { saveXeroPairs } from '../data-source'
import type { InvoiceDeps } from './invoice-flow'
import { loadXeroPairs } from '../data-source'
import { getJson, type Store } from '../store'
import { xeroWriteApi, xeroWriteConfig } from '../xero/write'
import type { Ledger } from '../types'
import type { FulfilDeps } from './fulfil'
import { notify } from './telegram'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function fulfilDeps(store: Store, over: Partial<Pick<FulfilDeps, 'notify'>> = {}): FulfilDeps {
  const g = gmailConfig()
  return {
    store,
    notify: over.notify ?? notify,
    dashboardUrl: process.env.AUTH_URL?.replace(/\/$/, ''),
    allowReal: process.env.OFFERS_ALLOW_REAL_SEND === 'true',
    allowLiveXero: process.env.XERO_WRITE_ALLOW_LIVE === 'true',
    ownerAddress: g?.to ?? 'info@fonenova.com',
    knownOrderIds: async () => {
      const ledger = await getJson<Ledger>(store, 'ledger')
      const pairs = await loadXeroPairs()
      return [...(ledger?.orders ?? []).map((o) => o.id), ...pairs.map((p) => p.orderId)]
    },
    xero: () => (xeroWriteConfig() ? xeroWriteApi(store) : null),
    reply: async (m) => {
      if (!g) throw new Error('Gmail is not set up on the dashboard')
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${esc(m.text).replace(/\n/g, '<br>')}</div>`
      const sent = await sendGmail(g, { subject: m.subject, text: m.text, html, to: m.to, fromName: 'FoneNova', ...(m.threadId ? { threadId: m.threadId } : {}), ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}) }, store)
      return { id: sent.id }
    },
    replied: async (threadId, afterIso) => {
      if (!g) throw new Error('Gmail is not set up')
      return hasReplied(g, threadId, afterIso, store)
    },
  }
}

/** The deps for approving, sending, filing and bill matching: the same as fulfilDeps plus their own switches and connections. */
export function invoiceDeps(store: Store): InvoiceDeps {
  return {
    ...fulfilDeps(store),
    allowApprove: process.env.OFFERS_ALLOW_APPROVE === 'true',
    filing: { dirs: filingDirs(), upload: (path, bytes) => fileInvoicePdf(path, bytes, store) },
    bills: async () => ({ bills: ((await loadSnapshot())?.invoices ?? []).filter((i) => i.kind === 'bill'), pairs: await loadXeroPairs() }),
    savePair: async (p) => {
      const pairs = await loadXeroPairs()
      await saveXeroPairs([...pairs.filter((x) => x.orderId !== p.orderId), p])
    },
  }
}
