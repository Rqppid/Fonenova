/**
 * A stand-in for the fonenova-payments service, for local development only. Fake data.
 *
 *   npx tsx scripts/mock-payments.ts            # http://localhost:3299, token dev-mock-token
 *   PAYMENTS_API_URL=http://localhost:3299 PAYMENTS_API_TOKEN=dev-mock-token npm run dev
 *
 * MOCK_STALE=1 reports an old last run with an error (health answers 503 {ok:false}, like the real
 * service); MOCK_DOWN=1 answers 503 with no data to everything.
 * Dismissing removes the exception. Approving the whole payment removes it; approving part of it
 * answers {ok:true, still_unallocated_cents} and keeps it open for the rest. More than the invoice
 * still needs, more than the payment has left, or invoice 2026043 (settled) answers 409.
 */
import http from 'node:http'
import { paymentsFixture } from '../tests/fixtures/payments'

const TOKEN = process.env.MOCK_TOKEN ?? 'dev-mock-token'
const PORT = Number(process.env.MOCK_PORT ?? 3299)
const state = paymentsFixture()
/** How much of each exception's bank payment has not been allocated yet. */
// X-OVERPAY: the payment is already on its invoice; only the €20 surplus is left to place.
const left = new Map(state.exceptions.map((e) => [e.id, e.code === 'X-OVERPAY' ? 20_00 : Math.max(0, e.bank_event?.amount_cents ?? 0)]))
if (process.env.MOCK_STALE) state.health = { ok: false, last_run: '2026-11-08T07:10:00Z', minutes_ago: 168, last_error: 'Revolut token expired' }

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http.createServer((req, res) => {
  if (process.env.MOCK_DOWN) return send(res, 503, { error: 'down' })
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'bad token' })
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...state, generated_at: new Date().toISOString() })
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, state.health.ok ? 200 : 503, state.health)
  if (req.method === 'GET' && url.pathname === '/api/tracker') {
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    return res.end(Buffer.from(`fake tracker ${url.searchParams.get('key')}`))
  }
  if (req.method === 'POST' && url.pathname === '/api/approve') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const b = JSON.parse(raw || '{}') as { exception_id?: number; invoice?: string; amount_cents?: number; dismiss_reason?: string; tracker?: string }
      const i = state.exceptions.findIndex((e) => e.id === b.exception_id)
      if (i < 0) return send(res, 400, { error: 'No such open exception' })
      if (b.dismiss_reason) {
        state.exceptions.splice(i, 1)
        return send(res, 200, { ok: true })
      }
      const ex = state.exceptions[i]
      if (!ex.bank_event) return send(res, 409, { error: 'This exception has no bank payment to allocate' })
      const inv = [...state.customer_invoices, ...state.supplier_invoices].find((x) => x.number === b.invoice && (!b.tracker || x.tracker === b.tracker))
      const unallocated = left.get(ex.id) ?? 0
      const amount = b.amount_cents ?? unallocated
      if (!inv) return send(res, 400, { error: `Invoice ${b.invoice} not found` })
      if (inv.remaining_cents <= 0) return send(res, 409, { error: `Invoice ${inv.number} is already settled` })
      if (amount > unallocated) return send(res, 409, { error: `Only €${(unallocated / 100).toFixed(2)} of this payment is still unallocated` })
      if (amount > inv.remaining_cents) return send(res, 409, { error: `€${(amount / 100).toFixed(2)} is more than the €${(inv.remaining_cents / 100).toFixed(2)} still open on ${inv.number}` })
      inv.remaining_cents -= amount
      inv.paid_cents += amount
      inv.state = inv.remaining_cents <= 0 ? 'fully_paid' : 'partly_paid'
      inv.payments.push({ date: ex.bank_event.date, amount_cents: amount, fee_cents: 0, method: 'Bank Transfer', source: 'approved', remark: 'Allocated in the dashboard (mock)', bank_event_id: `mock-${ex.id}` })
      const rest = unallocated - amount
      if (rest > 0) {
        left.set(ex.id, rest)
        return send(res, 200, { ok: true, still_unallocated_cents: rest })
      }
      state.exceptions.splice(i, 1)
      return send(res, 200, { ok: true })
    })
    return
  }
  send(res, 404, { error: 'not found' })
}).listen(PORT, () => console.log(`mock payments service on http://localhost:${PORT}`))
