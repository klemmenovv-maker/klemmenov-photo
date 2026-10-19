import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_MINUTES, BOOKING_PAID_RETENTION_S, createHold, getBooking, attachIntent, markPaid, markNeedsAttention,
  releaseExpired, BookingNotFound, InvalidState, IntentMismatch, NotPaid, AmountMismatch,
} from './bookings.mjs';

class MemKV {
  constructor({ pageSize = 1000, yieldBetween = false } = {}) {
    this.m = new Map(); this.afterPut = null; this.pageSize = pageSize; this.yieldBetween = yieldBetween;
    this.puts = []; this.getCount = new Map(); this.stalePuts = 0;
    this.version = new Map(); this.lastRead = new Map();
  }
  async get(key, type) {
    this.getCount.set(key, (this.getCount.get(key) ?? 0) + 1);
    const ver = this.version.get(key) ?? 0;
    this.lastRead.set(key, ver);
    const v = this.m.get(key);
    await Promise.resolve();
    if (this.yieldBetween) for (let i = 0; i < 5; i++) await Promise.resolve();
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, opts) {
    await Promise.resolve(); await Promise.resolve();
    if ((this.version.get(key) ?? 0) !== (this.lastRead.get(key) ?? 0)) this.stalePuts += 1;
    this.puts.push({ key, opts });
    this.m.set(key, value);
    this.version.set(key, (this.version.get(key) ?? 0) + 1);
    if (this.afterPut) await this.afterPut(key);
  }
  async delete(key) { this.m.delete(key); this.version.set(key, (this.version.get(key) ?? 0) + 1); }
  async list({ prefix = '', cursor } = {}) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const page = all.slice(from, from + this.pageSize);
    const done = from + this.pageSize >= all.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: String(from + this.pageSize) }) };
  }
}

const NOW = '2026-10-18T10:00:00+04:00';
const mk = (start, end, extra = {}) => ({
  serviceId: 'portrait', serviceLabel: 'Portrait', start, end, totalAed: 500, depositAed: 100,
  name: 'A', contact: 'a@b.c', notes: '', quoteOnly: [], ...extra,
});
const S = (h, m = 0, day = 20) => `2026-10-${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+04:00`;
const intent = (id, over = {}) => ({ id, status: 'completed', amountFils: 10000, currency: 'AED', ...over });

test('HOLD_MINUTES is 15', () => assert.equal(HOLD_MINUTES, 15));

test('identical and partially overlapping intervals are slot_taken; adjacent succeed', async () => {
  const kv = new MemKV();
  assert.equal((await createHold(kv, mk(S(10), S(12)), NOW)).ok, true);
  assert.deepEqual(await createHold(kv, mk(S(10), S(12)), NOW), { ok: false, error: 'slot_taken' });
  assert.deepEqual(await createHold(kv, mk(S(11), S(13)), NOW), { ok: false, error: 'slot_taken' });
  assert.deepEqual(await createHold(kv, mk(S(9), S(10, 30)), NOW), { ok: false, error: 'slot_taken' });
  assert.deepEqual(await createHold(kv, mk(S(10, 30), S(11)), NOW), { ok: false, error: 'slot_taken' });
  assert.equal((await createHold(kv, mk(S(12), S(13)), NOW)).ok, true);
  assert.equal((await createHold(kv, mk(S(8), S(10)), NOW)).ok, true);
});

test('hold record fields', async () => {
  const kv = new MemKV();
  const r = await createHold(kv, mk(S(10), S(11)), new Date(NOW));
  const b = await getBooking(kv, r.id);
  assert.equal(b.status, 'held');
  assert.equal(b.intentId, null);
  assert.equal(b.paidAt, null);
  assert.equal(b.reason, null);
  assert.equal(b.start, S(10));
  assert.equal(Date.parse(b.holdUntil) - Date.parse(NOW), 15 * 60000);
  assert.equal(await getBooking(kv, 'nope'), null);
});

