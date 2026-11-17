import { createElement as h } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { InvoiceSteps } from '@/components/offers/invoice-steps'
import { gmailThreadIdFrom, parseGmailFiles, parseGmailThread, type ThreadMessage } from '@/lib/gmail'
import type { XeroApi, XeroInvoiceDetail } from '@/lib/offers/draft'
import { seedClients } from '@/lib/offers/clients'
import { attachImeiFiles, candidatesIn, clearImeiFiles, findImeiFiles, imeiLine, kindOf, sendImeiFollowUp } from '@/lib/offers/imei'
import { sendInvoice, type InvoiceDeps } from '@/lib/offers/invoice-flow'
import type { Fulfilment, Offer } from '@/lib/offers/types'
import type { Store, StoreKey } from '@/lib/store'

vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const NOW = new Date('2026-11-15T10:00:00Z')
const HOURS = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3])
const SHEET = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9])
const LABEL = new Uint8Array([0x25, 0x50, 0x44, 0x46, 7, 7])
const WAVE = '1597cc5c-fbed-4817-a4e1-53149bb46d77'
const THREAD = '19e3aa5907590027'

function mem(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const tails = new Map<string, Promise<unknown>>()
  return { name: 'mem', data, async get(k: StoreKey) { return data.has(k) ? { kind: 'ok' as const, value: structuredClone(data.get(k)) } : { kind: 'missing' as const } }, async set(k: StoreKey, v: unknown) { data.set(k, structuredClone(v)) }, async del(k: StoreKey) { data.delete(k) }, async withLock<T>(n: string, fn: () => Promise<T>) { const prev = tails.get(n) ?? Promise.resolve(); const run = prev.then(fn, fn); tails.set(n, run.catch(() => {})); return run } }
}

const msg = (id: string, from: string, labels: string[], files: { name: string; size?: number; mime?: string }[], at = 1): ThreadMessage => ({ id, from, subject: 'Re: Offer', receivedAt: HOURS(10 - at), labels, files: files.map((f, i) => ({ messageId: id, partId: `0.${i + 1}`, attachmentId: `att-${id}-${i}-xxxxxxxx`, filename: f.name, mime: f.mime ?? 'application/octet-stream', size: f.size ?? 2048 })) })
const MO = 'Mobile One Trade <bv@mobileone.info>'
const threadFixture = (): ThreadMessage[] => [
  msg('aaaaaaaaaaaaaaa1', MO, ['INBOX'], [{ name: 'Invoice 2026050050.pdf', mime: 'application/pdf' }], 1),
  msg('aaaaaaaaaaaaaaa2', 'FoneNova <info@fonenova.com>', ['SENT'], [{ name: 'our-reply.pdf' }], 2),
  msg('aaaaaaaaaaaaaaa3', MO, ['INBOX'], [{ name: 'IMEI sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 52_000 }, { name: 'logo.png', mime: 'image/png' }, { name: 'IMEI sheet 2.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 31_000 }], 3),
]

function offer(test = false, threadId = THREAD): Offer {
  const f: Fulfilment = { orderRef: test ? 'TEST-001' : 'FN-ORD-016', test, startedAt: HOURS(3), reply: { state: 'sent', attempts: 1 }, draft: { state: 'done', attempts: 1, invoiceId: 'inv-1', invoiceNumber: '2026051', org: test ? 'Demo Company (UK)' : 'Fonenova Ltd' }, approve: { state: 'done', at: HOURS(1) } }
  return { id: 'of_i1', status: 'accepted', source: { gmailMessageId: 'm', threadId, rfcMessageId: null, from: MO, to: 'i@fonenova.com', subject: 'Offer', receivedAt: HOURS(5) }, text: '', lines: [{ id: 'l1', model: 'iPhone 16', storage: '128GB', grade: 'A', qty: 10, unitCostCents: 45_000, sourceText: 'x', note: null }], shipping: { mobileOneCents: 12_000, source: 'manual', sourceText: null }, pricing: { clientId: test ? 'c_test' : 'c_wave', marginCents: 700, overrides: {}, ackLow: false, shippingCents: 24_000, pricedAt: HOURS(4) }, sends: [{ clientId: test ? 'c_test' : 'c_wave', clientName: test ? 'Test client' : 'Wave Phone B.V.', to: ['x@example.test'], tokenHash: 'a'.repeat(64), tokenHint: 'abcdef', sentAt: HOURS(2), expiresAt: HOURS(-20), totalCents: 481_000, shippingCents: 24_000, units: 10, test, gmailMessageId: 'g1', outcome: 'accepted', resolvedAt: HOURS(1) }], fulfilment: f, createdAt: HOURS(6), updatedAt: HOURS(1), audit: [] }
}

