/**
 * Server-to-server access to the OneDrive tracker routes: a bearer token (ONEDRIVE_WRITE_TOKEN),
 * separate from every other secret, compared in constant time. These routes are outside the
 * dashboard sign-in (proxy.ts), so this check is the only lock: without the variable they are off.
 */
import 'server-only'
import crypto from 'node:crypto'
import type { WriteResult } from './onedrive-write'

export function oneDriveJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export function oneDriveGuard(req: Request): Response | null {
  const secret = process.env.ONEDRIVE_WRITE_TOKEN?.trim()
  if (!secret || secret.length < 32) return oneDriveJson({ error: 'not configured' }, 503)
  const got = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
  const a = crypto.createHash('sha256').update(got).digest()
  const b = crypto.createHash('sha256').update(secret).digest()
  return got && crypto.timingSafeEqual(a, b) ? null : oneDriveJson({ error: 'unauthorized' }, 401)
}

/** Every outcome but ok, as the contract's status and body. */
export function failure(r: Exclude<WriteResult<unknown>, { kind: 'ok' }>): Response {
  switch (r.kind) {
    case 'changed': return oneDriveJson({ error: 'changed' }, 409)
    case 'locked': return oneDriveJson({ error: 'locked' }, 423)
    case 'bad': return oneDriveJson({ error: r.message }, 400)
    case 'unavailable': return oneDriveJson({ error: r.message }, 503)
    case 'error': return oneDriveJson({ error: r.message }, 502)
  }
}
