# Profit dashboard (mockup v1)

Internal gross profit overview for Fone Nova Ltd, built from `FoneNova_Order_Ledger.xlsx`.
Local only: no backend, auth or live integrations.

## Run it

```bash
cd dashboard
npm install
# put the real ledger at data/FoneNova_Order_Ledger.xlsx, then:
npm run import      # xlsx -> data/generated/ledger.json, runs reconciliation, exits 1 on any mismatch
npm run dev         # http://localhost:3100
npm test            # unit tests + to-the-cent reconciliation against the real import
```

To read the ledger where it already lives (for example the copy OneDrive syncs to the desktop)
instead of copying it into `data/`, set it once on Windows, then open a new terminal:

```powershell
setx FN_LEDGER_PATH "C:\Users\fonen\OneDrive\Desktop\FoneNova_Order_Ledger.xlsx"
```

The import prints which file it read and when that file was last saved.

Without the real file the app falls back to `data/sample/ledger.json` (fake data, `npm run sample`
regenerates it) and shows a "Sample data" banner on every screen.

## Privacy

Everything in `data/` is git-ignored except `data/sample/`. Full PDF paths are imported but
stripped on the server before data reaches the browser; the UI shows file names only.

## Structure

| Path | Role |
| --- | --- |
| `scripts/import-ledger.ts` | Reads the xlsx, validates headers, writes typed JSON, reconciles |
| `lib/types.ts` | Domain types (`Order`, `OrderLine`, `CreditNote`, `LedgerException`, `Customer`, `Supplier`) |
| `lib/metrics.ts` | Every calculation, in integer cents |
| `lib/periods.ts` | Presets, previous-period rules, chart buckets |
| `lib/data-source.ts` | `DataSource` interface + local-file adapter. A Xero adapter replaces this file's adapter only |
| `components/dashboard/*` | The overview screen |

## Rules baked in

- Money is integer cents end to end. Float noise from the spreadsheet is rounded once, at import.
- Headline profit is **gross**. Net profit is shown as not available until own shipping, fees and
  overheads exist in the data.
- Credit notes count in the period of their own date. A credit referencing several orders is never
  split; it is shown as unallocated at portfolio level.
- Period comparisons show only when both periods sit inside the ledger's coverage (first order month
  to the Xero snapshot date). Otherwise the UI says why there is no comparison.
- Xero statuses, balances and "overdue N days" text are a snapshot (4 Oct 2026) and are never
  recalculated from today's date.
- Margin bands follow the ledger: amber under 0.5%, red below zero.

## Known importer quirk

exceljs drops cached formula results equal to 0, so a formula cell with no cached result is read as 0.
The import prints how many cells this affected (60 in the current ledger, all verified as 0 with a
second parser). A formula that was genuinely never calculated would also read as 0, but the
reconciliation would then fail rather than pass silently.

## Hosting (dashboard.fonenova.com)

Separate Vercel project (`fonenova-dashboard`, root directory `dashboard/`), not the marketing site.

**Access.** Google sign-in, locked to one address. Every request passes `proxy.ts`, and the page
re-checks the session before loading any data. Sessions are signed cookies (12 hours). Missing
configuration in production locks everyone out; it never opens up.

| Variable | Purpose |
| --- | --- |
| `AUTH_ALLOWED_EMAIL` | The only Google account that can sign in |
| `AUTH_URL` | `https://dashboard.fonenova.com` (fixed OAuth redirect origin) |
| `AUTH_SECRET` | 32+ random characters; signs cookies. Changing it signs everyone out |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client, redirect URI `https://dashboard.fonenova.com/auth/callback` |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Online storage. Set automatically when you connect **Upstash Redis** (Vercel → Storage) to the project |
| `FN_STORE_KEY` | 32+ random characters. Everything saved online is compressed and AES-256-GCM encrypted with it, so Upstash only holds ciphertext. Changing it means connecting OneDrive and Xero again |
| `CRON_SECRET` | 16+ random characters. Vercel sends it to the daily sync; without it the sync route refuses everyone |
| `MS_CLIENT_ID` | Microsoft app for OneDrive (below). `MS_CLIENT_SECRET` is optional |
| `FN_ONEDRIVE_LEDGER` | The ledger's place in OneDrive, e.g. `Desktop/FoneNova_Order_Ledger.xlsx`. A Windows path pasted as is (`C:\Users\...\OneDrive\Desktop\...`) works too |
| `FN_ONEDRIVE_EXPENSES_DIR` | The VAT returns folder in OneDrive, e.g. `Desktop/VAT RETURNS` |
| `ONEDRIVE_WRITE_TOKEN` | Bearer secret (32+ characters) for the payments service's tracker routes, below. Unset: the routes answer 503 |
| `ONEDRIVE_WRITE_PATHS` | The exact tracker paths the payments service may read and write, one per line (or `;`-separated) |
| `XERO_CLIENT_ID` | Optional. Add `https://dashboard.fonenova.com/xero/callback` to the Xero app's redirect URIs |

