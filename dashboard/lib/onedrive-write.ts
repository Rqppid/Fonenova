/**
 * Keeps the payments trackers on OneDrive current for the fonenova-payments service, through
 * the dashboard's own Microsoft connection (the token never leaves the dashboard).
 *
 * Only the exact paths in ONEDRIVE_WRITE_PATHS can be read or written; the ledger and the VAT
 * folder are refused even if listed. A write needs the sha256 the caller last saw: if the file
 * changed since, nothing is written ("changed"), and the upload itself carries If-Match with the
 * file's eTag so a change in between is refused by OneDrive too. A locked file is skipped. There
 * is no delete anywhere in this module. Each write is logged with path, hashes and time, never
 * the contents.
 */
import 'server-only'
import crypto from 'node:crypto'
import { getJson, getStore, type Store } from './store'
import { accessToken, encodePath, graphBase, normalisePath, oneDriveConfig, scopeCanWrite } from './onedrive'

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
/** Downloads for hashing: trackers are small; anything far bigger is not a tracker. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const ZIP = [0x50, 0x4b, 0x03, 0x04]

export type WriteResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'changed' }
  | { kind: 'locked' }
  | { kind: 'bad'; message: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export interface FileInfo {
  path: string
  exists: boolean
  sha256: string | null
  etag: string | null
  last_modified: string | null
  size: number | null
}

const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')
const lower = (s: string) => s.toLowerCase()

/** The exact paths that may be written: one per line, or separated by ";". */
export function allowedPaths(): string[] {
  return (process.env.ONEDRIVE_WRITE_PATHS ?? '')
    .split(/\r?\n|;/)
    .map((p) => p.trim().replace(/^\/+/, ''))
    .filter(Boolean)
}

/** The ledger and VAT locations: never written, whatever the allowlist says. */
function protectedPaths(): { files: string[]; folders: string[] } {
  const files = [process.env.FN_ONEDRIVE_LEDGER, process.env.FN_ONEDRIVE_EXPENSES].map((p) => normalisePath(p)).filter((p): p is string => !!p)
  const folders = [process.env.FN_ONEDRIVE_EXPENSES_DIR].map((p) => normalisePath(p)).filter((p): p is string => !!p)
  return { files, folders }
}

/** Null when the path may be used, else why not. */
export function checkPath(p: string | null): string | null {
  if (!p || p.length > 400) return 'path is required'
  if (/[\\\u0000-\u001f]/.test(p) || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return 'path is not allowed'
  if (!/\.xlsx$/i.test(p)) return 'path is not allowed'
  const { files, folders } = protectedPaths()
  if (files.some((f) => lower(f) === lower(p)) || folders.some((d) => lower(p).startsWith(`${lower(d)}/`))) return 'path is not allowed'
  if (!allowedPaths().includes(p)) return 'path is not allowed'
  return null
}

/** Null when the folder holds at least one allowed file, else why not. */
export function checkFolder(folder: string | null): string | null {
  if (!folder) return 'folder is required'
  const f = folder.replace(/^\/+|\/+$/g, '')
  return allowedPaths().some((p) => p.slice(0, p.lastIndexOf('/')) === f) ? null : 'folder is not allowed'
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

type Ready = { kind: 'ready'; call: (path: string, init?: RequestInit) => Promise<Response> } | { kind: 'unavailable'; message: string }

async function connect(store: Store, needWrite: boolean): Promise<Ready> {
  const c = oneDriveConfig()
  if (!c) return { kind: 'unavailable', message: 'OneDrive is not set up on the dashboard' }
  const t = await getJson<{ scope?: string }>(store, 'onedrive:tokens')
  if (!t) return { kind: 'unavailable', message: 'OneDrive is not connected on the dashboard' }
  if (needWrite && !scopeCanWrite(t.scope)) return { kind: 'unavailable', message: 'write access not granted: reconnect OneDrive on the dashboard' }
  let token: Promise<string> | null = null
  return {
    kind: 'ready',
    call: async (path, init = {}) => {
      token ??= accessToken(c, store)
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${await token}`)
      return fetch(`${graphBase()}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(30_000) })
    },
  }
}

const itemUrl = (p: string) => `/me/drive/root:/${encodePath(p)}`

function graphFailure(status: number, what: string): WriteResult<never> {
  if (status === 423) return { kind: 'locked' }
  if (status === 409 || status === 412) return { kind: 'changed' }
  if (status === 401 || status === 403) return { kind: 'unavailable', message: 'OneDrive refused the dashboard: reconnect OneDrive on the dashboard' }
  if (status === 507) return { kind: 'error', message: 'OneDrive is full' }
  return { kind: 'error', message: `OneDrive answered ${status} ${what}` }
}

interface Item { id: string; eTag?: string; size?: number; lastModifiedDateTime?: string; file?: unknown }

async function infoWith(g: Extract<Ready, { kind: 'ready' }>, p: string): Promise<WriteResult<FileInfo & { id: string | null }>> {
  const res = await g.call(`${itemUrl(p)}?$select=id,eTag,size,lastModifiedDateTime,file`)
  if (res.status === 404) return { kind: 'ok', data: { path: p, exists: false, sha256: null, etag: null, last_modified: null, size: null, id: null } }
  if (!res.ok) return graphFailure(res.status, 'looking up the file')
  const item = (await res.json()) as Item
  if (!item.file) return { kind: 'bad', message: 'path is a folder, not a file' }
  if ((item.size ?? 0) > MAX_DOWNLOAD_BYTES) return { kind: 'error', message: 'the file on OneDrive is too large to be a tracker' }
  // Personal OneDrive no longer reports sha256, so the file is read and hashed here.
  const body = await g.call(`/me/drive/items/${encodeURIComponent(item.id)}/content`)
  if (!body.ok) return graphFailure(body.status, 'downloading the file')
  const bytes = new Uint8Array(await body.arrayBuffer())
  return { kind: 'ok', data: { path: p, exists: true, sha256: sha256(bytes), etag: item.eTag ?? null, last_modified: item.lastModifiedDateTime ?? null, size: item.size ?? bytes.length, id: item.id } }
}

