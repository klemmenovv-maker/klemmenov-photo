import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './index.mjs';
import { createHold } from './bookings.mjs';
import { makeEnv, makeCtx, makeFakes, req, DAY, NOW } from './test-helpers.mjs';

async function avail(f, env, query, opts = {}) {
  const res = await handle(req('GET', `/availability?${query}`, opts), env, makeCtx(), f.deps);
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text, res };
}

const times = (j, day = DAY) => j.days[day].map((s) => s.time);
const allDay2h = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00'];

test('availability: a free day returns every 2h start with time and full ISO start', async () => {
  const f = makeFakes();
  const r = await avail(f, makeEnv(), `service=personal&hours=2&from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.service, 'personal');
  assert.equal(r.json.durationMin, 120);
  assert.equal(r.json.timezone, 'Asia/Dubai');
  assert.deepEqual(Object.keys(r.json.days), [DAY]);
  assert.deepEqual(times(r.json), allDay2h);
  assert.deepEqual(r.json.days[DAY][0], { time: '09:00', start: `${DAY}T09:00:00+04:00` });
  assert.deepEqual(f.calls.getBusy, [{ from: `${DAY}T00:00:00+04:00`, to: '2026-10-22T00:00:00+04:00' }]);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('availability: removes a busy range (plus buffer) and an active hold; never exposes event titles', async () => {
  const f = makeFakes();
  const env = makeEnv();
  f.busy = [{ start: `${DAY}T12:00:00+04:00`, end: `${DAY}T13:00:00+04:00`, summary: 'Private dentist visit', id: 'gcal_evt_1' }];
  await createHold(env.BOOKINGS, {
    serviceId: 'personal', serviceLabel: 'Personal photoshoot', start: `${DAY}T17:00:00+04:00`, end: `${DAY}T18:00:00+04:00`,
    totalAed: 1200, depositAed: 500, name: 'Hidden Name', contact: 'hidden@example.test', notes: 'secret notes',
  }, NOW);
  const r = await avail(f, env, `service=personal&hours=2&from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 200);
  // busy 12:00-13:00 blocks 11:30-13:30 -> 2h starts 10:00..13:00 removed
  // hold 17:00-18:00 blocks 16:30-18:30 -> starts 15:00..18:00 removed
  assert.deepEqual(times(r.json), ['09:00', '09:30', '13:30', '14:00', '14:30']);
  for (const s of ['dentist', 'gcal_evt_1', 'Hidden', 'hidden@', 'secret']) assert.ok(!r.text.includes(s), s);
});

test('availability: a lapsed hold does not block', async () => {
  const f = makeFakes();
  const env = makeEnv();
  await createHold(env.BOOKINGS, {
    serviceId: 'personal', serviceLabel: 'P', start: `${DAY}T09:00:00+04:00`, end: `${DAY}T10:00:00+04:00`,
    totalAed: 1200, depositAed: 500, name: 'n', contact: 'c', notes: '',
  }, '2026-10-19T09:00:00+04:00');
  const r = await avail(f, env, `service=personal&hours=2&from=${DAY}&to=${DAY}`);
  assert.deepEqual(times(r.json), allDay2h);
});

test('availability: packages use the configured duration and ignore hours', async () => {
  const f = makeFakes();
  const r = await avail(f, makeEnv(), `service=premium&hours=99&from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.durationMin, 240);
  assert.equal(times(r.json).at(-1), '16:00');
  const r2 = await avail(f, makeEnv(), `service=beauty&from=${DAY}&to=${DAY}`);
  assert.equal(r2.json.durationMin, 120);
});

test('availability: fails closed with 503 when Google is unavailable', async () => {
  const f = makeFakes();
  f.getBusyImpl = async () => { throw new Error('google down'); };
  const r = await avail(f, makeEnv(), `service=personal&hours=2&from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { error: 'calendar_unavailable' });
});

test('availability: 400 on bad service, hours or range', async () => {
  const cases = [
    ['service=wedding&hours=2', 'unknown_service'],
    ['hours=2', 'unknown_service'],
    ['service=personal', 'invalid_hours'],
    ['service=personal&hours=0', 'invalid_hours'],
    ['service=personal&hours=abc', 'invalid_hours'],
    ['service=personal&hours=2.5', 'invalid_hours'],
    ['service=personal&hours=-1', 'invalid_hours'],
    ['service=personal&hours=13', 'invalid_hours'],
    ['service=commercial&hours=1', 'below_minimum'],
    ['service=personal&hours=2&from=21-10-2026', 'bad_range'],
    ['service=personal&hours=2&from=2026-02-31', 'bad_range'],
    ['service=personal&hours=2&from=2026-10-25&to=2026-10-24', 'bad_range'],
    ['service=personal&hours=2&from=2026-10-20&to=2026-11-21', 'bad_range'],
    ['service=personal&hours=2&from=2027-01-01&to=2027-01-02', 'bad_range'],
  ];
  for (const [q, code] of cases) {
    const f = makeFakes();
    const r = await avail(f, makeEnv(), q);
    assert.equal(r.status, 400, q);
    assert.deepEqual(r.json, { error: code }, q);
    assert.equal(f.calls.getBusy.length, 0, q);
  }
});

test('availability: default range is Dubai tomorrow .. +14 days (Dubai date differs from UTC date)', async () => {
  // 02:00 in Dubai on the 19th is still the 18th in UTC
  const f = makeFakes({ now: '2026-10-19T02:00:00+04:00' });
  const r = await avail(f, makeEnv(), 'service=personal&hours=2');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(f.calls.getBusy[0], { from: '2026-10-20T00:00:00+04:00', to: '2026-11-04T00:00:00+04:00' });
  const days = Object.keys(r.json.days);
  assert.equal(days[0], '2026-10-20');
  assert.equal(days.at(-1), '2026-11-03');
  assert.equal(days.length, 15);
});

test('availability: range is clamped to today and to the horizon', async () => {
  const f = makeFakes();
  const r = await avail(f, makeEnv(), 'service=personal&hours=2&from=2026-12-10&to=2027-01-05');
  assert.equal(r.status, 200, r.text);
  const days = Object.keys(r.json.days);
  assert.equal(days[0], '2026-12-10');
  assert.equal(days.at(-1), '2026-12-18'); // NOW + 60 days
  const r2 = await avail(f, makeEnv(), 'service=personal&hours=2&from=2026-10-01&to=2026-10-21');
  assert.equal(r2.status, 200, r2.text);
  assert.equal(Object.keys(r2.json.days)[0], '2026-10-19');
  assert.deepEqual(r2.json.days['2026-10-19'], []); // inside the 24h notice
});
