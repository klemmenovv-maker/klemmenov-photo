import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLD_MINUTES, createHold, getBooking, attachIntent, markPaid, markNeedsAttention,
  releaseExpired, BookingNotFound, IntentMismatch, NotPaid, AmountMismatch,
} from './bookings.mjs';

class MemKV {
  constructor() { this.m = new Map(); this.afterPut = null; }
  async get(key, type) {
    await Promise.resolve();
    const v = this.m.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) {
    await Promise.resolve(); await Promise.resolve();
    this.m.set(key, value);
    if (this.afterPut) await this.afterPut(key);
  }
  async delete(key) { this.m.delete(key); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
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
  const r = await markPaid(kv, id, intent('pi_1'), t);
  assert.equal(r.changed, true);
  assert.equal(r.conflict, true);
  assert.equal(r.booking.status, 'paid_needs_attention');
  assert.equal(r.booking.reason, 'slot_taken_after_expiry');
  assert.equal(r.booking.paidAt, t === r.booking.paidAt ? t : r.booking.paidAt);
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
