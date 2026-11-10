import { failure, oneDriveGuard, oneDriveJson } from '@/lib/onedrive-guard'
import { checkPath, fileInfo, MAX_UPLOAD_BYTES, writeFile } from '@/lib/onedrive-write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * For the payments service only (bearer ONEDRIVE_WRITE_TOKEN). Only the exact paths in
 * ONEDRIVE_WRITE_PATHS. There is no DELETE.
 *
 * GET ?path=  → {path, exists, sha256, etag, last_modified, size}
 * PUT ?path=&expected_sha256=<hex|none>, body = raw xlsx bytes (≤ 4 MB)
 *   → 200 {sha256, etag, last_modified}; 409 changed; 423 locked; 400; 401; 503 not connected.
 */
export async function GET(req: Request) {
  const stop = oneDriveGuard(req)
  if (stop) return stop
  const path = new URL(req.url).searchParams.get('path')
  const bad = checkPath(path)
  if (bad) return oneDriveJson({ error: bad }, 400)
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
