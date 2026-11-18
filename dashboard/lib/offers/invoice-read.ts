/**
 * Reads one Mobile One invoice PDF with Claude (the same model and key as the offer reader), through a strict
 * tool. It copies what is printed; the checks in shipping-check.ts decide whether to trust it. Dutch numbers
 * (9.300,00) are converted by the model into plain decimals.
 */
import 'server-only'
import Anthropic from '@anthropic-ai/sdk'
import { ASK_MODEL } from '../ask/run'
import type { InvoiceReading } from './shipping-check'

export const RECORD_INVOICE = {
  name: 'record_invoice',
  description: 'Record what is printed on one supplier invoice.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['is_invoice', 'supplier', 'invoice_number', 'items', 'shipping_eur', 'total_eur'],
    properties: {
      is_invoice: { type: 'boolean', description: 'false if this document is not an invoice (a label, a packing list, a letter).' },
      supplier: { type: 'string', description: 'The company that issued it, as printed at the top.' },
      invoice_number: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      items: { type: 'array', description: 'Product lines only (phones). Not shipping, freight, delivery or fees.', items: { type: 'object', additionalProperties: false, required: ['description', 'quantity', 'amount_eur'], properties: { description: { type: 'string' }, quantity: { type: 'number' }, amount_eur: { type: 'number', description: 'The line amount excluding VAT, in euros, as a plain decimal.' } } } },
      shipping_eur: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'The shipping, freight or delivery charge line (for example "SHIPPING CHARGES"), in euros; null if there is none. Never guess.' },
      total_eur: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'The total excluding VAT, in euros.' },
    },
  },
} as const

const SYSTEM = 'You read supplier invoices sent to Fone Nova Ltd. Copy exactly what is printed. Convert European number formats to plain decimals (9.300,00 is 9300.00). Never guess a value; use null when it is not there.'
const cents = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : null)

export async function readInvoicePdf(bytes: Uint8Array, client: Anthropic = new Anthropic()): Promise<InvoiceReading | null> {
  const res = await client.messages.create({
    model: ASK_MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    tools: [RECORD_INVOICE as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'record_invoice' },
    messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64') } }, { type: 'text', text: 'Record this document.' }] }],
  })
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_invoice')
  if (!call) throw new Error('The invoice reader gave no answer')
  const i = call.input as { is_invoice: boolean; supplier: string; invoice_number: string | null; items: { description: string; quantity: number; amount_eur: number }[]; shipping_eur: number | null; total_eur: number | null }
  if (!i.is_invoice) return null
  return {
    supplier: String(i.supplier ?? '').slice(0, 80),
    invoiceNumber: i.invoice_number?.slice(0, 40) ?? null,
    items: (i.items ?? []).slice(0, 100).map((x) => ({ description: String(x.description).slice(0, 120), quantity: Math.round(Number(x.quantity)), amountCents: cents(x.amount_eur) ?? Number.NaN })),
    shippingCents: cents(i.shipping_eur),
    totalCents: cents(i.total_eur),
  }
}
