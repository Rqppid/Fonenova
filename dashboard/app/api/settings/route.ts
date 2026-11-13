import { NextResponse } from 'next/server'
import { loadSettings, overheadsWritable, saveSettings, validateSettingsPatch } from '@/lib/data-source'
import { getStore } from '@/lib/store'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function PUT(req: Request) {
  if ((await currentUser()) === false) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  if (!overheadsWritable()) return NextResponse.json({ error: 'Saving needs online storage: connect Upstash Redis and set FN_STORE_KEY in the Vercel project' }, { status: 501 })
  const patch = validateSettingsPatch(await req.json().catch(() => null))
  if (!patch) return NextResponse.json({ error: 'Expected { marginSchemeVat?: boolean, fridayEmail?: boolean, ignoredInvoiceNumbers?: string[] }' }, { status: 400 })
  let v
  try {
    // Merge under a lock, so two changes from different cards never undo each other.
    v = await getStore().withLock('settings', async () => {
      const next = { ...(await loadSettings()), ...patch }
      await saveSettings(next)
      return next
    })
  } catch (e) {
    return NextResponse.json({ error: `Could not save (${e instanceof Error ? e.message.slice(0, 160) : 'unknown'})` }, { status: 502 })
  }
  return NextResponse.json({ ok: true, settings: v })
}
