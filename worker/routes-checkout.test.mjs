import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './index.mjs';
import { makeEnv, makeCtx, makeFakes, req, validBody, START, DAY, NOW, SECRETS } from './test-helpers.mjs';

async function checkout(f, env, body, opts = {}) {
  const ctx = makeCtx();
  const res = await handle(req('POST', '/checkout', { body, ...opts }), env, ctx, f.deps);
  await ctx.drain();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, res };
}

// ---- 1. checkout_prices_on_server ------------------------------------------

test('checkout_prices_on_server: client totals are ignored; below minimum is rejected', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const r = await checkout(f, env, validBody({ serviceId: 'commercial', hours: 1, total: 1, deposit: 1 }));
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'below_minimum' });
  assert.equal(f.calls.createIntent.length, 0);
});

test('checkout_prices_on_server: Ziina receives the server deposit, never a client value', async () => {
  const cases = [
    // commercial 2h = 3000 + 3 retouched photos 30 = 3030; 50% deposit = 1515
    [{ serviceId: 'commercial', hours: 2, addons: { extra_retouch: 3 } }, 3030, 1515],
    // personal: fixed 500 deposit
    [{ serviceId: 'personal', hours: 2 }, 2400, 500],
    // package: price 5100, 50% = 2550, hours ignored
    [{ serviceId: 'beauty', hours: 7 }, 5100, 2550],
  ];
  for (const [sel, total, deposit] of cases) {
    const f = makeFakes();
    const env = makeEnv();
    const r = await checkout(f, env, validBody({
      ...sel, total: 1, deposit: 1, totalAed: 1, depositAed: 1, amountAed: 1, price: 1, label: 'Free',
    }));
    assert.equal(r.status, 200, `${sel.serviceId}: ${r.text}`);
    assert.equal(f.calls.createIntent.length, 1);
    const opts = f.calls.createIntent[0];
    assert.equal(opts.amountAed, deposit, sel.serviceId);
    assert.equal(r.json.totalAed, total);
    assert.equal(r.json.depositAed, deposit);
    assert.deepEqual(Object.keys(r.json).sort(), ['bookingId', 'depositAed', 'redirectUrl', 'totalAed']);
    const b = await env.BOOKINGS.get(`booking:${r.json.bookingId}`, 'json');
    assert.equal(b.depositAed, deposit);
    assert.equal(b.totalAed, total);
    assert.notEqual(b.serviceLabel, 'Free');
  }
});

test('checkout success: intent options, attached intent, intent index and booking record', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const r = await checkout(f, env, validBody({ addons: { second_photographer: 1 } }));
  assert.equal(r.status, 200, r.text);
  const { bookingId, redirectUrl } = r.json;
  assert.match(bookingId, /^[0-9a-f-]{36}$/);
  assert.equal(redirectUrl, `https://pay.ziina.example.test/${f.lastIntentId}`);
  const opts = f.calls.createIntent[0];
  assert.equal(opts.test, true);
  assert.equal(opts.successUrl, `${env.SITE_URL}/book/thanks/?id=${bookingId}`);
  assert.equal(opts.cancelUrl, `${env.SITE_URL}/book/cancelled/?id=${bookingId}`);
  assert.equal(opts.expiryMs, Date.parse(NOW) + 15 * 60000);
  assert.equal(opts.message, `Personal photoshoot ${DAY} 09:00`);
  const b = await env.BOOKINGS.get(`booking:${bookingId}`, 'json');
  assert.equal(b.status, 'held');
  assert.equal(b.intentId, f.lastIntentId);
  assert.equal(b.start, START);
  assert.equal(b.end, `${DAY}T11:00:00+04:00`);
  assert.equal(b.name, 'Anna Client');
  assert.equal(b.contact, '+971500000001');
  assert.deepEqual(b.quoteOnly, ['second_photographer']);
  assert.equal(await env.BOOKINGS.get(`intent:${f.lastIntentId}`), bookingId);
  const put = env.BOOKINGS.puts.find((p) => p.key === `intent:${f.lastIntentId}`);
  assert.equal(put.opts.expirationTtl, 3 * 86400);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('checkout: ZIINA_TEST is true unless exactly "false"', async () => {
  for (const [value, expected] of [[undefined, true], ['true', true], ['FALSE', true], ['false', false]]) {
    const f = makeFakes();
    const r = await checkout(f, makeEnv({ ZIINA_TEST: value }), validBody());
    assert.equal(r.status, 200);
    assert.equal(f.calls.createIntent[0].test, expected, String(value));
  }
});

test('checkout: a start given in Z is normalised to +04:00 and accepted', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const r = await checkout(f, env, validBody({ start: `${DAY}T05:00:00Z` }));
  assert.equal(r.status, 200, r.text);
  const b = await env.BOOKINGS.get(`booking:${r.json.bookingId}`, 'json');
  assert.equal(b.start, START);
});

