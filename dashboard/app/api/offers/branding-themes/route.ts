import { guard, paymentsJson as json } from '@/lib/payments-guard'
import { xeroWriteApi, xeroWriteConfig, xeroWriteStatus } from '@/lib/xero/write'

export const dynamic = 'force-dynamic'

/** The connected Xero organisation's branding themes (name and API id), for the Settings dropdown. Signed-in only. */
export async function GET(req: Request) {
  const stop = await guard(req, { write: false })
  if (stop) return stop
  if (!xeroWriteConfig() || !(await xeroWriteStatus()).connected) return json({ error: 'Connect the Xero write connection first.' }, 409)
  try {
    const themes = (await xeroWriteApi().brandingThemes?.()) ?? []
    return json({ ok: true, themes })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : 'Xero could not be reached' }, 502)
  }
}