test('concurrent attempts on the same interval: exactly one wins', async () => {
  const kv = new MemKV();
  const rs = await Promise.all(Array.from({ length: 6 }, () => createHold(kv, mk(S(10), S(12)), NOW)));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(rs.filter((r) => !r.ok && r.error === 'slot_taken').length, 5);
});

test('concurrent attempts on different days both succeed', async () => {
  const kv = new MemKV();
  const rs = await Promise.all([
    createHold(kv, mk(S(10, 0, 20), S(12, 0, 20)), NOW),
    createHold(kv, mk(S(10, 0, 21), S(12, 0, 21)), NOW),
  ]);
  assert.ok(rs.every((r) => r.ok));
});

test('post-write verification: loser against a foreign earlier writer removes itself', async () => {
  const kv = new MemKV();
  let injected = false;
  kv.afterPut = async (key) => {
    if (key !== 'slots:2026-10-20' || injected) return;
    injected = true;
    const idx = JSON.parse(kv.m.get(key));
    idx.push({ id: 'foreign', start: S(10), end: S(12), createdAt: '2026-10-18T05:59:59.000Z', holdUntil: '2026-10-18T07:00:00.000Z', status: 'held' });
    kv.m.set(key, JSON.stringify(idx));
  };
  const r = await createHold(kv, mk(S(10), S(12)), NOW);
  assert.deepEqual(r, { ok: false, error: 'slot_taken' });
  const idx = JSON.parse(kv.m.get('slots:2026-10-20'));
  assert.deepEqual(idx.map((e) => e.id), ['foreign']);
  assert.equal([...kv.m.keys()].filter((k) => k.startsWith('booking:')).length, 0);
});

test('post-write verification: winner keeps its slot against a later foreign writer', async () => {
  const kv = new MemKV();
  let injected = false;
  kv.afterPut = async (key) => {
    if (key !== 'slots:2026-10-20' || injected) return;
    injected = true;
    const idx = JSON.parse(kv.m.get(key));
    idx.push({ id: 'foreign', start: S(10), end: S(12), createdAt: '2026-10-18T07:00:00.000Z', holdUntil: '2026-10-18T08:00:00.000Z', status: 'held' });
    kv.m.set(key, JSON.stringify(idx));
  };
  const r = await createHold(kv, mk(S(10), S(12)), NOW);
  assert.equal(r.ok, true);
});

test('day key uses Dubai date of start, normalising UTC input', async () => {
  const kv = new MemKV();
  const a = await createHold(kv, mk('2026-10-20T23:30:00+04:00', '2026-10-20T23:59:00+04:00'), NOW);
  assert.ok(a.ok);
  assert.ok(kv.m.has('slots:2026-10-20'));
  const b = await createHold(kv, mk('2026-10-20T19:30:00Z', '2026-10-20T19:59:00Z'), NOW);
  assert.deepEqual(b, { ok: false, error: 'slot_taken' });
  const c = await createHold(kv, mk('2026-10-20T20:30:00Z', '2026-10-20T21:30:00Z'), NOW); // 00:30 Dubai on the 21st
  assert.ok(c.ok);
  assert.ok(kv.m.has('slots:2026-10-21'));
  assert.equal((await getBooking(kv, c.id)).start, '2026-10-21T00:30:00+04:00');
});

test('invalid inputs throw RangeError', async () => {
  const kv = new MemKV();
  await assert.rejects(createHold(kv, mk(S(12), S(10)), NOW), RangeError);
  await assert.rejects(createHold(kv, mk(S(10), S(10)), NOW), RangeError);
  await assert.rejects(createHold(kv, mk('tomorrow', S(10)), NOW), RangeError);
  await assert.rejects(createHold(kv, mk(S(10), 'soon'), NOW), RangeError);
  await assert.rejects(createHold(kv, mk(S(10), S(11)), 'garbage'), RangeError);
});

