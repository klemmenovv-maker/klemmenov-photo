import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, defaultDeps } from './index.mjs';
import {
  makeEnv, makeCtx, makeFakes, req, validBody, complete, webhookPayload, hmacHex, eventIdFor, START, DAY, SECRETS,
} from './_helpers.mjs';

async function call(f, env, request) {
  const ctx = makeCtx();
  const res = await handle(request, env, ctx, f.deps);
  await ctx.drain();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// Book the default slot through the real /checkout route; returns ids.
async function booked(f, env, body = validBody()) {
  const r = await call(f, env, req('POST', '/checkout', { body }));
  assert.equal(r.status, 200, r.text);
  return { bookingId: r.json.bookingId, intentId: f.lastIntentId };
}

const hook = (f, env, payload, headers = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return call(f, env, req('POST', '/webhook/ziina', { body, headers: { 'content-type': 'application/json', ...headers } }));
};
const getB = (env, id) => env.BOOKINGS.get(`booking:${id}`, 'json');
const IGNORED = { ok: true, ignored: true };

// ---- happy path ---------------------------------------------------------------

test('webhook: completed payment -> paid, one calendar event, one paid telegram', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid');
  assert.equal(b.calendarEventId, eventIdFor(bookingId));
  assert.ok(b.notifiedAt);
  assert.equal(f.calls.createEvent.length, 1);
  const ev = f.calls.createEvent[0];
  assert.deepEqual(ev, {
    serviceLabel: 'Personal photoshoot', startIso: START, endIso: `${DAY}T11:00:00+04:00`,
    name: 'Anna Client', contact: '+971500000001', notes: 'Golden hour please', quoteOnly: [],
    depositAed: 500, totalAed: 2400, bookingId,
  });
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /New paid booking/);
  // the busy re-check covered exactly the booking interval
  assert.deepEqual(f.calls.getBusy.at(-1), { from: START, to: `${DAY}T11:00:00+04:00` });
});

test('webhook: Telegram failure never changes the response', async () => {
  const f = makeFakes();
  const env = makeEnv();
  f.notifyImpl = async () => { throw new Error(`telegram down ${SECRETS.telegram}`); };
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 200);
  assert.equal((await getB(env, bookingId)).calendarEventId, eventIdFor(bookingId));
  assert.equal((await getB(env, bookingId)).notifiedAt, undefined);
});

// ---- 5. webhook_ignores_forged -----------------------------------------------------

test('webhook_ignores_forged: unknown intent id -> 200 ignored, no lookup', async () => {
  const f = makeFakes();
  const env = makeEnv();
  await booked(f, env);
  const r = await hook(f, env, webhookPayload('zi_forged'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, IGNORED);
  assert.equal(f.calls.getIntent.length, 0);
  assert.equal(f.calls.notify.length, 0, 'no owner alert for an unknown intent');
});

test('webhook_ignores_forged: payload says completed but Ziina says pending -> nothing happens', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  // forged payload has the right amount and currency; only getIntent can tell
  const r = await hook(f, env, webhookPayload(intentId, { status: 'completed', amount: 50000, currency_code: 'AED' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, IGNORED);
  assert.deepEqual(f.calls.getIntent, [intentId]);
  assert.equal((await getB(env, bookingId)).status, 'held');
  assert.equal(f.calls.createEvent.length, 0);
  assert.equal(f.calls.notify.length, 0);
});

test('webhook_ignores_forged: amount mismatch -> needs attention, attention telegram, never an event (even on redelivery)', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId, { amountFils: 100 });
  for (let i = 0; i < 2; i++) {
    const r = await hook(f, env, webhookPayload(intentId));
    assert.equal(r.status, 200);
  }
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'amount_mismatch');
  assert.equal(f.calls.createEvent.length, 0);
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /Needs your attention/);
  assert.match(f.calls.notify[0], /amount does not match/);
});

