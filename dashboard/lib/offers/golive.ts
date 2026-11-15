/**
 * The go-live checklist (phase 6): what has to be true before real clients get offers and real
 * invoices come from Quay Pilot instead of Invoice2go. The first group is checked from the live
 * state (nothing to tick); the second group is things only you can confirm, ticked by hand and
 * remembered. Pure: the page feeds it the facts.
 */
import type { Client } from './clients'
import type { DraftSettings } from './draft'
import type { Offer } from './types'

export type CheckStatus = 'ok' | 'todo' | 'warn'
export interface Check { id: string; group: 'system' | 'clients' | 'manual'; title: string; status: CheckStatus; detail: string }

export interface GoLiveFacts {
  xero: { configured: boolean; connected: boolean; isDemo: boolean | null; orgName: string | null }
  flags: { allowLiveXero: boolean; allowReal: boolean; allowApprove: boolean; filingConfigured: boolean }
  gmail: { connected: boolean; canRead: boolean }
  oneDrive: { connected: boolean; canWrite: boolean }
  telegram: boolean
  settings: DraftSettings
  clients: readonly Client[]
  offers: readonly Offer[]
  /** The manual items ticked so far. */
  ticks: Readonly<Record<string, string>>
}

export const MANUAL_ITEMS: { id: string; title: string; detail: string }[] = [
  { id: 'contacts_complete', title: 'Every real client contact in Xero is complete', detail: 'Postal address (and a street address if "Ship To" is wanted), a VAT number if one applies, and the registration number in the contact\'s Account Number field (the template prints it).' },
  { id: 'company_details', title: 'Company name and address on the invoice template match Companies House', detail: 'Open an approved invoice preview in Xero and read the header and footer.' },
  { id: 'real_client_test', title: 'The first real offer will be checked at every step', detail: 'Real client, real Mobile One offer: check the draft in Xero before approving, then approve, then send.' },
  { id: 'accountant_told', title: 'Accountant told about the three non-invoice numbers (2026048 deleted, 2026049 voided, 2026050 deleted)', detail: 'And marked 2026048 and 2026050 "not used" in Settings so the watchdog stays quiet.' },
  { id: 'invoice2go_bcc_off', title: 'Invoice2go: stop issuing from it, and its Bcc to Make is off', detail: 'Its numbers would clash with Xero\'s. Do this on the day the first real invoice comes from here.' },
  { id: 'make_webhooks_off', title: 'Make Integration Webhooks turned off', detail: 'Only after a clean month with no missed invoices.' },
  { id: 'test_clutter_cleared', title: 'Test emails and test contacts cleared out', detail: 'The [TEST] emails in info@fonenova.com, and the test contact in live Xero if you no longer need it.' },
]

