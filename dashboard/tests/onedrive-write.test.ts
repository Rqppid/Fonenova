import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SECRET = 'test-onedrive-write-secret-0123456789abcdef'
const WAVE = 'Desktop/WAVE-PHONE/Wave Phone Payments to FoneNova - Rebuilt.xlsx'
const M1 = 'Desktop/MOBILE ONE/Payments from FoneNova Ltd to Mobile One Trade B.V Updated.xlsx'
const LEDGER = 'Desktop/Ledger/FoneNova_Order_Ledger.xlsx'
const GRAPH = 'https://graph.test/v1.0'
const env = { ...process.env }
const sha = (b: Uint8Array | Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const xlsx = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)])

/** A tiny fake OneDrive: files by path, with eTags that change on every write. */
let drive: Map<string, { id: string; bytes: Buffer; etag: string; locked?: boolean }>
let requests: { method: string; url: string; headers: Headers; bodyLength: number }[]
let n = 0

function fakeGraph() {
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0)
    requests.push({ method, url: input, headers, bodyLength: body.length })
    const u = new URL(input)
    const p = decodeURIComponent(u.pathname.replace('/v1.0', ''))
    const byId = (id: string) => [...drive.entries()].find(([, f]) => f.id === id)
    const meta = (k: string, f: { id: string; bytes: Buffer; etag: string }) => Response.json({ id: f.id, eTag: f.etag, size: f.bytes.length, lastModifiedDateTime: '2026-11-10T10:00:00Z', file: {}, name: k.split('/').pop() })

    let m = p.match(/^\/me\/drive\/root:\/(.+):\/children$/)
    if (m && method === 'GET') {
      const folder = m[1]
      const value = [...drive.entries()].filter(([k]) => k.startsWith(`${folder}/`)).map(([k]) => ({ name: k.slice(folder.length + 1), lastModifiedDateTime: '2026-11-10T10:00:00Z', file: {} }))
      return Response.json({ value })
    }
    m = p.match(/^\/me\/drive\/root:\/(.+):\/content$/)
    if (m && method === 'PUT') {
      if (drive.has(m[1])) return new Response('{}', { status: 409 })
      const f = { id: `id${++n}`, bytes: body, etag: `"e${n}"` }
      drive.set(m[1], f)
      return meta(m[1], f)
    }
    m = p.match(/^\/me\/drive\/root:\/(.+)$/)
    if (m && method === 'GET') {
      const f = drive.get(m[1])
      return f ? meta(m[1], f) : new Response('{}', { status: 404 })
    }
    m = p.match(/^\/me\/drive\/items\/([^/]+)\/content$/)
    if (m) {
      const hit = byId(m[1])
      if (!hit) return new Response('{}', { status: 404 })
      const [k, f] = hit
      if (method === 'GET') return new Response(f.bytes)
      if (method === 'PUT') {
        if (f.locked) return new Response('{}', { status: 423 })
        if (headers.get('if-match') && headers.get('if-match') !== f.etag) return new Response('{}', { status: 412 })
        f.bytes = body
        f.etag = `"e${++n}"`
        return meta(k, f)
      }
    }
    return new Response('{}', { status: 400 })
  })
}