test('webhook_ignores_forged: other event names, missing or odd ids are ignored without lookup', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { intentId } = await booked(f, env);
  complete(f, intentId);
  const payloads = [
    { ...webhookPayload(intentId), event: 'refund.status.updated' },
    { event: 'payment_intent.status.updated' },
    { event: 'payment_intent.status.updated', data: null },
    { event: 'payment_intent.status.updated', data: { id: 42 } },
    { event: 'payment_intent.status.updated', data: { id: '' } },
    { event: 'payment_intent.status.updated', data: { id: 'x'.repeat(300) } },
    [webhookPayload(intentId)],
    'null',
  ];
  for (const p of payloads) {
    const r = await hook(f, env, p);
    assert.equal(r.status, 200, JSON.stringify(p).slice(0, 80));
    assert.deepEqual(r.json, IGNORED);
  }
  assert.equal(f.calls.getIntent.length, 0);
  assert.equal(f.calls.createEvent.length, 0);
});

test('webhook_ignores_forged: intent belonging to another booking (IntentMismatch) is ignored', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const a = await booked(f, env);
  // point a second intent id at booking A through the index (forged mapping)
  f.intents.set('zi_other', { id: 'zi_other', status: 'completed', amountFils: 50000, currency: 'AED' });
  await env.BOOKINGS.put('intent:zi_other', a.bookingId);
  const r = await hook(f, env, webhookPayload('zi_other'));
  assert.deepEqual(r.json, IGNORED);
  assert.equal((await getB(env, a.bookingId)).status, 'held');
  assert.equal(f.calls.createEvent.length, 0);
});

test('webhook: invalid JSON -> 400 bad_request', async () => {
  const f = makeFakes();
  const r = await hook(f, makeEnv(), '{"event":');
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'bad_request' });
});

test('webhook: Ziina lookup failure -> 500 so Ziina retries; state unchanged', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  f.getIntentImpl = async () => { throw new Error(`Ziina 503 ${SECRETS.ziina}`); };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'payment_lookup_failed' });
  assert.equal((await getB(env, bookingId)).status, 'held');
  // the owner is told, with the booking id and no personal data
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /Payment webhook failed/);
  assert.match(f.calls.notify[0], /could not confirm the payment with Ziina/);
  assert.ok(f.calls.notify[0].includes(bookingId));
  for (const pii of ['Anna', '+97150', 'Golden', SECRETS.ziina]) assert.ok(!f.calls.notify[0].includes(pii), pii);
});

test('webhook: owner alert failure does not change the 500', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { intentId } = await booked(f, env);
  f.getIntentImpl = async () => { throw new Error('Ziina 503'); };
  f.notifyImpl = async () => { throw new Error(`telegram down ${SECRETS.telegram}`); };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'payment_lookup_failed' });
  assert.equal(f.calls.notify.length, 1);
});

test('webhook: unexpected error after the booking is known -> 500 internal_error and an owner alert', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.deps.bookings = { ...f.deps.bookings, markPaid: async () => { throw new Error(`kv exploded ${SECRETS.ziina}`); } };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: 'internal_error' });
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /unexpected error/);
  assert.ok(f.calls.notify[0].includes(bookingId));
  assert.ok(!f.calls.notify[0].includes(SECRETS.ziina));
});

test('webhook_ignores_forged: HMAC required when the secret is configured', async () => {
  const f = makeFakes();
  const env = makeEnv({ ZIINA_WEBHOOK_SECRET: SECRETS.hmac });
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const body = JSON.stringify(webhookPayload(intentId));

  const missing = await hook(f, env, body);
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.json, { error: 'bad_signature' });

  const wrongKey = await hook(f, env, body, { 'X-Hmac-Signature': await hmacHex('not-the-secret', body) });
  assert.equal(wrongKey.status, 401);

  const otherBody = await hook(f, env, body, { 'X-Hmac-Signature': await hmacHex(SECRETS.hmac, `${body} `) });
  assert.equal(otherBody.status, 401);

  const garbage = await hook(f, env, body, { 'X-Hmac-Signature': 'zz' });
  assert.equal(garbage.status, 401);
  assert.equal(f.calls.getIntent.length, 0);
  assert.equal((await getB(env, bookingId)).status, 'held');

  const good = await hook(f, env, body, { 'X-Hmac-Signature': await hmacHex(SECRETS.hmac, body) });
  assert.equal(good.status, 200, good.text);
  assert.equal((await getB(env, bookingId)).status, 'paid');
  assert.equal(f.calls.createEvent.length, 1);
});