**Live data on the web.** The hosted dashboard reads the same two spreadsheets from OneDrive,
read-only, and keeps everything it saves (imports, overheads, row decisions, Xero and OneDrive
tokens) in Upstash, encrypted. It checks for new saves on each visit (at most every 30 seconds)
and once a day at 06:00 UTC from a scheduled job (`vercel.json`, `/api/cron/sync`; Hobby allows
daily, Pro allows hourly).
The same rules as on your PC apply: newest tracker, `_backups` skipped, and a save that cannot be
read leaves the last good import on screen with the reason in the status bar.

**Send this PC's data online (no OneDrive app needed).** `npm run push-online` copies the
imported ledger and expenses, plus your overheads, row decisions, confirmed Xero pairs and
settings, into the online store. It reads the store's details from `.env.online.local`
(git-ignored): `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `FN_STORE_KEY`, the same values as in
Vercel. Decisions already made on the website are kept unless you add `-- --force`. Xero and
OneDrive tokens are never copied. Run it again whenever the trackers change.

**OneDrive app (once, free).** Azure portal → App registrations → New registration:
*Personal Microsoft accounts only*; redirect URI platform **Public client/native (mobile & desktop)**,
`https://dashboard.fonenova.com/onedrive/callback`. That is a public client signing in with PKCE,
so there is no secret to store or renew. Copy the *Application (client) ID* into `MS_CLIENT_ID`,
redeploy, sign in and click **Connect OneDrive (read-only)**; Microsoft asks you to approve
`Files.ReadWrite` there (connections made before write access existed stay read-only, and keep
working, until connected again). Microsoft can't limit a personal account to one folder, so this
is write access to the whole OneDrive: the dashboard reads only the ledger and VAT paths above and
writes only the exact paths in `ONEDRIVE_WRITE_PATHS`, never the ledger or VAT folder, and has no
code that deletes anything.

**Payments trackers on OneDrive.** For the payments service (bearer `ONEDRIVE_WRITE_TOKEN`, outside
the dashboard sign-in, `lib/onedrive-write.ts`):

- `GET /api/onedrive/file?path=` → `{path, exists, sha256, etag, last_modified, size}`
- `PUT /api/onedrive/file?path=&expected_sha256=<hex|none>`, raw xlsx bytes (≤ 4 MB) →
  `200 {sha256, etag, last_modified}`, `409 {"error":"changed"}` (nothing written; the upload also
  carries `If-Match`), `423 {"error":"locked"}` (skipped), `400`, `401`, `503` (not connected, or
  connected read-only)
- `GET /api/onedrive/conflicts?folder=` → OneDrive's `<file>-<PCNAME>.xlsx` conflict copies

Each write is logged (path, hashes, result, time; never the contents). (A Web-platform app with a client
secret in `MS_CLIENT_SECRET` works too, but that secret expires.)

`FN_LEDGER_BR` (from `npm run pack-ledger`) still works as a fallback, without live sync: if set,
it replaces everything above for the ledger.

Local `npm run dev` skips sign-in when `GOOGLE_CLIENT_ID` is unset. Production builds never do.

## Payments (Revolut EUR, read-only)

`/payments` shows what the separate `fonenova-payments` service reports: open exceptions with
ranked suggestions (allocate or dismiss, each behind a confirmation step), what each customer
still owes and what is still owed to Mobile One per invoice, each payment on its own line, held
customer overpayments, and the three Excel trackers. The dashboard never moves money and never
recalculates balances; `remaining_cents` from the service is shown as is, in integer cents.

