'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { ukTime } from '@/lib/format-uk'
import type { ImeiCandidate } from '@/lib/offers/imei'
import type { Offer } from '@/lib/offers/types'

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const KIND: Record<ImeiCandidate['kind'], string> = { imei: 'IMEI list', label: 'label / shipping', other: 'other' }

/**
 * The IMEI list and shipping label from Mobile One, for the client. Pick the files from Mobile One's email;
 * if the invoice has not gone yet they are attached to it, and if it has, one click sends them as a reply
 * in the same email thread. Nothing is sent without the tick.
 */
export function ImeiBlock({ offer, sendHint }: { offer: Offer; sendHint: string | null }) {
  const router = useRouter()
  const f = offer.fulfilment
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [thread, setThread] = useState('')
  const [found, setFound] = useState<{ threadId: string; candidates: ImeiCandidate[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [tick, setTick] = useState(false)
  if (!f) return null
  const imei = f.imei
  const invoiceSent = f.send?.state === 'done'
  const key = (c: { messageId: string; attachmentId: string }) => `${c.messageId}:${c.attachmentId}`

  async function act(action: string, extra: object = {}) {
    setBusy(action)
    setError(null)
    setNotice(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: offer.id, ...extra }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string; threadId?: string; candidates?: ImeiCandidate[] } | null
    setBusy(null)
    if (!(res?.ok && out?.ok)) {
      setError(out?.error ?? 'Could not do that. Check your connection and try again.')
      return null
    }
    setNotice(out.message ?? null)
    router.refresh()
    return out
  }

  async function look() {
    const out = await act('imei_find', thread.trim() ? { thread: thread.trim() } : {})
    if (!out?.threadId) return
    const candidates = out.candidates ?? []
    setFound({ threadId: out.threadId, candidates })
    // Spreadsheets are the IMEI lists; ticked to start with, the rest left for you to choose.
    setPicked(new Set(candidates.filter((c) => c.kind === 'imei').slice(0, 1).map(key)))
  }

  async function keep() {
    if (!found) return
    const picks = found.candidates.filter((c) => picked.has(key(c))).map((c) => ({ messageId: c.messageId, attachmentId: c.attachmentId }))
    const out = await act('imei_attach', { thread: found.threadId, picks })
    if (out) setFound(null)
  }

  return (
    <div className="space-y-2" data-testid="imei-block">
      {imei && imei.sent?.state === 'done' ? (
        <p data-testid="imei-sent">{imei.sent.how === 'with_invoice' ? 'Sent with the invoice' : 'Sent in the same thread as the invoice'} to {imei.sent.to} {ukTime(imei.sent.at)}: {imei.files.map((x) => x.filename).join(', ')}.</p>
      ) : imei ? (
        <>
          <ul className="list-disc pl-5" data-testid="imei-files">
            {imei.files.map((x) => <li key={key(x)}>{x.filename} · {KIND[x.kind]} · {kb(x.size)}</li>)}
          </ul>
          {imei.sent?.state === 'failed' && <p className="text-warn" data-testid="imei-reason">{imei.sent.reason}</p>}
          {!invoiceSent ? (
            <p data-testid="imei-with-invoice">These go with the invoice email when you send it.</p>
          ) : (
            <>
              {sendHint && <p data-testid="imei-hint">{sendHint}</p>}
              <label className="flex items-start gap-2"><input type="checkbox" checked={tick} onChange={(e) => setTick(e.target.checked)} /><span>These files may be emailed to the client now (a reply in the invoice&apos;s email thread).</span></label>
              <Button size="sm" variant="primary" disabled={busy !== null || !tick || !!sendHint} onClick={() => act('imei_send', { confirm: tick })} data-testid="imei-send-button">{busy === 'imei_send' ? 'Sending…' : 'Send IMEI files to the client'}</Button>
            </>
          )}
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act('imei_clear')} data-testid="imei-clear-button">Remove this choice</Button>
        </>
      ) : (
        <p>Not chosen yet. Mobile One sends the IMEI list by email, with the invoice or a few days later.</p>
      )}

      {!(imei && imei.sent?.state === 'done') && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={look} data-testid="imei-find-button">{busy === 'imei_find' ? 'Looking…' : imei ? 'Choose other files' : "Find them in Mobile One's email"}</Button>
            <input value={thread} onChange={(e) => setThread(e.target.value)} placeholder="Or paste a Gmail link" aria-label="Gmail link of the email with the files" className="min-w-[14rem] flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[13px]" data-testid="imei-thread-input" />
          </div>
          {found && (
            <div className="space-y-1" data-testid="imei-candidates">
              {found.candidates.length === 0 ? <p>No files from Mobile One in that thread yet.</p> : (
                <>
                  {found.candidates.map((c) => (
                    <label key={key(c)} className="flex items-start gap-2" data-testid="imei-candidate">
                      <input type="checkbox" checked={picked.has(key(c))} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(key(c)); else n.delete(key(c)); setPicked(n) }} />
                      <span>{c.filename} · {KIND[c.kind]} · {kb(c.size)} · {ukTime(c.receivedAt)}<span className="block text-[12.5px] text-ink-3">{c.subject}</span></span>
                    </label>
                  ))}
                  <Button size="sm" variant="primary" disabled={busy !== null || picked.size === 0} onClick={keep} data-testid="imei-keep-button">{busy === 'imei_attach' ? 'Saving…' : 'Use the ticked files'}</Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {notice && <p role="status" className="text-gain" data-testid="imei-notice">{notice}</p>}
      {error && <p role="alert" className="text-loss">{error}</p>}
    </div>
  )
}
