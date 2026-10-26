// Minimal Google Calendar client (service account, JWT bearer flow).
// Only fetch + WebCrypto + standard APIs (Cloudflare Worker safe).
import { timeoutSignal, timeoutMs } from './fetch-timeout.mjs';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const TZ = 'Asia/Dubai';
const REFRESH_MARGIN_S = 60;

export class GoogleError extends Error {
  // `secrets` are scrubbed from body before truncation.
  constructor(message, status = 0, body = '', secrets = []) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    let b = String(body);
    for (const s of secrets) {
      if (typeof s === 'string' && s.length >= 6) b = b.split(s).join('[redacted]');
    }
    b = b.replace(/-----BEGIN [A-Z ]*-----[\s\S]*?(-----END [A-Z ]*-----|$)/g, '[redacted]');
    this.body = b.slice(0, 500);
  }
}

// client_email -> { token, expiresAt (epoch s, already minus margin) }
const tokenCache = new Map();
export function _resetTokenCacheForTests() { tokenCache.clear(); }

function secretsOf(sa, extra = []) {
  const out = [...extra];
  if (sa && typeof sa === 'object') {
    for (const k of ['client_secret', 'refresh_token']) if (sa[k]) out.push(sa[k]);
    if (typeof sa.client_email === 'string') out.push(sa.client_email);
    if (typeof sa.private_key === 'string') {
      const k = sa.private_key;
      out.push(k, k.replace(/\n/g, '\\n'), k.replace(/\r?\n/g, ''));
      const body = k.replace(/-----[A-Z ]+-----/g, '');
      for (const line of body.split(/\\n|\r?\n/)) out.push(line.trim());
      out.push(body.replace(/\\n|\s+/g, ''));
    }
  }
  return out.filter((s) => typeof s === 'string' && s.length >= 6);
}

function parseConfig(env) {
  if (env?.GOOGLE_OAUTH_CLIENT_ID && env?.GOOGLE_OAUTH_CLIENT_SECRET && env?.GOOGLE_OAUTH_REFRESH_TOKEN) {
    if (!env.GOOGLE_CALENDAR_ID) throw new GoogleError('GOOGLE_CALENDAR_ID is not configured', 0);
    return { sa: { client_email: `oauth:${env.GOOGLE_OAUTH_CLIENT_ID}:${env.GOOGLE_OAUTH_REFRESH_TOKEN}`, oauth: true, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN }, calendarId: String(env.GOOGLE_CALENDAR_ID) };
  }
  if (!env || !env.GOOGLE_SA_JSON) throw new GoogleError('GOOGLE_SA_JSON is not configured', 0);
  if (!env.GOOGLE_CALENDAR_ID) throw new GoogleError('GOOGLE_CALENDAR_ID is not configured', 0);
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SA_JSON); } catch { throw new GoogleError('GOOGLE_SA_JSON is not valid JSON', 0); }
  if (!sa || typeof sa !== 'object' || typeof sa.client_email !== 'string' || !sa.client_email
    || typeof sa.private_key !== 'string' || !sa.private_key) {
    throw new GoogleError('GOOGLE_SA_JSON is missing client_email or private_key', 0);
  }
  return { sa, calendarId: String(env.GOOGLE_CALENDAR_ID) };
}

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signJwt(serviceAccount, scope, now) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = { iss: serviceAccount.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  let sig;
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8', pemToDer(serviceAccount.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    );
    sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input)));
  } catch {
    throw new GoogleError('Could not sign JWT with the service account private key', 0);
  }
  return `${input}.${b64url(sig)}`;
}

// Every request gets a timeout signal; a timeout is GoogleError status 0.
async function doFetch(env, fetchImpl, url, init) {
  const signal = timeoutSignal(timeoutMs(env));
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch {
    if (signal.aborted) throw new GoogleError('Google request timed out', 0);
    throw new GoogleError('Google request failed (network error)', 0);
  }
  return { res, signal };
}

async function readText({ res, signal }) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  if (signal.aborted) throw new GoogleError('Google request timed out', 0);
  return text;
}