type Mail = { to: string; subject: string; text: string; html: string; attachments: { filename: string; mime: string; bytes: Uint8Array }[]; threadId?: string; inReplyTo?: string }
function setup(o: Offer, opts: { isDemo?: boolean; mailFails?: boolean; allowReal?: boolean; allowLive?: boolean; thread?: ThreadMessage[]; noGmailThread?: boolean } = {}) {
  const isDemo = opts.isDemo ?? o.fulfilment!.test
  const store = mem()
  store.data.set('offers', [o])
  store.data.set('offers:clients', seedClients().map((c) => (c.id === 'c_wave' ? { ...c, termsConfirmed: true, invoiceEmails: ['accounts@wave.example'] } : c.id === 'c_test' ? { ...c, xeroContactId: WAVE, invoiceEmails: ['owner@example.test'] } : c)))
  const mails: Mail[] = []
  const inv = { id: 'inv-1', number: '2026051', status: 'AUTHORISED', reference: 'x', currency: 'EUR', totalCents: 481_000, contactId: WAVE, contactEmail: 'accounts@wave.example', hasAddress: true, sentToContact: false } as XeroInvoiceDetail
  const api: XeroApi = { async organisation() { return { name: isDemo ? 'Demo Company (UK)' : 'Fonenova Ltd', isDemo } }, async invoiceNumbers() { return [] }, async findByReference() { return null }, async createDraft() { throw new Error('n/a') }, async getInvoice() { return { ...inv } }, async emailInvoice() {}, async invoicePdf() { return PDF } }
  const thread = opts.thread ?? threadFixture()
  let reads = 0
  const bytesOf = (name: string) => (/IMEI/.test(name) ? SHEET : LABEL)
  const asked: string[] = []
  const d: InvoiceDeps = { store, now: NOW, allowReal: opts.allowReal ?? true, allowLiveXero: opts.allowLive ?? true, allowApprove: true, ownerAddress: 'owner@example.test', notify: async () => true, knownOrderIds: async () => [], xero: () => api, reply: async () => ({ id: 'r' }), replied: async () => false,
    mail: async (m) => { if (opts.mailFails) throw new Error('Gmail did not send it (500)'); mails.push(m); return { id: `sent-${mails.length}`, threadId: m.threadId ?? 'newthread0000001' } },
    ...(opts.noGmailThread ? {} : { gmailThread: { async messages(t: string) { asked.push(t); reads++; return t === THREAD || t === '1a2b3c4d5e6f7a8b' ? thread.map((m) => ({ ...m, files: m.files.map((f) => ({ ...f, attachmentId: `${f.attachmentId}-read${reads}` })) })) : [] }, async file(mid: string, aid: string) { const f = thread.flatMap((m) => m.files).find((x) => x.messageId === mid && aid === `${x.attachmentId}-read${reads}`); if (!f) throw new Error('Gmail returned an empty attachment'); return bytesOf(f.filename) }, async rfcId() { return '<invoice-msg@mail.gmail.com>' } } }),
    filing: { dirs: null, upload: async () => ({ kind: 'ok' }) }, bills: async () => ({ bills: [], pairs: [] }), savePair: async () => {} }
  return { d, mails, asked, thread, get: () => (store.data.get('offers') as Offer[])[0] }
}
const pick = (ms: ThreadMessage[], name: string) => { const f = ms.flatMap((m) => m.files).find((x) => x.filename === name)!; return { messageId: f.messageId, partId: f.partId } }

