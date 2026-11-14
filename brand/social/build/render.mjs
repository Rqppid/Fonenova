// Renders the HTML pages that build.py wrote into a temp folder, and checks every one.
//
//   node brand/social/build/render.mjs <folder holding jobs.json and the .html files>
//
// Playwright is resolved normally, then from PLAYWRIGHT_MODULE, then from the common global
// install. Chromium comes from CHROME_PATH, or the newest one under /opt/pw-browsers, or
// Playwright's own. Exits non-zero if any content leaves the frame, so a broken banner can
// never be written without anyone noticing.
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
let pw
for (const spec of ['playwright', process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright']) {
  if (!spec) continue
  try { pw = require(spec); break } catch { /* try the next */ }
}
if (!pw) { console.error('Playwright not found. Set PLAYWRIGHT_MODULE to its folder.'); process.exit(2) }

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = '/opt/pw-browsers'
  if (!existsSync(base)) return undefined
  const dirs = readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) for (const sub of ['chrome-linux64', 'chrome-linux']) {
    const p = `${base}/${d}/${sub}/chrome`
    if (existsSync(p)) return p
  }
  return undefined
}

const dir = process.argv[2]
const jobs = JSON.parse(readFileSync(`${dir}/jobs.json`, 'utf8'))
const browser = await pw.chromium.launch({ executablePath: chromePath() })
let failed = false

for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.scale })
  await page.goto(`file://${dir}/${j.name}.html`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)

  // Everything that carries content must sit inside the frame.
  const bad = await page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight, out = []
    for (const sel of ['.brand', '.tag', '.meta']) {
      const r = document.querySelector(sel).getBoundingClientRect()
      if (r.left < 0 || r.right > vw || r.top < 0 || r.bottom > vh) out.push({ sel, l: r.left, r: r.right, t: r.top, b: r.bottom })
    }
    return out
  })
  if (bad.length) { failed = true; console.error(`OVERFLOW in ${j.name}:`, JSON.stringify(bad)) }

  mkdirSync(dirname(j.out), { recursive: true })
  await page.screenshot(j.jpeg ? { path: j.out, type: 'jpeg', quality: 82 } : { path: j.out })
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${j.name}  ${j.w * j.scale}x${j.h * j.scale}  ->  ${j.out}`)
  await page.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
