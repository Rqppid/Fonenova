import crypto from 'node:crypto'

/** True only for `Authorization: Bearer <secret>`, compared in constant time. An unset or short secret passes nobody. */
export function bearerOk(header: string | null, secret: string | undefined): boolean {
  const s = secret?.trim()
  if (!s || s.length < 32) return false
  const got = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
  if (!got) return false
  const a = crypto.createHash('sha256').update(got).digest()
  const b = crypto.createHash('sha256').update(s).digest()
  return crypto.timingSafeEqual(a, b)
}
