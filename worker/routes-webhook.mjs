// POST /webhook/ziina. The payload is only a hint: the payment status and amount
// always come from Ziina (getIntent), never from the request body.
import { fail, reply, readBody, hmacSha256Hex, safeEqual, background } from './http.mjs';

const EVENT = 'payment_intent.status.updated';
const MAX_INTENT_ID = 128;
const LOOKUPS_PER_INTENT_PER_MIN = 6;
const IGNORED = { ok: true, ignored: true };
const IGNORABLE = new Set(['IntentMismatch', 'NotPaid', 'BookingNotFound']);

// Per-booking promise chain: deliveries for one booking are processed one at a
// time inside this isolate. Across isolates, the deterministic Google event id
// (409 on re-insert) prevents a second event and a second paid message.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

function alert(c, booking, reason) {
  const { env, ctx, deps } = c;
  background(ctx, () => deps.telegram.notify(env, deps.telegram.formatAttention(booking, reason), deps.fetch),
    () => deps.log({ event: 'telegram_failed', bookingId: booking.id }));
}

async function flag(c, id, reason) {
  const { env, deps, now } = c;
  const b = await deps.bookings.markNeedsAttention(env.BOOKINGS, id, reason, now);
  deps.log({ event: 'needs_attention', bookingId: id, code: reason });
  alert(c, b, reason);
  return reply(200, { ok: true, attention: true });
}

// Owner alert for a 500 after the booking was identified: id + static reason only.
function paymentAlert(c, bookingId, reason) {
  const { env, ctx, deps } = c;
  background(ctx, () => deps.telegram.notify(env, deps.telegram.formatPaymentAlert(bookingId, reason), deps.fetch),
    () => deps.log({ event: 'telegram_failed', bookingId }));
}

const PAID = new Set(['paid', 'paid_needs_attention']);

async function settle(c, bookingId, intent) {
  const { env, ctx, deps, now } = c;
  const kv = env.BOOKINGS;
  const before = await deps.bookings.getBooking(kv, bookingId);
  if (!before) {
    deps.log({ event: 'webhook_ignored', bookingId, code: 'BookingNotFound' });
    return reply(200, IGNORED);
  }
  // Free/busy snapshot taken BEFORE markPaid. No delivery creates this
  // booking's event until the booking is paid, so this snapshot can never
  // contain our own event, even if another isolate is processing a duplicate
  // delivery at the same time.
  let snapshot = null;
  if (!PAID.has(before.status)) {
    snapshot = await deps.google.getBusy(env, { from: before.start, to: before.end }, deps.fetch)
      .then((busy) => ({ busy }), () => ({ failed: true }));
  }

  let result;
  try {
    result = await deps.bookings.markPaid(kv, bookingId, intent, now);
  } catch (e) {
    if (e?.name === 'AmountMismatch') return flag(c, bookingId, 'amount_mismatch');
    if (IGNORABLE.has(e?.name)) {
      deps.log({ event: 'webhook_ignored', bookingId, code: e.name });
      return reply(200, IGNORED);
    }
    throw e;
  }
  const b = result.booking;

  // Idempotency: continue an unchanged booking only when it is plainly paid and
  // has no calendar event recorded yet (an earlier or concurrent delivery may
  // have crashed or still be running; the deterministic event id makes the
  // insert below idempotent).
  if (!result.changed && (b.calendarEventId || b.status !== 'paid')) {
    return reply(200, { ok: true, duplicate: true });
  }
  if (result.conflict) {
    deps.log({ event: 'needs_attention', bookingId, code: b.reason });
    alert(c, b, b.reason);
    return reply(200, { ok: true, attention: true });
  }

  // Calendar re-check only for the delivery that turned the booking paid. A
  // retry finds the booking already paid and skips it: its own event may
  // already be in the calendar and must not count as a conflict.
  if (result.changed) {
    if (!snapshot || snapshot.failed) return flag(c, bookingId, 'calendar_failed');
    if (snapshot.busy.some((r) => overlaps(r, b))) return flag(c, bookingId, 'calendar_conflict');
  }

  let event;
  try {
    event = await deps.google.createEvent(env, {
      serviceLabel: b.serviceLabel,
      startIso: b.start,
      endIso: b.end,
      name: b.name,
      contact: b.contact,
      notes: b.notes,
      quoteOnly: b.quoteOnly,
      depositAed: b.depositAed,
      totalAed: b.totalAed,
      bookingId: b.id,
    }, deps.fetch);
  } catch {
    return flag(c, bookingId, 'calendar_failed');
  }
  const saved = await deps.bookings.updateBooking(kv, bookingId, { calendarEventId: event.eventId }, now);
  if (event.duplicate) {
    // Another delivery created the event; it also sends (or sent) the message.
    deps.log({ event: 'calendar_event_exists', bookingId });
    return reply(200, { ok: true, duplicate: true });
  }
  deps.log({ event: 'booking_paid', bookingId });
  background(ctx, async () => {
    await deps.telegram.notify(env, deps.telegram.formatPaid(saved), deps.fetch);
    await deps.bookings.updateBooking(kv, bookingId, { notifiedAt: now.toISOString() }, now);
  }, () => deps.log({ event: 'telegram_failed', bookingId }));
  return reply(200, { ok: true });
}

