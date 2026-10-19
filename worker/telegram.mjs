// Telegram notifier for the owner. Only fetch + standard APIs (Cloudflare Worker safe).
import { timeoutSignal, timeoutMs } from './fetch-timeout.mjs';
const API = 'https://api.telegram.org';
const MAX_TEXT = 4000;
const MAX_NOTES = 300;

export class TelegramError extends Error {
  // `secret` (the bot token) is scrubbed from body before truncation.
  constructor(message, status = 0, body = '', secret = '') {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    let b = String(body);
    if (secret) b = b.split(secret).join('[redacted]');
    this.body = b.slice(0, 300);
  }
}

function truncate(text) {
  const chars = Array.from(text);
  if (chars.length <= MAX_TEXT) return text;
  let out = chars.slice(0, MAX_TEXT - 1).join('');
  // Do not leave a half entity or half tag that Telegram's HTML parser would reject.
  out = out.replace(/&[#a-zA-Z0-9]*$/, '').replace(/<[^>]*$/, '');
  return out + '…';
}

export async function notify(env, text, fetchImpl = fetch) {
  const token = env && env.TELEGRAM_BOT_TOKEN;
  const chatId = env && env.TELEGRAM_CHAT_ID;
  if (!token) throw new TelegramError('TELEGRAM_BOT_TOKEN is not configured', 0);
  if (chatId === undefined || chatId === null || chatId === '') {
    throw new TelegramError('TELEGRAM_CHAT_ID is not configured', 0);
  }
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: truncate(String(text)),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: timeoutSignal(timeoutMs(env)),
  };
  let res;
  try {
    res = await fetchImpl(`${API}/bot${token}/sendMessage`, init);
  } catch {
    if (init.signal.aborted) throw new TelegramError('Telegram request timed out', 0);
    // The URL contains the token, so the original error is deliberately dropped.
    throw new TelegramError('Telegram request failed (network error)', 0);
  }
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  if (init.signal.aborted) throw new TelegramError('Telegram request timed out', 0);
  if (!res.ok) throw new TelegramError(`Telegram responded with HTTP ${res.status}`, res.status, body, token);
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!data || data.ok !== true) {
    throw new TelegramError('Telegram did not accept the message', res.status, body, token);
  }
}

// ---- formatting ----

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g; // keeps \t and \n

// Single-line user text: strip control chars, collapse all whitespace.
const line = (s) => esc(String(s ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim());

// Multi-line block (notes): keep newlines, cap in code points before escaping.
function block(s, max) {
  const clean = String(s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  return esc(Array.from(clean).slice(0, max).join(''));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DUBAI_OFFSET_MIN = 240;
const pad = (n) => String(n).padStart(2, '0');

// ISO string -> Dubai wall-clock parts, via pure UTC arithmetic (no Intl, no local tz).
function dubaiParts(iso) {
  const m = ISO.exec(String(iso ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, off] = m;
  let offMin = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi) - offMin * 60000;
  const t = new Date(utcMs + DUBAI_OFFSET_MIN * 60000);
  if (Number.isNaN(t.getTime())) return null;
  return {
    date: `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`,
    day: `${t.getUTCFullYear()}-${t.getUTCMonth()}-${t.getUTCDate()}`,
    time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}

function formatWhen(start, end) {
  const s = dubaiParts(start);
  if (!s) return `${line(start)} (unrecognised date)`;
  const e = dubaiParts(end);
  if (!e) return `${s.date}, ${s.time} (Dubai time)`;
  if (e.day === s.day) return `${s.date}, ${s.time}-${e.time} (Dubai time)`;
  return `${s.date}, ${s.time} - ${e.date}, ${e.time} (Dubai time)`;
}

const num = (n) => (Number.isFinite(Number(n)) ? String(Number(n)) : '?');

function details(b) {
  const out = [
    `Service: ${line(b.serviceLabel)}`,
    `When: ${formatWhen(b.start, b.end)}`,
    `Name: ${line(b.name)}`,
    `Contact: ${line(b.contact)}`,
    `Deposit paid: ${num(b.depositAed)} AED`,
  ];
  const remaining = Number(b.totalAed) - Number(b.depositAed);
  out.push(`Remaining on the day: ${num(remaining)} AED`);
  for (const item of Array.isArray(b.quoteOnly) ? b.quoteOnly : []) {
    out.push(`To confirm: ${line(item)}`);
  }
  const notes = block(b.notes, MAX_NOTES);
  if (notes) out.push(`Notes: ${notes}`);
  out.push(`Booking: ${line(b.id)}`);
  return out;
}

export function formatPaid(booking) {
  return ['<b>New paid booking</b>', ...details(booking || {})].join('\n');
}

const REASONS = {
  slot_taken_after_expiry: 'Payment arrived, but the slot was taken by someone else after the hold expired.',
  slot_taken: 'Payment arrived, but the slot is already taken.',
  calendar_failed: 'Payment arrived, but the calendar event could not be created.',
  amount_mismatch: 'Payment arrived, but the amount does not match the booking.',
  calendar_conflict: 'Payment arrived, but your calendar already has an event at this time.',
};

export function formatAttention(booking, reason) {
  const text = Object.hasOwn(REASONS, reason) ? REASONS[reason] : line(reason);
  return [
    '<b>Needs your attention</b>',
    text,
    ...details(booking || {}),
    'Please contact the client and fix the calendar manually.',
  ].join('\n');
}

const ALERTS = {
  payment_lookup_failed: 'A payment webhook arrived, but the Worker could not confirm the payment with Ziina.',
  internal_error: 'A payment webhook arrived, but the Worker hit an unexpected error while recording it.',
};

// Owner alert for a webhook that failed after the booking was identified. Carries
// only the booking id and a static reason (no personal data). Unknown reasons
// fall back to the generic text and are never echoed.
export function formatPaymentAlert(bookingId, reason) {
  const text = Object.hasOwn(ALERTS, reason) ? ALERTS[reason] : ALERTS.internal_error;
  return [
    '<b>Payment webhook failed</b>',
    text,
    `Booking: ${line(bookingId)}`,
    'Ziina will retry. If no paid-booking message follows, check the payment in the Ziina dashboard.',
  ].join('\n');
}
