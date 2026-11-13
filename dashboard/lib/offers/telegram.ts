/**
 * Pings to Hamza's Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID). Only his chat; never throws,
 * so a Telegram outage can't stop an offer being saved. Not set up: it simply does nothing.
 */
import 'server-only'

const API = () => (process.env.FN_TELEGRAM_API_URL ?? 'https://api.telegram.org').replace(/\/$/, '')

export const telegramConfigured = () => !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)

export async function notify(text: string, link?: { label: string; url: string }): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return false
  try {
    const res = await fetch(`${API()}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: text.slice(0, 3500),
        disable_web_page_preview: true,
        ...(link ? { reply_markup: { inline_keyboard: [[{ text: link.label, url: link.url }]] } } : {}),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok
  } catch {
    return false
  }
}
