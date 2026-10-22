// POST /request: a non-binding booking request from the site form. No payment,
// no hold. The server prices it, then delivers it to the CRM webhook and to the
// owner's Telegram. If neither works the client gets 502 and falls back to
// WhatsApp, so a request is never silently lost.
import { fail, reply, readBody, isJsonContentType, hmacSha256Hex } from './http.mjs';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const CONTACT_RE = /^(\+?[\d\s().-]{7,}|@[A-Za-z0-9_]{4,32}|[^\s@]+@[^\s@]+\.[^\s@]{2,})$/;
const LINK_RE = /https?:\/\/|www\./gi;
const MAX_ADDON_QTY = 1000;
const DEDUPE_TTL_S = 600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;

function validate(body, env) {
  const contact = body.contact;
  if (!isObj(contact)) return 'invalid_contact';
  const name = typeof contact.name === 'string' ? contact.name.trim() : null;
  if (name === null || chars(name) < 1 || chars(name) > 80) return 'invalid_name';
  const reach = typeof contact.reach === 'string' ? contact.reach.trim() : null;
  if (reach === null || chars(reach) < 3 || chars(reach) > 120 || !CONTACT_RE.test(reach)) return 'invalid_contact';
  const notes = body.notes ?? '';
  if (typeof notes !== 'string' || chars(notes) > 1000) return 'invalid_notes';
  if ((notes.match(LINK_RE) ?? []).length > 1) return 'invalid_notes'; // link spam
  if (env.REQUIRE_TERMS !== 'false' && body.accepted_terms !== true) return 'terms_not_accepted';
  return { name, reach, notes: notes.trim() };
}

// Optional preferred start: a real calendar time in the future. Not checked
// against the calendar: the owner confirms the slot, and a Google outage must
// not block a request.
function parseStart(v, nowMs) {
  if (v === undefined || v === null || v === '') return { ok: true, start: null };
  if (typeof v !== 'string' || !ISO_RE.test(v)) return { ok: false };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms < nowMs) return { ok: false };
  const off = v.endsWith('Z') ? 0 : (v.at(-6) === '-' ? -1 : 1) * (Number(v.slice(-5, -3)) * 60 + Number(v.slice(-2)));
  if (new Date(ms + off * 60000).toISOString().slice(0, 16) !== v.slice(0, 16)) return { ok: false };
  return { ok: true, start: v, ms };
}

export async function request(c) {
  const { request: req, env, deps, now } = c;
  if (!deps.crm.configured(env) && !(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) {
    return fail(503, 'requests_not_enabled');
  }
  if (!isJsonContentType(req)) return fail(415, 'unsupported_media_type');
  const raw = await readBody(req, deps.config.max_body_bytes);
  if (!raw.ok) return fail(raw.error === 'payload_too_large' ? 413 : 400, raw.error);
  let body;
  try { body = JSON.parse(raw.text); } catch { return fail(400, 'bad_request'); }
  if (!isObj(body)) return fail(400, 'bad_request');

  // Honeypot: a hidden field real visitors never fill. Bots get a fake success.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    deps.log({ event: 'request_honeypot' });
    return reply(200, { ok: true });
  }

  // Server-side pricing, same rules as /checkout; client totals are ignored.
  const q = deps.quote(deps.pricing, { serviceId: body.serviceId, hours: body.hours, addons: body.addons });
  if (!q.ok) return fail(400, q.error);
  if (isObj(body.addons) && Object.values(body.addons).some((n) => n > MAX_ADDON_QTY)) {
    return fail(400, 'invalid_quantity');
  }
  const when = parseStart(body.start, now.getTime());
  if (!when.ok) return fail(400, 'invalid_start');
  const fields = validate(body, env);
  if (typeof fields === 'string') return fail(400, fields);

  // The same person pressing the button twice must not ping the owner twice.
  const key = await hmacSha256Hex('request-dedupe', new TextEncoder().encode(
    [fields.name, fields.reach, q.serviceId, q.hours, when.start ?? ''].join('|').toLowerCase()));
  const dedupeKey = `reqdup:${key}`;
  try {
    if (await env.BOOKINGS.get(dedupeKey)) return reply(200, { ok: true, duplicate: true });
  } catch { /* KV trouble must not block a request */ }

  const id = crypto.randomUUID();
  const serviceLabel = deps.pricing.services[q.serviceId].label;
  const record = {
    id,
    createdAt: now.toISOString(),
    source: 'website',
    status: 'new',
    name: fields.name,
    contact: fields.reach,
    serviceId: q.serviceId,
    serviceLabel,
    hours: q.hours,
    addons: q.lines.map((l) => l.label),
    quoteOnly: q.quoteOnly,
    totalAed: q.total,
    start: when.start,
    notes: fields.notes,
  };

  let crm = 'skipped';
  if (deps.crm.configured(env)) {
    try { await deps.crm.send(env, record, deps.fetch); crm = 'ok'; }
    catch (e) { crm = 'failed'; deps.log({ event: 'request_crm_failed', requestId: id, code: e?.name ?? 'Error' }); }
  }
  let telegram = 'skipped';
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await deps.telegram.notify(env, deps.telegram.formatRequest(record, crm === 'failed'));
      telegram = 'ok';
    } catch (e) { telegram = 'failed'; deps.log({ event: 'request_telegram_failed', requestId: id, code: e?.name ?? 'Error' }); }
  }

  if (crm !== 'ok' && telegram !== 'ok') {
    deps.log({ event: 'request_undelivered', requestId: id });
    return fail(502, 'delivery_failed'); // the client offers the WhatsApp fallback
  }
  try { await env.BOOKINGS.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_S }); } catch { /* best effort */ }
  deps.log({ event: 'request_received', requestId: id, crm, telegram });
  return reply(200, { ok: true, id });
}
