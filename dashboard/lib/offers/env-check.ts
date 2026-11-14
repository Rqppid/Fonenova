/**
 * Checks the Offers environment variables for the mistakes that actually happen when they are
 * pasted into Vercel (a whole ".env" block instead of the token, quotes, spaces inside, a
 * half-copied address), and says which rule failed in plain words. The messages name the variable
 * and the rule and NEVER contain its value, so nothing secret can reach a screen, a response or a
 * log through them.
 *
 * A space or line break at the very START or END is harmless (a re-paste usually leaves one, and
 * HTTP header values are trimmed anyway), so it is removed by `envValue` and never reported. The
 * same trimmed value is what every request uses.
 */
type Env = Record<string, string | undefined>

const URL_VAR = 'OFFERS_PUBLIC_REDIS_URL'
const TOKEN_VAR = 'OFFERS_PUBLIC_REDIS_TOKEN'
const WEBHOOK_VAR = 'OFFERS_WEBHOOK_TOKEN'

/** The variable's value without surrounding whitespace, or undefined when it is unset or blank. Use this to read these variables. */
export function envValue(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

/** An "=" is fine as trailing padding (base64) but not inside the value: that is a pasted "NAME=value". */
const embeddedEquals = (v: string) => /=(?!=*$)/.test(v)

/** The first rule a (trimmed) value breaks, as a phrase that continues "it ...", or null. */
function shapeReason(v: string): string | null {
  if (/\s/.test(v)) return 'has a space or line break inside it'
  if (/["'`]/.test(v)) return 'has a quote mark in it (it looks wrapped in quotes)'
  if (embeddedEquals(v)) return 'has an equals sign inside it (it looks like NAME=value: paste only what comes after the equals sign)'
  return null
}

const malformed = (name: string, reason: string, advice: string) => `${name} looks malformed: it ${reason}. ${advice}`

export function urlProblem(raw: string | undefined): string | null {
  const v = envValue(raw)
  if (!v) return null
  const advice = 'Paste only the https:// address from Upstash.'
  const shape = shapeReason(v)
  if (shape) return malformed(URL_VAR, shape, advice)
  try {
    const u = new URL(v)
    return u.protocol === 'https:' && u.hostname.includes('.') ? null : malformed(URL_VAR, 'is not a complete https:// address', advice)
  } catch {
    return malformed(URL_VAR, 'is not a valid address', advice)
  }
}

export function tokenProblem(raw: string | undefined): string | null {
  const t = envValue(raw)
  if (!t) return null
  const advice = 'Paste only the token itself, with no name, "Bearer", quotes or spaces.'
  const shape = shapeReason(t)
  if (shape) return malformed(TOKEN_VAR, shape, advice)
  if (t.length < 20) return malformed(TOKEN_VAR, 'is too short to be a token (under 20 characters)', advice)
  return null
}

export function webhookProblem(raw: string | undefined): string | null {
  const t = envValue(raw)
  if (!t) return null
  const advice = 'It must be one run of at least 32 letters and digits, with no name, quotes or spaces.'
  const shape = shapeReason(t)
  if (shape) return malformed(WEBHOOK_VAR, shape, advice)
  if (t.length < 32) return malformed(WEBHOOK_VAR, 'is too short (under 32 characters)', advice)
  return null
}

/** The public store's two variables: set or not, and the problem (if any) with what is set. */
export function checkPublicStoreEnv(env: Env): { configured: boolean; problem: string | null } {
  const url = envValue(env[URL_VAR])
  const token = envValue(env[TOKEN_VAR])
  if (!url && !token) return { configured: false, problem: null }
  if (!url) return { configured: false, problem: `${URL_VAR} is not set (it goes with ${TOKEN_VAR}).` }
  if (!token) return { configured: false, problem: `${TOKEN_VAR} is not set (it goes with ${URL_VAR}).` }
  const problem = urlProblem(url) ?? tokenProblem(token)
  return { configured: problem === null, problem }
}

/**
 * Everything wrong with the Offers variables, for the watchdog. Says nothing when none of them
 * are set (sending is simply not set up), and names any that is missing once another is set.
 */
export function offersEnvProblems(env: Env): string[] {
  const any = [URL_VAR, TOKEN_VAR, WEBHOOK_VAR].some((k) => envValue(env[k]))
  if (!any) return []
  const out: string[] = []
  const store = checkPublicStoreEnv(env)
  if (store.problem) out.push(store.problem)
  if (!envValue(env[WEBHOOK_VAR])) out.push(`${WEBHOOK_VAR} is not set: answers will arrive within 5 minutes instead of at once.`)
  else {
    const w = webhookProblem(env[WEBHOOK_VAR])
    if (w) out.push(w)
  }
  return out
}
