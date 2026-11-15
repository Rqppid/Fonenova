/**
 * Where an invoice PDF is filed on OneDrive, laid out exactly as Make filed them, so the old and
 * the new PDFs sit side by side. Pure (no imports of server code), so the invoice flow and the
 * OneDrive module share it. Paths are OneDrive-relative (they start at "Desktop/...").
 *
 * - wave, telecom:  <dir>/Invoice-<no>/Invoice-<no>.pdf
 * - tradewise:      <dir>/FN-WT-Invoice-<no>/Invoice-<no>.pdf
 * - giglobal:       <dir>/FN-G&I Global-Inv-<no>/Invoice-<no>.pdf
 * - other:          <dir>/<client name>/Invoice-<no>.pdf
 */
import type { Folder } from './clients'

export type FilingDirs = { wave: string; telecom: string; other: string } & Partial<Record<Folder, string>>

const KEYS: Folder[] = ['wave', 'telecom', 'tradewise', 'giglobal', 'other']
const REQUIRED: Folder[] = ['wave', 'telecom', 'other']
const clean = (p: string) => p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')

/** The folders from INVOICE_FILING_DIRS (JSON), or null when it is not set or not usable. wave, telecom and other are required. */
export function parseFilingDirs(env: string | undefined): FilingDirs | null {
  if (!env?.trim()) return null
  let raw: unknown
  try {
    raw = JSON.parse(env)
  } catch {
    return null
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const out: Partial<Record<Folder, string>> = {}
  for (const k of KEYS) {
    const v = o[k]
    if (v === undefined || v === null || v === '') {
      if (REQUIRED.includes(k)) return null
      continue
    }
    if (typeof v !== 'string') return null
    // Accept a path pasted from Windows ("C:\Users\x\OneDrive\Desktop\..."): keep what follows the OneDrive folder.
    let p = clean(v)
    const m = /(^|\/)OneDrive[^/]*\//i.exec(p)
    if (m) p = p.slice(m.index + m[0].length)
    if (!p || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null
    out[k] = p
  }
  return out as FilingDirs
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()

/** The full OneDrive path of the PDF, or null if the number, the folder or the client name cannot be used. */
export function pdfPathFor(dirs: FilingDirs, folder: Folder, number: string, clientName: string): string | null {
  if (!/^\d{7}$/.test(number)) return null
  const dir = dirs[folder]
  if (!dir) return null
  switch (folder) {
    case 'wave':
    case 'telecom': return `${dir}/Invoice-${number}/Invoice-${number}.pdf`
    case 'tradewise': return `${dir}/FN-WT-Invoice-${number}/Invoice-${number}.pdf`
    case 'giglobal': return `${dir}/FN-G&I Global-Inv-${number}/Invoice-${number}.pdf`
    case 'other': {
      const name = safeName(clientName)
      return name ? `${dir}/${name}/Invoice-${number}.pdf` : null
    }
  }
}

/** True for a path that ends in an invoice PDF name this module would make. */
export const isInvoicePdfPath = (path: string) => /\/Invoice-\d{7}\.pdf$/.test(path)
