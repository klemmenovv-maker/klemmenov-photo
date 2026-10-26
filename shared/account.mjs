// Pure helpers for the account pages (/my/ for clients, /admin/ for the owner).
// The pages themselves are my-page.mjs and admin-page.mjs.

export const CLIENT_STATUS = {
  new: 'Received: waiting for confirmation',
  needs_details: 'Details needed: please add a time',
  confirmed: 'Confirmed',
  declined: 'Declined',
  cancelled: 'Cancelled',
  done: 'Done',
};
export const OWNER_STATUS = {
  new: 'Новая',
  needs_details: 'Ждём детали',
  confirmed: 'Подтверждена',
  declined: 'Отклонена',
  cancelled: 'Отменена',
  done: 'Проведена',
};

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DUBAI_MS = 4 * 3600000;

// Dubai wall clock of an ISO instant, as "YYYY-MM-DDTHH:mm" (value of <input type=datetime-local>).
export function toLocalInput(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + DUBAI_MS).toISOString().slice(0, 16) : '';
}
// ...and back: the value typed in the owner's form is Dubai time.
export function fromLocalInput(v) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v || '') ? `${v}:00+04:00` : null;
}

export function formatWhen(iso, lang = 'en') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return lang === 'ru' ? 'время не выбрано' : 'time not chosen';
  const d = new Date(ms + DUBAI_MS);
  const m = (lang === 'ru' ? MONTHS_RU : MONTHS_EN)[d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)}`;
}

// Where the browser keeps the visitor's private token. Never throws (private windows, blocked storage).
export function tokenStore(storage, key) {
  return {
    get() { try { return storage.getItem(key) || null; } catch { return null; } },
    set(v) { try { v ? storage.setItem(key, v) : storage.removeItem(key); } catch { /* storage unavailable */ } },
  };
}
export const CLIENT_KEY = 'klemmenov.client';
export const OWNER_KEY = 'klemmenov.owner';

// JSON call to the Worker. Never throws: { ok, status, data }.
export async function api(base, path, { method = 'GET', token, body } = {}, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

// "#s=<session>" or "#error=<code>" left by the Google sign-in redirect.
export function readHash(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  return { session: p.get('s'), error: p.get('error') };
}
