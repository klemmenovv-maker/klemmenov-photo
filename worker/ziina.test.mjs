import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntent, getIntent, ZiinaError, registerWebhookBody } from './ziina.mjs';

const env = { ZIINA_TOKEN: 'test-token' };
const base = {
  amountAed: 500,
  message: 'Booking 2026-11-01',
  successUrl: 'https://example.com/ok',
  cancelUrl: 'https://example.com/cancel',
  expiryMs: 1893456000000,
  test: true,
};

function fakeFetch(status, json, calls = []) {
  const f = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status });
  };
  f.calls = calls;
  return f;
}

test('createIntent sends the right request and returns id + redirectUrl', async () => {
  const f = fakeFetch(200, { id: 'pi_1', redirect_url: 'https://pay.ziina.com/x' });
  const r = await createIntent(env, base, f);
  assert.deepEqual(r, { id: 'pi_1', redirectUrl: 'https://pay.ziina.com/x' });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api-v2.ziina.com/api/payment_intent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer test-token');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    amount: 50000,
    currency_code: 'AED',
    message: 'Booking 2026-11-01',
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/cancel',
    expiry: '1893456000000',
    test: true,
  });
});

test('test:false is sent explicitly; failureUrl optional is included when given', async () => {
  const f = fakeFetch(200, { id: 'pi_1', redirect_url: 'https://r' });
  await createIntent(env, { ...base, test: false, failureUrl: 'https://example.com/fail' }, f);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.test, false);
  assert.ok('test' in body);
  assert.equal(body.failure_url, 'https://example.com/fail');
});

test('ZIINA_BASE overrides base url', async () => {
  const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
  await createIntent({ ...env, ZIINA_BASE: 'http://localhost:9/api' }, base, f);
  assert.equal(f.calls[0].url, 'http://localhost:9/api/payment_intent');
});

test('message truncated to 200 chars', async () => {
  const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
  await createIntent(env, { ...base, message: 'x'.repeat(500) }, f);
  assert.equal(JSON.parse(f.calls[0].init.body).message.length, 200);
});

test('non-2xx throws ZiinaError with status and no token in message', async () => {
  const f = fakeFetch(401, 'nope '.repeat(300));
  await assert.rejects(createIntent(env, base, f), (e) => {
    assert.ok(e instanceof ZiinaError);
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes('test-token'));
    assert.ok(e.body.length <= 500);
    return true;
  });
});

test('network error -> ZiinaError status 0', async () => {
  const f = async () => { throw new TypeError('boom'); };
  await assert.rejects(createIntent(env, base, f), (e) => e instanceof ZiinaError && e.status === 0);
});

test('2xx missing redirect_url or id throws ZiinaError', async () => {
  await assert.rejects(createIntent(env, base, fakeFetch(200, { id: 'a' })), ZiinaError);
  await assert.rejects(createIntent(env, base, fakeFetch(200, { redirect_url: 'https://r' })), ZiinaError);
  await assert.rejects(getIntent(env, 'a', fakeFetch(200, {})), ZiinaError);
});

test('invalid amountAed throws RangeError and never fetches', async () => {
  for (const amountAed of [0, -1, 0.5, '5', NaN, Infinity]) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(env, { ...base, amountAed }, f), RangeError);
    assert.equal(f.calls.length, 0);
  }
});

test('invalid expiryMs rejected', async () => {
  for (const expiryMs of [0, -5, 1.5, NaN, '123']) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(env, { ...base, expiryMs }, f), RangeError);
    assert.equal(f.calls.length, 0);
  }
});

test('bad URLs rejected, localhost allowed', async () => {
  for (const patch of [
    { successUrl: 'javascript:alert(1)' },
    { cancelUrl: 'ftp://x' },
    { successUrl: 'http://evil.com' },
    { failureUrl: 'nope' },
  ]) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(env, { ...base, ...patch }, f), RangeError);
    assert.equal(f.calls.length, 0);
  }
  const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
  await createIntent(env, { ...base, successUrl: 'http://localhost:8787/ok' }, f);
  assert.equal(f.calls.length, 1);
});

test('getIntent maps a completed intent', async () => {
  const f = fakeFetch(200, { id: 'pi_1', status: 'completed', amount: 50000, currency_code: 'AED', test: true });
  const r = await getIntent(env, 'pi_1', f);
  assert.deepEqual(r, { id: 'pi_1', status: 'completed', amountFils: 50000, currency: 'AED', test: true });
  assert.equal(f.calls[0].url, 'https://api-v2.ziina.com/api/payment_intent/pi_1');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer test-token');
});

