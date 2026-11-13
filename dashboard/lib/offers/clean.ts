/**
 * Mobile One's emails as plain offer text: quoted replies, forwarded headers, the signature and
 * image placeholders removed. Pure, so it runs anywhere and is tested on the real samples.
 */
const QUOTE_START = [
  /^On .{4,200}\bwrote:\s*$/i,
  /^On .{4,200}$/i, // "On Wed, 30 Sept 2026, 13:59 Mobile One Trade," … "wrote:" on the next line
  /^_{10,}\s*$/,
  /^-{3,}\s*Original Message\s*-{3,}/i,
  /^From:\s.+/i,
]
const SIGN_OFF = /^(sincerely|kind regards|best regards|regards|thanks|thank you|many thanks)[,.!]?\s*$/i

export function cleanOfferText(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('>')) continue
    if (QUOTE_START[0].test(t) || QUOTE_START.slice(2).some((r) => r.test(t))) break
    if (QUOTE_START[1].test(t) && /wrote:\s*$/i.test(`${t} ${lines[i + 1]?.trim() ?? ''}`)) break
    if (SIGN_OFF.test(t)) break
    out.push(line)
  }
  return out
    .join('\n')
    .replace(/\[image:[^\]]*\]/gi, '')
    .replace(/\[https?:[^\]]*\]/gi, '')
    .replace(/\*(\S[^*\n]*?)\*/g, '$1') // *bold* from HTML mail; a "* " bullet stays
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Worth asking the reader about: has some text and at least one number of two or more digits. */
export function mayBeOffer(text: string): boolean {
  return text.length > 10 && /\d{2,}/.test(text)
}

/** "Mobile One Trade <bv@mobileone.info>" → "bv@mobileone.info". */
export function emailAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase()
}