test('markPaid happy path, then second call is unchanged', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  const r1 = await markPaid(kv, id, intent('pi_1'), '2026-10-18T10:05:00+04:00');
  assert.equal(r1.changed, true);
  assert.equal(r1.booking.status, 'paid');
  assert.ok(r1.booking.paidAt);
  const r2 = await markPaid(kv, id, intent('pi_1'), '2026-10-18T10:06:00+04:00');
  assert.equal(r2.changed, false);
  assert.equal(r2.booking.status, 'paid');
  assert.equal(r2.booking.paidAt, r1.booking.paidAt);
});

test('markPaid validation errors', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  await assert.rejects(markPaid(kv, 'missing', intent('pi_1'), NOW), BookingNotFound);
  await assert.rejects(markPaid(kv, id, intent('pi_x'), NOW), IntentMismatch);
  await assert.rejects(markPaid(kv, id, intent('pi_1', { status: 'pending' }), NOW), NotPaid);
  await assert.rejects(markPaid(kv, id, intent('pi_1', { amountFils: 9999 }), NOW), AmountMismatch);
  await assert.rejects(markPaid(kv, id, intent('pi_1', { currency: 'USD' }), NOW), AmountMismatch);
  assert.equal((await getBooking(kv, id)).status, 'held');
});

test('expired hold releases the slot', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  const later = '2026-10-18T10:15:00+04:00';
  assert.equal(await releaseExpired(kv, '2026-10-18T10:14:59+04:00'), 0);
  assert.equal(await releaseExpired(kv, later), 1);
  assert.equal((await getBooking(kv, id)).status, 'expired');
  assert.ok((await createHold(kv, mk(S(10), S(11)), later)).ok);
});

test('an expired-but-unreleased hold no longer blocks createHold', async () => {
  const kv = new MemKV();
  await createHold(kv, mk(S(10), S(11)), NOW);
  assert.ok((await createHold(kv, mk(S(10), S(11)), '2026-10-18T10:16:00+04:00')).ok);
});

test('markPaid after expiry re-claims the free slot', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  await releaseExpired(kv, '2026-10-18T10:20:00+04:00');
  const r = await markPaid(kv, id, intent('pi_1'), '2026-10-18T10:21:00+04:00');
  assert.equal(r.changed, true);
  assert.equal(r.booking.status, 'paid');
  assert.notEqual(r.conflict, true);
  assert.deepEqual(await createHold(kv, mk(S(10), S(11)), '2026-10-18T10:22:00+04:00'), { ok: false, error: 'slot_taken' });
});

test('markPaid after expiry flags paid_needs_attention when the slot was retaken', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  const t = '2026-10-18T10:20:00+04:00';
  await releaseExpired(kv, t);
  assert.ok((await createHold(kv, mk(S(10), S(11)), t)).ok);
  const otherBefore = JSON.parse(kv.m.get('slots:2026-10-20'));
  const r = await markPaid(kv, id, intent('pi_1'), t);
  assert.deepEqual(JSON.parse(kv.m.get('slots:2026-10-20')), otherBefore);
  assert.equal(otherBefore.length, 1);
  assert.equal(r.changed, true);
  assert.equal(r.conflict, true);
  assert.equal(r.booking.status, 'paid_needs_attention');
  assert.equal(r.booking.reason, 'slot_taken_after_expiry');
  const again = await markPaid(kv, id, intent('pi_1'), t);
  assert.equal(again.changed, false);
});

test('paid slots never expire in releaseExpired', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  await markPaid(kv, id, intent('pi_1'), NOW);
  assert.equal(await releaseExpired(kv, '2027-01-01T00:00:00+04:00'), 0);
  assert.equal((await getBooking(kv, id)).status, 'paid');
  assert.deepEqual(await createHold(kv, mk(S(10), S(11)), '2027-01-01T00:00:00+04:00'), { ok: false, error: 'slot_taken' });
});