let dir: string
beforeEach(async () => {
  vi.resetModules()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-od-'))
  drive = new Map([[WAVE, { id: 'wave', bytes: xlsx('wave v1'), etag: '"w1"' }], [LEDGER, { id: 'ledger', bytes: xlsx('ledger'), etag: '"l1"' }]])
  requests = []
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL']) delete process.env[k]
  Object.assign(process.env, {
    FN_DATA_DIR: dir, FN_GRAPH_URL: GRAPH, FN_MS_LOGIN_URL: 'https://login.test', MS_CLIENT_ID: 'client',
    ONEDRIVE_WRITE_TOKEN: SECRET, ONEDRIVE_WRITE_PATHS: `${WAVE}\n${M1}\n${LEDGER}`, FN_ONEDRIVE_LEDGER: LEDGER, FN_ONEDRIVE_EXPENSES_DIR: 'Desktop/VAT RETURNS',
  })
  vi.stubGlobal('fetch', fakeGraph())
  await tokens('Files.ReadWrite offline_access')
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function tokens(scope: string | undefined, expiresAt = Date.now() + 3_600_000) {
  const { getStore } = await import('@/lib/store')
  await getStore().set('onedrive:tokens', { accessToken: 'at', refreshToken: 'rt', expiresAt, accountName: 'Hamza', ...(scope ? { scope } : {}) })
}
const req = (url: string, init: RequestInit & { auth?: string | null } = {}) => {
  const headers = new Headers(init.headers)
  if (init.auth !== null) headers.set('authorization', `Bearer ${init.auth ?? SECRET}`)
  return new Request(`https://dashboard.fonenova.com${url}`, { ...init, headers })
}
const q = (p: string) => encodeURIComponent(p)
const routes = async () => ({ file: await import('@/app/api/onedrive/file/route'), conflicts: await import('@/app/api/onedrive/conflicts/route') })

describe('OneDrive tracker routes: access', () => {
  it('refuse a missing or wrong bearer token, and are off without the secret', async () => {
    const { file } = await routes()
    expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`, { auth: null }))).status).toBe(401)
    expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`, { auth: 'wrong' }))).status).toBe(401)
    delete process.env.ONEDRIVE_WRITE_TOKEN
    expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`))).status).toBe(503)
    expect(requests).toHaveLength(0)
  })

  it('refuse paths not on the list, the ledger and VAT folder even when listed, and tricks', async () => {
    const { file } = await routes()
    process.env.ONEDRIVE_WRITE_PATHS += '\nDesktop/VAT RETURNS/VAT Return From Sept-Dec, 2026.xlsx'
    for (const p of ['Desktop/Other.xlsx', LEDGER, 'Desktop/VAT RETURNS/VAT Return From Sept-Dec, 2026.xlsx', 'Desktop/WAVE-PHONE/../Ledger/FoneNova_Order_Ledger.xlsx', WAVE.toUpperCase(), '', 'Desktop\\WAVE-PHONE\\x.xlsx']) {
      expect((await file.GET(req(`/api/onedrive/file?path=${q(p)}`))).status, p).toBe(400)
      expect((await file.PUT(req(`/api/onedrive/file?path=${q(p)}&expected_sha256=none`, { method: 'PUT', body: xlsx('x') }))).status, p).toBe(400)
    }
    expect(requests).toHaveLength(0)
  })

  it('the proxy lets these routes through to their own bearer check', async () => {
    const { config } = await import('@/proxy')
    const re = new RegExp(`^${config.matcher[0]}$`)
    expect(re.test('/api/onedrive/file')).toBe(false)
    expect(re.test('/api/payments/approve')).toBe(true)
    expect(re.test('/onedrive/connect')).toBe(true)
  })
})

describe('OneDrive tracker routes: reading', () => {
  it('returns the sha256, etag and size of a file, and exists:false for a missing one', async () => {
    const { file } = await routes()
    const r = await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`))
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ path: WAVE, exists: true, sha256: sha(xlsx('wave v1')), etag: '"w1"', last_modified: '2026-11-10T10:00:00Z', size: xlsx('wave v1').length })
    expect(await (await file.GET(req(`/api/onedrive/file?path=${q(M1)}`))).json()).toEqual({ path: M1, exists: false, sha256: null, etag: null, last_modified: null, size: null })
  })

  it('works with a read-only connection, and says so when not connected', async () => {
    await tokens('Files.Read offline_access')
    const { file } = await routes()
    expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`))).status).toBe(200)
    const { getStore } = await import('@/lib/store')
    await getStore().del('onedrive:tokens')
    expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`))).status).toBe(503)
  })
})

