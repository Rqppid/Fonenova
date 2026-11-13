import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishGmailAuth, gmailConfig, mimeMessage, sendGmail, startGmailAuth } from '@/lib/gmail'
import { FileStore } from '@/lib/store'

const env = { ...process.env }
let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-'))
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', AUTH_URL: 'https://dashboard.fonenova.com', AUTH_ALLOWED_EMAIL: 'info@fonenova.com', FN_DATA_DIR: dir })
  delete process.env.KV_REST_API_URL
  delete process.env.UPSTASH_REDIS_REST_URL
})
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

describe('Gmail', () => {
  it('asks for send and read-only access with a refresh token, for the allowed account', () => {
    const { url } = startGmailAuth(gmailConfig()!)
    const q = new URL(url).searchParams
    expect(q.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly')
    expect(q.get('scope')).not.toMatch(/gmail\.modify|mail\.google\.com/) // read, never change or delete
    expect([q.get('access_type'), q.get('prompt'), q.get('login_hint'), q.get('redirect_uri')]).toEqual(['offline', 'consent', 'info@fonenova.com', 'https://dashboard.fonenova.com/gmail/callback'])
  })

  it('refuses a different Google account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.includes('token') ? Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }) : Response.json({ email: 'someone@gmail.com' }))))
    await expect(finishGmailAuth(gmailConfig()!, 'code', 'v')).rejects.toThrow('Only info@fonenova.com')
  })

  it('refreshes an expired token, then sends a two-part message as the connected account', async () => {
    const store = new FileStore(dir)
    await store.set('gmail:tokens', { accessToken: 'old', refreshToken: 'r', expiresAt: 0, email: 'info@fonenova.com' })
    const calls: { url: string; body: string; auth: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization ?? '') })
      return url.includes('token') ? Response.json({ access_token: 'new', expires_in: 3600 }) : Response.json({ id: 'm1' })
    }))
    const r = await sendGmail(gmailConfig()!, { subject: 'QuayPilot weekly: €55k overdue', text: 'hi', html: '<p>hi</p>' }, store)
    expect(r).toEqual({ id: 'm1', to: 'info@fonenova.com', from: 'info@fonenova.com' })
    expect(calls[0].body).toContain('grant_type=refresh_token')
    expect(calls[1].auth).toBe('Bearer new')
    const raw = Buffer.from(JSON.parse(calls[1].body).raw, 'base64url').toString()
    expect(raw).toContain('Content-Type: multipart/alternative')
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('QuayPilot weekly: €55k overdue').toString('base64')}?=`)
  })

  it('encodes the body so long lines and non-ASCII survive', () => {
    const m = mimeMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'x', text: '€'.repeat(100), html: '<p>ok</p>' })
    expect(m.split('\r\n').every((l) => l.length <= 998)).toBe(true)
  })
})

describe('Gmail read access', () => {
  it('knows a token saved before reading existed is send-only', async () => {
    const { scopeCanRead } = await import('@/lib/gmail')
    expect(scopeCanRead(undefined)).toBe(false)
    expect(scopeCanRead('openid email https://www.googleapis.com/auth/gmail.send')).toBe(false)
    expect(scopeCanRead('https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly')).toBe(true)
  })
})
