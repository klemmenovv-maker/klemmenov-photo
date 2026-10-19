// Minimal Google Calendar client (service account, JWT bearer flow).
// Only fetch + WebCrypto + standard APIs (Cloudflare Worker safe).
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

async function doFetch(fetchImpl, url, init) {
  try { return await fetchImpl(url, init); } catch { throw new GoogleError('Google request failed (network error)', 0); }
}

async function readText(res) {
  try { return await res.text(); } catch { return ''; }
}

async function getToken(env, sa, fetchImpl) {
  const now = Number.isFinite(env._nowSeconds) ? Math.floor(env._nowSeconds) : Math.floor(Date.now() / 1000);
  const hit = tokenCache.get(sa.client_email);
  if (hit && now < hit.expiresAt) return hit.token;

  const jwt = await signJwt(sa, SCOPE, now);
  const secrets = secretsOf(sa, [jwt]);
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString();
  const res = await doFetch(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await readText(res);
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
  const res = await doFetch(fetchImpl, url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await readText(res);
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

export async function createEvent(env, booking, fetchImpl = fetch) {
  const { sa, calendarId } = parseConfig(env);
  const b = booking || {};
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
    summary: `${sanitize(b.serviceLabel, 120)} \u00b7 ${sanitize(b.name, 80)}`,
    description: lines.join('\n'),
    start: { dateTime: b.startIso, timeZone: TZ },
    end: { dateTime: b.endIso, timeZone: TZ },
  };
  const { data, text, secrets } = await api(
    env, sa, `${API}/calendars/${encodeURIComponent(calendarId)}/events`, payload, fetchImpl,
  );
  if (!data.id) throw new GoogleError('Google event response is missing id', 200, text, secrets);
  return { eventId: data.id };
}
