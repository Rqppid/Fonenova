import { failure, oneDriveGuard, oneDriveJson } from '@/lib/onedrive-guard'
import { checkFolder, conflictCopies } from '@/lib/onedrive-write'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET ?folder= → OneDrive's "<file>-<PCNAME>.xlsx" conflict copies of the allowed files there. */
export async function GET(req: Request) {
  const stop = oneDriveGuard(req)
  if (stop) return stop
  const folder = new URL(req.url).searchParams.get('folder')
  const bad = checkFolder(folder)
  if (bad) return oneDriveJson({ error: bad }, 400)
  const r = await conflictCopies(folder!)
  return r.kind === 'ok' ? oneDriveJson(r.data) : failure(r)
}
