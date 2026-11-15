import { checkDraftSettings, loadDraftSettings } from '@/lib/offers/draft'
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
  // A theme id belongs to one Xero organisation: it is saved for the organisation drafts go to now, never for another.
  const store = getStore()
  const status = await xeroWriteStatus(store)
  const wanted = checked.value.brandingThemeId
  if (wanted && !status.selectedTenantId) return json({ error: 'Choose the Xero organisation for drafts first: a branding theme belongs to one organisation.' }, 400)
  const saved = await loadDraftSettings(store)
  const ids = { ...(saved.brandingThemeIds ?? {}) }
  if (status.selectedTenantId) {
    if (wanted) ids[status.selectedTenantId.toLowerCase()] = wanted
    else delete ids[status.selectedTenantId.toLowerCase()]
  }
  const next = { taxType: checked.value.taxType, accountCode: checked.value.accountCode, brandingThemeId: status.isDemo === false ? wanted : saved.brandingThemeId, brandingThemeIds: ids }
  await store.set('offers:draft-settings', next)
  return json({ ok: true, settings: next })
}
