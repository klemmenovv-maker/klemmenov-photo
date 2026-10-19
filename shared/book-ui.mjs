// Pure helpers for the /book/ page (no DOM). Copied to docs/assets by tools/build.py.

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function formatAed(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function parseServiceParam(search, services) {
  if (typeof search !== 'string' || !services) return null;
  let id;
  try { id = new URLSearchParams(search).get('service'); } catch { return null; }
  return typeof id === 'string' && has(services, id) ? id : null;
}

export function waUrl(number, text) {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

// result: successful quote() result. contact: {name, reach, notes, preferredDate, greeting}.
// addons: optional {id: quantity} to show quantities. opts.quoteLabels: optional {id: label} for quote-only add-ons.
export function buildWhatsAppText(result, contact, addons = {}, opts = {}) {
  const c = contact || {};
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const out = [];
  if (clean(c.greeting)) out.push(clean(c.greeting));
  const [base, ...extras] = result.lines;
  const hours = result.hours === undefined ? '' : `, ${result.hours} ${result.hours === 1 ? 'hour' : 'hours'}`;
  out.push(`Shoot: ${base.label}${hours}`);
  for (const l of extras) {
    const q = addons[l.id];
    out.push(q > 1 ? `${l.label} x ${q}` : l.label);
  }
  const labels = opts.quoteLabels || {};
  for (const id of result.quoteOnly || []) {
    out.push(`${has(labels, id) ? labels[id] : id.replace(/_/g, ' ')} (quote, confirmed by the photographer)`);
  }
  out.push(`Total online: ${formatAed(result.total)} AED`);
  if (clean(c.preferredDate)) out.push(`Preferred date: ${clean(c.preferredDate)}`);
  if (clean(c.name)) out.push(`Name: ${clean(c.name)}`);
  if (clean(c.reach)) out.push(`Contact: ${clean(c.reach)}`);
  if (clean(c.notes)) out.push(`Notes: ${clean(c.notes)}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- live mode (booking Worker API)
// All network helpers take fetchImpl so tests inject a fake. Nothing here touches the DOM or storage.

export class BookingApiError extends Error {
  constructor(code, status = 0) {
    super(code);
    this.name = 'BookingApiError';
    this.code = code;
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 10000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const base = (api) => String(api).replace(/\/+$/, '');

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// JSON request -> parsed body. Non-2xx -> BookingApiError(worker code | 'http_error', status).
async function requestJson(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: timeoutSignal(FETCH_TIMEOUT_MS) });
  } catch {
    throw new BookingApiError('network', 0);
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const code = isObj(body) && typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : 'http_error';
    throw new BookingApiError(code, res.status);
  }
  if (body === null) throw new BookingApiError('bad_response', res.status);
  return body;
}

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

function isDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export const dubaiToday = (nowMs) => new Date(nowMs + 4 * 3600000).toISOString().slice(0, 10);

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-10-20" -> "Tue 20 Oct" (calendar date only, no time zone conversion)
export function dayLabel(day) {
  if (!isDay(day)) return '';
  const d = new Date(`${day}T00:00:00Z`);
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}

// Worker start "2026-10-21T18:30:00+04:00" -> "Wed 21 Oct, 18:30" (already Dubai local time)
export function slotWhen(start) {
  if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) return '';
  const label = dayLabel(start.slice(0, 10));
  return label ? `${label}, ${start.slice(11, 16)}` : '';
}

// offsetMin: minutes east of UTC on the visitor's device (= -Date#getTimezoneOffset()).
export const tzDiffers = (offsetMin) => offsetMin !== 240;

function validSlot(day, s) {
  return isObj(s) && typeof s.time === 'string' && TIME_RE.test(s.time) && typeof s.start === 'string'
    && s.start === `${day}T${s.time}:00+04:00`;
}

export async function loadSlots(api, selection, range, fetchImpl) {
  const q = new URLSearchParams({ service: selection.serviceId });
  if (selection.hours !== undefined) q.set('hours', String(selection.hours));
  q.set('from', range.from);
  q.set('to', range.to);
  const body = await requestJson(fetchImpl, `${base(api)}/availability?${q}`);
  const bad = () => new BookingApiError('bad_response', 200);
  if (!isObj(body) || typeof body.timezone !== 'string' || !Number.isInteger(body.durationMin) || !isObj(body.days)) throw bad();
  const days = [];
  for (const date of Object.keys(body.days).sort()) {
    const list = body.days[date];
    if (!isDay(date) || !Array.isArray(list) || !list.every((s) => validSlot(date, s))) throw bad();
    days.push({ date, slots: list.map((s) => ({ time: s.time, start: s.start })) });
  }
  return { timezone: body.timezone, durationMin: body.durationMin, days };
}

// Only https pages on ziina.com or its subdomains, no credentials, default port.
export function isAllowedRedirect(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return h === 'ziina.com' || h.endsWith('.ziina.com');
}

export async function submitCheckout(api, payload, fetchImpl) {
  const body = await requestJson(fetchImpl, `${base(api)}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!isObj(body) || !isUuid(body.bookingId) || !Number.isFinite(body.totalAed) || !Number.isFinite(body.depositAed)) {
    throw new BookingApiError('bad_response', 200);
  }
  if (!isAllowedRedirect(body.redirectUrl)) throw new BookingApiError('bad_redirect', 200);
  return { bookingId: body.bookingId, redirectUrl: body.redirectUrl, totalAed: body.totalAed, depositAed: body.depositAed };
}

const FINAL = new Set(['paid', 'expired']);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls GET /booking/:id. Returns the Worker's object once status is paid or expired,
// {status:'unknown'} for a bad or unknown id, {status:'pending'} when timeoutMs passes.
// Network errors and 5xx answers are retried until the timeout.
export async function pollBooking(api, id, fetchImpl, opts = {}) {
  const { intervalMs = 3000, timeoutMs = 60000, sleep = defaultSleep } = opts;
  if (!isUuid(id)) return { status: 'unknown' };
  for (let waited = 0; ; waited += intervalMs) {
    try {
      const b = await requestJson(fetchImpl, `${base(api)}/booking/${id}`);
      if (isObj(b) && FINAL.has(b.status)) return b;
    } catch (e) {
      if (e instanceof BookingApiError && e.status === 404) return { status: 'unknown' };
    }
    if (waited + intervalMs > timeoutMs) return { status: 'pending' };
    await sleep(intervalMs);
  }
}

const WA_HINT = ' You can also request the shoot in WhatsApp.';
const MESSAGES = {
  slot_taken: 'Someone has just taken this time. Please choose another time.',
  slot_unavailable: 'This time is no longer free. Please choose another time.',
  calendar_unavailable: 'Available times could not be loaded right now.' + WA_HINT,
  payment_unavailable: 'The payment page could not be opened. Nothing was charged.' + WA_HINT,
  rate_limited: 'Too many attempts in a short time. Please wait a minute and try again.',
  terms_not_accepted: 'Please accept the booking terms to continue.',
  below_minimum: 'This shoot has a minimum number of hours. Add more hours.',
  invalid_hours: 'Choose between 1 and 12 hours.',
  invalid_name: 'Please enter your name.',
  invalid_contact: 'Please enter your WhatsApp number or Telegram username.',
  invalid_notes: 'The notes are too long. Please shorten them.',
  invalid_start: 'Please choose a date and time again.',
  network: 'The booking service could not be reached. Check your connection and try again.' + WA_HINT,
  bad_redirect: 'The payment link looked wrong, so it was not opened. Nothing was charged.' + WA_HINT,
  bad_response: 'The booking service sent an unexpected answer.' + WA_HINT,
};
const GENERIC = 'Something went wrong. Please try again.' + WA_HINT;

export function friendlyError(code) {
  return typeof code === 'string' && has(MESSAGES, code) ? MESSAGES[code] : GENERIC;
}

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

// state: {quote: quote() result, start, name, reach, terms}. Returns the missing pieces in form order.
export function payMissing(state) {
  const s = state || {};
  const out = [];
  if (!s.quote || s.quote.ok !== true) out.push('service');
  if (typeof s.start !== 'string' || !s.start) out.push('date');
  if (!trimmed(s.name)) out.push('name');
  if (Array.from(trimmed(s.reach)).length < 3) out.push('contact');
  if (s.terms !== true) out.push('terms');
  return out;
}

export const canPay = (state) => !!state && payMissing(state).length === 0;