test('checkout: REQUIRE_TERMS="false" allows a missing accepted_terms', async () => {
  const f = makeFakes();
  const body = validBody();
  delete body.accepted_terms;
  const r = await checkout(f, makeEnv({ REQUIRE_TERMS: 'false' }), body);
  assert.equal(r.status, 200, r.text);
});

// ---- 2. checkout_rejects_bad_input -----------------------------------------

const long = (n) => 'x'.repeat(n);
const noTerms = (() => { const b = validBody(); delete b.accepted_terms; return b; })();
const noContact = (() => { const b = validBody(); delete b.contact; return b; })();

const BAD = [
  ['hours 0', validBody({ hours: 0 }), 400, 'invalid_hours'],
  ['hours -1', validBody({ hours: -1 }), 400, 'invalid_hours'],
  ['hours 0.5', validBody({ hours: 0.5 }), 400, 'invalid_hours'],
  ['hours "2"', validBody({ hours: '2' }), 400, 'invalid_hours'],
  ['hours 1e9', validBody({ hours: 1e9 }), 400, 'invalid_hours'],
  ['hours "NaN"', validBody({ hours: 'NaN' }), 400, 'invalid_hours'],
  ['hours "Infinity"', validBody({ hours: 'Infinity' }), 400, 'invalid_hours'],
  ['hours missing', validBody({ hours: undefined }), 400, 'invalid_hours'],
  ['unknown service', validBody({ serviceId: 'wedding' }), 400, 'unknown_service'],
  ['service __proto__', validBody({ serviceId: '__proto__' }), 400, 'unknown_service'],
  ['unknown add-on', validBody({ addons: { drone: 1 } }), 400, 'unknown_addon'],
  ['add-on quantity 0', validBody({ addons: { extra_retouch: 0 } }), 400, 'invalid_quantity'],
  ['add-on quantity huge', validBody({ addons: { extra_retouch: 1e12 } }), 400, 'invalid_quantity'],
  ['add-ons array', validBody({ addons: ['makeup'] }), 400, 'invalid_quantity'],
  ['missing contact', noContact, 400, 'invalid_contact'],
  ['contact string', validBody({ contact: 'anna@example.test' }), 400, 'invalid_contact'],
  ['empty name', validBody({ contact: { name: '  ', reach: 'anna@example.test' } }), 400, 'invalid_name'],
  ['name 81 chars', validBody({ contact: { name: long(81), reach: 'anna@example.test' } }), 400, 'invalid_name'],
  ['name not a string', validBody({ contact: { name: 5, reach: 'anna@example.test' } }), 400, 'invalid_name'],
  ['reach too short', validBody({ contact: { name: 'Anna', reach: 'ab' } }), 400, 'invalid_contact'],
  ['reach 121 chars', validBody({ contact: { name: 'Anna', reach: long(121) } }), 400, 'invalid_contact'],
  ['notes 1001 chars', validBody({ notes: long(1001) }), 400, 'invalid_notes'],
  ['notes not a string', validBody({ notes: { a: 1 } }), 400, 'invalid_notes'],
  ['missing accepted_terms', noTerms, 400, 'terms_not_accepted'],
  ['accepted_terms "true"', validBody({ accepted_terms: 'true' }), 400, 'terms_not_accepted'],
  ['start without offset', validBody({ start: `${DAY}T09:00:00` }), 400, 'invalid_start'],
  ['start not a string', validBody({ start: Date.parse(START) }), 400, 'invalid_start'],
  ['start garbage', validBody({ start: 'tomorrow 9am' }), 400, 'invalid_start'],
  ['start impossible date', validBody({ start: '2026-02-31T09:00:00+04:00' }), 400, 'invalid_start'],
  ['start outside work hours', validBody({ start: `${DAY}T03:00:00+04:00` }), 409, 'slot_unavailable'],
  ['start off the grid', validBody({ start: `${DAY}T09:15:00+04:00` }), 409, 'slot_unavailable'],
  ['start with seconds', validBody({ start: `${DAY}T09:00:30+04:00` }), 409, 'slot_unavailable'],
  ['start inside notice period', validBody({ start: '2026-10-19T15:00:00+04:00' }), 409, 'slot_unavailable'],
  ['start in the past', validBody({ start: '2026-10-01T10:00:00+04:00' }), 409, 'slot_unavailable'],
  ['start beyond horizon', validBody({ start: '2027-03-01T10:00:00+04:00' }), 409, 'slot_unavailable'],
  ['body is an array', [validBody()], 400, 'bad_request'],
  ['body is null', null, 400, 'bad_request'],
];

