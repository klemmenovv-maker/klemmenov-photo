import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitRequest } from './request-client.mjs';

const json = (status, body) => async () => new Response(JSON.stringify(body), { status });

test('submitRequest: success', async () => {
  let seen;
  const r = await submitRequest('https://w.example/', { a: 1 }, async (u, i) => { seen = { u, i }; return new Response('{"ok":true,"id":"x"}'); });
  assert.deepEqual(r, { ok: true, id: 'x' });
  assert.equal(seen.u, 'https://w.example/request');
  assert.equal(seen.i.method, 'POST');
});

test('submitRequest: validation errors stay on the form', async () => {
  const r = await submitRequest('https://w', {}, json(400, { error: 'invalid_contact' }));
  assert.equal(r.ok, false);
  assert.equal(r.fallback, null);
  assert.match(r.message, /phone/);
});

test('submitRequest: 429 asks to wait, no fallback', async () => {
  const r = await submitRequest('https://w', {}, json(429, { error: 'rate_limited' }));
  assert.equal(r.fallback, null);
  assert.match(r.message, /wait/);
});

test('submitRequest: server and network failures offer WhatsApp and never throw', async () => {
  for (const f of [json(502, { error: 'delivery_failed' }), json(503, { error: 'requests_not_enabled' }), async () => { throw new TypeError('x'); }, async () => new Response('<html>', { status: 500 })]) {
    const r = await submitRequest('https://w', {}, f);
    assert.equal(r.ok, false);
    assert.equal(r.fallback, 'whatsapp');
  }
});
