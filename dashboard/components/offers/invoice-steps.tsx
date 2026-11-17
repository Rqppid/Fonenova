'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CircleAlert, CircleCheck, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImeiBlock } from '@/components/offers/imei-row'
import { ukTime } from '@/lib/format-uk'
import type { BillCandidate } from '@/lib/offers/invoice-flow'
import type { Offer } from '@/lib/offers/types'
import { cn } from '@/lib/utils'

const eur = (c: number) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** What the screen needs to say about the switches and connections behind the invoice steps. */
export interface InvoiceSetup {
  /** OFFERS_ALLOW_APPROVE: approving in a live organisation. */
  allowApprove: boolean
  /** OFFERS_ALLOW_REAL_SEND. */
  allowReal: boolean
  /** XERO_WRITE_ALLOW_LIVE. */
  allowLiveXero: boolean
  /** INVOICE_FILING_DIRS is set. */
  filingConfigured: boolean
  /** Whether the organisation drafts go to is a live one (null when none is chosen). */
  orgIsLive: boolean | null
}

type Tone = 'ok' | 'wait' | 'bad'
const ICON = { ok: CircleCheck, wait: Clock, bad: CircleAlert }
const TONE: Record<Tone, string> = { ok: 'text-gain', wait: 'text-ink-2', bad: 'text-warn' }

function Row({ tone, title, children, testId }: { tone: Tone; title: string; children: React.ReactNode; testId: string }) {
  const Icon = ICON[tone]
  return (
    <li className="flex gap-2 py-2 text-[13px]" data-testid={testId}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE[tone])} aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-ink">{title}</p>
        <div className="text-ink-2">{children}</div>
      </div>
    </li>
  )
}

/**
 * After the draft exists: pair the supplier bill, approve, send, file the PDF. Each is a separate
 * click with its own tick box; nothing here happens by itself, and the server checks everything again.
 */