describe('reading Gmail threads', () => {
  it('turns what is pasted into a thread id: the hex id, or the decimal id in a Gmail link', () => {
    expect(gmailThreadIdFrom('19e3aa5907590027')).toBe('19e3aa5907590027')
    expect(gmailThreadIdFrom('https://mail.google.com/mail/?authuser=info@fonenova.com#all/thread-f:1881940372914403044')).toBe(BigInt('1881940372914403044').toString(16))
    expect(gmailThreadIdFrom('https://mail.google.com/mail/u/0/#inbox/19e3aa5907590027')).toBe('19e3aa5907590027')
    expect(gmailThreadIdFrom('hello')).toBeNull()
    expect(gmailThreadIdFrom('')).toBeNull()
  })
  it('lists real attachments from nested parts and skips the text bodies', () => {
    const j = { id: 'm1', payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'aGk' } }] }, { partId: '0.1', mimeType: 'application/pdf', filename: 'label.pdf', body: { attachmentId: 'ATT1', size: 1234 } }, { mimeType: 'application/zip', filename: '', body: { attachmentId: 'NOPE', size: 5 } }] } }
    expect(parseGmailFiles(j)).toEqual([{ messageId: 'm1', partId: '0.1', attachmentId: 'ATT1', filename: 'label.pdf', mime: 'application/pdf', size: 1234 }])
    const t = parseGmailThread({ messages: [{ ...j, internalDate: '1779276425000', labelIds: ['INBOX'], payload: { ...j.payload, headers: [{ name: 'From', value: MO }, { name: 'Subject', value: 'IMEI' }] } }] })
    expect(t[0]).toMatchObject({ id: 'm1', from: MO, subject: 'IMEI', labels: ['INBOX'] })
    expect(t[0].files).toHaveLength(1)
  })
  it('offers files other people sent: not our own messages, not pictures, newest first', () => {
    const names = candidatesIn(threadFixture()).map((c) => c.filename)
    expect(names).toEqual(['IMEI sheet.xlsx', 'IMEI sheet 2.xlsx', 'Invoice 2026050050.pdf'])
  })
  it('knows a spreadsheet is the IMEI list and a DHL pdf is the label', () => {
    expect(kindOf('IMEI sheet.xlsx', '')).toBe('imei')
    expect(kindOf('stock.csv', '')).toBe('imei')
    expect(kindOf('DHL label.pdf', 'application/pdf')).toBe('label')
    expect(kindOf('Invoice 2026050050.pdf', 'application/pdf')).toBe('other')
  })
})

