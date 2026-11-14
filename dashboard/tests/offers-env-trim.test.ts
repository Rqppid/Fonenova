import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPublicStoreEnv, envValue, offersEnvProblems, tokenProblem, urlProblem, webhookProblem } from '@/lib/offers/env-check'

vi.mock('server-only', () => ({}))

const PUB = 'https://public-store.example.test'
const TOKEN = 'pub-token-0123456789abcdefghijklmnop'
const WEBHOOK = 'webhook-token-0123456789abcdefghij'
const env = { ...process.env }
afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

describe('a space or line break at the ends is harmless', () => {
  it('is accepted by every check, not reported', () => {
    for (const pad of [' ', '\n', '\r\n', '\t ', '  \n']) {
      expect(tokenProblem(`${TOKEN}${pad}`), JSON.stringify(pad)).toBeNull()
      expect(tokenProblem(`${pad}${TOKEN}`)).toBeNull()
      expect(urlProblem(`${PUB}${pad}`)).toBeNull()
      expect(webhookProblem(`${WEBHOOK}${pad}`)).toBeNull()
    }
    expect(checkPublicStoreEnv({ OFFERS_PUBLIC_REDIS_URL: `${PUB}\n`, OFFERS_PUBLIC_REDIS_TOKEN: ` ${TOKEN}\n` })).toEqual({ configured: true, problem: null })
    expect(offersEnvProblems({ OFFERS_PUBLIC_REDIS_URL: PUB, OFFERS_PUBLIC_REDIS_TOKEN: `${TOKEN}\n`, OFFERS_WEBHOOK_TOKEN: `${WEBHOOK} ` })).toEqual([])
    expect(envValue('  \n')).toBeUndefined()
    expect(envValue(` ${TOKEN}\n`)).toBe(TOKEN)
  })

  it('the request carries the trimmed value, never the padding', async () => {
    process.env.OFFERS_PUBLIC_REDIS_URL = `${PUB}\n`
    process.env.OFFERS_PUBLIC_REDIS_TOKEN = ` ${TOKEN}\r\n`
    const seen: { url: string; auth: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, auth: String((init.headers as Record<string, string>).authorization) })
      return Response.json({ result: null })
    }))
    const { getPublicAnswer } = await import('@/lib/offers/public-store')
    await getPublicAnswer('a'.repeat(64))
    expect(seen).toEqual([{ url: PUB, auth: `Bearer ${TOKEN}` }])
  })
})

describe('each rule has its own message, and none contains the value', () => {
  const cases: [string, string][] = [
    [`Bearer ${TOKEN}`, 'a space or line break inside it'],
    [`UPSTASH_REDIS_REST_TOKEN=${TOKEN}`, 'an equals sign inside it'],
    [`"${TOKEN}"`, 'a quote mark'],
    ['abcdefghij', 'too short'],
  ]
  it.each(cases)('%s', (bad, reason) => {
    const m = tokenProblem(bad)!
    expect(m).toContain('OFFERS_PUBLIC_REDIS_TOKEN looks malformed')
    expect(m).toContain(reason)
    expect(m).not.toContain(TOKEN)
    expect(m).not.toContain('abcdefghij')
  })
  it('the url and webhook name their rule too', () => {
    expect(urlProblem('http://public-store.example.test')).toContain('not a complete https:// address')
    expect(urlProblem('not a url at all')).toContain('space or line break inside it')
    expect(webhookProblem('short')).toContain('too short')
    expect(webhookProblem(`${WEBHOOK} x`)).toContain('space or line break inside it')
  })
})

describe('the old keyword rule is gone', () => {
  it('a genuine random token that happens to contain a keyword is accepted', () => {
    for (const t of [`Xk9Bearer3Qm7Zt2Lp8Wv4Rn6Yd`, `abcREST_URLdefghijklmnopqrstuv`, `abc_UPSTASH_REDIS_xyz0123456789`, `qwertyREST_TOKENasdfghjkl012`]) expect(tokenProblem(t), t).toBeNull()
  })
  it('a real pasted block is still caught, by its own shape', () => {
    expect(tokenProblem(`UPSTASH_REDIS_REST_URL=${PUB}\nUPSTASH_REDIS_REST_TOKEN=${TOKEN}`)).toContain('looks malformed')
  })
})