export async function fileInfo(p: string, store: Store = getStore()): Promise<WriteResult<FileInfo>> {
  const g = await connect(store, false)
  if (g.kind !== 'ready') return g
  const r = await infoWith(g, p)
  if (r.kind !== 'ok') return r
  const { id: _id, ...info } = r.data
  return { kind: 'ok', data: info }
}

/** Plain checks on an upload, before anything is sent anywhere. */
export function checkUpload(expected: string | null, bytes: Uint8Array): string | null {
  if (!expected || !(expected === 'none' || /^[0-9a-f]{64}$/i.test(expected))) return 'expected_sha256 must be 64 hex characters or "none"'
  if (bytes.length === 0) return 'the file is empty'
  if (bytes.length > MAX_UPLOAD_BYTES) return 'the file is too large (4 MB at most)'
  if (!ZIP.every((b, i) => bytes[i] === b)) return 'the file is not an xlsx (no zip signature)'
  return null
}

function log(entry: Record<string, unknown>) {
  // Path, hashes, outcome and time only. Never the file contents.
  console.log(JSON.stringify({ event: 'onedrive-write', at: new Date().toISOString(), ...entry }))
}

export async function writeFile(p: string, expected: string, bytes: Uint8Array, store: Store = getStore()): Promise<WriteResult<{ sha256: string; etag: string | null; last_modified: string | null }>> {
  const bad = checkUpload(expected, bytes)
  if (bad) return { kind: 'bad', message: bad }
  const g = await connect(store, true)
  if (g.kind !== 'ready') return g
  const written = sha256(bytes)
  const want = expected.toLowerCase()

  // One write per file at a time, so two cycles of the service can't race each other.
  return store.withLock(`onedrive:write:${p}`, async () => {
    const before = await infoWith(g, p)
    if (before.kind !== 'ok') {
      log({ path: p, expected: want, written_sha256: written, result: before.kind })
      return before
    }
    const remote = before.data
    let res: Response
    if (want === 'none') {
      if (remote.exists) {
        log({ path: p, expected: want, remote_sha256: remote.sha256, written_sha256: written, result: 'changed' })
        return { kind: 'changed' } as const
      }
      res = await g.call(`${itemUrl(p)}:/content?@microsoft.graph.conflictBehavior=fail`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes })
    } else {
      if (!remote.exists || remote.sha256 !== want || !remote.id) {
        log({ path: p, expected: want, remote_sha256: remote.sha256, written_sha256: written, result: 'changed' })
        return { kind: 'changed' } as const
      }
      // If-Match: OneDrive itself refuses the upload if the file changed after the check above.
      res = await g.call(`/me/drive/items/${encodeURIComponent(remote.id)}/content`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(remote.etag ? { 'if-match': remote.etag } : {}) }, body: bytes })
    }
    if (!res.ok) {
      const f = graphFailure(res.status, 'saving the file')
      log({ path: p, expected: want, remote_sha256: remote.sha256, written_sha256: written, result: f.kind, status: res.status })
      return f
    }
    const item = (await res.json().catch(() => ({}))) as Item
    log({ path: p, expected: want, remote_sha256: remote.sha256, written_sha256: written, result: 'ok' })
    return { kind: 'ok', data: { sha256: written, etag: item.eTag ?? null, last_modified: item.lastModifiedDateTime ?? null } } as const
  })
}

/**
 * OneDrive's conflict copies of the allowed files in a folder ("<file>-<PCNAME>.xlsx"), made
 * when the PC saved a version while the service had written another.
 */
export async function conflictCopies(folder: string, store: Store = getStore()): Promise<WriteResult<{ folder: string; conflicts: { name: string; last_modified: string | null }[] }>> {
  const f = folder.replace(/^\/+|\/+$/g, '')
  const stems = allowedPaths().filter((p) => p.slice(0, p.lastIndexOf('/')) === f).map((p) => lower(p.slice(p.lastIndexOf('/') + 1).replace(/\.xlsx$/i, '')))
  const g = await connect(store, false)
  if (g.kind !== 'ready') return g
  const found: { name: string; last_modified: string | null }[] = []
  let next: string | null = `${itemUrl(f)}:/children?$select=name,lastModifiedDateTime,file&$top=200`
  for (let i = 0; next && i < 10; i++) {
    const res: Response = await g.call(next)
    if (res.status === 404) return { kind: 'bad', message: 'folder not found on OneDrive' }
    if (!res.ok) return graphFailure(res.status, 'listing the folder')
    const body = (await res.json()) as { value: { name: string; lastModifiedDateTime?: string; file?: unknown }[]; '@odata.nextLink'?: string }
    for (const it of body.value) {
      const n = lower(it.name)
      if (it.file && n.endsWith('.xlsx') && stems.some((s) => n.startsWith(`${s}-`) && n.length > s.length + 6)) found.push({ name: it.name, last_modified: it.lastModifiedDateTime ?? null })
    }
    next = body['@odata.nextLink'] ? body['@odata.nextLink'].replace(graphBase(), '') : null
  }
  return { kind: 'ok', data: { folder: f, conflicts: found } }
}
