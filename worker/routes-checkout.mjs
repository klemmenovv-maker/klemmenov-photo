// POST /checkout: validate, price on the server, re-check the slot, hold it and
// start a Ziina payment. Client-sent totals, deposits and labels are ignored.
import { fail, reply, readBody, isJsonContentType } from './http.mjs';
import { freeSlots, durationFor, dubaiIso, CalendarUnavailable } from './routes-availability.mjs';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const MAX_ADDON_QTY = 1000;
const INTENT_INDEX_TTL_S = 3 * 86400;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => Array.from(s).length;

// Same calendar fields back out of Date (rejects 2026-02-31 and the like).
function parseStart(v) {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const off = v.endsWith('Z') ? 0 : (v.at(-6) === '-' ? -1 : 1) * (Number(v.slice(-5, -3)) * 60 + Number(v.slice(-2)));
  const local = new Date(ms + off * 60000).toISOString();
  return local.slice(0, 16) === v.slice(0, 16) ? ms : null;
}

function validate(body, env) {
  const contact = body.contact;
  if (!isObj(contact)) return 'invalid_contact';
  const name = typeof contact.name === 'string' ? contact.name.trim() : null;
  if (name === null || chars(name) < 1 || chars(name) > 80) return 'invalid_name';
  const reach = typeof contact.reach === 'string' ? contact.reach.trim() : null;
  if (reach === null || chars(reach) < 3 || chars(reach) > 120) return 'invalid_contact';
  const notes = body.notes ?? '';
  if (typeof notes !== 'string' || chars(notes) > 1000) return 'invalid_notes';
  if (env.REQUIRE_TERMS !== 'false' && body.accepted_terms !== true) return 'terms_not_accepted';
  return { name, reach, notes };
}

export async function checkout(c) {
  const { request, env, deps, now } = c;
  if (!isJsonContentType(request)) return fail(415, 'unsupported_media_type');
  const raw = await readBody(request, deps.config.max_body_bytes);
  if (!raw.ok) return fail(raw.error === 'payload_too_large' ? 413 : 400, raw.error);
  let body;
  try { body = JSON.parse(raw.text); } catch { return fail(400, 'bad_request'); }
  if (!isObj(body)) return fail(400, 'bad_request');

  // Server-side pricing: only these three fields reach quote().
  const q = deps.quote(deps.pricing, { serviceId: body.serviceId, hours: body.hours, addons: body.addons });
  if (!q.ok) return fail(400, q.error);
  if (isObj(body.addons) && Object.values(body.addons).some((n) => n > MAX_ADDON_QTY)) {
    return fail(400, 'invalid_quantity');
  }
  if (!Number.isSafeInteger(q.total) || !Number.isSafeInteger(q.deposit) || q.deposit <= 0) {
    return fail(400, 'invalid_quantity');
  }
  const startMs = parseStart(body.start);
  if (startMs === null) return fail(400, 'invalid_start');
  const fields = validate(body, env);
  if (typeof fields === 'string') return fail(400, fields);

  // Slot re-check against Google + active holds, with the real duration.
  const durationMin = durationFor(deps.config, q);
  const start = dubaiIso(startMs);
  let slots;
  try {
    slots = startMs % 60000 === 0 ? await freeSlots(c, durationMin, start.slice(0, 10), start.slice(0, 10)) : [];
  } catch (e) {
    if (e instanceof CalendarUnavailable) return fail(503, 'calendar_unavailable');
    throw e;
  }
  if (!slots.includes(start)) return fail(409, 'slot_unavailable');

  const kv = env.BOOKINGS;
  const serviceLabel = deps.pricing.services[q.serviceId].label;
  const hold = await deps.bookings.createHold(kv, {
    serviceId: q.serviceId,
    serviceLabel,
    start,
    end: dubaiIso(startMs + durationMin * 60000),
    totalAed: q.total,
    depositAed: q.deposit,
    name: fields.name,
    contact: fields.reach,
    notes: fields.notes,
    quoteOnly: q.quoteOnly,
  }, now);
  if (!hold.ok) return fail(409, 'slot_taken');
  const id = hold.id;

  try {
    const site = String(env.SITE_URL ?? '').replace(/\/+$/, '');
    const intent = await deps.ziina.createIntent(env, {
      amountAed: q.deposit,
      message: `${serviceLabel} ${start.slice(0, 10)} ${start.slice(11, 16)}`,
      successUrl: `${site}/book/thanks/?id=${id}`,
      cancelUrl: `${site}/book/cancelled/?id=${id}`,
      expiryMs: now.getTime() + deps.config.holdMinutes * 60000,
      test: env.ZIINA_TEST !== 'false',
    }, deps.fetch);
    await deps.bookings.attachIntent(kv, id, intent.id, now);
    await kv.put(`intent:${intent.id}`, id, { expirationTtl: INTENT_INDEX_TTL_S });
    deps.log({ event: 'checkout_created', bookingId: id });
    return reply(200, { bookingId: id, redirectUrl: intent.redirectUrl, totalAed: q.total, depositAed: q.deposit });
  } catch (e) {
    deps.log({ event: 'payment_unavailable', bookingId: id, code: e?.name ?? 'Error' });
    try { await deps.bookings.releaseHold(kv, id, now); } catch {
      deps.log({ event: 'release_hold_failed', bookingId: id });
    }
    return fail(502, 'payment_unavailable');
  }
}