test('markPaid on a held booking whose slot was taken after lapse (not yet released) flags attention', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  const t = '2026-10-18T10:30:00+04:00';
  assert.ok((await createHold(kv, mk(S(10), S(11)), t)).ok);
  const r = await markPaid(kv, id, intent('pi_1'), t);
  assert.equal(r.conflict, true);
  assert.equal(r.booking.status, 'paid_needs_attention');
});

test('markNeedsAttention sets status and reason; unknown id throws', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  const b = await markNeedsAttention(kv, id, 'calendar_failed');
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'calendar_failed');
  assert.equal((await getBooking(kv, id)).reason, 'calendar_failed');
  await assert.rejects(markNeedsAttention(kv, 'missing', 'x'), BookingNotFound);
});

test('attachIntent stores intent id; unknown id throws', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  assert.equal((await attachIntent(kv, id, 'pi_9')).intentId, 'pi_9');
  await assert.rejects(attachIntent(kv, 'missing', 'x'), BookingNotFound);
});

const days = (n) => n * 86400;

test('TTLs: slots index and booking records carry exact expirationTtl', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  // end of 2026-10-20 Dubai = 2026-10-21T00:00+04:00; NOW = 2026-10-18T10:00+04:00 -> 62h + 2d margin
  const slotPut = kv.puts.find((p) => p.key === 'slots:2026-10-20');
  assert.equal(slotPut.opts.expirationTtl, 62 * 3600 + days(2));
  const held = kv.puts.find((p) => p.key === `booking:${id}`);
  assert.equal(held.opts.expirationTtl, 15 * 60 + days(2));
  await attachIntent(kv, id, 'pi_1', NOW);
  await markPaid(kv, id, intent('pi_1'), NOW);
  const paidPut = kv.puts.filter((p) => p.key === `booking:${id}`).at(-1);
  assert.equal(paidPut.opts.expirationTtl, days(2) + BOOKING_PAID_RETENTION_S);
  assert.equal(BOOKING_PAID_RETENTION_S, days(400));
  assert.ok(kv.puts.every((p) => p.opts.expirationTtl >= 60));
});

test('TTL never below KV minimum of 60s', async () => {
  const kv = new MemKV();
  await createHold(kv, mk('2026-10-18T10:00:00+04:00', '2026-10-18T11:00:00+04:00'), '2030-01-01T00:00:00+04:00');
  assert.ok(kv.puts.every((p) => p.opts.expirationTtl >= 60));
  const slot = kv.puts.find((p) => p.key.startsWith('slots:'));
  assert.equal(slot.opts.expirationTtl, 60);
});

test('releaseExpired skips day keys older than yesterday (Dubai)', async () => {
  const kv = new MemKV();
  const old = [{ id: 'old', start: '2020-01-01T10:00:00+04:00', end: '2020-01-01T11:00:00+04:00', createdAt: '2020-01-01T00:00:00Z', holdUntil: '2020-01-01T00:15:00Z', status: 'held' }];
  kv.m.set('slots:2020-01-01', JSON.stringify(old));
  const { id } = await createHold(kv, mk(S(10, 0, 17), S(11, 0, 17)), '2026-10-17T00:00:00+04:00');
  assert.equal(await releaseExpired(kv, NOW), 1);
  assert.equal(kv.getCount.get('slots:2020-01-01') ?? 0, 0);
  assert.ok(kv.getCount.get('slots:2026-10-17') >= 1);
  assert.equal((await getBooking(kv, id)).status, 'expired');
});

test('releaseExpired paginates kv.list', async () => {
  const kv = new MemKV({ pageSize: 2 });
  for (let d = 20; d < 25; d++) await createHold(kv, mk(S(10, 0, d), S(11, 0, d)), NOW);
  assert.equal(await releaseExpired(kv, '2026-10-18T11:00:00+04:00'), 5);
});

test('booking spanning Dubai midnight throws RangeError; ending exactly at midnight is fine', async () => {
  const kv = new MemKV();
  await assert.rejects(createHold(kv, mk(S(23), S(1, 0, 21)), NOW), RangeError);
  assert.ok((await createHold(kv, mk(S(23), S(0, 0, 21)), NOW)).ok);
});