test('webhook: HMAC is not checked when no secret is configured', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const r = await hook(f, env, webhookPayload(intentId), { 'X-Hmac-Signature': 'whatever' });
  assert.equal(r.status, 200);
  assert.equal((await getB(env, bookingId)).status, 'paid');
});

// ---- 6. webhook_idempotent ---------------------------------------------------------

test('webhook_idempotent: the same completed webhook twice -> one event, one paid telegram', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { intentId } = await booked(f, env);
  complete(f, intentId);
  await hook(f, env, webhookPayload(intentId));
  const second = await hook(f, env, webhookPayload(intentId));
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { ok: true, duplicate: true });
  assert.equal(f.calls.createEvent.length, 1);
  assert.equal(f.calls.notify.filter((t) => /New paid booking/.test(t)).length, 1);
});

test('webhook_idempotent: two concurrent deliveries -> one event, one paid telegram', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { intentId } = await booked(f, env);
  complete(f, intentId);
  const rs = await Promise.all([hook(f, env, webhookPayload(intentId)), hook(f, env, webhookPayload(intentId))]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  assert.equal(f.calls.createEvent.length, 1);
  assert.equal(f.calls.notify.length, 1);
});

// ---- 7. webhook_retry_after_crash --------------------------------------------------

test('webhook_retry_after_crash: paid booking without calendarEventId gets its event on redelivery', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.createEventImpl = async () => { f.createEventImpl = null; throw new Error('google 500'); };
  const first = await hook(f, env, webhookPayload(intentId));
  assert.equal(first.status, 200);
  let b = await getB(env, bookingId);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'calendar_failed');
  assert.match(f.calls.notify[0], /calendar event could not be created/);

  // simulate a crash right after markPaid: booking paid, no calendarEventId
  await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ ...b, status: 'paid', reason: null }));
  const second = await hook(f, env, webhookPayload(intentId));
  assert.equal(second.status, 200);
  b = await getB(env, bookingId);
  assert.equal(b.calendarEventId, eventIdFor(bookingId));
  assert.equal(f.calls.createEvent.length, 2);
  assert.equal(f.events.size, 1);
  assert.match(f.calls.notify.at(-1), /New paid booking/);

  // and a third delivery is a duplicate
  const third = await hook(f, env, webhookPayload(intentId));
  assert.deepEqual(third.json, { ok: true, duplicate: true });
  assert.equal(f.calls.createEvent.length, 2);
});

// ---- 8. paid_but_calendar_fails ----------------------------------------------------

test('paid_but_calendar_fails: attention flagged, telegram sent, lookup still says paid without PII', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.createEventImpl = async () => { throw new Error(`google ${SECRETS.google}`); };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(SECRETS.google));
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'calendar_failed');
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /Needs your attention/);

  const look = await call(f, env, req('GET', `/booking/${bookingId}`));
  assert.equal(look.status, 200);
  assert.deepEqual(look.json, {
    id: bookingId, status: 'paid', serviceLabel: 'Personal photoshoot',
    start: START, end: `${DAY}T11:00:00+04:00`, depositAed: 500, totalAed: 2400,
  });
  for (const pii of ['Anna', '+97150', 'Golden', intentId]) assert.ok(!look.text.includes(pii), pii);
});

test('webhook: Google busy re-check failing -> calendar_failed attention, no event', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.getBusyImpl = async () => { throw new Error('google down'); };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 200);
  assert.equal((await getB(env, bookingId)).reason, 'calendar_failed');
  assert.equal(f.calls.createEvent.length, 0);
  assert.equal(f.calls.notify.length, 1);
});

// ---- 9. calendar_conflict_after_payment --------------------------------------------

test('calendar_conflict_after_payment: busy overlap at webhook time -> attention, no event', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.busy = [{ start: `${DAY}T10:30:00+04:00`, end: `${DAY}T10:45:00+04:00` }];
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 200);
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'calendar_conflict');
  assert.equal(f.calls.createEvent.length, 0);
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /calendar already has an event/);
});

