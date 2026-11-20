import { failure, oneDriveGuard, oneDriveJson } from '@/lib/onedrive-guard'
import { checkPath, fileContent, fileInfo, MAX_UPLOAD_BYTES, writeFile } from '@/lib/onedrive-write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * For the payments service only (bearer ONEDRIVE_WRITE_TOKEN). Only the exact paths in
 * ONEDRIVE_WRITE_PATHS. There is no DELETE.
 *
 * GET ?path=  → {path, exists, sha256, etag, last_modified, size}
 * GET ?path=&content=1 → the xlsx bytes (200, application/octet-stream, headers x-sha256, etag, last-modified;
 *   same allowlist and 4 MB cap; 404 {exists:false} when there is no such file). Read-only.
 * PUT ?path=&expected_sha256=<hex|none>, body = raw xlsx bytes (≤ 4 MB)
 *   → 200 {sha256, etag, last_modified}; 409 changed; 423 locked; 400; 401; 503 not connected.
 */
export async function GET(req: Request) {
  const stop = oneDriveGuard(req)
  if (stop) return stop
  const q = new URL(req.url).searchParams
  const path = q.get('path')
  const bad = checkPath(path)
  if (bad) return oneDriveJson({ error: bad }, 400)
  if (q.get('content') === '1') {
    const c = await fileContent(path!)
    if (c.kind !== 'ok') return failure(c)
    if (!c.data.exists || !c.data.bytes) return oneDriveJson({ path, exists: false }, 404)
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': String(c.data.bytes.length), 'x-sha256': c.data.sha256 ?? '' })
    if (c.data.etag) headers.set('etag', c.data.etag)
    if (c.data.last_modified) headers.set('last-modified', new Date(c.data.last_modified).toUTCString())
    return new Response(c.data.bytes as unknown as BodyInit, { status: 200, headers })
  }
  const r = await fileInfo(path!)
  return r.kind === 'ok' ? oneDriveJson(r.data) : failure(r)
}

export async function PUT(req: Request) {
  const stop = oneDriveGuard(req)
  if (stop) return stop
  const q = new URL(req.url).searchParams
  const path = q.get('path')
  const bad = checkPath(path)
  if (bad) return oneDriveJson({ error: bad }, 400)
  // Refuse an oversized body before reading it.
  const declared = Number(req.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return oneDriveJson({ error: 'the file is too large (4 MB at most)' }, 400)
  const bytes = new Uint8Array(await req.arrayBuffer())
  const r = await writeFile(path!, q.get('expected_sha256') ?? '', bytes)
  return r.kind === 'ok' ? oneDriveJson(r.data) : failure(r)
}