- `lib/payments-source.ts` (server only) calls the service with `PAYMENTS_API_URL` and
  `PAYMENTS_API_TOKEN`, `no-store`, 15 s timeout. Errors are plain words without the token,
  the address or response bodies. Without the two variables (Preview, local) the page says
  "Payments service not configured" rather than showing tables or zeros.
- `/api/payments/{approve,dismiss,tracker}` check the dashboard session (`currentUser`), require
  a same-origin request for changes, validate input (`lib/payments-validate.ts`: invoice
  `^[0-9/]{1,20}$`, positive integer cents, a 3 to 300 character dismiss reason, tracker
  `wave|tw|m1`) and forward only those fields. Approve also sends the chosen invoice's
  `tracker`, for numbers that exist in two trackers.
- A part allocation answers `{ok:true, still_unallocated_cents}`; the page shows that remainder
  and the exception stays open for the rest.
- X-REVERSAL, X-TOKEN, X-FETCH, X-BULK and any exception without a bank payment offer Dismiss
  only. X-OVERPAY offers to place only the surplus. X-OUT-* codes allocate to Mobile One bills.
- Local development: `npm run mock-payments`, then
  `PAYMENTS_API_URL=http://localhost:3299 PAYMENTS_API_TOKEN=dev-mock-token npm run dev`
  (`MOCK_STALE=1` or `MOCK_DOWN=1` on the mock to see those states).

## Offers from Mobile One (phase 1: read and review)