test('calendar re-check: adjacent busy ranges are not a conflict', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  f.busy = [{ start: `${DAY}T08:00:00+04:00`, end: START }, { start: `${DAY}T11:00:00+04:00`, end: `${DAY}T12:00:00+04:00` }];
  await hook(f, env, webhookPayload(intentId));
  assert.equal((await getB(env, bookingId)).status, 'paid');
  assert.equal(f.calls.createEvent.length, 1);
});

test('webhook: slot taken after the hold expired -> attention slot_taken_after_expiry, no event', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const a = await booked(f, env);
  // 20 minutes later the hold has lapsed and someone else books the slot
  f.nowIso = '2026-10-19T10:20:00+04:00';
  const other = await call(f, env, req('POST', '/checkout', { body: validBody({ contact: { name: 'Bob', reach: 'bob@example.test' } }) }));
  assert.equal(other.status, 200, other.text);
  complete(f, a.intentId);
  const r = await hook(f, env, webhookPayload(a.intentId));
  assert.equal(r.status, 200);
  const b = await getB(env, a.bookingId);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'slot_taken_after_expiry');
  assert.equal(f.calls.createEvent.length, 0);
  assert.match(f.calls.notify[0], /taken by someone else after the hold expired/);
});

// ---- cross-isolate safety (no in-isolate lock) ------------------------------------

test('webhook_cross_isolate: two concurrent deliveries without the in-isolate lock -> one event, one paid telegram, no false conflict', async () => {
  const f = makeFakes();
  f.deps.webhookLock = (key, fn) => fn(); // simulate two isolates: no shared lock
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const rs = await Promise.all([hook(f, env, webhookPayload(intentId)), hook(f, env, webhookPayload(intentId))]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  assert.equal(f.events.size, 1, 'exactly one calendar event exists');
  assert.equal(f.calls.notify.filter((t) => /New paid booking/.test(t)).length, 1);
  assert.equal(f.calls.notify.filter((t) => /Needs your attention/.test(t)).length, 0);
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid');
  assert.equal(b.calendarEventId, eventIdFor(bookingId));
});

test('webhook_crash_after_createEvent: retry stores the event id, no false conflict, no second telegram', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  // createEvent succeeds, then the Worker dies before recording calendarEventId
  const real = f.deps.bookings.updateBooking;
  f.deps.bookings = {
    ...f.deps.bookings,
    updateBooking: async (...a) => {
      if (a[2]?.calendarEventId) throw new Error('isolate died');
      return real(...a);
    },
  };
  const first = await hook(f, env, webhookPayload(intentId));
  assert.equal(first.status, 500);
  assert.equal(f.events.size, 1);
  assert.equal((await getB(env, bookingId)).calendarEventId, undefined);
  const paidBefore = f.calls.notify.filter((t) => /New paid booking/.test(t)).length;

  f.deps.bookings = { ...f.deps.bookings, updateBooking: real };
  const retry = await hook(f, env, webhookPayload(intentId));
  assert.equal(retry.status, 200, retry.text);
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid', `reason: ${b.reason}`);
  assert.equal(b.calendarEventId, eventIdFor(bookingId));
  assert.equal(f.events.size, 1);
  assert.equal(f.calls.notify.filter((t) => /Needs your attention/.test(t)).length, 0);
  assert.equal(f.calls.notify.filter((t) => /New paid booking/.test(t)).length, paidBefore);
});