describe('only IMEI lists, never a label or an invoice', () => {
  const withLabel = (): ThreadMessage[] => [
    msg('aaaaaaaaaaaaaaa1', MO, ['INBOX'], [{ name: 'Invoice 2026050050.pdf', mime: 'application/pdf' }, { name: 'DHL Label_2026050047.pdf', mime: 'application/pdf', size: 66_000 }], 1),
    msg('aaaaaaaaaaaaaaa3', MO, ['INBOX'], [{ name: 'IMEI_2026050047.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 12_000 }], 3),
  ]
  it('the finder lists the IMEI list and leaves the DHL label and the invoice out', async () => {
    const t = setup(offer(), { thread: withLabel() })
    const r = await findImeiFiles('of_i1', t.d)
    expect(r.candidates!.map((c) => c.filename)).toEqual(['IMEI_2026050047.xlsx'])
    expect(r.message).toContain('1 IMEI list found')
  })
  it('says there is no IMEI list when the thread only has a label and an invoice', async () => {
    const t = setup(offer(), { thread: withLabel().slice(0, 1) })
    const r = await findImeiFiles('of_i1', t.d)
    expect(r.candidates).toEqual([])
    expect(r.message).toContain('No IMEI list in that thread yet')
  })
  it('even if a label is asked for directly, it is refused and nothing is saved', async () => {
    const t = setup(offer(), { thread: withLabel() })
    const label = pick(t.thread, 'DHL Label_2026050047.pdf')
    expect(await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [label] })).toMatchObject({ ok: false, message: expect.stringContaining('Only an IMEI list can be sent') })
    expect(t.get().fulfilment!.imei).toBeUndefined()
    const mixed = await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI_2026050047.xlsx'), label] })
    expect(mixed).toMatchObject({ ok: false })
    expect(t.get().fulfilment!.imei).toBeUndefined()
  })
  it('the email says IMEI list, never shipping details', () => {
    const f = (filename: string) => ({ messageId: 'a', partId: '0.1', filename, mime: 'x', size: 1, kind: 'imei' as const })
    expect(imeiLine({ threadId: 't', chosenAt: 'x', files: [f('IMEI.xlsx')] })).toBe('The IMEI list is attached: IMEI.xlsx.')
    expect(imeiLine({ threadId: 't', chosenAt: 'x', files: [f('a.xlsx'), f('b.xlsx')] })).toBe('The IMEI lists are attached: a.xlsx, b.xlsx.')
  })
})

describe('finding and choosing the files', () => {
  it('looks in the offer\'s own Mobile One thread and saves nothing until files are chosen', async () => {
    const t = setup(offer())
    const r = await findImeiFiles('of_i1', t.d)
    expect(r).toMatchObject({ ok: true, threadId: THREAD })
    expect(r.candidates!.map((c) => c.filename)).toContain('IMEI sheet.xlsx')
    expect(t.get().fulfilment!.imei).toBeUndefined()
  })
  it('a pasted link can point at another thread (Mobile One sometimes starts a new one)', async () => {
    const t = setup(offer())
    const r = await findImeiFiles('of_i1', t.d, { thread: 'https://mail.google.com/mail/?authuser=x#all/thread-f:' + BigInt('0x1a2b3c4d5e6f7a8b').toString() })
    expect(r.ok).toBe(true)
    expect(t.asked).toContain('1a2b3c4d5e6f7a8b')
    expect(await findImeiFiles('of_i1', t.d, { thread: 'not a link' })).toMatchObject({ ok: false })
  })
  it('a real order only takes files from a thread Mobile One wrote in', async () => {
    const t = setup(offer(), { thread: [msg('aaaaaaaaaaaaaaa9', 'Someone <x@elsewhere.example>', ['INBOX'], [{ name: 'IMEI.xlsx' }])] })
    expect(await findImeiFiles('of_i1', t.d)).toMatchObject({ ok: false, message: expect.stringContaining('nothing from Mobile One') })
    const test = setup(offer(true), { thread: [msg('aaaaaaaaaaaaaaa9', 'Me <me@example.test>', ['INBOX'], [{ name: 'IMEI.xlsx' }])] })
    expect((await findImeiFiles('of_i1', test.d, { thread: THREAD })).ok).toBe(true)
  })
  it('a test offer has no real thread of its own, so it asks for a pasted one', async () => {
    const t = setup(offer(true, 'test-abc'))
    expect(await findImeiFiles('of_i1', t.d)).toMatchObject({ ok: false, message: expect.stringContaining('Paste the link') })
  })
  it('says so when Gmail is not connected, and when the offer was not accepted', async () => {
    expect(await findImeiFiles('of_i1', setup(offer(), { noGmailThread: true }).d)).toMatchObject({ ok: false, message: expect.stringContaining('Gmail is not connected') })
    const o = offer(); o.status = 'sent'
    expect(await findImeiFiles('of_i1', setup(o).d)).toMatchObject({ ok: false })
  })
  it('saves only files that really are in that thread, and only where they are, never the bytes', async () => {
    const t = setup(offer())
    const sheet = pick(t.thread, 'IMEI sheet.xlsx')
    expect(await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [{ messageId: sheet.messageId, partId: '9.9' }] })).toMatchObject({ ok: false, message: expect.stringContaining('not in that thread') })
    expect(await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [] })).toMatchObject({ ok: false })
    const r = await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [sheet, pick(t.thread, 'IMEI sheet 2.xlsx'), sheet] })
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('attached to the invoice email') })
    const saved = t.get().fulfilment!.imei!
    expect(saved.threadId).toBe(THREAD)
    expect(saved.files.map((f) => `${f.filename}:${f.kind}`)).toEqual(['IMEI sheet.xlsx:imei', 'IMEI sheet 2.xlsx:imei'])
    expect(JSON.stringify(t.get())).not.toContain('PK')
  })
  it('refuses files that are too big together, and the choice can be removed until it is sent', async () => {
    const big = setup(offer(), { thread: [msg('aaaaaaaaaaaaaaa1', MO, ['INBOX'], [{ name: 'a.xlsx', size: 9_000_000 }, { name: 'b.xlsx', size: 9_000_000 }])] })
    expect(await attachImeiFiles('of_i1', big.d, { thread: THREAD, picks: [pick(big.thread, 'a.xlsx'), pick(big.thread, 'b.xlsx')] })).toMatchObject({ ok: false, message: expect.stringContaining('too big') })
    const t = setup(offer())
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx')] })
    expect(await clearImeiFiles('of_i1', t.d)).toMatchObject({ ok: true })
    expect(t.get().fulfilment!.imei).toBeUndefined()
  })
})