Every 5 minutes Upstash QStash calls `POST /api/cron/offers` with `Authorization: Bearer <CRON_SECRET>`
(set as `Upstash-Forward-Authorization`). It searches the connected Gmail for
`from:bv@mobileone.info newer_than:3d`, skips our own replies and anything already read, drops
quoted replies and signatures (`lib/offers/clean.ts`), and asks Claude Haiku (strict tool,
`lib/offers/parse.ts`) whether it is an offer and what its lines are. Offers are saved as
NEEDS REVIEW and pinged to Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`). `/offers` shows
each one beside the email, with checks per line (`lib/offers/check.ts`: unknown model such as
"iPhone 7 Pro", missing storage, quantity, price outside €20 to €2,500, duplicates, lines that do
not match the email). Nothing is sent to anyone in this phase.

Gmail needs read access: new connections ask for `gmail.send` and `gmail.readonly` (read only,
never change or delete). Connect Gmail again in Settings once; the consent screen must be
Internal (Workspace) or the token expires after 7 days.

The Friday cash email has been removed (no scheduled job, nothing on the Settings card); the
`fridayEmail` setting stays off and `/api/cron/digest` answers "switched off". An offer whose Gmail
thread already has our reply (answered by hand) is stored as "not an offer" with a note and no
Telegram ping; Restore brings it back.

### Offers phase 2: clients and pricing

`/offers/clients` holds each client's margin rule, payment terms, contacts and Xero ContactID
(`offers:clients` in the store; first run: Wave Phone manual, EU Telecoms fixed €4.00 locked, an
empty test client). A reviewed offer gets a "Price for a client" panel (`lib/offers/pricing.ts`):
sale = unit cost + margin in whole cents; fixed-locked clients allow no per-line changes; manual
clients need a per-unit margin with optional per-line overrides; a line under €4.00 per unit needs
a tick box; a line the review flagged cannot be priced. The server recomputes every price, and a
saved price is removed if the lines or status change. `publicLines()` is the only shape meant for
the client-facing page (description, quantity, sale price): it has no cost or margin field.
Nothing is sent to anyone in this phase.

### Offers phase 3: sending to a client, and the answer

A priced offer shows "Send to <client>": a preview of exactly what the client sees (sale prices
only), a confirmation, then `lib/offers/send.ts` reserves the offer, writes the client's snapshot
to the **public store** (a separate Upstash database, `OFFERS_PUBLIC_REDIS_URL` /
`OFFERS_PUBLIC_REDIS_TOKEN`, shared with fonenova.com and never holding a cost), emails the link
from the connected Gmail account, and records it. If anything fails the reservation is undone, so
nothing is half-sent. Only the link's SHA-256 is kept. The link is valid 24 hours.

The client answers on fonenova.com. That site calls `POST /api/offers/answered` with
`Authorization: Bearer OFFERS_WEBHOOK_TOKEN` (set the same value on both Vercel projects) and only
the link's hash; the dashboard reads the answer from the public store itself, so a forged call
changes nothing. The 5-minute check (`/api/cron/offers`) also picks up missed answers, expires
offers past their deadline and rolls back a send that never completed. Accept, decline and expiry
each ping Telegram; a declined or expired offer is unlocked with one click to reprice.

When a client accepts, declines or lets an offer expire, Telegram is told and so is the owner by
email (`lib/offers/notify-email.ts`, sale prices only); a failed email never stops the status
update or the Telegram message. The three variables (`OFFERS_PUBLIC_REDIS_URL`,
`OFFERS_PUBLIC_REDIS_TOKEN`, `OFFERS_WEBHOOK_TOKEN`) are checked before use
(`lib/offers/env-check.ts`): a pasted `.env` block, quotes, spaces or a half address give a plain
"<NAME> looks malformed" and the value is never shown. Gmail's state is explicit: not connected,
unreadable, check failed (the store did not answer: nothing was disconnected) or needs reconnect
(Google no longer accepts the login), each with its fix.

Real clients stay switched off until the order and invoice steps exist (`OFFERS_ALLOW_REAL_SEND`
unset): until then offers go to the test client only.

### Offers phase 4 follow-ups: shipping, the acceptance email, draft safety, live kept separate

**Shipping.** Mobile One's shipping is read from their email (with the line it came from) and shown on the review screen under "Mobile One's shipping", where you can change it or confirm there is none. It is never assumed: with no figure the offer cannot be priced or sent, and "no shipping" is a tick box you choose. The client is charged Mobile One's shipping x the client's multiplier (default 2, set per client on the Clients screen); when you price the offer you can type a different figure for that client. That one figure is the shipping row on the offer email, on the accept page (inside the total the client accepts) and its own line on the Xero draft: "SHIPPING CHARGES", quantity 1, the same sales account and tax type as the items (200 and NONE, as on invoice 2026047).

**Acceptance email.** When a client accepts, one email goes to info@fonenova.com from the connected Gmail, after the draft has been attempted so it can carry the Xero link: client, offer reference (order reference, Mobile One's subject, offer id), each line (description, quantity, unit price), shipping, total, currency, and the draft (or why there is none). It is claimed before it is sent (`notifiedAt` on the send), so a retried webhook, simultaneous deliveries and the 5-minute check can never send a second one.

**Before a draft is created.** An invoice already in Xero with the same reference is linked and no second one is made (a retry after a timeout adopts it). If the Xero contact has no address the draft is still created and "Add an address in Xero before approving" is shown next to its link. If the same contact was invoiced in the last 14 days, the panel (and the email) say which invoices. A real client's payment terms must be chosen on purpose (Clients screen: 7 days, 14 days, other days or upfront) before the client can stop being a test client, and a draft for a real client with unconfirmed terms is not raised.

**Live is separate from real sending.** Two switches, each its own explicit step, and neither implies the other:
1. `XERO_WRITE_ALLOW_LIVE=true` lets the write connection create drafts in a live Xero organisation (and the connection itself is made on the Settings card). Without it a live organisation gets no drafts.
2. `OFFERS_ALLOW_REAL_SEND=true` lets offers go to real clients.
A real client needs both, and the Send panel says which one is missing. Test offers use only the Xero Demo Company and need neither.

**Try it without a real email:** on the Offers page, **New test offer** makes a clearly marked sample offer (subject "[TEST] Sample offer, not from Mobile One", a TEST badge, a banner). It is reviewed but unpriced. It can only be priced for and sent to a test client: the pricing and the send step both refuse any other client, whatever the screen shows. Up to 3 unanswered test offers at a time; "Not an offer" dismisses one.

### Offers phase 4: after a client accepts

When a client accepts, Quay Pilot does three things (and tells you on Telegram):

1. **Reserves the order reference.** Real offers take the next `FN-ORD-###` after the ledger, the Xero pairs and any already reserved. Test offers use `TEST-###` and never use a real number.
2. **Replies to Mobile One** in their original thread: "We accept the offer. Please proceed with the invoice." It goes by itself only if all of these hold: their offer is under 48 hours old, the accepted total equals what was priced, and you have not already replied in the thread. Otherwise it is held and the offer shows an **OK, send the reply** button. A **test** offer never reaches Mobile One: the would-be reply goes to your own inbox, outside their thread. Nothing real is sent while `OFFERS_ALLOW_REAL_SEND` is unset.
3. **Creates a DRAFT invoice in Xero** (never approved, emailed or filed): the contact by ContactID, lines at the sale prices the client saw, EUR, due date from the client's terms, Reference = the order reference. The number is one more than the highest 7-digit sales invoice number in the connected Xero organisation (any status, so drafts, voided and deleted numbers count), read from Xero at the moment the draft is made: the dashboard keeps no counter of its own, so it continues whatever sequence the organisation is really on (live is at 2026047, so the next is 2026048). If Xero rejects the number as a duplicate, the numbers are read again and it is tried once more with the next free one; a second duplicate stops with nothing created. A draft with the same reference is adopted, never duplicated, including inside that retry. The Demo Company has no 7-digit numbers, so its first draft is 2026001 and the next is read from Xero as 2026002.