async function getToken(env, sa, fetchImpl) {
  const now = Number.isFinite(env._nowSeconds) ? Math.floor(env._nowSeconds) : Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(sa.client_email);
  if (hit && now < hit.expiresAt) return hit.token;

  const jwt = sa.oauth ? null : await signJwt(sa, SCOPE, now);
  const secrets = secretsOf(sa, [jwt]);
  const body = new URLSearchParams(sa.oauth ? { grant_type: 'refresh_token', client_id: sa.client_id, client_secret: sa.client_secret, refresh_token: sa.refresh_token } : { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
  const sent = await doFetch(env, fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const { res } = sent;
  const text = await readText(sent);
  if (!res.ok) throw new GoogleError(`Google token endpoint responded with HTTP ${res.status}`, res.status, text, secrets);
  let data;
  try { data = JSON.parse(text); } catch { throw new GoogleError('Google token endpoint returned invalid JSON', res.status, text, secrets); }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new GoogleError('Google token response is missing access_token', res.status, '', secrets);
  }
  const ttl = Number.isFinite(data.expires_in) ? data.expires_in : 3600;
  tokenCache.set(sa.client_email, { token: data.access_token, expiresAt: now + ttl - REFRESH_MARGIN_S });
  return data.access_token;
}

async function api(env, sa, url, payload, fetchImpl, retried = false) {
  const token = await getToken(env, sa, fetchImpl);
  const secrets = secretsOf(sa, [token]);
  const sent = await doFetch(env, fetchImpl, url, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const { res } = sent;
  const text = await readText(sent);
  if ((res.status === 401 || res.status === 403) && !retried) {
    tokenCache.delete(sa.client_email);
    return api(env, sa, url, payload, fetchImpl, true);
  }
  if (!res.ok) throw new GoogleError(`Google API responded with HTTP ${res.status}`, res.status, text, secrets);
  let data;
  try { data = JSON.parse(text); } catch { throw new GoogleError('Google API returned invalid JSON', res.status, text, secrets); }
  if (!data || typeof data !== 'object') throw new GoogleError('Google API returned an unexpected response', res.status, text, secrets);
  return { data, text, secrets };
}

const OFFSET_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/i;
function checkInstant(v) {
  if (typeof v !== 'string' || !OFFSET_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new GoogleError('Google returned a busy range without an explicit UTC offset', 0);
  }
  return v;
}

export async function getBusy(env, { from, to }, fetchImpl = fetch) {
  const { sa, calendarId } = parseConfig(env);
  const { data, text, secrets } = await api(env, sa, `${API}/freeBusy`, {
    timeMin: from, timeMax: to, timeZone: TZ, items: [{ id: calendarId }],
  }, fetchImpl);
  const cal = data.calendars && data.calendars[calendarId];
  if (!cal) throw new GoogleError('Google freeBusy response is missing the calendar', 200, text, secrets);
  if (Array.isArray(cal.errors) && cal.errors.length) {
    throw new GoogleError('Google freeBusy reported calendar errors', 200, JSON.stringify(cal.errors), secrets);
  }
  if (!Array.isArray(cal.busy)) throw new GoogleError('Google freeBusy response is missing busy ranges', 200, text, secrets);
  return cal.busy.map((r) => ({ start: checkInstant(r && r.start), end: checkInstant(r && r.end) }));
}

// Plain text only. Strip control chars, bidi/zero-width, line/paragraph separators.
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029]/g;
function sanitize(v, max, multiline = false) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE_RE, '');
  s = s.replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g : /[\u0000-\u001f\u007f-\u009f]/g, multiline ? '' : ' ');
  if (!multiline) s = s.replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('');
}
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const line = (v, max) => escHtml(sanitize(v, max));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deterministic Google event id for a booking: "kb" + the UUID's 32 hex digits,
// lowercased (hex digits are valid base32hex). Re-inserting the same booking
// then fails with HTTP 409 instead of creating a second event.
export function eventIdFor(bookingId) {
  if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
    throw new GoogleError('bookingId must be a UUID', 0);
  }
  return `kb${bookingId.replace(/-/g, '').toLowerCase()}`;
}