describe('Gmail hands out a different attachment handle on every read', () => {
  it('a file chosen from one listing is still found, and fetched, when the handle has since changed', async () => {
    const t = setup(offer())
    const listed = await findImeiFiles('of_i1', t.d)
    const sheet = listed.candidates!.find((c) => c.filename === 'IMEI sheet.xlsx')!
    // The choice carries the file's place in the email, not Gmail's handle for it.
    expect(await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [{ messageId: sheet.messageId, partId: sheet.partId }] })).toMatchObject({ ok: true })
    expect(JSON.stringify(t.get().fulfilment!.imei)).not.toContain('attachmentId')
    // Several reads later (the thread is read again to send), the bytes still come.
    await t.d.gmailThread!.messages(THREAD)
    await t.d.gmailThread!.messages(THREAD)
    expect(await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    expect(t.mails[0].attachments[1]).toMatchObject({ filename: 'IMEI sheet.xlsx' })
    expect(t.mails[0].attachments[1].bytes).toEqual(SHEET)
  })
  it('a chosen file that has left the thread stops the send with a plain message', async () => {
    const t = setup(offer())
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx')] })
    t.thread.splice(0, t.thread.length, ...t.thread.filter((m) => m.id !== 'aaaaaaaaaaaaaaa3'))
    expect(await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('no longer in the Gmail thread') })
    expect(t.mails).toHaveLength(0)
  })
})

