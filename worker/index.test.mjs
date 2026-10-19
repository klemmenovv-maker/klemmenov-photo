import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, defaultDeps } from './index.mjs';
import { HOLD_MINUTES, createHold, getBooking } from './bookings.mjs';
import config from './booking-config.json' with { type: 'json' };
import {
  makeEnv, makeCtx, makeFakes, req, validBody, complete, webhookPayload, ORIGIN, DAY, NOW, SECRETS, MemKV,
} from './_helpers.mjs';

async function call(f, env, request) {
  const ctx = makeCtx();
  const res = await handle(request, env, ctx, f.deps);
  await ctx.drain();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const AVAIL = `/availability?service=personal&hours=2&from=${DAY}&to=${DAY}`;

test('config: hold minutes match the bookings module and the brief', () => {
  assert.equal(config.holdMinutes, HOLD_MINUTES);
  assert.equal(config.rate_limit.checkout_per_min, 10);
  assert.equal(config.max_body_bytes, 8192);
});

test('defaultDeps wires every function the routes call', () => {
  const used = {
    telegram: ['notify', 'formatPaid', 'formatAttention', 'formatPaymentAlert'],
    google: ['getBusy', 'createEvent'],
    ziina: ['createIntent', 'getIntent'],
    bookings: ['createHold', 'getBooking', 'attachIntent', 'markPaid', 'markNeedsAttention', 'releaseHold',
      'updateBooking', 'listActiveEntries', 'releaseExpired'],
  };
  for (const [group, names] of Object.entries(used)) {
    for (const name of names) assert.equal(typeof defaultDeps[group]?.[name], 'function', `${group}.${name}`);
  }
  for (const name of ['now', 'computeSlots', 'quote', 'fetch', 'log']) assert.equal(typeof defaultDeps[name], 'function', name);
  for (const name of ['memoryLimiter', 'intentLimiter']) assert.equal(typeof defaultDeps[name]?.hitKey, 'function', name);
  assert.equal(typeof defaultDeps.pricing?.services, 'object');
  assert.equal(defaultDeps.config, config);
});

test('route fakes have exactly the defaultDeps shape', () => {
  const f = makeFakes();
  assert.deepEqual(Object.keys(f.deps).sort(), Object.keys(defaultDeps).sort());
  for (const group of ['telegram', 'google', 'ziina']) {
    assert.deepEqual(Object.keys(f.deps[group]).sort(), Object.keys(defaultDeps[group]).sort(), group);
  }
  // formatters are the production ones, not test copies
  for (const name of ['formatPaid', 'formatAttention', 'formatPaymentAlert']) {
    assert.equal(f.deps.telegram[name], defaultDeps.telegram[name], name);
  }
});

// ---- routing ------------------------------------------------------------------

test('routing: unknown path 404, wrong method 405, JSON errors with no-store', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const cases = [
    ['GET', '/', 404, 'not_found'],
    ['GET', '/admin', 404, 'not_found'],
    ['GET', '/availability/extra', 404, 'not_found'],
    ['GET', '/checkout', 405, 'method_not_allowed'],
    ['POST', '/availability', 405, 'method_not_allowed'],
    ['GET', '/webhook/ziina', 405, 'method_not_allowed'],
    ['DELETE', '/booking/00000000-0000-4000-8000-000000000000', 405, 'method_not_allowed'],
  ];
  for (const [m, p, status, code] of cases) {
    const r = await call(f, env, req(m, p));
    assert.equal(r.status, status, `${m} ${p}`);
    assert.deepEqual(r.json, { error: code });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-type'), /^application\/json/);
  }
});

// ---- 10. cors -------------------------------------------------------------------

