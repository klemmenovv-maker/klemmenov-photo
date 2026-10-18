import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quote, depositFor } from './pricing.mjs';

const config = JSON.parse(readFileSync(new URL('../worker/pricing.json', import.meta.url), 'utf8'));
const q = (serviceId, hours, addons) => quote(config, { serviceId, hours, addons });

test('base services and deposits', () => {
  const cases = [
    ['personal', 1, 1200, 500], ['commercial', 2, 3000, 1500], ['event', 3, 4500, 2250],
    ['beauty', undefined, 5100, 2550], ['premium', undefined, 10200, 5100],
  ];
  for (const [id, h, total, deposit] of cases) {
    const r = q(id, h);
    assert.equal(r.ok, true, id);
    assert.equal(r.total, total, id);
    assert.equal(r.deposit, deposit, id);
    assert.equal(r.serviceId, id);
    assert.deepEqual(r.quoteOnly, []);
  }
});

test('add-ons are priced by quantity', () => {
  let r = q('personal', 2, { makeup_hair: 2, extra_retouch: 30 });
  assert.equal(r.total, 4700); assert.equal(r.deposit, 500);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.lines[0], { id: 'personal', label: 'Personal photoshoot', amount: 2400 });
  r = q('commercial', 3, { makeup: 1 });
  assert.equal(r.total, 5200); assert.equal(r.deposit, 2600);
  r = q('event', 3, { video_edit: 1 });
  assert.equal(r.total, 4650); assert.equal(r.deposit, 2325);
});

test('deposit rounds up', () => {
  assert.equal(depositFor(config, 'event', 4651), 2326);
  assert.equal(depositFor(config, 'personal', 99999), 500);
  assert.equal(depositFor(config, 'beauty', 5100), 2550);
});

test('quote-only add-ons are listed, never priced', () => {
  const r = q('commercial', 2, { second_photographer: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quoteOnly, ['second_photographer']);
  assert.equal(r.total, 3000);
  assert.equal(r.lines.some((l) => l.id === 'second_photographer'), false);
});

test('invalid hours', () => {
  for (const h of [0, -1, 0.5, 13, '2', NaN, 1e9, undefined, null, Infinity]) {
    assert.deepEqual(q('personal', h), { ok: false, error: 'invalid_hours' }, String(h));
  }
});

test('below minimum', () => {
  assert.deepEqual(q('commercial', 1), { ok: false, error: 'below_minimum' });
  assert.deepEqual(q('event', 1), { ok: false, error: 'below_minimum' });
});

test('unknown service and add-on', () => {
  assert.deepEqual(q('nope', 2), { ok: false, error: 'unknown_service' });
  assert.deepEqual(q('toString', 2), { ok: false, error: 'unknown_service' });
  assert.deepEqual(q('personal', 2, { nope: 1 }), { ok: false, error: 'unknown_addon' });
  assert.deepEqual(q('personal', 2, { constructor: 1 }), { ok: false, error: 'unknown_addon' });
});

test('invalid quantities', () => {
  for (const n of [0, -1, 1.5, '2', NaN, null, Infinity]) {
    assert.deepEqual(q('personal', 2, { makeup: n }), { ok: false, error: 'invalid_quantity' }, String(n));
  }
});

test('packages ignore hours and reject makeup add-ons', () => {
  assert.equal(q('beauty', 99).total, 5100);
  assert.deepEqual(q('beauty', undefined, { makeup: 1 }), { ok: false, error: 'not_available' });
  assert.deepEqual(q('premium', undefined, { makeup_hair: 1 }), { ok: false, error: 'not_available' });
  assert.equal(q('beauty', undefined, { extra_retouch: 5 }).total, 5150);
});

test('bad input never throws', () => {
  assert.equal(quote(config, null).ok, false);
  assert.equal(quote(config, {}).ok, false);
  assert.equal(quote(config, { serviceId: 'personal', hours: 1, addons: [] }).ok, false);
  assert.equal(quote(config, { serviceId: 'personal', hours: 1, addons: 'x' }).ok, false);
});