describe('the files go with the invoice when they are chosen first', () => {
  it('attaches them to the invoice email next to the PDF, says so in the text, and marks them sent', async () => {
    const t = setup(offer())
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx'), pick(t.thread, 'IMEI sheet 2.xlsx')] })
    expect(await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    expect(t.mails).toHaveLength(1)
    expect(t.mails[0].attachments.map((a) => a.filename)).toEqual(['Invoice-2026051.pdf', 'IMEI sheet.xlsx', 'IMEI sheet 2.xlsx'])
    expect(t.mails[0].attachments[1].bytes).toEqual(SHEET)
    expect(t.mails[0].text).toContain('IMEI list')
    const f = t.get().fulfilment!
    expect(f.imei!.sent).toMatchObject({ state: 'done', how: 'with_invoice', to: 'accounts@wave.example' })
    expect(f.send).toMatchObject({ state: 'done', messageId: 'sent-1', threadId: 'newthread0000001', detail: expect.stringContaining('with IMEI files') })
    // They are not sent a second time.
    expect(await sendImeiFollowUp('of_i1', t.d, { confirm: true })).toMatchObject({ ok: true, message: 'Already sent.' })
    expect(t.mails).toHaveLength(1)
  })
  it('without a choice the invoice email is exactly as before', async () => {
    const t = setup(offer())
    await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })
    expect(t.mails[0].attachments.map((a) => a.filename)).toEqual(['Invoice-2026051.pdf'])
    expect(t.mails[0].text).not.toContain('IMEI')
  })
  it('if the files cannot be fetched, nothing is sent and the invoice send can be tried again', async () => {
    const t = setup(offer())
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx')] })
    const broken = { ...t.d, gmailThread: { ...t.d.gmailThread!, file: async () => { throw new Error('Gmail answered 500') } } }
    expect(await sendInvoice('of_i1', broken, { confirm: true, via: 'gmail' })).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was sent') })
    expect(t.mails).toHaveLength(0)
    expect(await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })).toMatchObject({ ok: true })
    expect(t.mails).toHaveLength(1)
  })
})

