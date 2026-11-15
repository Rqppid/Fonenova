import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const user = vi.hoisted(() => ({ value: 'owner@example.test' as string | false }))
vi.mock('@/lib/session', () => ({ currentUser: async () => user.value }))

const env = { ...process.env }
let dir: string
beforeEach(() => {
  vi.resetModules()
  user.value = 'owner@example.test'
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-golive-'))
  for (const k of ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k]
  Object.assign(process.env, { FN_DATA_DIR: dir, AUTH_URL: 'https://dashboard.example.test' })
})
afterEach(() => { process.env = { ...env }; fs.rmSync(dir, { recursive: true, force: true }) })

const put = async (body: unknown, origin = 'https://dashboard.example.test') => {
  const { PUT } = await import('@/app/api/offers/golive/route')
  return PUT(new Request('https://dashboard.example.test/api/offers/golive', { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}
const ticks = async () => { const { getStore, getJson } = await import('@/lib/store'); return getJson<Record<string, string>>(getStore(), 'offers:golive') }

describe('ticking the go-live checklist', () => {
  it('remembers a tick with its time, and an untick removes it', async () => {
    expect((await put({ id: 'accountant_told', done: true })).status).toBe(200)
    expect(Object.keys((await ticks())!)).toEqual(['accountant_told'])
    expect((await put({ id: 'accountant_told', done: false })).status).toBe(200)
    expect(await ticks()).toEqual({})
  })
  it('only knows the listed items, needs the owner and the dashboard origin', async () => {
    expect((await put({ id: 'switch_real_send', done: true })).status).toBe(400) // the switches are Vercel settings, never ticks
    expect((await put({ id: 'accountant_told', done: 'yes' })).status).toBe(400)
    expect((await put({ id: 'accountant_told', done: true }, 'https://evil.example.test')).status).toBe(403)
    user.value = false
    expect((await put({ id: 'accountant_told', done: true })).status).toBe(401)
  })
})
