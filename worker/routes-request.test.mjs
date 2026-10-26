import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './index.mjs';
import { makeEnv, makeCtx, makeFakes, req, validBody, START, ORIGIN } from './_helpers.mjs';

const CRM_URL = 'https://script.example.test/macros/s/SECRET_CRM_URL_0005/exec';
const reqEnv = (over = {}) => makeEnv({ CRM_WEBHOOK_URL: CRM_URL, ...over });

async function send(f, env, body, opts = {}) {
  const ctx = makeCtx();
  const res = await handle(req('POST', '/request', { body, origin: ORIGIN, ...opts }), env, ctx, f.deps);
  await ctx.drain();
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, res };
}

test('request: valid request reaches the CRM and Telegram, priced on the server', async () => {
  const f = makeFakes();
  const r = await send(f, reqEnv(), validBody({ serviceId: 'commercial', hours: 2, totalAed: 1, total: 1 }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(f.calls.crm.length, 1);
  const rec = f.calls.crm[0];
  assert.equal(rec.id, r.json.id);
  assert.equal(rec.totalAed, 3000);
  assert.equal(rec.name, 'Anna Client');
  assert.equal(rec.source, 'website');
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0], /New booking request/);
  assert.match(f.calls.notify[0], /Anna Client/);
  assert.doesNotMatch(f.calls.notify[0], /did not receive/);
  assert.equal(f.calls.createIntent.length, 0, 'no payment is started');
  assert.equal(r.res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('request: works without a start time', async () => {
  const f = makeFakes();
  const r = await send(f, reqEnv(), validBody({ start: undefined }));
  assert.equal(r.status, 200, r.text);
  assert.equal(f.calls.crm[0].start, null);
  assert.match(f.calls.notify[0], /not chosen/);
});

test('request: not enabled without any destination', async () => {
  const f = makeFakes();
  const r = await send(f, makeEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }), validBody());
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'requests_not_enabled' });
});

test('request: Telegram alone is enough when the CRM is not configured', async () => {
  const f = makeFakes();
  const r = await send(f, makeEnv(), validBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(f.calls.crm.length, 0);
  assert.equal(f.calls.notify.length, 1);
});

test('request: CRM failure still notifies the owner and says so', async () => {
  const f = makeFakes();
  f.crmImpl = async () => { throw new Error('boom'); };
  const r = await send(f, reqEnv(), validBody());
  assert.equal(r.status, 200, r.text);
  assert.match(f.calls.notify[0], /CRM did not receive/);
});

test('request: Telegram failure is fine when the CRM has the request', async () => {
  const f = makeFakes();
  f.notifyImpl = async () => { throw new Error('boom'); };
  const r = await send(f, reqEnv(), validBody());
  assert.equal(r.status, 200, r.text);
  assert.equal(f.calls.crm.length, 1);
});

test('request: both destinations failing returns 502 so the client can use WhatsApp', async () => {
  const f = makeFakes();
  f.crmImpl = async () => { throw new Error('boom'); };
  f.notifyImpl = async () => { throw new Error('boom'); };
  const env = reqEnv();
  const r = await send(f, env, validBody());
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, { error: 'delivery_failed' });
  assert.ok(f.calls.log.some((l) => l.event === 'request_undelivered'));
  // a retry after the outage is not swallowed as a duplicate
  f.crmImpl = null; f.notifyImpl = null;
  const again = await send(f, env, validBody());
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, undefined);
});