describe('the files follow in the same thread when they come later', () => {
  async function sentWithoutFiles(o = offer(), opts: Parameters<typeof setup>[1] = {}) {
    const t = setup(o, opts)
    await sendInvoice('of_i1', t.d, { confirm: true, via: 'gmail' })
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx'), pick(t.thread, 'IMEI sheet 2.xlsx')] })
    return t
  }
  it('replies in the thread of the invoice email, to the client, with the files attached', async () => {
    const t = await sentWithoutFiles()
    expect(await sendImeiFollowUp('of_i1', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(t.mails).toHaveLength(2)
    const m = t.mails[1]
    expect(m).toMatchObject({ to: 'accounts@wave.example', subject: 'Re: Invoice 2026051 from FoneNova Ltd', threadId: 'newthread0000001', inReplyTo: '<invoice-msg@mail.gmail.com>' })
    expect(m.attachments.map((a) => a.filename)).toEqual(['IMEI sheet.xlsx', 'IMEI sheet 2.xlsx'])
    expect(m.text).toContain('Please find the IMEI list for invoice 2026051')
    expect(m.text).not.toContain('shipping')
    expect(t.get().fulfilment!.imei!.sent).toMatchObject({ state: 'done', how: 'follow_up' })
  })
  it('three clicks at once send once', async () => {
    const t = await sentWithoutFiles()
    await Promise.all([1, 2, 3].map(() => sendImeiFollowUp('of_i1', t.d, { confirm: true })))
    expect(t.mails).toHaveLength(2)
  })
  it('needs the tick, the choice and an invoice that has gone', async () => {
    const t = await sentWithoutFiles()
    expect(await sendImeiFollowUp('of_i1', t.d, { confirm: false })).toMatchObject({ ok: false })
    const none = setup(offer()); await sendInvoice('of_i1', none.d, { confirm: true, via: 'gmail' })
    expect(await sendImeiFollowUp('of_i1', none.d, { confirm: true })).toMatchObject({ ok: false, message: 'Choose the IMEI files first.' })
    const early = setup(offer())
    await attachImeiFiles('of_i1', early.d, { thread: THREAD, picks: [pick(early.thread, 'IMEI sheet.xlsx')] })
    expect(await sendImeiFollowUp('of_i1', early.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('invoice has not been sent yet') })
    expect(early.mails).toHaveLength(0)
  })
  it('keeps the same gates as sending the invoice', async () => {
    const noReal = await sentWithoutFiles(); noReal.d.allowReal = false
    expect(await sendImeiFollowUp('of_i1', noReal.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('OFFERS_ALLOW_REAL_SEND') })
    const noLive = await sentWithoutFiles(); noLive.d.allowLiveXero = false
    expect(await sendImeiFollowUp('of_i1', noLive.d, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('XERO_WRITE_ALLOW_LIVE') })
    expect(noReal.mails.length + noLive.mails.length).toBe(2) // only the two invoices
    const test = await sentWithoutFiles(offer(true))
    expect(test.mails[0].to).toBe('owner@example.test')
    expect(await sendImeiFollowUp('of_i1', test.d, { confirm: true })).toMatchObject({ ok: true })
    expect(test.mails[1].subject).toBe('Re: [TEST] Invoice 2026051 from FoneNova Ltd')
  })
  it('an invoice that went by Xero\'s own email has no thread of ours, so the files go as a new email', async () => {
    const t = setup(offer())
    await sendInvoice('of_i1', t.d, { confirm: true, via: 'xero' })
    await attachImeiFiles('of_i1', t.d, { thread: THREAD, picks: [pick(t.thread, 'IMEI sheet.xlsx')] })
    expect(await sendImeiFollowUp('of_i1', t.d, { confirm: true })).toMatchObject({ ok: true })
    expect(t.mails[0].threadId).toBeUndefined()
    expect(t.mails[0].subject).toBe('IMEI list for invoice 2026051')
  })
  it('a failed send says where to look and is not retried by itself', async () => {
    const t = await sentWithoutFiles()
    const bad = { ...t.d, mail: async () => { throw new Error('Gmail did not send it (500)') } }
    expect(await sendImeiFollowUp('of_i1', bad, { confirm: true })).toMatchObject({ ok: false, message: expect.stringContaining('Sent folder of info@fonenova.com') })
    expect(t.get().fulfilment!.imei!.sent!.state).toBe('failed')
    // The person can choose to try once more, which is the same explicit click.
    expect(await sendImeiFollowUp('of_i1', t.d, { confirm: true })).toMatchObject({ ok: true })
  })
})

describe('the panel', () => {
  const render = (o: Offer) => renderToString(h(InvoiceSteps, { offer: o, setup: { allowApprove: true, allowReal: true, allowLiveXero: true, filingConfigured: true, orgIsLive: true } })).replace(/<!-- -->/g, '')
  const withImei = (state: 'chosen' | 'sent-with' | 'sent-later', invoiceSent: boolean) => {
    const o = offer()
    if (invoiceSent) o.fulfilment!.send = { state: 'done', at: HOURS(1), detail: 'a@x.example (Gmail, PDF attached)' }
    o.fulfilment!.imei = { threadId: THREAD, chosenAt: HOURS(1), files: [{ messageId: 'aaaaaaaaaaaaaaa3', partId: '0.1', filename: 'IMEI sheet.xlsx', mime: 'x', size: 52_000, kind: 'imei' }], ...(state === 'chosen' ? {} : { sent: { state: 'done' as const, at: HOURS(0), how: state === 'sent-with' ? ('with_invoice' as const) : ('follow_up' as const), to: 'a@x.example' } }) }
    return o
  }
  it('before anything is chosen it offers to find the files', () => {
    const html = render(offer())
    expect(html).toContain('step-imei')
    expect(html).toContain('imei-find-button')
    expect(html).toContain('imei-thread-input')
  })
  it('chosen before the invoice: they go with it; chosen after: a separate, ticked send', () => {
    expect(render(withImei('chosen', false))).toContain('imei-with-invoice')
    const after = render(withImei('chosen', true))
    expect(after).toContain('imei-send-button')
    expect(after).not.toContain('imei-with-invoice')
  })
  it('once sent it says how', () => {
    expect(render(withImei('sent-with', true))).toContain('Sent with the invoice')
    expect(render(withImei('sent-later', true))).toContain('Sent in the same thread as the invoice')
  })
})