Every step is retried by the 5-minute check; after three failed tries you get a Telegram message. The offer page has an **After acceptance** panel with both steps and a **Try again now** button.

**If the draft invoice is refused (a 400):** the After acceptance panel shows Xero's own validation messages and which field they point at, followed by checks of the organisation's currency (EUR), tax type, sales account, contact and branding theme, so the cause is named in words. A refusal is a rule problem, so it is not retried every 5 minutes: fix the setting (Settings, Xero draft invoices, or in Xero itself, e.g. Settings, Currencies) and press **Try again now**. That button is safe to press repeatedly: the step is claimed under a lock, an existing draft with the same reference is found and reused, and Xero is sent an idempotency key, so there is never a second draft. The branding theme is picked by name from the organisation's own list (**Load themes from Xero**), because the id in the theme editor's page address is not always the API id.

A refused draft also shows **Technical detail**: the endpoint and API version, the tenant the request carried (first 8 characters), the organisations the write app is connected to, the idempotency key, the request fields that matter (the currency fields included; `CurrencyRate` is not sent, Xero applies its own rate) and Xero's raw error body. It never contains a token or an Authorization header, and the same record is written to the Vercel runtime log (`xero-write-rejected`). Each definite refusal moves the idempotency key on (`...-r0`, `-r1`, ...), so a stored refusal can never answer a retry after you fix a setting; an unknown outcome (a dropped connection) keeps its key and the existing draft is found by its Reference, so a retry never makes a second draft.

**Which Xero organisation drafts go to.** The write app can be connected to more than one organisation (for example the Demo Company and Fonenova Ltd). After a sign-in, every connected organisation is listed on the Settings card, tagged DEMO or LIVE, and the one chosen in that sign-in is identified from Xero's own `authEventId` (not "the first in the list"). Connecting is not choosing: which organisation drafts go to is its own explicit step on the card ("Use <name>"), and a live organisation needs a second, separate tick ("Drafts will be created in my LIVE Xero") on top. A live organisation is never selected by connecting alone; a demo chosen on a fresh connection is. When a live organisation is selected a red banner reads "LIVE: drafts go to <name>" on the Settings card and the Offers page. The tenant guard: every request carries only the selected organisation's tenant id, the organisation Xero reports for it must match, and if the selection is changed while a draft is being made the draft is not sent. A test client stays in the Demo Company unless a **live test contact** is mapped for it on the Clients screen (then its test offers use that live contact, and still need `XERO_WRITE_ALLOW_LIVE`). Note that a live test draft takes a real number from your live sequence.

**Xero write connection (a second app, separate from the read-only one):** create an app in the Xero developer portal with redirect `https://dashboard.fonenova.com/xero-write/callback` and the scopes `offline_access accounting.invoices accounting.contacts.read accounting.settings.read` (override with `XERO_WRITE_SCOPES`), add its client id in Vercel as `XERO_WRITE_CLIENT_ID`, redeploy, then press **Connect Xero** in Settings, Xero draft invoices. Connect the **Demo Company** first: test offers may only create drafts in a demo organisation, real offers only in a live one, and the check runs against the organisation the token really reaches. Settings also holds the tax type, sales account and branding theme used on every draft: check them against invoice 2026047 before the first real offer.

## Watchdog (nothing fails silently)

