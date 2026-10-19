// Outbound fetch timeouts for the Ziina, Google and Telegram clients.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { timeoutSignal, timeoutMs, DEFAULT_TIMEOUT_MS } from './fetch-timeout.mjs';
import { createIntent, getIntent, ZiinaError } from './ziina.mjs';
import { getBusy, createEvent, GoogleError, _resetTokenCacheForTests } from './google.mjs';
import { notify, TelegramError } from './telegram.mjs';

const ZTOKEN = 'zt_SECRET_timeout_ziina';
const TTOKEN = '777:SECRET_timeout_telegram';

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
const SA = { client_email: 'timeout-bot@example.iam.gserviceaccount.com', private_key: PEM };
const genv = (extra = {}) => ({ GOOGLE_SA_JSON: JSON.stringify(SA), GOOGLE_CALENDAR_ID: 'cal@example.test', ...extra });
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const intentOpts = {
  amountAed: 500, message: 'x', successUrl: 'https://example.test/ok', cancelUrl: 'https://example.test/no',
  expiryMs: 1893456000000, test: true,
};
const event = {
  serviceLabel: 'P', startIso: '2026-10-22T10:00:00+04:00', endIso: '2026-10-22T11:00:00+04:00',
  name: 'n', contact: 'c', notes: '', quoteOnly: [], depositAed: 1, totalAed: 2,
  bookingId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};

beforeEach(() => _resetTokenCacheForTests());

// A fetch that never answers but honours abort, like a real hung connection.
function hanging(answer = () => null) {
  const calls = [];
  const f = (url, init) => {
    calls.push({ url, init });
    const a = answer(url);
    if (a) return Promise.resolve(new Response(JSON.stringify(a.json), { status: a.status ?? 200 }));
    return new Promise((_, reject) => {
      // Keep the event loop alive like a real pending socket would (Node's
      // AbortSignal.timeout timer is unref'd); give up after 2 s.
      const keepAlive = setTimeout(() => reject(new Error('fake fetch: never aborted')), 2000);
      init.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason); }, { once: true });
    });
  };
  f.calls = calls;
  return f;
}

// A fetch that answers immediately and records the init.
function answering(json) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(typeof json === 'function' ? json(url) : json), { status: 200 });
  };
  f.calls = calls;
  return f;
}

const isTimeout = (Type, secrets) => (e) => {
  assert.ok(e instanceof Type, e?.name);
  assert.equal(e.status, 0);
  assert.match(e.message, /timed out/);
  for (const s of secrets) assert.ok(!e.message.includes(s) && !String(e.body ?? '').includes(s));
  return true;
};

// Rejects with the typed timeout error, and does so because of the 20 ms
// timeout (well before the fake's 2 s safety net).
async function timesOut(promise, Type, secrets) {
  const t0 = Date.now();
  await assert.rejects(promise, isTimeout(Type, secrets));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
}

// ---- helper ---------------------------------------------------------------------

test('timeoutMs: 8000 by default, env.HTTP_TIMEOUT_MS when positive', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 8000);
  assert.equal(timeoutMs({}), 8000);
  assert.equal(timeoutMs(undefined), 8000);
  assert.equal(timeoutMs({ HTTP_TIMEOUT_MS: '25' }), 25);
  for (const bad of ['0', '-5', 'abc', '']) assert.equal(timeoutMs({ HTTP_TIMEOUT_MS: bad }), 8000, bad);
});

test('timeoutSignal aborts after the timeout, with and without AbortSignal.timeout', async () => {
  const original = AbortSignal.timeout;
  try {
    for (const native of [true, false]) {
      if (!native) AbortSignal.timeout = undefined;
      const s = timeoutSignal(10);
      assert.ok(s instanceof AbortSignal);
      assert.equal(s.aborted, false);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(s.aborted, true, `native=${native}`);
    }
  } finally {
    AbortSignal.timeout = original;
  }
});

// ---- Ziina ----------------------------------------------------------------------

test('ziina: every request carries an AbortSignal', async () => {
  const f = answering({ id: 'pi_1', redirect_url: 'https://pay.example.test/x', status: 'pending' });
  await createIntent({ ZIINA_TOKEN: ZTOKEN }, intentOpts, f);
  await getIntent({ ZIINA_TOKEN: ZTOKEN }, 'pi_1', f);
  for (const c of f.calls) assert.ok(c.init.signal instanceof AbortSignal);
});

test('ziina: a hung request becomes ZiinaError status 0 "timed out"', async () => {
  const env = { ZIINA_TOKEN: ZTOKEN, HTTP_TIMEOUT_MS: '20' };
  await timesOut(createIntent(env, intentOpts, hanging()), ZiinaError, [ZTOKEN]);
  await timesOut(getIntent(env, 'pi_1', hanging()), ZiinaError, [ZTOKEN]);
});

// ---- Google ---------------------------------------------------------------------

test('google: token and API requests carry an AbortSignal', async () => {
  const f = answering((url) => url === TOKEN_URL ? { access_token: 'ya29.T', expires_in: 3600 }
    : { id: 'e', calendars: { 'cal@example.test': { busy: [] } } });
  await getBusy(genv(), { from: event.startIso, to: event.endIso }, f);
  await createEvent(genv(), event, f);
  assert.equal(f.calls.length, 3);
  for (const c of f.calls) assert.ok(c.init.signal instanceof AbortSignal, c.url);
});

test('google: a hung token request becomes GoogleError status 0 "timed out"', async () => {
  await timesOut(getBusy(genv({ HTTP_TIMEOUT_MS: '20' }), { from: event.startIso, to: event.endIso }, hanging()),
    GoogleError, [PEM, SA.client_email]);
});

test('google: a hung API request becomes GoogleError status 0 "timed out"', async () => {
  const f = hanging((url) => url === TOKEN_URL ? { json: { access_token: 'ya29.SECRET', expires_in: 3600 } } : null);
  await timesOut(createEvent(genv({ HTTP_TIMEOUT_MS: '20' }), event, f), GoogleError, ['ya29.SECRET', PEM]);
});

// ---- Telegram -------------------------------------------------------------------

test('telegram: the request carries an AbortSignal', async () => {
  const f = answering({ ok: true });
  await notify({ TELEGRAM_BOT_TOKEN: TTOKEN, TELEGRAM_CHAT_ID: '1' }, 'hi', f);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
});

test('telegram: a hung request becomes TelegramError status 0 "timed out" without the token', async () => {
  const env = { TELEGRAM_BOT_TOKEN: TTOKEN, TELEGRAM_CHAT_ID: '1', HTTP_TIMEOUT_MS: '20' };
  await timesOut(notify(env, 'hi', hanging()), TelegramError, [TTOKEN]);
});
