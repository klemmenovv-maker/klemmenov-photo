import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots } from './availability.mjs';

const NOW = '2026-10-18T06:00:00Z'; // 10:00 Dubai, Sunday
const base = { busy: [], held: [], now: NOW, durationMin: 60 };
const d = (day, hhmm) => `2026-10-${day}T${hhmm}:00+04:00`;
const onDay = (slots, day) => slots.filter((s) => s.startsWith(`2026-10-${day}T`));
const times = (slots) => slots.map((s) => s.slice(11, 16));

test('free day, 60 min: 09:00 through 19:00', () => {
  const t = times(onDay(computeSlots(base), '20'));
  assert.equal(t[0], '09:00');
  assert.equal(t.at(-1), '19:00');
  assert.equal(t.length, 21);
});

test('free day, 120 min: last start 18:00', () => {
  const t = times(onDay(computeSlots({ ...base, durationMin: 120 }), '20'));
  assert.equal(t[0], '09:00');
  assert.equal(t.at(-1), '18:00');
});

test('busy 12:00-14:00, 120 min shoot, 30 min buffer', () => {
  const busy = [{ start: d('20', '12:00'), end: d('20', '14:00') }];
  const t = times(onDay(computeSlots({ ...base, durationMin: 120, busy }), '20'));
  assert.ok(t.includes('09:30')); // ends 11:30 = 12:00 - buffer
  assert.ok(!t.includes('10:00'));
  assert.ok(!t.includes('14:00'));
  assert.ok(!t.includes('14:00') && !t.includes('13:30'));
  assert.ok(t.includes('14:30'));
  assert.ok(t.includes('09:00'));
  assert.deepEqual(t.filter((x) => x > '09:30' && x < '14:30'), []);
});

test('notice: now=10:00 on D hides starts before 10:00 on D+1', () => {
  const s = computeSlots(base);
  assert.equal(onDay(s, '18').length, 0);
  assert.equal(times(onDay(s, '19'))[0], '10:00');
});

test('held removes exactly what busy removes', () => {
  const r = [{ start: d('21', '12:00'), end: d('21', '14:00') }];
  assert.deepEqual(computeSlots({ ...base, held: r }), computeSlots({ ...base, busy: r }));
  assert.notDeepEqual(computeSlots({ ...base, held: r }), computeSlots(base));
});

test('UTC busy event 23:30-01:00 Dubai blocks correctly; no slot outside 09-20', () => {
  const busy = [{ start: '2026-10-20T19:30:00Z', end: '2026-10-20T21:00:00Z' }];
  const s = computeSlots({ ...base, busy });
  assert.deepEqual(s, computeSlots(base)); // outside work hours, buffer reaches 23:00 / 01:30 only
  for (const x of s) {
    const h = x.slice(11, 16);
    assert.ok(h >= '09:00' && h <= '19:00');
  }
  // a busy event ending 08:00 Dubai (04:00Z) blocks starts before 08:30 + nothing else
  const early = computeSlots({ ...base, busy: [{ start: '2026-10-20T03:00:00Z', end: '2026-10-20T05:30:00Z' }] });
  assert.equal(times(onDay(early, '20'))[0], '10:00'); // 09:30 end +30 buffer = 10:00
});

test('horizon: day 60 present, day after absent', () => {
  const s = computeSlots(base); // now = Oct 18 10:00 Dubai; +60d = Dec 17 10:00
  assert.ok(s.some((x) => x.startsWith('2026-12-16T')));
  assert.ok(!s.some((x) => x.startsWith('2026-12-18T')));
  assert.ok(!s.some((x) => x === '2026-12-17T10:00:00+04:00'));
  assert.ok(s.includes('2026-12-17T09:00:00+04:00'));
});

test('invalid durations throw RangeError', () => {
  for (const durationMin of [0, -60, NaN, '60', Infinity, 1.5]) {
    assert.throws(() => computeSlots({ ...base, durationMin }), RangeError);
  }
});

test('invalid ISO and workHours throw RangeError', () => {
  assert.throws(() => computeSlots({ ...base, now: 'nope' }), /now/);
  assert.throws(() => computeSlots({ ...base, busy: [{ start: 'x', end: d('20', '10:00') }] }), RangeError);
  assert.throws(() => computeSlots({ ...base, held: [{ start: d('20', '10:00'), end: 'x' }] }), /held/);
  assert.throws(() => computeSlots({ ...base, workHours: { from: '20:00', to: '09:00' } }), RangeError);
  assert.throws(() => computeSlots({ ...base, workHours: { from: '09:00', to: '09:00' } }), RangeError);
});

test('offset suffix, sorted, unique, no milliseconds', () => {
  const s = computeSlots(base);
  assert.ok(s.every((x) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+04:00$/.test(x)));
  assert.deepEqual(s, [...new Set(s)].sort());
});

test('overlapping and unsorted busy behave like merged', () => {
  const a = [
    { start: d('22', '13:00'), end: d('22', '15:00') },
    { start: d('22', '10:00'), end: d('22', '12:00') },
    { start: d('22', '11:00'), end: d('22', '13:30') },
  ];
  const merged = [{ start: d('22', '10:00'), end: d('22', '15:00') }];
  assert.deepEqual(computeSlots({ ...base, busy: a }), computeSlots({ ...base, busy: merged }));
});

test('stepMin and custom workHours', () => {
  const s = computeSlots({ ...base, stepMin: 60, workHours: { from: '10:00', to: '12:00' } });
  assert.deepEqual(times(onDay(s, '20')), ['10:00', '11:00']);
});
