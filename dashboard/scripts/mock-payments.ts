/**
 * A stand-in for the fonenova-payments service, for local development only. Fake data.
 *
 *   npx tsx scripts/mock-payments.ts            # http://localhost:3299, token dev-mock-token
 *   PAYMENTS_API_URL=http://localhost:3299 PAYMENTS_API_TOKEN=dev-mock-token npm run dev
 *
 * MOCK_STALE=1 reports an old last run with an error; MOCK_DOWN=1 answers 503 to everything.
 * Approving or dismissing removes the exception; approving more than the invoice's remaining
 * balance, or invoice 2026043 (settled), answers 409 like the real service.
 */
import http from 'node:http'
import { paymentsFixture } from '../tests/fixtures/payments'

const TOKEN = process.env.MOCK_TOKEN ?? 'dev-mock-token'
const PORT = Number(process.env.MOCK_PORT ?? 3299)
const state = paymentsFixture()
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
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, state.health)
  if (req.method === 'GET' && url.pathname === '/api/tracker') {
    res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    return res.end(Buffer.from(`fake tracker ${url.searchParams.get('key')}`))
  }
  if (req.method === 'POST' && url.pathname === '/api/approve') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const b = JSON.parse(raw || '{}') as { exception_id?: number; invoice?: string; amount_cents?: number; dismiss_reason?: string }
      const i = state.exceptions.findIndex((e) => e.id === b.exception_id)
      if (i < 0) return send(res, 400, { error: 'No such open exception' })
      if (b.dismiss_reason) {
        state.exceptions.splice(i, 1)
        return send(res, 200, { ok: true })
      }
      const inv = [...state.customer_invoices, ...state.supplier_invoices].find((x) => x.number === b.invoice)
      const amount = b.amount_cents ?? state.exceptions[i].bank_event?.amount_cents ?? 0
      if (!inv) return send(res, 400, { error: `Invoice ${b.invoice} not found` })
      if (inv.remaining_cents <= 0) return send(res, 409, { error: `Invoice ${inv.number} is already settled` })
      if (amount > inv.remaining_cents) return send(res, 409, { error: `€${(amount / 100).toFixed(2)} is more than the €${(inv.remaining_cents / 100).toFixed(2)} still open on ${inv.number}` })
      state.exceptions.splice(i, 1)
      return send(res, 200, { ok: true })
    })
    return
  }
  send(res, 404, { error: 'not found' })
}).listen(PORT, () => console.log(`mock payments service on http://localhost:${PORT}`))