test('getIntent encodes id and rejects empty id', async () => {
  const f = fakeFetch(200, { id: 'a/b', status: 'pending', amount: 1, currency_code: 'AED' });
  await getIntent(env, 'a/b', f);
  assert.equal(f.calls[0].url, 'https://api-v2.ziina.com/api/payment_intent/a%2Fb');
  for (const id of ['', undefined, 5]) {
    const g = fakeFetch(200, {});
    await assert.rejects(getIntent(env, id, g), RangeError);
    assert.equal(g.calls.length, 0);
  }
});

test('getIntent non-2xx throws ZiinaError', async () => {
  await assert.rejects(getIntent(env, 'x', fakeFetch(404, 'missing')), (e) => e instanceof ZiinaError && e.status === 404);
});

test('registerWebhookBody', () => {
  assert.deepEqual(registerWebhookBody('https://w.example.com/hook'), { url: 'https://w.example.com/hook' });
  assert.deepEqual(registerWebhookBody('https://w.example.com/hook', 's3'), { url: 'https://w.example.com/hook', secret: 's3' });
});

// ---- fix round 1 ----
test('URL check: tricky hosts and credentials rejected, good URLs accepted', async () => {
  for (const u of [
    'http://localhost.evil.com',
    'http://localhost@evil.com',
    'http://evil.com@localhost',
    'https://user:pw@example.com/x',
  ]) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(env, { ...base, successUrl: u }, f), RangeError, u);
    await assert.rejects(createIntent(env, { ...base, failureUrl: u }, f), RangeError, u);
    assert.equal(f.calls.length, 0);
  }
  for (const u of ['http://localhost:8787/ok', 'https://klemmenovv-maker.github.io/klemmenov-photo/book/thanks/?id=1']) {
    const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
    await createIntent(env, { ...base, successUrl: u }, f);
    assert.equal(f.calls.length, 1);
  }
});

test('missing/empty ZIINA_TOKEN throws ZiinaError(0) and never fetches', async () => {
  for (const e of [{}, { ZIINA_TOKEN: '' }, undefined]) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(e, base, f), (x) => x instanceof ZiinaError && x.status === 0);
    await assert.rejects(getIntent(e, 'a', f), (x) => x instanceof ZiinaError && x.status === 0);
    assert.equal(f.calls.length, 0);
  }
});

test('token never appears in message or body on any failure path', async () => {
  const T = env.ZIINA_TOKEN;
  const echo = `Bearer ${T} ${T}`;
  const cases = [
    fakeFetch(401, echo),
    fakeFetch(500, { error: echo }),
    async () => { throw new TypeError(echo); },
    fakeFetch(200, echo),
    fakeFetch(200, { id: 'a', note: echo }),
    fakeFetch(200, { note: echo }),
  ];
  for (const f of cases) {
    await assert.rejects(createIntent(env, base, f), (e) => {
      assert.ok(e instanceof ZiinaError);
      assert.ok(!e.message.includes(T), 'message leaks token');
      assert.ok(!e.body.includes(T), 'body leaks token');
      return true;
    });
  }
  const f = fakeFetch(401, echo);
  await assert.rejects(getIntent(env, 'a', f), (e) => !e.body.includes(T) && e.body.includes('[redacted]'));
});

test('Accept header is sent', async () => {
  const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
  await createIntent(env, base, f);
  assert.equal(f.calls[0].init.headers.Accept, 'application/json');
});

test('huge numbers rejected before network', async () => {
  for (const patch of [
    { amountAed: 1e300 },
    { amountAed: Number.MAX_SAFE_INTEGER },
    { expiryMs: 1e21 },
    { expiryMs: Number.MAX_SAFE_INTEGER + 2 },
  ]) {
    const f = fakeFetch(200, {});
    await assert.rejects(createIntent(env, { ...base, ...patch }, f), RangeError);
    assert.equal(f.calls.length, 0);
  }
});

test('message truncation does not split a surrogate pair', async () => {
  const f = fakeFetch(200, { id: 'a', redirect_url: 'https://r' });
  await createIntent(env, { ...base, message: 'x'.repeat(199) + '😀yyy' }, f);
  const m = JSON.parse(f.calls[0].init.body).message;
  assert.ok(m.isWellFormed());
  assert.equal(Array.from(m).length, 200);
  assert.ok(m.endsWith('😀'));
});

test('getIntent omits test when absent', async () => {
  const f = fakeFetch(200, { id: 'a', status: 'pending', amount: 1, currency_code: 'AED' });
  const r = await getIntent(env, 'a', f);
  assert.ok(!('test' in r));
});
