// HTTP plumbing for the booking Worker: JSON responses, CORS allow-list, body
// limits, KV rate counter, HMAC. Only standard Web APIs (Cloudflare Worker safe).

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export const reply = (status, body) => ({ status, body });
export const fail = (status, error) => reply(status, { error });

// ---- CORS ----------------------------------------------------------------------

// Normalised: trimmed, lowercased, trailing slashes removed, empties, "*" and
// "null" dropped (never a wildcard).
const normOrigin = (o) => o.trim().toLowerCase().replace(/\/+$/, '');

function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(normOrigin)
    .filter((s) => s && s !== '*' && s !== 'null');
}

// origin: the request Origin as sent (or null); allowed: exact match after
// normalisation. The response echoes the request's own Origin.
export function corsFor(request, env) {
  const origin = request.headers.get('Origin');
  return { origin, allowed: origin !== null && allowedOrigins(env).includes(normOrigin(origin)) };
}

function corsHeaders(cors) {
  const h = { Vary: 'Origin' };
  if (cors.allowed) h['Access-Control-Allow-Origin'] = cors.origin;
  return h;
}

export function toResponse({ status, body }, cors) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, ...corsHeaders(cors) },
  });
}

export function preflight(cors) {
  const h = { 'Cache-Control': 'no-store', ...corsHeaders(cors) };
  if (cors.allowed) {
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '600';
  }
  return new Response(null, { status: 204, headers: h });
}

// ---- request body ------------------------------------------------------------------

// Reads at most `max` bytes. Returns { ok: true, bytes, text } or { ok: false, error }.
export async function readBody(request, max) {
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    return { ok: false, error: 'payload_too_large' };
  }
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, error: 'payload_too_large' };
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, error: 'bad_request' }; }
  return { ok: true, bytes, text };
}

export function isJsonContentType(request) {
  const ct = request.headers.get('Content-Type');
  return ct !== null && ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

// ---- rate limit ----------------------------------------------------------------------

// Fixed one-minute window per route and IP, stored in KV. KV has no atomic
// increment, so concurrent requests can undercount slightly; good enough as an
// abuse brake, not as an exact quota.
export async function overLimit(kv, route, request, nowMs, limit) {
  const key = `rl:${route}:${clientIp(request)}:${Math.floor(nowMs / 60000)}`;
  const count = Number(await kv.get(key)) || 0;
  if (count >= limit) return true;
  await kv.put(key, String(count + 1), { expirationTtl: 120 });
  return false;
}

// ---- HMAC ----------------------------------------------------------------------------

export async function hmacSha256Hex(secret, bytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison for equal-length strings (length itself is public).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- misc ----------------------------------------------------------------------------

// Run `fn` after the response (ctx.waitUntil) and swallow its errors.
export function background(ctx, fn, onError) {
  const p = Promise.resolve().then(fn).catch(() => { try { onError?.(); } catch { /* ignore */ } });
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

// Single-line JSON log: event name, booking id and short codes only.
export function log(entry) {
  console.log(JSON.stringify(entry));
}

// Best-effort per-isolate counter (no KV writes). Fixed one-minute windows;
// at most `maxKeys` buckets, older minutes are dropped first.
export function createMemoryLimiter({ maxKeys = 5000 } = {}) {
  const buckets = new Map();
  // true when `key` is over `limit` in the current minute (and counts the hit).
  function hitKey(key, nowMs, limit) {
    const minute = Math.floor(nowMs / 60000);
    const k = `${key}|${minute}`;
    const count = buckets.get(k) ?? 0;
    if (count >= limit) return true;
    if (!buckets.has(k) && buckets.size >= maxKeys) {
      for (const old of buckets.keys()) if (!old.endsWith(`|${minute}`)) buckets.delete(old);
      if (buckets.size >= maxKeys) buckets.clear();
    }
    buckets.set(k, count + 1);
    return false;
  }
  return {
    hitKey,
    hit: (route, request, nowMs, limit) => hitKey(`${route}:${clientIp(request)}`, nowMs, limit),
    get size() { return buckets.size; },
  };
}

// Only Cloudflare's own header; X-Forwarded-For and friends are client-controlled.
export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