test('cors: allowed origin gets CORS headers, never a wildcard', async () => {
  const f = makeFakes();
  for (const origin of [ORIGIN, 'https://staging.example.test']) {
    const r = await call(f, makeEnv(), req('GET', AVAIL, { origin }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.match(r.headers.get('vary'), /Origin/);
  }
  const c = await call(f, makeEnv(), req('POST', '/checkout', { origin: ORIGIN, body: validBody() }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.headers.get('access-control-allow-origin'), ORIGIN);
  // errors from an allowed origin also carry the header so the page can read them
  const e = await call(f, makeEnv(), req('POST', '/checkout', { origin: ORIGIN, body: validBody({ hours: 0 }) }));
  assert.equal(e.status, 400);
  assert.equal(e.headers.get('access-control-allow-origin'), ORIGIN);
});

test('cors: other origins get 403 on /availability and /checkout and no CORS headers', async () => {
  const f = makeFakes();
  for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`, 'http://klemmenovv-maker.github.io']) {
    for (const r of [
      await call(f, makeEnv(), req('GET', AVAIL, { origin })),
      await call(f, makeEnv(), req('POST', '/checkout', { origin, body: validBody() })),
    ]) {
      assert.equal(r.status, 403, origin);
      assert.deepEqual(r.json, { error: 'origin_not_allowed' });
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal(f.calls.createIntent.length, 0);
  assert.equal(f.calls.getBusy.length, 0);
});

test('cors: no Origin header is allowed (curl, server to server) and gets no CORS headers', async () => {
  const f = makeFakes();
  const r = await call(f, makeEnv(), req('GET', AVAIL));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('cors: preflight answers 204; headers only for an allowed origin', async () => {
  const f = makeFakes();
  const ok = await call(f, makeEnv(), req('OPTIONS', '/checkout', { origin: ORIGIN, headers: { 'Access-Control-Request-Method': 'POST' } }));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(ok.headers.get('access-control-max-age'), '600');
  assert.match(ok.headers.get('vary'), /Origin/);
  const bad = await call(f, makeEnv(), req('OPTIONS', '/checkout', { origin: 'https://evil.example' }));
  assert.equal(bad.status, 204);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal(bad.headers.get('access-control-allow-methods'), null);
  const wild = await call(f, makeEnv({ ALLOWED_ORIGINS: '*' }), req('OPTIONS', '/checkout', { origin: 'https://evil.example' }));
  assert.equal(wild.headers.get('access-control-allow-origin'), null);
});

// ---- 11. rate_limit ---------------------------------------------------------------

test('rate_limit: the 11th checkout per minute from one IP is 429; other IPs and the next minute are fine', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const ip = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    const r = await call(f, env, req('POST', '/checkout', { ip, body: validBody({ hours: 0 }) }));
    assert.equal(r.status, 400, `request ${i + 1}`);
  }
  const eleventh = await call(f, env, req('POST', '/checkout', { ip, body: validBody() }));
  assert.equal(eleventh.status, 429);
  assert.deepEqual(eleventh.json, { error: 'rate_limited' });
  assert.equal(f.calls.createIntent.length, 0);

  const other = await call(f, env, req('POST', '/checkout', { ip: '203.0.113.8', body: validBody({ hours: 0 }) }));
  assert.equal(other.status, 400);

  const put = env.BOOKINGS.puts.find((p) => p.key.startsWith('rl:checkout:203.0.113.7:'));
  assert.equal(put.opts.expirationTtl, 120);
  assert.equal(put.key, `rl:checkout:203.0.113.7:${Math.floor(Date.parse(NOW) / 60000)}`);

  f.nowIso = '2026-10-19T10:01:00+04:00';
  const nextMinute = await call(f, env, req('POST', '/checkout', { ip, body: validBody({ hours: 0 }) }));
  assert.equal(nextMinute.status, 400);
});

test('rate_limit: requests without CF-Connecting-IP share the "unknown" bucket; routes are separate', async () => {
  const f = makeFakes();
  const env = makeEnv();
  for (let i = 0; i < 10; i++) await call(f, env, req('POST', '/checkout', { ip: null, body: validBody({ hours: 0 }) }));
  assert.equal((await call(f, env, req('POST', '/checkout', { ip: null, body: validBody() }))).status, 429);
  assert.ok(await env.BOOKINGS.get(`rl:checkout:unknown:${Math.floor(Date.parse(NOW) / 60000)}`));
  assert.equal((await call(f, env, req('GET', AVAIL, { ip: null }))).status, 200);
});

test('cors: ALLOWED_ORIGINS entries are normalised (trim, case, trailing slash, empties)', async () => {
  const f = makeFakes();
  const env = makeEnv({ ALLOWED_ORIGINS: ' , HTTPS://Klemmenovv-Maker.GitHub.io/ ,, https://staging.example.test/' });
  const r = await call(f, env, req('GET', AVAIL, { origin: ORIGIN }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  const s2 = await call(f, env, req('GET', AVAIL, { origin: 'https://staging.example.test' }));
  assert.equal(s2.headers.get('access-control-allow-origin'), 'https://staging.example.test');
  const bad = await call(f, env, req('GET', AVAIL, { origin: 'https://evil.example' }));
  assert.equal(bad.status, 403);
});

test('rate_limit: availability allows 60 per minute', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const ip = '198.51.100.1';
  for (let i = 0; i < 60; i++) {
    assert.equal((await call(f, env, req('GET', '/availability?service=nope', { ip }))).status, 400);
  }
  assert.equal((await call(f, env, req('GET', '/availability?service=nope', { ip }))).status, 429);
  // counted in memory, not in KV
  assert.equal((await env.BOOKINGS.list({ prefix: 'rl:' })).keys.length, 0);
  assert.equal((await call(f, env, req('GET', '/availability?service=nope', { ip: '198.51.100.2' }))).status, 400);
  f.nowIso = '2026-10-19T10:01:00+04:00';
  assert.equal((await call(f, env, req('GET', '/availability?service=nope', { ip }))).status, 400);
});

const kvFailingOnRl = (env, method) => {
  const orig = env.BOOKINGS[method].bind(env.BOOKINGS);
  env.BOOKINGS[method] = async (key, ...rest) => {
    if (String(key).startsWith('rl:')) throw new Error('KV write limit exceeded');
    return orig(key, ...rest);
  };
};

test('rate_limit: KV counter failure fails open (request served, not 500)', async () => {
  for (const method of ['put', 'get']) {
    const f = makeFakes();
    const env = makeEnv();
    kvFailingOnRl(env, method);
    const r = await call(f, env, req('POST', '/checkout', { body: validBody() }));
    assert.equal(r.status, 200, `${method}: ${r.text}`);
    assert.ok(f.calls.log.some((l) => l.event === 'rate_limit_unavailable'));
  }
});

test('rate_limit: the webhook is never limited, even when KV counter writes fail', async () => {
  const f = makeFakes();
  const env = makeEnv();
  kvFailingOnRl(env, 'put');
  for (let i = 0; i < config.rate_limit.webhook_per_min + 10; i++) {
    const r = await call(f, env, req('POST', '/webhook/ziina', { ip: '192.0.2.50', body: webhookPayload('zi_unknown') }));
    assert.equal(r.status, 200, `request ${i + 1}`);
  }
  const env2 = makeEnv();
  for (let i = 0; i < 5; i++) await call(f, env2, req('POST', '/webhook/ziina', { ip: '192.0.2.51', body: webhookPayload('zi_unknown') }));
  assert.equal((await env2.BOOKINGS.list({ prefix: 'rl:' })).keys.length, 0);
});

test('rate_limit: only CF-Connecting-IP counts; X-Forwarded-For is ignored', async () => {
  const f = makeFakes();
  const env = makeEnv();
  for (let i = 0; i < 10; i++) {
    const r = await call(f, env, req('POST', '/checkout', {
      ip: '203.0.113.20', headers: { 'X-Forwarded-For': `198.18.0.${i}` }, body: validBody({ hours: 0 }),
    }));
    assert.equal(r.status, 400);
  }
  const spoofed = await call(f, env, req('POST', '/checkout', {
    ip: '203.0.113.20', headers: { 'X-Forwarded-For': '198.18.9.9' }, body: validBody(),
  }));
  assert.equal(spoofed.status, 429);
  const other = await call(f, env, req('POST', '/checkout', {
    ip: '203.0.113.21', headers: { 'X-Forwarded-For': '203.0.113.20' }, body: validBody({ hours: 0 }),
  }));
  assert.equal(other.status, 400);
});

// ---- 13. booking_lookup -------------------------------------------------------------

test('booking_lookup: 404 for non-UUID and unknown ids', async () => {
  const f = makeFakes();
  const env = makeEnv();
  for (const id of ['abc', '../booking', '00000000-0000-4000-8000-00000000000g', '%00', '00000000-0000-4000-8000-000000000000/x']) {
    const r = await call(f, env, req('GET', `/booking/${id}`));
    assert.equal(r.status, 404, id);
    assert.deepEqual(r.json, { error: 'not_found' });
  }
  const r = await call(f, env, req('GET', '/booking/00000000-0000-4000-8000-000000000000'));
  assert.equal(r.status, 404);
});

test('booking_lookup: held, expired and paid bookings expose only public fields', async () => {
  const f = makeFakes();
  const env = makeEnv();
  const c = await call(f, env, req('POST', '/checkout', { body: validBody() }));
  const id = c.json.bookingId;
  const held = await call(f, env, req('GET', `/booking/${id}`));
  assert.equal(held.status, 200);
  assert.deepEqual(Object.keys(held.json).sort(), ['depositAed', 'end', 'id', 'serviceLabel', 'start', 'status', 'totalAed']);
  assert.equal(held.json.status, 'held');
  for (const pii of ['Anna', '+97150', 'Golden', 'zi_']) assert.ok(!held.text.includes(pii), pii);

  f.nowIso = '2026-10-19T10:16:00+04:00'; // hold lapsed, cron not run yet
  assert.equal((await call(f, env, req('GET', `/booking/${id}`))).json.status, 'expired');

  f.nowIso = NOW;
  complete(f, f.lastIntentId);
  await call(f, env, req('POST', '/webhook/ziina', { body: webhookPayload(f.lastIntentId) }));
  const paid = await call(f, env, req('GET', `/booking/${id}`));
  assert.equal(paid.json.status, 'paid');
  assert.ok(!paid.text.includes('kb'));
});

// ---- scheduled cleanup ----------------------------------------------------------------

test('scheduled: releases lapsed holds', async () => {
  const kv = new MemKV();
  const long = new Date(Date.now() - 2 * 3600000);
  const day = new Date(Date.now() + 3 * 86400000 + 4 * 3600000).toISOString().slice(0, 10);
  const r = await createHold(kv, {
    serviceId: 'personal', serviceLabel: 'P', start: `${day}T10:00:00+04:00`, end: `${day}T11:00:00+04:00`,
    totalAed: 1200, depositAed: 500, name: 'n', contact: 'c',
  }, long);
  const ctx = makeCtx();
  await worker.scheduled({}, makeEnv({ BOOKINGS: kv }), ctx);
  await ctx.drain();
  assert.equal((await getBooking(kv, r.id)).status, 'expired');
});

test('default export has fetch and scheduled', () => {
  assert.equal(typeof worker.fetch, 'function');
  assert.equal(typeof worker.scheduled, 'function');
});

// ---- 14. response hygiene ------------------------------------------------------------

test('response hygiene: no secret, stack trace or provider body in any response or log', async () => {
  const boom = (label) => async () => {
    const e = new Error(`${label} failed ${SECRETS.ziina} ${SECRETS.telegram} ${SECRETS.hmac} ${SECRETS.google}`);
    e.body = `provider body ${SECRETS.ziina}`;
    throw e;
  };
  const out = [];
  const logs = [];
  const run = async (setup, request, envOver = {}) => {
    const f = makeFakes();
    const env = makeEnv({ ZIINA_WEBHOOK_SECRET: SECRETS.hmac, ...envOver });
    const ctx = await setup(f, env);
    const r = await call(f, env, typeof request === 'function' ? await request(f, ctx) : request);
    out.push(r);
    logs.push(...f.calls.log);
    return r;
  };
  const noop = async () => {};
  await run((f) => { f.getBusyImpl = boom('google'); }, req('GET', AVAIL));
  await run((f) => { f.getBusyImpl = boom('google'); }, req('POST', '/checkout', { body: validBody() }));
  await run((f) => { f.createIntentImpl = boom('ziina'); }, req('POST', '/checkout', { body: validBody() }));
  await run((f) => { f.deps.bookings = { ...f.deps.bookings, createHold: boom('kv') }; }, req('POST', '/checkout', { body: validBody() }));
  await run((f) => { f.deps.bookings = { ...f.deps.bookings, getBooking: boom('kv') }; },
    req('GET', '/booking/00000000-0000-4000-8000-000000000000'));
  await run(noop, req('POST', '/webhook/ziina', { body: '{}' }));
  await run(noop, req('POST', '/checkout', { body: '{bad', headers: { 'content-type': 'application/json' } }));
  // webhook failures after a real checkout (no HMAC secret so the request is processed)
  for (const fail of ['getIntentImpl', 'createEventImpl', 'notifyImpl']) {
    await run(async (f, env) => {
      const c = await call(f, env, req('POST', '/checkout', { body: validBody() }));
      assert.equal(c.status, 200);
      complete(f, f.lastIntentId);
      f[fail] = boom(fail);
    }, (f) => req('POST', '/webhook/ziina', { body: webhookPayload(f.lastIntentId) }), { ZIINA_WEBHOOK_SECRET: undefined });
  }
  assert.ok(out.some((r) => r.status === 500), 'an internal error was exercised');
  for (const r of out) {
    for (const s of Object.values(SECRETS)) assert.ok(!r.text.includes(s), `secret leaked: ${r.text}`);
    assert.ok(!/\bat \S+:\d+|Error\b|stack|provider body/.test(r.text), r.text);
  }
  const logText = logs.map((l) => JSON.stringify(l)).join('\n');
  for (const s of [...Object.values(SECRETS), 'Anna', '+97150', 'Golden', 'provider body']) {
    assert.ok(!logText.includes(s), `log leaked ${s}`);
  }
});
