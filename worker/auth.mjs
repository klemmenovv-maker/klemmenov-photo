// Tokens and sign-in for the two account areas.
//   client  random token kept in the visitor's browser; only its SHA-256 is stored
//   owner   Google sign-in (OpenID Connect), then a signed session token (HMAC)
// Only fetch + Web Crypto (Cloudflare Worker safe).
import { hmacSha256Hex, safeEqual } from './http.mjs';
import { timeoutSignal, timeoutMs } from './fetch-timeout.mjs';

export const SESSION_TTL_S = 30 * 86400;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export function randomToken(bytes = 24) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bearer(request) {
  const m = /^Bearer\s+([A-Za-z0-9._~-]{16,600})$/.exec(request.headers.get('Authorization') ?? '');
  return m ? m[1] : null;
}

// ---- owner session ---------------------------------------------------------
export async function signSession(env, email, nowMs) {
  if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not configured');
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ email, exp: Math.floor(nowMs / 1000) + SESSION_TTL_S })));
  return `${payload}.${await hmacSha256Hex(env.SESSION_SECRET, new TextEncoder().encode(payload))}`;
}

// Returns the owner's email or null. Never throws.
export async function verifySession(env, token, nowMs) {
  try {
    if (!env.SESSION_SECRET || !env.OWNER_EMAIL || !token) return null;
    const [payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra !== undefined) return null;
    const want = await hmacSha256Hex(env.SESSION_SECRET, new TextEncoder().encode(payload));
    if (!safeEqual(want, sig)) return null;
    const { email, exp } = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof exp !== 'number' || exp * 1000 <= nowMs) return null;
    if (String(email).toLowerCase() !== String(env.OWNER_EMAIL).trim().toLowerCase()) return null;
    return email;
  } catch { return null; }
}

// ---- Google sign-in --------------------------------------------------------
export function googleAuthUrl(env, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid email', state, prompt: 'select_account', login_hint: env.OWNER_EMAIL ?? '',
  });
  return `${GOOGLE_AUTH}?${p}`;
}

// Exchanges the code at Google (server to server over TLS, so the returned
// id_token needs no signature check) and returns the verified identity.
export async function exchangeCode(env, code, redirectUri, fetchImpl = fetch) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
    signal: timeoutSignal(timeoutMs(env)),
  };
  const res = await fetchImpl(GOOGLE_TOKEN, init);
  if (!res.ok) throw new Error(`google token ${res.status}`);
  const data = await res.json();
  const part = String(data.id_token ?? '').split('.')[1];
  if (!part) throw new Error('no id_token');
  const c = JSON.parse(new TextDecoder().decode(fromB64url(part)));
  if (c.aud !== env.GOOGLE_OAUTH_CLIENT_ID || !ISSUERS.includes(c.iss)) throw new Error('bad id_token');
  return { email: String(c.email ?? '').toLowerCase(), verified: c.email_verified === true };
}