for (const [name, body, status, code] of BAD) {
  test(`checkout_rejects_bad_input: ${name} -> ${status} ${code}`, async () => {
    const f = makeFakes();
    const env = makeEnv();
    const r = await checkout(f, env, body);
    assert.equal(r.status, status, r.text);
    assert.deepEqual(r.json, { error: code });
    assert.equal(f.calls.createIntent.length, 0);
    assert.equal((await env.BOOKINGS.list({ prefix: 'booking:' })).keys.length, 0);
  });
}

test('checkout_rejects_bad_input: invalid JSON -> 400 bad_request', async () => {
  const f = makeFakes();
  const r = await checkout(f, makeEnv(), '{"serviceId": "personal",', { headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: 'bad_request' });
});

test('checkout_rejects_bad_input: wrong content type -> 415', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp', null]) {
    const f = makeFakes();
    const headers = ct ? { 'content-type': ct } : {};
    const res = await handle(
      new Request('https://booking.example.test/checkout', {
        method: 'POST', headers: { 'CF-Connecting-IP': '9.9.9.9', ...headers }, body: ct ? JSON.stringify(validBody()) : undefined,
      }),
      makeEnv(), makeCtx(), f.deps,
    );
    assert.equal(res.status, 415, String(ct));
    assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
  }
  const f = makeFakes();
  const ok = await checkout(f, makeEnv(), JSON.stringify(validBody()), { headers: { 'content-type': 'Application/JSON; charset=utf-8' } });
  assert.equal(ok.status, 200, ok.text);
});

test('checkout_rejects_bad_input: oversized body -> 413 (actual bytes and declared length)', async () => {
  const f = makeFakes();
  const big = validBody({ notes: 'é'.repeat(5000) }); // > 8192 bytes in UTF-8
  const r = await checkout(f, makeEnv(), big);
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { error: 'payload_too_large' });
  const r2 = await checkout(f, makeEnv(), validBody(), { headers: { 'content-type': 'application/json', 'content-length': '999999' } });
  assert.equal(r2.status, 413);
  assert.equal(f.calls.createIntent.length, 0);
});

