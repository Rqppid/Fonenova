/**
 * Files an invoice PDF on OneDrive, through the dashboard's own Microsoft connection. It can only
 * CREATE a new file `Invoice-<7-digit number>.pdf` (laid out as Make filed them: see offers/filing-paths) inside a folder named in INVOICE_FILING_DIRS: never
 * overwrite (an existing file is left alone and reported as "already there"), never delete, and
 * never touch the ledger or the VAT folder. Without INVOICE_FILING_DIRS it is off.
 *
 * INVOICE_FILING_DIRS is JSON like {"wave":"Documents/Invoices/Wave Phone","telecom":"...","other":"..."},
 * OneDrive-relative paths for the three client folders (Offers, Clients, "Invoice PDF folder").
 */
import 'server-only'
import { getJson, getStore, type Store } from './store'
import { accessToken, encodePath, graphBase, normalisePath, oneDriveConfig, scopeCanWrite } from './onedrive'
import type { Folder } from './offers/clients'
import { isInvoicePdfPath, parseFilingDirs, pdfPathFor, type FilingDirs } from './offers/filing-paths'

const MAX_PDF_BYTES = 4 * 1024 * 1024 // Graph's simple upload limit

export { type FilingDirs, pdfPathFor } from './offers/filing-paths'

/** The folders from INVOICE_FILING_DIRS, or null when it is not set up or not usable. */
export function filingDirs(env: string | undefined = process.env.INVOICE_FILING_DIRS): FilingDirs | null {
  return parseFilingDirs(env)
}

/** The path, or null if it is not usable or would land in the ledger or VAT locations. */
export function invoiceFilePath(dirs: FilingDirs, folder: Folder, number: string, clientName = 'client'): string | null {
  const path = pdfPathFor(dirs, folder, number, clientName)
  if (!path) return null
  const protectedPaths = [process.env.FN_ONEDRIVE_LEDGER, process.env.FN_ONEDRIVE_EXPENSES].map((p) => normalisePath(p)).filter((p): p is string => !!p)
  const protectedDirs = [process.env.FN_ONEDRIVE_EXPENSES_DIR].map((p) => normalisePath(p)).filter((p): p is string => !!p)
  const low = path.toLowerCase()
  if (protectedPaths.some((p) => p.toLowerCase() === low) || protectedDirs.some((d) => low.startsWith(`${d.toLowerCase()}/`))) return null
  return path
}

export type FileResult = { kind: 'ok' } | { kind: 'exists' } | { kind: 'unavailable'; message: string } | { kind: 'error'; message: string }

export async function fileInvoicePdf(path: string, bytes: Uint8Array, store: Store = getStore()): Promise<FileResult> {
  if (!isInvoicePdfPath(path)) return { kind: 'error', message: 'Only invoice PDFs named Invoice-<number>.pdf can be filed' }
  if (bytes.length < 100 || bytes.length > MAX_PDF_BYTES || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') return { kind: 'error', message: 'That is not a usable PDF (or it is over 4 MB)' }
  const c = oneDriveConfig()
  if (!c) return { kind: 'unavailable', message: 'OneDrive is not set up on the dashboard' }
  const t = await getJson<{ scope?: string }>(store, 'onedrive:tokens')
  if (!t) return { kind: 'unavailable', message: 'OneDrive is not connected on the dashboard' }
  if (!scopeCanWrite(t.scope)) return { kind: 'unavailable', message: 'OneDrive has no write access: reconnect OneDrive on the dashboard' }
  try {
    const token = await accessToken(c, store)
    // conflictBehavior=fail: an existing file is never replaced.
    const res = await fetch(`${graphBase()}/me/drive/root:/${encodePath(path)}:/content?@microsoft.graph.conflictBehavior=fail`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/pdf' },
      body: bytes,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 409) return { kind: 'exists' }
    if (res.status === 401 || res.status === 403) return { kind: 'unavailable', message: 'OneDrive refused the dashboard: reconnect OneDrive on the dashboard' }
    if (!res.ok) return { kind: 'error', message: `OneDrive answered ${res.status} saving the PDF` }
    console.log(JSON.stringify({ event: 'onedrive-invoice-filed', at: new Date().toISOString(), path }))
    return { kind: 'ok' }
  } catch {
    return { kind: 'error', message: 'OneDrive could not be reached' }
  }
}