export function InvoiceSteps({ offer, setup, bills = [] }: { offer: Offer; setup?: InvoiceSetup; bills?: BillCandidate[] }) {
  const router = useRouter()
  const f = offer.fulfilment
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** What the last action answered when it worked, so a click is never silent (the re-check used to show nothing). */
  const [notice, setNotice] = useState<string | null>(null)
  const [ticks, setTicks] = useState({ approve: false, send: false })
  if (!f || f.draft.state !== 'done') return null

  async function act(action: string, extra: object = {}) {
    setBusy(action)
    setError(null)
    setNotice(null)
    const res = await fetch('/api/offers', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id: offer.id, ...extra }) }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; message?: string } | null
    setBusy(null)
    if (res?.ok && out?.ok) setNotice(out.message ?? null)
    else setError(out?.error ?? 'Could not do that. Check your connection and try again.')
    router.refresh()
  }

  const live = setup?.orgIsLive === true
  const approve = f.approve
  const send = f.send
  const filing = f.filing
  const real = /^FN-ORD-\d{3,}$/.test(f.orderRef)
  const approveHint = live && f.test ? 'A test invoice is never approved in the live organisation.' : live && !setup?.allowLiveXero ? 'Live Xero is switched off (XERO_WRITE_ALLOW_LIVE).' : live && !setup?.allowApprove ? 'Approving in the live organisation is its own switch (OFFERS_ALLOW_APPROVE) and it is not on.' : null
  const sendHint = live && f.test ? 'A test invoice is never sent from the live organisation.' : live && !setup?.allowReal ? 'Sending to real clients is switched off (OFFERS_ALLOW_REAL_SEND).' : null

  return (
    <div className="space-y-2" data-testid="invoice-steps">
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-[13px] font-semibold text-ink">Invoice · {f.draft.invoiceNumber}</h4>
        {approve?.state !== 'done' && <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act('draft_recheck')} data-testid="recheck-button">{busy === 'draft_recheck' ? 'Checking…' : 'Re-check in Xero'}</Button>}
      </div>
      <ul className="divide-y divide-line">
        {real && (
          <Row tone={f.bill ? 'ok' : 'wait'} title="Mobile One's bill" testId="step-bill">
            {f.bill ? (
              <p>Paired with {f.bill.supplier} bill {f.bill.billNumber} ({eur(f.bill.totalCents)}).</p>
            ) : bills.length === 0 ? (
              <p>No matching bill in Xero yet. It appears here once Mobile One has billed you and Xero has synced.</p>
            ) : (
              <ul className="space-y-1">
                {bills.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2" data-testid="bill-candidate">
                    <span>{b.supplier} · {b.number || 'no number'} · {b.date ?? 'no date'} · {eur(b.totalCents)} ({b.diffCents === 0 ? 'exact' : `${b.diffCents > 0 ? '+' : '-'}${eur(Math.abs(b.diffCents))} from the order cost`})</span>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('bill_confirm', { billId: b.id })}>{busy === 'bill_confirm' ? 'Pairing…' : 'Pair this bill'}</Button>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}

        {f.auto && (
          <Row tone={f.auto.state === 'done' ? 'ok' : f.auto.state === 'failed' || f.auto.state === 'blocked' ? 'bad' : 'wait'} title="Automatic invoicing" testId="step-auto">
            {f.auto.state === 'scheduled' ? (
              <>
                <p data-testid="auto-scheduled">Will be approved in Xero and emailed to the client at {ukTime(f.auto.dueAt)}, by itself. Check the draft in Xero before then.</p>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('auto_hold')} data-testid="auto-hold-button">{busy === 'auto_hold' ? 'Holding…' : 'Hold: do not send automatically'}</Button>
              </>
            ) : f.auto.state === 'running' ? (
              <p>Being approved and emailed now.</p>
            ) : f.auto.state === 'done' ? (
              <p>Approved and emailed automatically {f.auto.at ? ukTime(f.auto.at) : ''}.</p>
            ) : f.auto.state === 'held' ? (
              <>
                <p data-testid="auto-held">Held by you. Nothing is sent automatically; approve and send it yourself below, or let it run again.</p>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('auto_resume')} data-testid="auto-resume-button">{busy === 'auto_resume' ? 'Releasing…' : 'Release the hold (sends in 10 minutes)'}</Button>
              </>
            ) : (
              <p className="text-warn" data-testid="auto-reason">{f.auto.state === 'failed' ? 'The automatic invoice stopped: ' : 'It will not go out by itself: '}{f.auto.reason}</p>
            )}
          </Row>
        )}

        <Row tone={approve?.state === 'done' ? 'ok' : approve?.state === 'blocked' || approve?.state === 'failed' ? 'bad' : 'wait'} title="Approve the invoice in Xero" testId="step-approve">
          {approve?.state === 'done' ? (
            <p>Approved {approve.at ? ukTime(approve.at) : ''}.{approve.detail ? ` ${approve.detail}` : ''}</p>
          ) : (
            <>
              {(approve?.state === 'blocked' || approve?.state === 'failed') && <p className="text-warn" data-testid="approve-reason">{approve.reason}</p>}
              {approveHint && <p data-testid="approve-hint">{approveHint}</p>}
              <label className="flex items-start gap-2"><input type="checkbox" checked={ticks.approve} onChange={(e) => setTicks({ ...ticks, approve: e.target.checked })} /><span>I have checked the draft in Xero (items, shipping, total, address).</span></label>
              <Button size="sm" variant="primary" disabled={busy !== null || !ticks.approve || !!approveHint} onClick={() => act('invoice_approve', { confirm: ticks.approve })} data-testid="approve-button">{busy === 'invoice_approve' ? 'Approving…' : 'Approve in Xero'}</Button>
            </>
          )}
        </Row>

        <Row tone={send?.state === 'done' ? 'ok' : send?.state === 'blocked' || send?.state === 'failed' ? 'bad' : 'wait'} title="Send the invoice to the client" testId="step-send">
          {send?.state === 'done' ? (
            <p data-testid="send-done">{send.detail?.includes('(Gmail') ? 'Emailed from info@fonenova.com' : 'Emailed by Xero'}{send.detail ? ` to ${send.detail}` : ''} {send.at ? ukTime(send.at) : ''}.</p>
          ) : approve?.state !== 'done' ? (
            <p>Approve it first.</p>
          ) : (
            <>
              {(send?.state === 'blocked' || send?.state === 'failed') && <p className="text-warn" data-testid="send-reason">{send.reason}</p>}
              {sendHint && <p data-testid="send-hint">{sendHint}</p>}
              <label className="flex items-start gap-2"><input type="checkbox" checked={ticks.send} onChange={(e) => setTicks({ ...ticks, send: e.target.checked })} /><span>This invoice may be emailed to the client now.</span></label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" disabled={busy !== null || !ticks.send || !!sendHint} onClick={() => act('invoice_send', { confirm: ticks.send, via: 'gmail' })} data-testid="send-gmail-button">{busy === 'invoice_send' ? 'Sending…' : 'Send with Gmail (PDF attached)'}</Button>
                <Button size="sm" variant="outline" disabled={busy !== null || !ticks.send || !!sendHint} onClick={() => act('invoice_send', { confirm: ticks.send, via: 'xero' })} data-testid="send-xero-button">Send with Xero email</Button>
              </div>
              <p className="text-[12.5px]">Gmail sends from info@fonenova.com to the client&apos;s invoice emails with the PDF attached. Xero email sends from Xero to the contact&apos;s own address (it must be one of the client&apos;s invoice emails). Use one, not both.</p>
            </>
          )}
        </Row>

        <Row tone={f.imei?.sent?.state === 'done' ? 'ok' : f.imei?.sent?.state === 'failed' ? 'bad' : 'wait'} title="IMEI list (from Mobile One)" testId="step-imei">
          <ImeiBlock offer={offer} sendHint={sendHint} />
        </Row>

        <Row tone={filing?.state === 'done' ? 'ok' : filing?.state === 'failed' || filing?.state === 'skipped' ? 'bad' : 'wait'} title="File the PDF on OneDrive" testId="step-filing">
          {filing?.state === 'done' ? (
            <p>Filed at <code>{filing.detail}</code>.{filing.reason ? ` ${filing.reason}` : ''}</p>
          ) : !setup?.filingConfigured ? (
            <p data-testid="filing-off">Not set up: the folders go in Vercel as <code>INVOICE_FILING_DIRS</code> (JSON with wave, telecom and other). Until then, save the PDF from Xero by hand.</p>
          ) : approve?.state !== 'done' ? (
            <p>Approve it first.</p>
          ) : (
            <>
              {filing?.reason && <p className="text-warn">{filing.reason}</p>}
              <p>It is filed by itself after sending; you can also file it now.</p>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act('invoice_file')} data-testid="file-button">{busy === 'invoice_file' ? 'Filing…' : 'File the PDF now'}</Button>
            </>
          )}
        </Row>
      </ul>
      {notice && <p role="status" className="text-[13px] text-gain" data-testid="invoice-notice">{notice}</p>}
      {error && <p role="alert" className="text-[13px] text-loss">{error}</p>}
    </div>
  )
}