export function goLiveChecks(f: GoLiveFacts): Check[] {
  const out: Check[] = []
  const add = (c: Check) => out.push(c)
  const real = f.clients.filter((c) => !c.test)

  add({ id: 'xero_write', group: 'system', title: 'Xero write connection', status: f.xero.connected ? 'ok' : 'todo', detail: f.xero.connected ? `Connected${f.xero.orgName ? `; drafts go to ${f.xero.orgName}` : ' (no organisation chosen yet)'}.` : 'Not connected (Settings, Xero draft invoices).' })
  add({ id: 'xero_live_selected', group: 'system', title: 'Live organisation chosen for drafts', status: f.xero.isDemo === false ? 'ok' : 'todo', detail: f.xero.isDemo === false ? `Drafts go to ${f.xero.orgName}.` : 'Choose Fonenova Ltd (live) on the Settings card: a deliberate step of its own.' })
  add({ id: 'switch_live_drafts', group: 'system', title: 'Live drafts switched on (XERO_WRITE_ALLOW_LIVE)', status: f.flags.allowLiveXero ? 'ok' : 'todo', detail: f.flags.allowLiveXero ? 'On.' : 'Off: nothing is created in the live organisation.' })
  add({ id: 'switch_approve', group: 'system', title: 'Approving in live switched on (OFFERS_ALLOW_APPROVE)', status: f.flags.allowApprove ? 'ok' : 'todo', detail: f.flags.allowApprove ? 'On.' : 'Off: invoices stay drafts until you switch it on. A separate step from sending.' })
  add({ id: 'switch_real_send', group: 'system', title: 'Real client sending (OFFERS_ALLOW_REAL_SEND)', status: f.flags.allowReal ? 'ok' : 'todo', detail: f.flags.allowReal ? 'On: real clients can receive offers and invoices.' : 'Off. Switch it on only when you decide to go live; it is separate from the Xero switches.' })
  add({ id: 'branding_theme', group: 'system', title: 'Invoice branding theme chosen', status: f.settings.brandingThemeId ? 'ok' : 'warn', detail: f.settings.brandingThemeId ? 'A theme is set on the Settings card.' : 'Xero\'s default theme would be used. Pick the margin-scheme theme by name.' })
  add({ id: 'gmail', group: 'system', title: 'Gmail connected (reads Mobile One, sends offers and notices)', status: f.gmail.connected && f.gmail.canRead ? 'ok' : 'todo', detail: f.gmail.connected ? (f.gmail.canRead ? 'Connected.' : 'Send-only: reconnect to allow reading.') : 'Not connected.' })
  add({ id: 'telegram', group: 'system', title: 'Telegram alerts', status: f.telegram ? 'ok' : 'warn', detail: f.telegram ? 'Set up.' : 'Not set up: "Invoice ready" pings will not arrive.' })
  add({ id: 'onedrive', group: 'system', title: 'OneDrive filing of invoice PDFs', status: f.flags.filingConfigured && f.oneDrive.connected && f.oneDrive.canWrite ? 'ok' : 'warn', detail: !f.flags.filingConfigured ? 'INVOICE_FILING_DIRS is not set: PDFs are not filed (save them from Xero by hand).' : !f.oneDrive.connected ? 'OneDrive is not connected.' : !f.oneDrive.canWrite ? 'OneDrive has no write access: reconnect it.' : 'Ready.' })

  const tested = f.offers.some((o) => o.fulfilment?.test && o.fulfilment.draft.state === 'done' && o.fulfilment.approve?.state === 'done' && o.fulfilment.send?.state === 'done')
  const drafted = f.offers.some((o) => o.fulfilment?.test && o.fulfilment.draft.state === 'done')
  add({ id: 'demo_journey', group: 'system', title: 'A whole test journey has been run (offer, accept, draft, approve, send)', status: tested ? 'ok' : drafted ? 'warn' : 'todo', detail: tested ? 'A test offer went all the way through in the Demo Company.' : drafted ? 'Drafts work; approve and send have not been tried on a test offer in the Demo Company yet.' : 'No test offer has produced a draft yet.' })

  if (real.length === 0) add({ id: 'real_clients', group: 'clients', title: 'Real clients', status: 'todo', detail: 'No real client yet (Offers, Clients).' })
  for (const c of real) {
    const problems = [
      !c.termsConfirmed && 'payment terms not chosen',
      !c.xeroContactId && 'no Xero ContactID',
      c.offerEmails.length === 0 && 'no offer email',
      c.invoiceEmails.length === 0 && 'no invoice email',
    ].filter(Boolean) as string[]
    add({ id: `client_${c.id}`, group: 'clients', title: c.name, status: problems.length ? 'todo' : 'ok', detail: problems.length ? `Missing: ${problems.join(', ')}.` : `Ready: ${c.terms === 'upfront' ? 'pays upfront' : `${(c.terms as { days: number }).days} days`}, shipping x ${c.shippingMultiplier ?? 2}.` })
  }

  for (const m of MANUAL_ITEMS) add({ id: m.id, group: 'manual', title: m.title, status: f.ticks[m.id] ? 'ok' : 'todo', detail: f.ticks[m.id] ? `Ticked ${f.ticks[m.id].slice(0, 10)}.` : m.detail })
  return out
}

/** Ready to switch real sending on: every system and client check ok (warnings allowed), every manual item ticked. */
export const readyToGoLive = (checks: readonly Check[]): boolean => checks.every((c) => (c.group === 'system' && c.id === 'switch_real_send' ? true : c.status !== 'todo'))