export async function webhook(c) {
  const { request, env, deps, now } = c;
  // The webhook is not rate-limited, so in production it must be signed.
  if (env.ZIINA_TEST === 'false' && !env.ZIINA_WEBHOOK_SECRET) {
    deps.log({ event: 'webhook_not_configured' });
    return fail(503, 'webhook_not_configured');
  }
  const raw = await readBody(request, deps.config.max_body_bytes);
  if (!raw.ok) return fail(raw.error === 'payload_too_large' ? 413 : 400, raw.error);

  if (env.ZIINA_WEBHOOK_SECRET) {
    const got = String(request.headers.get('X-Hmac-Signature') ?? '').trim().toLowerCase();
    const want = await hmacSha256Hex(env.ZIINA_WEBHOOK_SECRET, raw.bytes);
    if (!safeEqual(got, want)) {
      deps.log({ event: 'webhook_bad_signature' });
      return fail(401, 'bad_signature');
    }
  }

  let payload;
  try { payload = JSON.parse(raw.text); } catch { return fail(400, 'bad_request'); }
  const intentId = payload?.data?.id;
  if (payload?.event !== EVENT || typeof intentId !== 'string' || !intentId || intentId.length > MAX_INTENT_ID) {
    return reply(200, IGNORED);
  }
  const bookingId = await env.BOOKINGS.get(`intent:${intentId}`);
  if (!bookingId) return reply(200, IGNORED);

  // Cheap brake in front of Ziina: someone replaying a real intent id cannot
  // burn the API quota or trigger a stream of owner alerts.
  if (deps.intentLimiter.hitKey(`intent:${intentId}`, now.getTime(), LOOKUPS_PER_INTENT_PER_MIN)) {
    deps.log({ event: 'webhook_throttled', bookingId });
    return reply(200, { ok: true, throttled: true });
  }

  // From here on a 500 means "a real booking may be paid but unrecorded":
  // Ziina retries, and the owner gets a background alert (id + reason only).
  try {
    let intent;
    try {
      intent = await deps.ziina.getIntent(env, intentId, deps.fetch);
    } catch (e) {
      deps.log({ event: 'payment_lookup_failed', bookingId, code: e?.name ?? 'Error' });
      paymentAlert(c, bookingId, 'payment_lookup_failed');
      return fail(500, 'payment_lookup_failed'); // no state changed: let Ziina retry
    }
    if (!intent || intent.status !== 'completed') return reply(200, IGNORED);
    const lock = deps.webhookLock ?? withLock;
    return await lock(bookingId, () => settle(c, bookingId, intent));
  } catch (e) {
    deps.log({ event: 'internal_error', bookingId, code: e?.name ?? 'Error' });
    paymentAlert(c, bookingId, 'internal_error');
    return fail(500, 'internal_error');
  }
}
