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

The Friday cash email is a separate switch in Settings → Gmail, **off by default** (the same Gmail
connection serves offers, so connecting it does not start the email). `/api/cron/digest` answers
"switched off" and sends nothing unless it is on; "Send test email now" always works. An offer
whose Gmail thread already has our reply (answered by hand) is stored as "not an offer" with a
note and no Telegram ping; Restore brings it back.

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

## Watchdog (nothing fails silently)

Every morning the daily job (`/api/cron/sync`) runs the checks in `lib/health.ts`: each data
source syncing, Xero and OneDrive connected, Xero refreshed in the last 30 hours, both Make
scenarios on and their last run clean, Make credits, a sales invoice and a supplier bill in the
last 7 days (red at 14), no gaps in your invoice numbers, and (where `PAYMENTS_API_URL` is set)
the payments service's `/api/health`: red when it answers 503 `{ok:false}`, has not run for 30
minutes, or cannot be reached within 7 s (4 s when the dashboard page itself checks, so a hung
service cannot hold the page up). The service's `last_error` is shown as details, not the headline. Settings shows the list, the
status pill turns red, and the Friday email has a System health section.

It then pings `HEALTHCHECK_URL` (a free [Healthchecks.io](https://healthchecks.io) check, period
1 day, grace 6 hours): `/fail` with the problems when anything is red, a plain ping otherwise.
Healthchecks emails you on a fail, and also when no ping arrives at all, so a stopped job, a
Vercel outage or an expired connection is reported without anyone opening the dashboard.
An invoice number deleted in Invoice2Go can be marked "never used" in Settings.

## Friday cash email

Every Friday at 16:00 UTC (`vercel.json`, `/api/cron/digest`, locked by `CRON_SECRET`) the
dashboard emails who is late paying, supplier bills due in the next 14 days next to what clients
owe, the live Xero checks, and drafts to approve. It is built by `lib/digest.ts` from the same
view as the page (`lib/live-view.ts`) and sent through Gmail with a send-only connection
(`lib/gmail.ts`, scope `gmail.send`; it can never read mail). Settings has **Connect Gmail** and
**Send test email now**.

Setup, once: in Google Cloud (project of the sign-in client) enable the **Gmail API**, add
`https://dashboard.fonenova.com/gmail/callback` as a redirect URI on the OAuth client, and set
the consent screen's user type to **Internal** so the connection never expires. Recipient:
`DIGEST_TO`, else `AUTH_ALLOWED_EMAIL`.

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