test('depositAed must be a positive safe integer', async () => {
  const kv = new MemKV();
  for (const bad of [0, -5, 10.5, '100', NaN, undefined]) {
    await assert.rejects(createHold(kv, mk(S(10), S(11), { depositAed: bad }), NOW), RangeError);
  }
});

test('attachIntent refuses non-held bookings (InvalidState)', async () => {
  const kv = new MemKV();
  const a = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, a.id, 'pi_1');
  await markPaid(kv, a.id, intent('pi_1'), NOW);
  await assert.rejects(attachIntent(kv, a.id, 'pi_2'), InvalidState);
  const b = await createHold(kv, mk(S(12), S(13)), NOW);
  await releaseExpired(kv, '2026-10-18T11:00:00+04:00');
  await assert.rejects(attachIntent(kv, b.id, 'pi_3'), InvalidState);
});

test('markNeedsAttention re-blocks a lapsed slot when free', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  const t = '2026-10-18T11:00:00+04:00';
  await releaseExpired(kv, t);
  await markNeedsAttention(kv, id, 'calendar_failed', t);
  assert.deepEqual(await createHold(kv, mk(S(10), S(11)), t), { ok: false, error: 'slot_taken' });
});

test('markNeedsAttention keeps the slot blocked and survives releaseExpired', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await markNeedsAttention(kv, id, 'calendar_failed', NOW);
  const later = '2026-10-19T10:00:00+04:00';
  assert.equal(await releaseExpired(kv, later), 0);
  assert.equal((await getBooking(kv, id)).status, 'paid_needs_attention');
  assert.deepEqual(await createHold(kv, mk(S(10), S(11)), later), { ok: false, error: 'slot_taken' });
});

test('markNeedsAttention leaves another holder untouched when the slot was retaken', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  const t = '2026-10-18T11:00:00+04:00';
  await releaseExpired(kv, t);
  const other = await createHold(kv, mk(S(10), S(11)), t);
  const before = JSON.parse(kv.m.get('slots:2026-10-20'));
  const b = await markNeedsAttention(kv, id, 'calendar_failed', t);
  assert.equal(b.status, 'paid_needs_attention');
  assert.equal(b.reason, 'calendar_failed');
  assert.deepEqual(JSON.parse(kv.m.get('slots:2026-10-20')), before);
  assert.equal(before[0].id, other.id);
});

test('cross-isolate loss on a still-valid hold uses reason slot_taken', async () => {
  const kv = new MemKV();
  const { id } = await createHold(kv, mk(S(10), S(11)), NOW);
  await attachIntent(kv, id, 'pi_1');
  const idx = JSON.parse(kv.m.get('slots:2026-10-20'));
  idx.push({ id: 'foreign', start: S(10), end: S(11), createdAt: '2026-10-18T05:00:00.000Z', holdUntil: '2026-10-18T07:00:00.000Z', status: 'paid' });
  kv.m.set('slots:2026-10-20', JSON.stringify(idx));
  const r = await markPaid(kv, id, intent('pi_1'), '2026-10-18T10:05:00+04:00');
  assert.equal(r.conflict, true);
  assert.equal(r.booking.reason, 'slot_taken');
});

test('mutex: concurrent holds never lose updates (fails without the lock)', async () => {
  const kv = new MemKV({ yieldBetween: true });
  const rs = await Promise.all(Array.from({ length: 6 }, () => createHold(kv, mk(S(10), S(12)), NOW)));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(kv.stalePuts, 0);
  const rs2 = await Promise.all(Array.from({ length: 6 }, (_, i) => createHold(kv, mk(S(13 + i), S(14 + i)), NOW)));
  assert.ok(rs2.every((r) => r.ok));
  assert.equal(kv.stalePuts, 0);
  assert.equal(JSON.parse(kv.m.get('slots:2026-10-20')).length, 7);
});
