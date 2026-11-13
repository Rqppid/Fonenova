/**
 * Reads one Mobile One email into offer lines with Claude Haiku (the AI bar's model and key),
 * through a strict tool, so the answer is always the same shape. It copies; it never corrects:
 * a typo stays a typo, with a note, and the review screen flags it.
 */
import 'server-only'
import crypto from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { ASK_MODEL } from '../ask/run'
import type { OfferLine } from './types'

export interface ParsedOffer {
  isOffer: boolean
  reason: string
  lines: OfferLine[]
}

const orNull = (description: string) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description })

export const RECORD_OFFER = {
  name: 'record_offer',
  description: 'Record whether this email from the supplier is a stock offer, and its lines.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['is_offer', 'reason', 'lines'],
    properties: {
      is_offer: { type: 'boolean', description: 'True only if the email offers stock for sale with prices. False for invoices, IMEI lists, shipping or tracking details, payment matters and replies without new prices.' },
      reason: { type: 'string', description: 'One short sentence: why it is or is not an offer.' },
      lines: {
        type: 'array',
        description: 'One entry per product line offered. Empty when is_offer is false.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['model', 'storage', 'grade', 'quantity', 'unit_cost_eur', 'source_text', 'note'],
          properties: {
            model: { type: 'string', description: 'Brand and model exactly as written, e.g. "iPhone 16 Pro", "Samsung S25 Ultra". Keep spelling mistakes as they are; do not correct them.' },
            storage: orNull('e.g. "128GB", "1TB"; null if not given'),
            grade: orNull('Condition or spec as written, e.g. "Grade A+", "AP Grade A+", "DNA", "e-Sim", "Used"; null if not given'),
            quantity: { type: 'integer', description: 'Number of units' },
            unit_cost_eur: { type: 'number', description: 'Price per unit in euros, e.g. 248.87' },
            source_text: { type: 'string', description: 'The exact line of the email this came from' },
            note: orNull('Anything odd about this line, e.g. "iPhone 7 Pro is old; may mean iPhone 17 Pro". Null if nothing odd.'),
          },
        },
      },
    },
  },
} as const

const SYSTEM = [
  'You read emails that Mobile One Trade B.V., a phone wholesaler, sends to Fone Nova Ltd.',
  'Decide whether the email is a stock offer with prices, and if so list every product line.',
  'Copy model names, storage, grades, quantities and prices exactly as written. Never correct a typo or guess a missing value: put null and say so in the note.',
  'Prices are per unit in EUR. "Nos", "N0s", "pcs", "pieces" and "units" all mean quantity.',
  'Ignore greetings, signatures and quoted earlier messages.',
].join('\n')

export async function readOffer(text: string, subject: string, client: Anthropic = new Anthropic()): Promise<ParsedOffer> {
  const res = await client.messages.create({
    model: ASK_MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [RECORD_OFFER as unknown as Anthropic.Tool],
    tool_choice: { type: 'tool', name: 'record_offer' },
    messages: [{ role: 'user', content: `Subject: ${subject || '(none)'}\n\n${text.slice(0, 8000)}` }],
  })
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'record_offer')
  if (!call) throw new Error(res.stop_reason === 'refusal' ? 'The reader declined this email' : 'The reader gave no answer')
  const input = call.input as { is_offer: boolean; reason: string; lines: { model: string; storage: string | null; grade: string | null; quantity: number; unit_cost_eur: number; source_text: string; note: string | null }[] }
  return {
    isOffer: !!input.is_offer && input.lines.length > 0,
    reason: String(input.reason ?? ''),
    lines: (input.is_offer ? input.lines : []).slice(0, 100).map((l) => ({
      id: crypto.randomBytes(6).toString('hex'),
      model: String(l.model).trim().slice(0, 80),
      storage: l.storage?.trim().slice(0, 40) || null,
      grade: l.grade?.trim().slice(0, 40) || null,
      qty: Math.round(Number(l.quantity)),
      unitCostCents: Math.round(Number(l.unit_cost_eur) * 100),
      sourceText: String(l.source_text ?? '').trim().slice(0, 300),
      note: l.note?.trim().slice(0, 200) || null,
    })),
  }
}