test('checkout_rejects_bad_input: start overlapping a Google busy range (with buffer) -> 409', async () => {
  const f = makeFakes();
  f.busy = [{ start: `${DAY}T11:15:00+04:00`, end: `${DAY}T12:00:00+04:00`, summary: 'Dentist' }];
  const r = await checkout(f, makeEnv(), validBody());
  assert.equal(r.status, 409);
  assert.deepEqual(r.json, { error: 'slot_unavailable' });
  assert.equal(f.calls.createIntent.length, 0);
  assert.deepEqual(f.calls.getBusy[0], { from: `${DAY}T00:00:00+04:00`, to: '2026-10-22T00:00:00+04:00' });
});

test('checkout: Google unavailable -> 503 calendar_unavailable, nothing held', async () => {
  const f = makeFakes();
  f.getBusyImpl = async () => { throw new Error(`google down ${SECRETS.google}`); };
  const env = makeEnv();
  const r = await checkout(f, env, validBody());
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'calendar_unavailable' });
  assert.equal(f.calls.createIntent.length, 0);
  assert.equal((await env.BOOKINGS.list({ prefix: 'slots:' })).keys.length, 0);
});

// ---- 3. checkout_slot_race ---------------------------------------------------

test('checkout_slot_race: two simultaneous checkouts for one slot -> one 200, one 409, one Ziina call', async () => {
  const f = makeFakes();
  const env = makeEnv();
  // Barrier: neither request gets its busy list until both have asked, so both
  // pass the slot re-check and really race inside createHold.
  let release;
  const both = new Promise((r) => { release = r; });
  f.getBusyImpl = async () => {
    if (f.calls.getBusy.length >= 2) release();
    await both;
    return [];
  };
  const [a, b] = await Promise.all([checkout(f, env, validBody()), checkout(f, env, validBody({ hours: 3 }))]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.deepEqual(loser.json, { error: 'slot_taken' });
  assert.equal(f.calls.createIntent.length, 1);
});

test('checkout: an existing active hold makes the slot unavailable', async () => {
  const f = makeFakes();
  const env = makeEnv();
  assert.equal((await checkout(f, env, validBody())).status, 200);
  const again = await checkout(f, env, validBody());
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { error: 'slot_unavailable' });
  assert.equal(f.calls.createIntent.length, 1);
});

// ---- 4. checkout_payment_failure_releases_hold -------------------------------

test('checkout_payment_failure_releases_hold: createIntent throws -> 502 and the slot is free again', async () => {
  const f = makeFakes();
  const env = makeEnv();
  f.createIntentImpl = async () => {
    f.createIntentImpl = null; // fail once, then behave
    const e = new Error(`Ziina responded with HTTP 500 Bearer ${SECRETS.ziina}`);
    e.body = `{"token":"${SECRETS.ziina}"}`;
    throw e;
  };
  const r = await checkout(f, env, validBody());
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, { error: 'payment_unavailable' });
  assert.ok(!r.text.includes(SECRETS.ziina));
  const held = (await env.BOOKINGS.list({ prefix: 'booking:' })).keys;
  assert.equal(held.length, 1);
  assert.equal((await env.BOOKINGS.get(held[0].name, 'json')).status, 'expired');
  const again = await checkout(f, env, validBody());
  assert.equal(again.status, 200, again.text);
});

test('checkout_payment_failure_releases_hold: SITE_URL missing makes createIntent fail -> 502, slot freed', async () => {
  const f = makeFakes();
  const env = makeEnv({ SITE_URL: undefined });
  f.createIntentImpl = async (e, opts) => {
    if (!/^https:\/\//.test(opts.successUrl)) throw new RangeError('successUrl must be https://');
    return { id: 'zi_x', redirectUrl: 'https://pay.example.test/zi_x' };
  };
  const r = await checkout(f, env, validBody());
  assert.equal(r.status, 502);
  env.SITE_URL = 'https://klemmenovv-maker.github.io/klemmenov-photo';
  assert.equal((await checkout(f, env, validBody())).status, 200);
});
