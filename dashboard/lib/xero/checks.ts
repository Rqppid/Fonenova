/**
 * The Xero mismatch alarm: compares what the ledger and the paired documents say with what Xero
 * holds right now, and turns every gap into a "Needs attention" item. Pure, so it is tested
 * against the real cases found by hand (the missing Mobile One credits, the €378 over-credit,
 * invoice 2026022 missing its discount, bill 2026020014 left unpaid).
 *
 * Because these checks are live, they replace the ledger's own Exceptions-tab rows about Xero:
 * those were written once and would otherwise stay on screen after the fix is made in Xero.
 */
import type { AttentionItem } from '../attention'
import type { Cents, CreditNote, IsoDate, Ledger, LedgerException, Order, XeroCreditNote, XeroInvoice, XeroSnapshot } from '../types'
import { matchOrders } from './map'
import { xeroLink } from './pairing'

/** Differences under a euro are rounding, not a mistake. */
const TOLERANCE = 100
const DRAFT_DAYS = 7
/** Unpaid bills at or above this get their own line in the list. */
const BIG_BILL = 10_000_00

const norm = (s: string) => s.trim().toLowerCase()
const eur = (c: Cents) => `€${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const daysBetween = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const live = (i: XeroInvoice) => i.currency === 'EUR' && !['VOIDED', 'DELETED'].includes(i.status)
const liveNote = (n: XeroCreditNote) => n.currency === 'EUR' && ['AUTHORISED', 'PAID'].includes(n.status)

/** Invoice numbers a ledger credit note names: "2026050049, 2026070068 & 2026070069". */
export function referencedInvoices(text: string): string[] {
  return [...new Set((text.match(/[A-Z0-9][A-Z0-9/-]{4,}/gi) ?? []).filter((t) => /\d{5,}/.test(t)))]
}

/** How much of a Xero credit note went to each invoice. Old snapshots without amounts split it evenly. */
function allocationsOf(n: XeroCreditNote): { invoiceNumber: string; amountCents: Cents }[] {
  if (n.allocations) return n.allocations
  if (!n.allocatedTo.length) return []
  const each = Math.round(n.totalCents / n.allocatedTo.length)
  return n.allocatedTo.map((invoiceNumber) => ({ invoiceNumber, amountCents: each }))
}

interface CreditGap {
  note: CreditNote
  /** Positive: Xero is missing this much credit. Negative: Xero credits this much too much. */
  gapCents: Cents
  creditedCents: Cents
  invoices: string[]
}

/**
 * Each ledger credit note against the Xero credits allocated to the invoices it names. A Xero
 * credit that covers several ledger notes at once (the €31,783 on invoice 2026033 is three client
 * memos) is matched by amount before anything is reported as missing.
 */
export function creditGaps(ledgerNotes: readonly CreditNote[], xeroNotes: readonly XeroCreditNote[]): CreditGap[] {
  const notes = xeroNotes.filter(liveNote)
  const usedXero = new Set<string>()
  const credited = new Map<string, Cents>() // `${kind}:${invoice}` -> credited amount
  for (const n of notes) {
    for (const a of allocationsOf(n)) {
      const k = `${n.kind}:${norm(a.invoiceNumber)}`
      credited.set(k, (credited.get(k) ?? 0) + a.amountCents)
    }
  }
  const gaps: CreditGap[] = []
  for (const note of ledgerNotes) {
    const kind = note.side === 'client' ? 'sale' : 'bill'
    const invoices = referencedInvoices(note.refersToInvoices)
    if (!invoices.length) continue
    const got = invoices.reduce((s, i) => s + (credited.get(`${kind}:${norm(i)}`) ?? 0), 0)
    for (const n of notes) if (n.kind === kind && allocationsOf(n).some((a) => invoices.some((i) => norm(i) === norm(a.invoiceNumber)))) usedXero.add(n.id)
    gaps.push({ note, gapCents: note.amountCents - got, creditedCents: got, invoices })
  }

  // Notes still short: a single unused Xero credit of the same amount, or one equal to the sum
  // of several short notes from the same side and date, means Xero holds them under other invoices.
  const free = notes.filter((n) => !usedXero.has(n.id))
  const short = gaps.filter((g) => g.gapCents > TOLERANCE && g.creditedCents === 0)
  const settled = new Set<CreditGap>()
  for (const x of free) {
    const kind = x.kind === 'sale' ? 'client' : 'supplier'
    const pool = short.filter((g) => !settled.has(g) && g.note.side === kind)
    const single = pool.find((g) => Math.abs(g.note.amountCents - x.totalCents) <= TOLERANCE)
    if (single) {
      settled.add(single)
      continue
    }
    const group = subsetSum(pool.filter((g) => !x.date || g.note.date === x.date || Math.abs(daysBetween(g.note.date, x.date)) <= 7), x.totalCents)
    group?.forEach((g) => settled.add(g))
  }
  // A credit applied to another of the same customer's invoices shows as one note short and
  // another over by the same amount (FN-CN-202601's €44,804 sits on 2026037, not 2026034): moved, not missing.
  const open = gaps.filter((g) => !settled.has(g) && Math.abs(g.gapCents) > TOLERANCE)
  for (const s of open.filter((g) => g.gapCents > 0)) {
    const o = open.find((g) => g !== s && !settled.has(g) && g.note.side === s.note.side && g.gapCents < 0 && Math.abs(s.gapCents + g.gapCents) <= TOLERANCE)
    if (o) {
      settled.add(s)
      settled.add(o)
    }
  }
  return open.filter((g) => !settled.has(g))
}

/** A set of gaps whose note amounts add up to `total` (small sets only: a handful of credit notes). */
function subsetSum(pool: CreditGap[], total: Cents): CreditGap[] | null {
  const items = pool.slice(0, 12)
  for (let mask = 1; mask < 1 << items.length; mask++) {
    let sum = 0
    const pick: CreditGap[] = []
    items.forEach((g, i) => {
      if (mask & (1 << i)) {
        sum += g.note.amountCents
        pick.push(g)
      }
    })
    if (pick.length > 1 && Math.abs(sum - total) <= TOLERANCE) return pick
  }
  return null
}

export interface XeroChecks {
  items: AttentionItem[]
  /** Ledger Exceptions-tab rows these live checks replace. */
  supersedes: string[]
}

export function xeroChecks(args: { ledger: Ledger; orders: readonly Order[]; snapshot: XeroSnapshot | null; today: IsoDate }): XeroChecks {
  const { snapshot, today } = args
  if (!snapshot) return { items: [], supersedes: [] }
  const items: AttentionItem[] = []
  const invoices = snapshot.invoices.filter(live)
  const links = matchOrders(args.orders, invoices)
  const byNumber = new Map(invoices.map((i) => [`${i.kind}:${norm(i.number)}`, i]))

  // 1 and 2. Credit notes missing, short or over-allocated.
  if (snapshot.creditNotes) {
    for (const g of creditGaps(args.ledger.creditNotes, snapshot.creditNotes)) {
      const who = g.note.side === 'client' ? 'Client credit memo' : 'Supplier credit note'
      const first = byNumber.get(`${g.note.side === 'client' ? 'sale' : 'bill'}:${norm(g.invoices[0])}`)
      const over = g.gapCents < 0
      items.push({
        id: `X-CREDIT-${g.note.number}`,
        priority: Math.abs(g.gapCents) >= 1_000_00 ? 'HIGH' : 'MEDIUM',
        source: 'Xero check',
        reference: `${who} ${g.note.number}`,
        orderId: g.note.orderIds.length === 1 ? g.note.orderIds[0] : null,
        orderIds: g.note.orderIds,
        issue: over
          ? `Xero credits ${eur(g.creditedCents)} against ${g.invoices.join(', ')}, but the credit note is only ${eur(g.note.amountCents)}: ${eur(-g.gapCents)} too much.`
          : g.creditedCents === 0
            ? `${eur(g.note.amountCents)} credit (${g.note.date}) against ${g.invoices.join(', ')} is not in Xero at all.`
            : `Only ${eur(g.creditedCents)} of the ${eur(g.note.amountCents)} credit (${g.note.date}) is in Xero against ${g.invoices.join(', ')}: ${eur(g.gapCents)} missing.`,
        impactCents: Math.abs(g.gapCents),
        impactLabel: over ? 'Over-credited' : 'Missing in Xero',
        action: over
          ? 'Reduce the allocation in Xero so it matches the credit note PDF.'
          : g.note.side === 'supplier'
            ? 'Enter it in Xero as a supplier credit note and allocate it to the bill, or match it to the refund in Revolut. Until then Xero overstates what you owe.'
            : 'Check whether it was applied to a later invoice or refunded, then record it in Xero.',
        ...(first ? { link: xeroLink(first) } : {}),
      })
    }
  }

  // 3. Ledger order totals that no longer match the Xero document.
  for (const o of args.orders) {
    if (o.source === 'xero') continue
    const l = links.get(o.id)
    for (const [doc, ledgerTotal, side] of [
      [l?.client, o.clientTotalCents, 'Client invoice'],
      [l?.bill, o.supplierTotalCents, 'Supplier bill'],
    ] as const) {
      if (!doc || Math.abs(doc.totalCents - ledgerTotal) <= TOLERANCE) continue
      const diff = doc.totalCents - ledgerTotal
      items.push({
        id: `X-TOTAL-${o.id}-${doc.kind}`,
        priority: Math.abs(diff) >= 1_000_00 ? 'HIGH' : 'MEDIUM',
        source: 'Xero check',
        reference: `${o.id} / ${doc.kind === 'sale' ? 'invoice' : 'bill'} ${doc.number}`,
        orderId: o.id,
        orderIds: [o.id],
        issue: `${side} is ${eur(doc.totalCents)} in Xero but ${eur(ledgerTotal)} in the ledger (the agreed document): ${eur(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} in Xero.`,
        impactCents: Math.abs(diff),
        impactLabel: 'Difference',
        action: doc.kind === 'sale'
          ? diff > 0 ? 'Add the missing discount in Xero as a credit note (draft, do not email it).' : 'Check the invoice in Xero against the PDF sent to the client.'
          : 'Check the bill in Xero against the supplier PDF.',
        link: xeroLink(doc),
      })
    }
  }

  // 5. Supplier bills unpaid past their due date.
  const orderOfBill = new Map<string, { order: Order; client: XeroInvoice | null }>()
  for (const o of args.orders) {
    const l = links.get(o.id)
    if (l?.bill) orderOfBill.set(l.bill.id, { order: o, client: l.client })
  }
  const smallBills: { b: XeroInvoice; late: number }[] = []
  for (const b of invoices) {
    if (b.kind !== 'bill' || b.status === 'DRAFT' || b.amountDueCents <= 0 || !b.dueDate) continue
    const late = daysBetween(b.dueDate, today)
    if (late <= 0) continue
    const link = orderOfBill.get(b.id)
    const clientPaid = link?.client?.status === 'PAID'
    const noInvoice = link ? !link.client : false
    if (!clientPaid && !noInvoice && late < 14) continue // ordinary terms slack; long overdue still shows below
    // Large or clear-cut ones get their own line; small remainders (often a credit or payment
    // not recorded) are grouped below, so they don't bury everything else.
    if (!noInvoice && b.amountDueCents < BIG_BILL) {
      smallBills.push({ b, late })
      continue
    }
    items.push({
      id: `X-BILL-${b.id}`,
      priority: clientPaid || noInvoice || late >= 30 ? 'HIGH' : 'MEDIUM',
      source: 'Xero check',
      reference: `${link ? `${link.order.id} / ` : ''}bill ${b.number || b.reference}`,
      orderId: link?.order.id ?? null,
      orderIds: link ? [link.order.id] : [],
      issue: `${b.contactName} bill ${eur(b.amountDueCents)} unpaid in Xero, ${late} days past its due date (${b.dueDate}).${clientPaid ? ' The client has already paid this order.' : ''}${noInvoice ? ' Its client invoice is not in Xero.' : ''}`,
      impactCents: b.amountDueCents,
      impactLabel: 'Unpaid',
      action: 'If it was paid, record the payment in Xero (check Revolut). If not, it is genuinely owed.',
      link: xeroLink(b),
    })
  }

  if (smallBills.length) {
    const total = smallBills.reduce((n, x) => n + x.b.amountDueCents, 0)
    const list = smallBills.sort((a, b) => b.b.amountDueCents - a.b.amountDueCents)
    items.push({
      id: 'X-BILLS-SMALL',
      priority: 'MEDIUM',
      source: 'Xero check',
      reference: `${smallBills.length} supplier bill${smallBills.length > 1 ? 's' : ''} part-unpaid`,
      orderId: null,
      orderIds: list.map((x) => orderOfBill.get(x.b.id)?.order.id).filter((id): id is string => !!id),
      issue: `Unpaid in Xero past their due date: ${list.map((x) => `${x.b.number || x.b.reference} ${eur(x.b.amountDueCents)} (${x.late} days)`).join(', ')}.`,
      impactCents: total,
      impactLabel: 'Unpaid in Xero',
      action: 'Usually a payment or credit that was never recorded in Xero. Match each against Revolut; record it, or pay what is genuinely owed.',
    })
  }

  // 6. Synced drafts left waiting.
  for (const d of invoices) {
    if (d.status !== 'DRAFT' || !d.date) continue
    const age = daysBetween(d.date, today)
    if (age <= DRAFT_DAYS) continue
    items.push({
      id: `X-DRAFT-${d.id}`,
      priority: 'MEDIUM',
      source: 'Xero check',
      reference: `${d.kind === 'sale' ? 'Invoice' : 'Bill'} ${d.number || d.reference}`,
      orderId: null,
      orderIds: [],
      issue: `Still a draft in Xero after ${age} days (${d.contactName}, ${d.date}). Drafts do not count in Xero's own reports.`,
      impactCents: d.totalCents,
      impactLabel: 'Draft total',
      action: 'Check it against the PDF, then Approve in Xero (never email it from Xero).',
      link: xeroLink(d),
    })
  }

  // 7. Draft credit notes: a duplicate of a credit already in Xero would double the credit if
  // approved (Make's number check misses one Xero holds under another number, e.g. CN-202602
  // vs FN-CN-202602). Others are nudged like any draft once they are a week old.
  if (snapshot.creditNotes) {
    const live = snapshot.creditNotes.filter(liveNote)
    const missing = new Set(creditGaps(args.ledger.creditNotes, snapshot.creditNotes).map((g) => g.note.number))
    for (const d of snapshot.creditNotes.filter((n) => n.status === 'DRAFT' && n.currency === 'EUR')) {
      const side = d.kind === 'sale' ? 'client' : 'supplier'
      const same = (c: number) => Math.abs(c - d.totalCents) <= TOLERANCE
      const inXero = live.find((n) => n.kind === d.kind && same(n.totalCents) && (!n.contactName || !d.contactName || norm(n.contactName) === norm(d.contactName)))
      // A ledger credit only counts as "already in Xero" when the gap check does not report it missing.
      const inLedger = args.ledger.creditNotes.find((n) => n.side === side && same(n.amountCents) && !missing.has(n.number))
      const twin = inXero ? `credit note ${inXero.number}${inXero.allocatedTo.length ? `, already applied to ${inXero.allocatedTo.join(', ')}` : ''}` : inLedger ? `credit ${inLedger.number} (${inLedger.date}), which Xero already holds against ${inLedger.refersToInvoices}` : null
      if (twin) {
        items.push({
          id: `X-CNDUP-${d.id}`,
          priority: 'HIGH',
          source: 'Xero check',
          reference: `Draft credit note ${d.number || d.reference}`,
          orderId: null,
          orderIds: [],
          issue: `Draft ${d.number || d.reference} (${eur(d.totalCents)}, ${d.contactName}) duplicates ${twin}. Approving it would count the same credit twice.`,
          impactCents: d.totalCents,
          impactLabel: 'Would be doubled',
          action: 'Delete the draft in Xero. Do not approve it.',
          link: creditNoteLink(d),
        })
        continue
      }
      const age = d.date ? daysBetween(d.date, today) : 0
      if (age <= DRAFT_DAYS) continue
      items.push({
        id: `X-CNDRAFT-${d.id}`,
        priority: 'MEDIUM',
        source: 'Xero check',
        reference: `Draft credit note ${d.number || d.reference}`,
        orderId: null,
        orderIds: [],
        issue: `Still a draft after ${age} days (${d.contactName}, ${eur(d.totalCents)}). Until approved, Xero overstates what ${d.kind === 'bill' ? 'you owe the supplier' : 'the customer owes you'}.`,
        impactCents: d.totalCents,
        impactLabel: 'Draft total',
        action: 'Check it against the PDF, approve it, then allocate it to the invoice it names.',
        link: creditNoteLink(d),
      })
    }
  }

  return { items, supersedes: superseded(args.ledger.exceptions, args.orders, links, !!snapshot.creditNotes) }
}

/** Where to open a credit note in Xero. */
function creditNoteLink(n: Pick<XeroCreditNote, 'id' | 'kind'>): string {
  return `https://go.xero.com/${n.kind === 'sale' ? 'AccountsReceivable' : 'AccountsPayable'}/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(n.id)}`
}

/**
 * Exceptions-tab rows about Xero records that the live checks now cover: a row on an order whose
 * documents Xero returned, or the credit-notes row once Xero's credit notes are read. When the
 * fix is made in Xero, the live check clears and nothing stale is left behind.
 */
function superseded(exceptions: readonly LedgerException[], orders: readonly Order[], links: ReturnType<typeof matchOrders>, haveCredits: boolean): string[] {
  const known = new Set(orders.map((o) => o.id))
  return exceptions
    .filter((e) => /xero/i.test(e.issue + e.suggestedAction))
    .filter((e) => {
      if (!e.orderId) return haveCredits && /credit/i.test(e.reference + e.issue)
      const l = known.has(e.orderId) ? links.get(e.orderId) : undefined
      return !!(l?.client || l?.bill)
    })
    .map((e) => e.id)
}