describe('OneDrive tracker routes: writing', () => {
  const put = async (p: string, expected: string, body: Buffer) => (await routes()).file.PUT(req(`/api/onedrive/file?path=${q(p)}&expected_sha256=${expected}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } }))

  it('writes when the remote file still has the expected hash, with If-Match', async () => {
    const r = await put(WAVE, sha(xlsx('wave v1')), xlsx('wave v2'))
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ sha256: sha(xlsx('wave v2')), etag: expect.stringMatching(/^"e\d+"$/) })
    expect(drive.get(WAVE)!.bytes.equals(xlsx('wave v2'))).toBe(true)
    const write = requests.find((x) => x.method === 'PUT')!
    expect(write.headers.get('if-match')).toBe('"w1"')
  })

  it('writes nothing when the remote file changed since the caller looked', async () => {
    const r = await put(WAVE, sha(xlsx('something else')), xlsx('wave v2'))
    expect([r.status, await r.json()]).toEqual([409, { error: 'changed' }])
    expect(requests.some((x) => x.method === 'PUT')).toBe(false)
    expect(drive.get(WAVE)!.bytes.equals(xlsx('wave v1'))).toBe(true)
  })

  it('maps a change between the check and the upload (412) to changed, and a locked file to 423', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const r = await fakeGraph()(input, init)
      if ((init.method ?? 'GET') === 'GET' && input.includes('/content')) drive.get(WAVE)!.etag = '"moved"' // someone saved in between
      return r
    }))
    expect([(await put(WAVE, sha(xlsx('wave v1')), xlsx('v2'))).status]).toEqual([409])
    vi.stubGlobal('fetch', fakeGraph())
    drive.get(WAVE)!.etag = '"w1"'
    drive.get(WAVE)!.locked = true
    const locked = await put(WAVE, sha(xlsx('wave v1')), xlsx('v2'))
    expect([locked.status, await locked.json()]).toEqual([423, { error: 'locked' }])
  })

  it('"none" creates a new file only if there is none, and never replaces one', async () => {
    const made = await put(M1, 'none', xlsx('m1 v1'))
    expect(made.status).toBe(200)
    expect(requests.find((x) => x.method === 'PUT')!.url).toContain('conflictBehavior=fail')
    expect(drive.get(M1)!.bytes.equals(xlsx('m1 v1'))).toBe(true)
    expect((await put(WAVE, 'none', xlsx('x'))).status).toBe(409)
  })

  it('refuses a body that is not an xlsx, too large, empty, or a bad expected hash', async () => {
    expect((await put(WAVE, sha(xlsx('wave v1')), Buffer.from('not a zip'))).status).toBe(400)
    expect((await put(WAVE, sha(xlsx('wave v1')), Buffer.alloc(0))).status).toBe(400)
    expect((await put(WAVE, sha(xlsx('wave v1')), Buffer.concat([xlsx(''), Buffer.alloc(4 * 1024 * 1024)]))).status).toBe(400)
    expect((await put(WAVE, 'abc', xlsx('x'))).status).toBe(400)
    expect((await put(WAVE, '', xlsx('x'))).status).toBe(400)
    expect(requests).toHaveLength(0)
  })

  it('refuses to write with a read-only connection, asking for a reconnect', async () => {
    await tokens(undefined) // saved before write access existed
    const r = await put(WAVE, sha(xlsx('wave v1')), xlsx('v2'))
    expect(r.status).toBe(503)
    expect((await r.json()).error).toContain('reconnect OneDrive')
    expect(requests).toHaveLength(0)
  })

  it('never sends a DELETE, and logs hashes but never the contents', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await put(WAVE, sha(xlsx('wave v1')), xlsx('SECRET-CONTENT v2'))
    await put(WAVE, 'f'.repeat(64), xlsx('SECRET-CONTENT v3'))
    await put(M1, 'none', xlsx('SECRET-CONTENT m1'))
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('SECRET-CONTENT')
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'onedrive-write', path: WAVE, result: 'ok', written_sha256: sha(xlsx('SECRET-CONTENT v2')) })
    expect(JSON.parse(lines[1]).result).toBe('changed')
    expect(requests.every((x) => x.method !== 'DELETE')).toBe(true)
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/onedrive-write.ts'), 'utf8') + fs.readFileSync(path.join(process.cwd(), 'app/api/onedrive/file/route.ts'), 'utf8')
    expect(src).not.toMatch(/DELETE['"]|method:\s*['"]DELETE|export async function DELETE/)
    log.mockRestore()
  })
})

describe('OneDrive conflict copies', () => {
  it('lists only "<file>-<PC>.xlsx" copies of allowed files in an allowed folder', async () => {
    drive.set('Desktop/WAVE-PHONE/Wave Phone Payments to FoneNova - Rebuilt-HAMZA-PC.xlsx', { id: 'c1', bytes: xlsx('c'), etag: '"c"' })
    drive.set('Desktop/WAVE-PHONE/Notes.xlsx', { id: 'c2', bytes: xlsx('n'), etag: '"n"' })
    const { conflicts } = await routes()
    const r = await conflicts.GET(req(`/api/onedrive/conflicts?folder=${q('Desktop/WAVE-PHONE')}`))
    expect(await r.json()).toEqual({ folder: 'Desktop/WAVE-PHONE', conflicts: [{ name: 'Wave Phone Payments to FoneNova - Rebuilt-HAMZA-PC.xlsx', last_modified: '2026-11-10T10:00:00Z' }] })
    expect((await conflicts.GET(req(`/api/onedrive/conflicts?folder=${q('Desktop/VAT RETURNS')}`))).status).toBe(400)
  })
})

describe('OneDrive scope on refresh', () => {
  it('a token saved read-only refreshes read-only; a write token refreshes with write', async () => {
    for (const [saved, asked] of [[undefined, 'Files.Read offline_access'], ['Files.ReadWrite offline_access', 'Files.ReadWrite offline_access']] as const) {
      await tokens(saved, Date.now() - 1000)
      const bodies: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
        if (input.startsWith('https://login.test')) {
          bodies.push(String(init.body))
          return Response.json({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600 })
        }
        return fakeGraph()(input, init)
      }))
      const { file } = await routes()
      expect((await file.GET(req(`/api/onedrive/file?path=${q(WAVE)}`))).status).toBe(200)
      expect(new URLSearchParams(bodies[0]).get('scope')).toBe(asked)
      const { getStore, getJson } = await import('@/lib/store')
      expect(await getJson<{ refreshToken: string }>(getStore(), 'onedrive:tokens')).toMatchObject({ refreshToken: 'rt2', scope: asked })
    }
  })

  it('a new connection asks Microsoft for read and write', async () => {
    const { startOneDriveAuth, oneDriveConfig } = await import('@/lib/onedrive')
    expect(new URL(startOneDriveAuth(oneDriveConfig()!).url).searchParams.get('scope')).toBe('Files.ReadWrite offline_access')
  })
})