test('request: honeypot gets a fake success and delivers nothing', async () => {
  const f = makeFakes();
  const r = await send(f, reqEnv(), validBody({ website: 'http://spam.example' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(f.calls.crm.length, 0);
  assert.equal(f.calls.notify.length, 0);
});

test('request: an identical resubmission within minutes is not delivered twice', async () => {
  const f = makeFakes();
  const env = reqEnv();
  assert.equal((await send(f, env, validBody())).status, 200);
  const second = await send(f, env, validBody());
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
  assert.equal(f.calls.notify.length, 1);
  assert.equal(f.calls.crm.length, 1);
});

test('request: rate limit allows 3 per minute per IP', async () => {
  const f = makeFakes();
  const env = reqEnv();
  const ip = '203.0.113.9';
  for (let i = 0; i < 3; i++) {
    const r = await send(f, env, validBody({ contact: { name: `N${i}`, reach: '+971500000001', email: 'n@example.test' } }), { ip });
    assert.equal(r.status, 200);
  }
  const r = await send(f, env, validBody(), { ip });
  assert.equal(r.status, 429);
});

test('request: validation errors', async () => {
  const cases = [
    [{ serviceId: 'nope' }, 400],
    [{ contact: { name: '', reach: '+971500000001' } }, 400, 'invalid_name'],
    [{ contact: { name: 'A', reach: 'hello' } }, 400, 'invalid_contact'],
    [{ contact: 'x' }, 400, 'invalid_contact'],
    [{ notes: 'x'.repeat(1001) }, 400, 'invalid_notes'],
    [{ notes: 'see http://a.example and http://b.example' }, 400, 'invalid_notes'],
    [{ accepted_terms: false }, 400, 'terms_not_accepted'],
    [{ start: '2020-01-01T10:00:00+04:00' }, 400, 'invalid_start'],
    [{ start: '2026-02-31T10:00:00+04:00' }, 400, 'invalid_start'],
    [{ start: 'tomorrow' }, 400, 'invalid_start'],
    [{ hours: 1, serviceId: 'commercial' }, 400, 'below_minimum'],
  ];
  for (const [over, status, error] of cases) {
    const f = makeFakes();
    const r = await send(f, reqEnv(), validBody(over));
    assert.equal(r.status, status, JSON.stringify(over));
    if (error) assert.equal(r.json.error, error, JSON.stringify(over));
    assert.equal(f.calls.crm.length + f.calls.notify.length, 0);
  }
});

test('request: accepts email and telegram handle contacts', async () => {
  for (const reach of ['anna@example.com', '@anna_k']) {
    const f = makeFakes();
    const r = await send(f, reqEnv(), validBody({ contact: { name: 'Anna', reach, email: 'anna@example.test' } }));
    assert.equal(r.status, 200, reach);
  }
});

test('request: wrong content type, oversize body, foreign origin, wrong method', async () => {
  const f = makeFakes();
  const env = reqEnv();
  assert.equal((await send(f, env, 'x=1', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await send(f, env, validBody({ notes: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await send(f, env, validBody(), { origin: 'https://evil.example' })).status, 403);
  const res = await handle(req('GET', '/request', { origin: ORIGIN }), env, makeCtx(), f.deps);
  assert.equal(res.status, 405);
});

test('request: secrets never leak into responses or logs', async () => {
  const f = makeFakes();
  f.crmImpl = async () => { throw new Error(CRM_URL); };
  const r = await send(f, reqEnv(), validBody());
  assert.equal(r.status, 200);
  const all = JSON.stringify([r.text, f.calls.log]);
  assert.ok(!all.includes('SECRET_CRM_URL'));
});

test('request: not gated by SCHEDULE_ONLY (requests are not payments)', async () => {
  const f = makeFakes();
  const r = await send(f, reqEnv({ SCHEDULE_ONLY: 'true' }), validBody());
  assert.equal(r.status, 200);
  const co = await handle(req('POST', '/checkout', { body: validBody(), origin: ORIGIN }), reqEnv({ SCHEDULE_ONLY: 'true' }), makeCtx(), f.deps);
  assert.equal(co.status, 503);
});

test('request: email and location are required and validated; they reach the owner', async () => {
  const f = makeFakes();
  const bad = [
    ['no email', { contact: { name: 'A', reach: '+971500000001' } }, 'invalid_email'],
    ['bad email', { contact: { name: 'A', reach: '+971500000001', email: 'nope' } }, 'invalid_email'],
    ['no location', { location: undefined }, 'invalid_location'],
    ['unknown location', { location: { type: 'moon' } }, 'invalid_location'],
    ['client place without address', { location: { type: 'client', details: '' } }, 'invalid_location'],
  ];
  for (const [name, over, error] of bad) {
    const r = await send(f, reqEnv(), validBody(over));
    assert.equal(r.status, 400, name); assert.equal(r.json.error, error, name);
  }
  const ok = await send(f, reqEnv(), validBody({ location: { type: 'client', details: 'Marina, Tower 5, apt 12' } }));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(f.calls.crm[0].email, 'anna@example.test');
  assert.equal(f.calls.crm[0].location, 'client');
  assert.match(f.calls.notify[0], /Email: anna@example\.test/);
  assert.match(f.calls.notify[0], /Location: client, Marina/);
});