export async function createEvent(env, booking, fetchImpl = fetch) {
  const { sa, calendarId } = parseConfig(env);
  const b = booking || {};
  const eventId = eventIdFor(b.bookingId);
  for (const k of ['startIso', 'endIso']) {
    if (typeof b[k] !== 'string' || !OFFSET_RE.test(b[k]) || Number.isNaN(Date.parse(b[k]))) {
      throw new GoogleError(`${k} must be an ISO date-time with an explicit offset`, 0);
    }
  }
  for (const k of ['depositAed', 'totalAed']) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k])) throw new GoogleError(`${k} must be a finite number`, 0);
  }
  const lines = [`Contact: ${line(b.contact, 120)}`, `Deposit paid: ${b.depositAed} AED`, `Online total: ${b.totalAed} AED`];
  const quote = (Array.isArray(b.quoteOnly) ? b.quoteOnly : []).map((q) => line(q, 200)).filter(Boolean);
  if (quote.length) lines.push('Quote-only items:', ...quote.map((q) => `- ${q}`));
  lines.push(`Booking id: ${line(b.bookingId, 80)}`);
  // Notes last; every line prefixed so user text can never look like a field.
  const notes = sanitize(b.notes, 1000, true);
  if (notes.trim()) lines.push('Notes:', ...escHtml(notes).split('\n').map((l) => `> ${l}`));

  const payload = {
    id: eventId,
    summary: `${sanitize(b.serviceLabel, 120)} \u00b7 ${sanitize(b.name, 80)}`,
    description: lines.join('\n'),
    start: { dateTime: b.startIso, timeZone: TZ },
    end: { dateTime: b.endIso, timeZone: TZ },
  };
  let res;
  try {
    res = await api(env, sa, `${API}/calendars/${encodeURIComponent(calendarId)}/events`, payload, fetchImpl);
  } catch (e) {
    // 409: an event with this id already exists, i.e. an earlier or concurrent
    // delivery already created it. That is the idempotent success case.
    if (e instanceof GoogleError && e.status === 409) return { eventId, duplicate: true };
    throw e;
  }
  const { data, text, secrets } = res;
  if (!data.id) throw new GoogleError('Google event response is missing id', 200, text, secrets);
  return { eventId: data.id };
}

// A mixed shared calendar: Project K-labelled entries block the studio;
// all other busy entries conservatively block the photographer. Never return titles.
export function classifyBusyEvent(event) {
  if (event.status === 'cancelled' || event.transparency === 'transparent') return null;
  const title = String(event.summary || '');
  const ownName = /yevhenii|евгений|женя|klemenov|klemmenov/i.test(title);
  // Team members' days off do not mean that this photographer is unavailable.
  if (/\b(?:day\s*off|off)\b/i.test(title) && !ownName) return null;
  if (/(?:\broma\b|рома|ромы)/i.test(title) && !ownName && !/\bproject\s*k\b/i.test(title)) return null;
  const studio = /\bproject\s*k\b/i.test(title);
  // Only this category ever leaves the server, never the title.
  const kind = /\b(?:day\s*off|off)\b|выходн/i.test(title) ? 'dayoff'
    : /video|видео|reel|ролик/i.test(title) ? 'video'
    : studio || /студи/i.test(title) ? 'studio' : 'photo';
  // Explicit photographer identifiers can make a studio booking block both resources.
  const photographer = !studio || ownName;
  return { studio, photographer, kind };
}
function eventInstant(value, end = false) {
  if (value?.dateTime) return checkInstant(value.dateTime);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value?.date || '')) return `${value.date}T00:00:00+04:00`;
  throw new GoogleError('Calendar event is missing a valid start/end', 0);
}
export async function getResourcesBusy(env, { from, to }, fetchImpl = fetch) {
  const { sa, calendarId } = parseConfig(env);
  const ranges = { photographer: [], studio: [] };
  let pageToken;
  const seen = new Set();
  do {
    const params = new URLSearchParams({timeMin: from, timeMax: to, singleEvents: 'true', maxResults: '2500', timeZone: TZ, fields: 'nextPageToken,items(summary,start,end,status,transparency)'});
    if (pageToken) params.set('pageToken', pageToken);
    const { data } = await api(env, sa, `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, undefined, fetchImpl);
    if (!Array.isArray(data.items)) throw new GoogleError('Calendar response missing events', 0);
    for (const event of data.items) {
      const resource = classifyBusyEvent(event);
      if (!resource) continue;
      const range = { start: eventInstant(event.start), end: eventInstant(event.end), kind: resource.kind };
      if (Date.parse(range.end) <= Date.parse(range.start)) throw new GoogleError('Invalid event interval', 0);
      if (resource.studio) ranges.studio.push(range);
      if (resource.photographer) ranges.photographer.push(range);
    }
    pageToken = data.nextPageToken;
    if (pageToken && seen.has(pageToken)) throw new GoogleError('Calendar pagination repeated', 0);
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  // Include the owner's primary calendar too, if explicitly configured.
  if (env.GOOGLE_PERSONAL_CALENDAR_ID && env.GOOGLE_PERSONAL_CALENDAR_ID !== calendarId) {
    ranges.photographer.push(...await getBusy({...env, GOOGLE_CALENDAR_ID: env.GOOGLE_PERSONAL_CALENDAR_ID}, {from,to}, fetchImpl));
  }
  return ranges;
}
