import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLocalInput, fromLocalInput, formatWhen, tokenStore, api, readHash } from './account.mjs';

test('Dubai local input round trip', () => {
  assert.equal(toLocalInput('2026-10-22T11:00:00+04:00'), '2026-10-22T11:00');
  assert.equal(toLocalInput('2026-10-22T07:00:00Z'), '2026-10-22T11:00');
  assert.equal(fromLocalInput('2026-10-22T11:00'), '2026-10-22T11:00:00+04:00');
  assert.equal(fromLocalInput(''), null);
  assert.equal(toLocalInput('nope'), '');
});

test('formatWhen in both languages', () => {
  assert.equal(formatWhen('2026-10-22T11:00:00+04:00'), '22 Oct 2026, 11:00');
  assert.equal(formatWhen('2026-10-22T11:00:00+04:00', 'ru'), '22 окт 2026, 11:00');
  assert.equal(formatWhen(null, 'ru'), 'время не выбрано');
});

test('tokenStore survives broken storage', () => {
  const m = new Map();
  const s = tokenStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }, 'k');
  s.set('abc'); assert.equal(s.get(), 'abc'); s.set(null); assert.equal(s.get(), null);
  const bad = tokenStore({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } }, 'k');
  assert.equal(bad.get(), null); bad.set('a');
});

test('api sends the bearer token and never throws', async () => {
  let seen;
  const ok = await api('https://w.test/', '/my', { token: 'tok' }, async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ a: 1 }) }; });
  assert.deepEqual(ok, { ok: true, status: 200, data: { a: 1 } });
  assert.equal(seen.url, 'https://w.test/my');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  const down = await api('https://w.test', '/my', {}, async () => { throw new Error('net'); });
  assert.deepEqual(down, { ok: false, status: 0, data: null });
});

test('readHash', () => {
  assert.deepEqual(readHash('#s=abc.def'), { session: 'abc.def', error: null });
  assert.deepEqual(readHash('#error=forbidden'), { session: null, error: 'forbidden' });
  assert.deepEqual(readHash(''), { session: null, error: null });
});
