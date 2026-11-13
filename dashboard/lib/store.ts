/**
 * Where the dashboard keeps everything it saves: imported data, overheads, row overrides,
 * and the Xero and OneDrive tokens.
 *
 * Two backends behind one interface:
 *   - FileStore: plain JSON files in data/ (git-ignored). Used on your PC.
 *   - RedisStore: Upstash Redis over its REST API. Used when hosted, picked automatically when
 *     KV_REST_API_URL and KV_REST_API_TOKEN are set (Vercel's Upstash integration sets both).
 *     Every value is brotli-compressed and AES-256-GCM encrypted with FN_STORE_KEY before it
 *     leaves the server, so Upstash only ever holds ciphertext.
 *
 * Kept free of Next.js so it is unit-tested.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

export type StoreKey =
  | 'ledger'
  | 'expenses'
  | 'expenses-archive'
  | 'overheads'
  | 'expense-overrides'
  | 'xero:tokens'
  | 'xero:snapshot'
  | 'xero:pairs'
  | 'settings'
  | 'onedrive:tokens'
  | 'gmail:tokens'
  | 'digest:last'
  | 'ai:usage'
  | 'sync:status'
  | 'meta:ledger'
  | 'meta:expenses'
  | 'meta:expenses-archive'
  | 'offers'
  | 'offers:seen'
  | 'offers:status'

export type ReadResult = { kind: 'ok'; value: unknown } | { kind: 'missing' } | { kind: 'invalid'; message: string }

export interface Store {
  readonly name: string
  get(key: StoreKey): Promise<ReadResult>
  set(key: StoreKey, value: unknown): Promise<void>
  del(key: StoreKey): Promise<void>
  /** Run `fn` while holding a lock, so two refreshes never spend the same single-use token. */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>
}

/** Read a value, or null when it is missing or unreadable. */
export async function getJson<T>(store: Store, key: StoreKey): Promise<T | null> {
  const r = await store.get(key)
  return r.kind === 'ok' ? (r.value as T) : null
}

// ---------------------------------------------------------------------------
// FileStore: the local data/ folder. Same file names as before, so existing data keeps working.
// ---------------------------------------------------------------------------

const FILES: Record<StoreKey, string> = {
  ledger: 'generated/ledger.json',
  expenses: 'generated/expenses.json',
  'expenses-archive': 'generated/expenses-archive.json',
  overheads: 'overheads.json',
  'expense-overrides': 'expense-overrides.json',
  'xero:tokens': 'xero/tokens.json',
  'xero:snapshot': 'xero/snapshot.json',
  'xero:pairs': 'xero/pairs.json',
  settings: 'settings.json',
  'onedrive:tokens': 'onedrive/tokens.json',
  'gmail:tokens': 'gmail/tokens.json',
  'digest:last': 'digest-last.json',
  'ai:usage': 'ai-usage.json',
  'sync:status': 'sync-status.json',
  'meta:ledger': 'generated/ledger.meta.json',
  'meta:expenses': 'generated/expenses.meta.json',
  'meta:expenses-archive': 'generated/expenses-archive.meta.json',
  offers: 'offers/offers.json',
  'offers:seen': 'offers/seen.json',
  'offers:status': 'offers/status.json',
}

const SECRET_KEYS = new Set<StoreKey>(['xero:tokens', 'onedrive:tokens', 'gmail:tokens'])

export class FileStore implements Store {
  readonly name = 'Local data folder'
  private locks = new Map<string, Promise<unknown>>()

  constructor(private readonly dir: string) {}

  file(key: StoreKey): string {
    return path.join(this.dir, FILES[key])
  }

  async get(key: StoreKey): Promise<ReadResult> {
    let text: string
    try {
      text = await fs.readFile(this.file(key), 'utf8')
    } catch {
      return { kind: 'missing' }
    }
    try {
      return { kind: 'ok', value: JSON.parse(text) }
    } catch (e) {
      return { kind: 'invalid', message: `${path.basename(this.file(key))} is not valid JSON (${e instanceof Error ? e.message : String(e)})` }
    }
  }

  async set(key: StoreKey, value: unknown): Promise<void> {
    const file = this.file(key)
    const secret = SECRET_KEYS.has(key)
    await fs.mkdir(path.dirname(file), { recursive: true, ...(secret ? { mode: 0o700 } : {}) })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', secret ? { mode: 0o600 } : undefined)
    await fs.rename(tmp, file) // atomic: readers see the old file or the new one, never half of it
  }

