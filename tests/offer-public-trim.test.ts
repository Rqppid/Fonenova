import { afterEach, describe, expect, it, vi } from 'vitest'
import { publicStoreConfigured } from '@/lib/offers-public'

vi.mock('server-only', () => ({}))

const STORE = 'https://public-store.example.test'
const TOKEN = 'store-token-0123456789abcdefghij'
const env = { ...process.env }
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

describe('the public site tolerates a stray space or line break at the ends of its variables', () => {
  it('counts padded values as set up, and still refuses a space inside the token', () => {
    Object.assign(process.env, { OFFERS_PUBLIC_REDIS_URL: `${STORE}\n`, OFFERS_PUBLIC_REDIS_TOKEN: ` ${TOKEN}\r\n` })
    expect(publicStoreConfigured()).toBe(true)
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = `Bearer ${TOKEN}`
    expect(publicStoreConfigured()).toBe(false)
  })

  it('keywords inside a genuine token no longer count against it', () => {
    Object.assign(process.env, { OFFERS_PUBLIC_REDIS_URL: STORE, OFFERS_PUBLIC_REDIS_TOKEN: 'Xk9Bearer3Qm7Zt2Lp8Wv4Rn6Yd' })
    expect(publicStoreConfigured()).toBe(true)
  })
})