Every morning the daily job (`/api/cron/sync`) runs the checks in `lib/health.ts`: each data
source syncing, Xero and OneDrive connected, Xero refreshed in the last 30 hours, both Make
scenarios on and their last run clean, Make credits, a sales invoice and a supplier bill in the
last 7 days (red at 14), no gaps in your invoice numbers, and (where `PAYMENTS_API_URL` is set)
the payments service's `/api/health`: red when it answers 503 `{ok:false}`, has not run for 30
minutes, or cannot be reached within 7 s (4 s when the dashboard page itself checks, so a hung
service cannot hold the page up). The service's `last_error` is shown as details, not the headline. Settings shows the list, the
status pill turns red.

It then pings `HEALTHCHECK_URL` (a free [Healthchecks.io](https://healthchecks.io) check, period
1 day, grace 6 hours): `/fail` with the problems when anything is red, a plain ping otherwise.
Healthchecks emails you on a fail, and also when no ping arrives at all, so a stopped job, a
Vercel outage or an expired connection is reported without anyone opening the dashboard.
An invoice number deleted in Invoice2Go can be marked "never used" in Settings.

## Gmail setup (offers and notifications)

The dashboard's one Gmail connection (`lib/gmail.ts`, scopes `gmail.send` and `gmail.readonly`)
reads Mobile One's offers and sends the offer emails and the answer notifications. The Friday cash
email that once used it has been removed: `lib/digest.ts` and `/api/cron/digest` remain in the
code, but nothing schedules them and the `fridayEmail` setting is off, so nothing is sent.

Setup, once: in Google Cloud (project of the sign-in client) enable the **Gmail API**, add
`https://dashboard.fonenova.com/gmail/callback` as a redirect URI on the OAuth client, and set
the consent screen's user type to **Internal** so the connection never expires. Then **Connect
Gmail** in Settings. Notifications go to `DIGEST_TO`, else `AUTH_ALLOWED_EMAIL`, else the
dashboard's own address.

## AI bar (search and questions)

The search box in the top bar (Ctrl/⌘ K) finds orders (by number, e.g. `34`), invoice and bill
numbers, customers and pages instantly, in the browser, at no cost. A question ("who owes me
most?") goes to `/api/ask`, where Claude Haiku 5.5 (`lib/ask/run.ts`) answers with read-only
tools over the same view as the page (`lib/ask/tools.ts`: orders, period totals, customers,
overdue, cash due, Xero problems, expenses, deal check). It cannot change anything.

Cost guards: `AI_DAILY_LIMIT` questions a day (default 50, counted in the store), at most four
tool rounds and low effort per question (about $0.002 each). Put `ANTHROPIC_API_KEY` in its own
Anthropic workspace with a monthly spend limit. Each question and the figures the tools return
are sent to Anthropic's API.

## Live data from Xero (read-only)

**How documents reach Xero.** Two Make.com scenarios create DRAFT documents: "Integration
Webhooks" (8112915) turns each Invoice2Go invoice into a Xero sales invoice, and "Mobile One
Bills" (8119866) turns each Mobile One invoice email into a Xero bill. The dashboard lists every
draft still to approve (Invoice matching page, "Needs doing" on Overview, the status pill) with a
link into Xero, and, with `MAKE_API_TOKEN` set, shows each scenario's state, last run and
credits on Settings; a scenario that is off or whose last run failed turns the status pill red.

**Margin-scheme VAT.** A Settings switch (off by default) deducts 1/6 of each order's positive
margin from net business profit and shows it on its own line. It is an EUR estimate; confirm with
the accountant that it applies.

**Xero is the live source of new orders.** Invoice2Go syncs each sent invoice to Xero, and Mobile
One's bill emails are auto-forwarded from Gmail to Xero's bills inbox. The **Invoice matching**
page pairs each new Xero sales invoice with its bill: same FN-ORD reference on both pairs them
automatically; otherwise it suggests the EUR bill dated within 10 days whose total sits a little
below the invoice (replayed against the 34 ledger orders it picks the right bill 34/34 with bills
dated within 2 days, and never offers one bill twice). Confirming makes it an order (FN-ORD-035
onwards) on every page; Unpair undoes it. Pairs are kept in `data/xero/pairs.json` (or the online
store when hosted). The spreadsheet ledger stays as history for orders up to 4 Oct, and anything
it already pairs is never counted again. Xero credit notes the ledger does not have are added too.

The dashboard can read invoice statuses, balances still owed, due dates, each payment and bank
balances from Xero. Sales, costs and the pairing of client and supplier invoices still come from
the ledger, and the 25 reconciliation checks always run against the untouched ledger.

1. At https://developer.xero.com/app/manage create a new app of type **Mobile or desktop app**
   (PKCE, so no client secret). Redirect URI: `http://localhost:3100/xero/callback`.
2. Put its client ID in `dashboard/.env.local` (git-ignored): `XERO_CLIENT_ID=...`
3. Restart the dashboard, click **Connect Xero (read-only)**, sign in and pick the organisation.
4. Use **Refresh** whenever you want the latest figures. The bar shows when it last refreshed and
   which orders could not be matched.

Scopes requested: `offline_access accounting.invoices.read accounting.payments.read
accounting.reports.banksummary.read`. If Xero's app settings name them differently, set
`XERO_SCOPES`. Bank balances are taken as Xero reports them, in the organisation's base currency
(`XERO_BASE_CURRENCY`, default GBP). Tokens and the last snapshot live in `data/xero/` on your PC
(git-ignored), or encrypted in online storage when hosted. Hosted, Xero's redirect URI is
`https://dashboard.fonenova.com/xero/callback` (derived from `AUTH_URL`; override with `XERO_REDIRECT_URI`).

## Currency, overheads and the cash calendar

- **EUR / GBP switch:** GBP uses the European Central Bank daily reference rate (via Frankfurter,
  no key), shown with its date and source. Without a rate the switch is disabled; nothing is guessed.
- **Overheads:** entered on the dashboard and saved to `data/overheads.json` (git-ignored). Net
  business profit = gross profit after credit notes minus business overheads taken in the period,
  up to today. Personal items only appear in the cash calendar.
- **Cash calendar:** open balances by due date (from Xero) plus overheads, with a running balance
  from Xero's bank balances. Overdue bills count from today; overdue client payments are not
  counted until they arrive.
- Saving overheads and the Xero connection need a writable disk, so both are local-only until the
  hosted version gets online storage.

## Expenses from the VAT return tracker

```powershell
npm.cmd run import-expenses -- "C:\path\to\VAT Return From Sept-Dec, 2026.xlsx"
```

(or set `FN_EXPENSES_PATH`, or save the file as `dashboard/data/expenses.xlsx`). The import reads
Sheet2 (the expense log) and the "FX Exchanges (Reference)" sheet, and prints its totals to check
against the tracker's summary. Output: `data/generated/expenses.json` (git-ignored).

Each row is sorted by plain rules in `lib/expenses.ts` into **Business** (comes off net profit),
**Needs review** (business purpose not recorded) or **Personal**. Change any row with its
dropdown; your choices are saved to `data/expense-overrides.json` (git-ignored) and survive
re-imports. Rows for office rent, housing rent and car finance are linked to those overheads and
skipped once the overhead is entered, so nothing is counted twice. The panel also shows VAT
reclaimed on rows not confirmed as business, personal spending paid by the company, and the rate
actually achieved on EUR to GBP conversions.

## Automatic sync (local)

Copy `.env.local.example` to `.env.local` and set where OneDrive keeps your files:

```
FN_LEDGER_PATH=C:\Users\fonen\OneDrive\Desktop\FoneNova_Order_Ledger.xlsx
FN_EXPENSES_DIR=C:\Users\fonen\OneDrive\Desktop\VAT RETURNS
```

Then start the dashboard with **`Start dashboard.cmd`** (double-click; put a shortcut in
`shell:startup` to run it at login). From then on there is nothing to run: when you save either
file, the dashboard re-imports it on its next refresh (an open page refreshes itself every
minute). The newest `VAT Return From….xlsx` in the folder is used; `_backups` folders are skipped.
The May to Aug tracker (`VATReturn_Automated_….xlsx`, newest copy) in the same folder is read
too and joined on: the current tracker wins from its first date, so a row in both is counted once.
Each import is checked against the tracker's own TOTAL row and the status bar says if they differ.
Both trackers are only ever opened for reading.
If a save cannot be read (still syncing, or the layout changed), the last good import stays on
screen and the status bar says why. Xero, once connected, refreshes itself when its data is more
than 10 minutes old. The manual `npm run import` commands still work and read `.env.local` too.
