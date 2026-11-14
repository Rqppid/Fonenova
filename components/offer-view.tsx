"use client"

import { useState } from "react"
import { eur, ukTime, MAX_REMARKS, type OfferState } from "@/lib/offers-format"

export interface OfferViewData {
  token: string
  state: OfferState
  clientName: string
  lines: { description: string; qty: number; unitSaleCents: number }[]
  units: number
  totalCents: number
  expiresAt: string
  test: boolean
  answer: { decision: "accept" | "decline"; at: string; remarks: string } | null
}

const ERRORS: Record<string, string> = {
  answered: "This offer has already been answered.",
  expired: "This offer has expired.",
  withdrawn: "This offer is no longer available.",
  rate: "Too many attempts. Please wait a few minutes and try again.",
  remarks: `Please keep your remarks under ${MAX_REMARKS} characters.`,
  unavailable: "We could not save that just now. Please try again in a moment.",
}

/** The client's page: their offer, then accept (with a confirm step) or decline. Read-only once answered, expired or withdrawn. */
export function OfferView({ data }: { data: OfferViewData }) {
  const [step, setStep] = useState<"view" | "accept" | "decline">("view")
  const [remarks, setRemarks] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState(data.state)
  const [answer, setAnswer] = useState(data.answer)

  async function send(decision: "accept" | "decline") {
    setBusy(true)
    setError(null)
    const res = await fetch("/api/offer/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.token, decision, remarks, confirmed: decision === "accept" }),
    }).catch(() => null)
    const out = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string; at?: string } | null
    setBusy(false)
    if (res?.ok && out?.ok) {
      setAnswer({ decision, at: out.at ?? new Date().toISOString(), remarks })
      setState("answered")
      return
    }
    if (out?.error === "answered" || out?.error === "expired" || out?.error === "withdrawn") {
      // Someone (or another tab) got there first: show the real state.
      window.location.reload()
      return
    }
    setError(ERRORS[out?.error ?? ""] ?? ERRORS.unavailable)
  }

  const open = state === "open"
  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <p className="font-mono text-sm font-bold tracking-tight text-primary">FoneNova</p>
        <h1 className="mt-1 font-mono text-2xl font-bold tracking-tight sm:text-3xl">Offer for {data.clientName}</h1>
        {data.test && <p className="mt-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">This is a test offer.</p>}

        {state === "expired" && <p role="status" className="mt-4 rounded-md border border-border bg-muted px-4 py-3 text-sm">This offer expired on {ukTime(data.expiresAt)}. Contact us at info@fonenova.com if you would still like it.</p>}
        {state === "withdrawn" && <p role="status" className="mt-4 rounded-md border border-border bg-muted px-4 py-3 text-sm">This offer is no longer available. Contact us at info@fonenova.com.</p>}
        {state === "answered" && answer && (
          <div role="status" className="mt-4 rounded-md border border-border bg-muted px-4 py-3 text-sm" data-testid="outcome">
            <p className="font-semibold">{answer.decision === "accept" ? "You accepted this offer" : "You declined this offer"} on {ukTime(answer.at)}.</p>
            <p className="mt-1 text-muted-foreground">{answer.decision === "accept" ? "Thank you. We will be in touch to confirm your order." : "Thank you for letting us know."}</p>
            {answer.remarks && <p className="mt-2 whitespace-pre-wrap">Your remarks: {answer.remarks}</p>}
          </div>
        )}

        <div className="mt-6 overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[460px] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="px-4 py-3 font-medium">Item</th><th className="px-3 py-3 text-right font-medium">Qty</th><th className="px-3 py-3 text-right font-medium">Unit price</th><th className="px-4 py-3 text-right font-medium">Total</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-4 py-3">{l.description}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{l.qty.toLocaleString("en-GB")}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{eur(l.unitSaleCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{eur(l.qty * l.unitSaleCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold"><td className="px-4 py-3">Total</td><td className="px-3 py-3 text-right tabular-nums">{data.units.toLocaleString("en-GB")}</td><td /><td className="px-4 py-3 text-right tabular-nums">{eur(data.totalCents)}</td></tr>
            </tfoot>
          </table>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          All prices in euros. Subject to availability. {open ? <>Prices are valid until <strong className="font-semibold text-foreground">{ukTime(data.expiresAt)}</strong>.</> : "Prices were valid until " + ukTime(data.expiresAt) + "."} The offer is for all items together: it can be accepted or declined as a whole.
        </p>

        {open && step === "view" && (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => setStep("accept")} className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Accept offer</button>
            <button type="button" onClick={() => setStep("decline")} className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-background px-6 text-sm font-semibold hover:bg-muted">Decline</button>
          </div>
        )}

        {open && step !== "view" && (
          <section aria-labelledby="confirm-title" className="mt-6 rounded-xl border border-border bg-card p-5" data-testid="confirm">
            <h2 id="confirm-title" className="font-mono text-lg font-bold tracking-tight">
              {step === "accept" ? `Confirm order for ${data.units.toLocaleString("en-GB")} units, ${eur(data.totalCents)}?` : "Decline this offer?"}
            </h2>
            <label className="mt-4 block text-sm">
              <span className="mb-1 block font-medium">{step === "accept" ? "Remarks (optional)" : "Anything we should know? (optional)"}</span>
              <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={MAX_REMARKS} rows={4} placeholder={step === "decline" ? "e.g. price too high on the S25" : ""} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              <span className="mt-1 block text-xs text-muted-foreground">{remarks.length} / {MAX_REMARKS}</span>
            </label>
            {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button type="button" disabled={busy} onClick={() => send(step === "accept" ? "accept" : "decline")} className="inline-flex h-11 flex-1 items-center justify-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {busy ? "Sending…" : step === "accept" ? "Yes, confirm order" : "Yes, decline"}
              </button>
              <button type="button" disabled={busy} onClick={() => { setStep("view"); setError(null) }} className="inline-flex h-11 flex-1 items-center justify-center rounded-md border border-border bg-background px-6 text-sm font-semibold hover:bg-muted disabled:opacity-50">Go back</button>
            </div>
          </section>
        )}

        <p className="mt-10 text-xs text-muted-foreground">FoneNova Ltd · info@fonenova.com · Please do not forward this link: it can only be answered once.</p>
      </div>
    </main>
  )
}
