/**
 * Checks the Offers environment variables for the mistakes that actually happen when they are
 * pasted into Vercel (a whole ".env" block instead of the token, quotes, spaces, a half-copied
 * address), and says so in plain words. The messages name the variable and NEVER contain its
 * value, so nothing secret can reach a screen, a response or a log through them.
 */
type Env = Record<string, string | undefined>

const URL_VAR = 'OFFERS_PUBLIC_REDIS_URL'
const TOKEN_VAR = 'OFFERS_PUBLIC_REDIS_TOKEN'
const WEBHOOK_VAR = 'OFFERS_WEBHOOK_TOKEN'

const present = (v: string | undefined) => !!v && v.length > 0
/** An "=" is fine as trailing padding (base64) but not inside the value: that is a pasted "NAME=value". */
const embeddedEquals = (v: string) => /=(?!=*$)/.test(v)
const hasJunk = (v: string) => /\s/.test(v) || /["'`]/.test(v)

export function urlProblem(v: string | undefined): string | null {
  if (!present(v)) return null
  const bad = `${URL_VAR} looks malformed: it must be the plain https:// address from Upstash, with no name, quotes or spaces.`
  if (hasJunk(v!) || embeddedEquals(v!)) return bad
  try {
    const u = new URL(v!)
    return u.protocol === 'https:' && u.hostname.includes('.') ? null : bad
  } catch {
    return bad
  }
}

export function tokenProblem(v: string | undefined): string | null {
  if (!present(v)) return null
  const t = v!
  if (hasJunk(t) || embeddedEquals(t) || /bearer|UPSTASH_REDIS|REST_URL|REST_TOKEN/i.test(t) || t.length < 20) {
    return `${TOKEN_VAR} looks malformed: paste only the token itself, with no name, "Bearer", quotes or spaces.`
  }
  return null
}

export function webhookProblem(v: string | undefined): string | null {
  if (!present(v)) return null
  const t = v!
  return hasJunk(t) || embeddedEquals(t) || t.length < 32 ? `${WEBHOOK_VAR} looks malformed: it must be one run of at least 32 letters and digits, with no name, quotes or spaces.` : null
}

/** The public store's two variables: set or not, and the problem (if any) with what is set. */
export function checkPublicStoreEnv(env: Env): { configured: boolean; problem: string | null } {
  const url = env[URL_VAR]
  const token = env[TOKEN_VAR]
  if (!present(url) && !present(token)) return { configured: false, problem: null }
  if (!present(url)) return { configured: false, problem: `${URL_VAR} is not set (it goes with ${TOKEN_VAR}).` }
  if (!present(token)) return { configured: false, problem: `${TOKEN_VAR} is not set (it goes with ${URL_VAR}).` }
  const problem = urlProblem(url) ?? tokenProblem(token)
  return { configured: problem === null, problem }
}

/**
 * Everything wrong with the Offers variables, for the watchdog. Says nothing when none of them
 * are set (sending is simply not set up), and names any that is missing once another is set.
 */
export function offersEnvProblems(env: Env): string[] {
  const any = [URL_VAR, TOKEN_VAR, WEBHOOK_VAR].some((k) => present(env[k]))
  if (!any) return []
  const out: string[] = []
  const store = checkPublicStoreEnv(env)
  if (store.problem) out.push(store.problem)
  if (!present(env[WEBHOOK_VAR])) out.push(`${WEBHOOK_VAR} is not set: answers will arrive within 5 minutes instead of at once.`)
  else {
    const w = webhookProblem(env[WEBHOOK_VAR])
    if (w) out.push(w)
  }
  return out
}
