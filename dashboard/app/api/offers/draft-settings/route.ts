import { checkDraftSettings } from '@/lib/offers/draft'
import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { getStore } from '@/lib/store'
import { xeroWriteApi, xeroWriteConfig, xeroWriteStatus } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

/** Save how draft invoices are built (tax type, sales account, branding theme). Signed-in, same-origin only. */
export async function PUT(req: Request) {
  const stop = await guard(req, { write: true })
  if (stop) return stop
  const checked = checkDraftSettings(await req.json().catch(() => null))
  if (!checked.ok) return json({ error: checked.error }, 400)
  // When the organisation can be asked, a branding theme id must be one of its themes: the id in the
  // theme editor's page address is not always the API id, and a wrong one makes every draft fail.
  if (checked.value.brandingThemeId && xeroWriteConfig() && (await xeroWriteStatus()).connected) {
    const themes = await xeroWriteApi().brandingThemes?.().catch(() => null)
    if (themes && !themes.some((t) => t.id.toLowerCase() === checked.value.brandingThemeId!.toLowerCase())) {
      return json({ error: `That id is not a branding theme in the connected Xero organisation. Press "Load themes" and pick one: ${themes.map((t) => t.name).join(', ') || 'none found'}.` }, 400)
    }
  }
  await getStore().set('offers:draft-settings', checked.value)
  return json({ ok: true, settings: checked.value })
}