test('webhook_cross_isolate: the delivery that marks paid never mistakes the concurrent delivery\'s event for a conflict', async () => {
  const f = makeFakes();
  f.deps.webhookLock = (key, fn) => fn(); // two isolates
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  // Worst-case timing: any free/busy read made AFTER the booking became paid
  // is answered only once the other delivery's event exists in the calendar.
  f.getBusyImpl = async () => {
    const b = await env.BOOKINGS.get(`booking:${bookingId}`, 'json');
    if (b?.status === 'paid') {
      for (let i = 0; i < 100 && f.events.size === 0; i++) await new Promise((r) => setTimeout(r, 2));
    }
    return f.busy.map((x) => ({ ...x }));
  };
  const rs = await Promise.all([hook(f, env, webhookPayload(intentId)), hook(f, env, webhookPayload(intentId))]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  const b = await getB(env, bookingId);
  assert.equal(b.status, 'paid', `reason: ${b.reason}`);
  assert.equal(f.events.size, 1);
  assert.equal(f.calls.notify.filter((t) => /Needs your attention/.test(t)).length, 0);
  assert.equal(f.calls.notify.filter((t) => /New paid booking/.test(t)).length, 1);
});

test('webhook 500 alert uses the production formatPaymentAlert (only notify faked)', async () => {
  const f = makeFakes();
  assert.equal(f.deps.telegram.formatPaymentAlert, defaultDeps.telegram.formatPaymentAlert);
  f.deps.telegram = { ...defaultDeps.telegram, notify: f.deps.telegram.notify };
  const env = makeEnv();
  const { bookingId, intentId } = await booked(f, env);
  f.getIntentImpl = async () => { throw new Error('Ziina 503'); };
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 500);
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /^<b>Payment webhook failed<\/b>/);
  assert.ok(f.calls.notify[0].includes(bookingId));
  assert.ok(!f.calls.log.some((l) => l.event === 'telegram_failed'));
});

// ---- production gate and per-intent throttle -------------------------------------

test('webhook: production (ZIINA_TEST="false") without a webhook secret refuses with 503 and never processes', async () => {
  const f = makeFakes();
  const env = makeEnv({ ZIINA_TEST: 'false' });
  const { bookingId, intentId } = await booked(f, env);
  complete(f, intentId);
  const r = await hook(f, env, webhookPayload(intentId));
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'webhook_not_configured' });
  assert.equal(f.calls.getIntent.length, 0);
  assert.equal((await getB(env, bookingId)).status, 'held');
  assert.ok(f.calls.log.some((l) => l.event === 'webhook_not_configured'));
  // with the secret configured, production processes signed deliveries
  env.ZIINA_WEBHOOK_SECRET = SECRETS.hmac;
  const body = JSON.stringify(webhookPayload(intentId));
  const ok = await hook(f, env, body, { 'X-Hmac-Signature': await hmacHex(SECRETS.hmac, body) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await getB(env, bookingId)).status, 'paid');
});

test('webhook: test mode without a secret still processes (HMAC optional)', async () => {
  for (const ZIINA_TEST of ['true', undefined, 'FALSE']) {
    const f = makeFakes();
    const env = makeEnv({ ZIINA_TEST });
    const { bookingId, intentId } = await booked(f, env);
    complete(f, intentId);
    assert.equal((await hook(f, env, webhookPayload(intentId))).status, 200);
    assert.equal((await getB(env, bookingId)).status, 'paid', String(ZIINA_TEST));
  }
});

test('webhook: at most 6 Ziina lookups per intent per minute; then throttled without lookup or alert', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const { intentId } = await booked(f, env);
  f.getIntentImpl = async () => { throw new Error('Ziina 503'); };
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const r = await hook(f, env, webhookPayload(intentId));
    statuses.push(r.status);
    if (i >= 6) assert.deepEqual(r.json, { ok: true, throttled: true });
  }
  assert.deepEqual(statuses, [500, 500, 500, 500, 500, 500, 200, 200]);
  assert.equal(f.calls.getIntent.length, 6);
  assert.equal(f.calls.notify.length, 6, 'no alert for throttled deliveries');
  // the window is per minute
  f.nowIso = '2026-10-19T10:01:00+04:00';
  f.getIntentImpl = null;
  complete(f, intentId);
  assert.equal((await hook(f, env, webhookPayload(intentId))).status, 200);
  assert.equal(f.calls.getIntent.length, 7);
});

test('webhook: the per-intent throttle is per intent id', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const a = await booked(f, env);
  const b = await booked(f, env, validBody({ start: `${DAY}T15:00:00+04:00` }));
  for (let i = 0; i < 7; i++) await hook(f, env, webhookPayload(a.intentId));
  assert.equal(f.calls.getIntent.length, 6);
  complete(f, b.intentId);
  const r = await hook(f, env, webhookPayload(b.intentId));
  assert.deepEqual(r.json, { ok: true });
  assert.equal(f.calls.getIntent.length, 7);
});