  async del(key: StoreKey): Promise<void> {
    await fs.rm(this.file(key), { force: true })
  }

  /** One dashboard process runs locally, so an in-memory queue is enough. */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.locks.set(name, next)
    try {
      return await next
    } finally {
      if (this.locks.get(name) === next) this.locks.delete(name)
    }
  }
}

// ---------------------------------------------------------------------------
// Encryption for values stored online
// ---------------------------------------------------------------------------

const VERSION = 'v1'

export function storeKey(secret: string): Buffer {
  if (secret.length < 32) throw new Error('FN_STORE_KEY must be at least 32 characters')
  return crypto.createHash('sha256').update(secret).digest()
}

/** Compress, then encrypt. The key name is bound in, so a value can't be moved to another key. */
export function seal(key: Buffer, name: string, value: unknown): string {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(name))
  const body = Buffer.concat([c.update(zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)))), c.final()])
  return `${VERSION}.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`
}

export function unseal(key: Buffer, name: string, sealed: string): unknown {
  const [v, data] = sealed.split('.', 2)
  if (v !== VERSION || !data) throw new Error('unknown format')
  const raw = Buffer.from(data, 'base64')
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  d.setAAD(Buffer.from(name))
  d.setAuthTag(raw.subarray(12, 28))
  const plain = Buffer.concat([d.update(raw.subarray(28)), d.final()])
  return JSON.parse(zlib.brotliDecompressSync(plain).toString('utf8'))
}

// ---------------------------------------------------------------------------
// RedisStore: Upstash's REST API, no client library needed
// ---------------------------------------------------------------------------

const PREFIX = 'fn:'

export class RedisStore implements Store {
  readonly name = 'Online store (Upstash, encrypted)'
  private readonly key: Buffer

  constructor(
    private readonly url: string,
    private readonly token: string,
    secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.key = storeKey(secret)
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    const res = await this.fetchImpl(this.url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
    if (!res.ok || body.error) throw new Error(`Online store ${String(args[0])} failed (${res.status}${body.error ? `: ${body.error.slice(0, 120)}` : ''})`)
    return body.result ?? null
  }

  async get(key: StoreKey): Promise<ReadResult> {
    const raw = await this.command(['GET', PREFIX + key])
    if (raw === null) return { kind: 'missing' }
    try {
      return { kind: 'ok', value: unseal(this.key, key, String(raw)) }
    } catch {
      return { kind: 'invalid', message: `the saved ${key} could not be decrypted (was FN_STORE_KEY changed?)` }
    }
  }

  async set(key: StoreKey, value: unknown): Promise<void> {
    await this.command(['SET', PREFIX + key, seal(this.key, key, value)])
  }

  async del(key: StoreKey): Promise<void> {
    await this.command(['DEL', PREFIX + key])
  }

  /** SET NX with an expiry, so a crashed holder can't block the lock for more than `ttlMs`. */
  async withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 30_000): Promise<T> {
    const lockKey = `${PREFIX}lock:${name}`
    const id = crypto.randomBytes(12).toString('hex')
    const deadline = Date.now() + ttlMs
    while ((await this.command(['SET', lockKey, id, 'NX', 'PX', ttlMs])) !== 'OK') {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`)
      await new Promise((r) => setTimeout(r, 250))
    }
    try {
      return await fn()
    } finally {
      // Release only our own lock.
      await this.command(['EVAL', "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, id]).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------

export function dataDir(): string {
  return process.env.FN_DATA_DIR ?? path.join(process.cwd(), 'data')
}

let cached: { sig: string; store: Store } | null = null

/** The store for this environment. Hosted without online storage set up, it throws (fails closed). */
export function getStore(): Store {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  const sig = `${url ?? ''}|${dataDir()}`
  if (cached?.sig === sig) return cached.store
  let store: Store
  if (url && token) {
    const secret = process.env.FN_STORE_KEY
    if (!secret) throw new Error('Online storage is connected but FN_STORE_KEY is not set, so nothing can be saved or read')
    store = new RedisStore(url, token, secret)
  } else {
    store = new FileStore(dataDir())
  }
  cached = { sig, store }
  return store
}

/** True when saving survives a restart: always on your PC, and hosted only with online storage. */
export function storeWritable(): boolean {
  if (!process.env.VERCEL) return true
  return !!((process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL) && process.env.FN_STORE_KEY)
}
