// Booking state on Cloudflare KV.
//
// Keys:
//   booking:<id>        the booking record
//   slots:<YYYY-MM-DD>  ONE index per Dubai calendar day (day of the booking's
//                       start) with [{id, start, end, createdAt, holdUntil, status}]
//
// Concurrency model (read before changing): KV is eventually consistent and has
// NO compare-and-set. We therefore defend in layers:
//   1. Within one isolate every read-modify-write on a day index (and on a
//      booking record) is serialised by a module-level promise-chain mutex.
//   2. After writing, we RE-READ the day index and check that our entry wins
//      every overlap by a deterministic rule (paid before held, then earlier
//      createdAt, then smaller id). A loser removes its own entry and reports
//      slot_taken.
// Residual risk: two different isolates writing the same day within KV's
// propagation window can both pass step 2 (last write wins, one entry may be
// clobbered). At single-owner volume this is very unlikely; the real upgrade
// path is a Durable Object per day, which gives true serialisation.
// Bookings that span Dubai midnight are indexed under the start day only.
// Only minimal PII is stored and payment tokens are never persisted.

export const HOLD_MINUTES = 15;

const DUBAI_OFFSET_MS = 4 * 3600000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export class BookingNotFound extends Error {
  constructor(id) { super(`booking not found: ${id}`); this.name = 'BookingNotFound'; }
}
export class IntentMismatch extends Error {
  constructor(msg = 'payment intent does not belong to this booking') { super(msg); this.name = 'IntentMismatch'; }
}
export class NotPaid extends Error {
  constructor(msg = 'payment intent is not completed') { super(msg); this.name = 'NotPaid'; }
}
export class AmountMismatch extends Error {
  constructor(msg = 'payment amount or currency does not match the deposit') { super(msg); this.name = 'AmountMismatch'; }
}

// ---- helpers ---------------------------------------------------------------

function toMs(value, field) {
  if (value instanceof Date) {
    const t = value.getTime();
    if (Number.isFinite(t)) return t;
  } else if (typeof value === 'string' && ISO_RE.test(value)) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  throw new RangeError(`${field}: invalid ISO date ${JSON.stringify(value)}`);
}

const dubaiIso = (ms) => new Date(ms + DUBAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+04:00');
const dubaiDay = (ms) => new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
const dayKey = (startMs) => `slots:${dubaiDay(startMs)}`;
const bookingKey = (id) => `booking:${id}`;

const isActive = (e, nowMs) => e.status !== 'held' || Date.parse(e.holdUntil) > nowMs;
const overlaps = (a, b) => Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);

// true when entry a takes precedence over entry b
function beats(a, b) {
  const ra = a.status === 'held' ? 1 : 0;
  const rb = b.status === 'held' ? 1 : 0;
  if (ra !== rb) return ra < rb;
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) < Date.parse(b.createdAt);
  return a.id < b.id;
}

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

async function readIndex(kv, key) {
  const idx = await kv.get(key, 'json');
  return Array.isArray(idx) ? idx : [];
}

async function writeIndex(kv, key, idx) {
  if (idx.length === 0) await kv.delete(key);
  else await kv.put(key, JSON.stringify(idx));
}

async function loadBooking(kv, id) {
  return (await kv.get(bookingKey(id), 'json')) ?? null;
}

const saveBooking = (kv, b) => kv.put(bookingKey(b.id), JSON.stringify(b));

// Try to claim the slot for booking `b` with the given index status. Returns
// true when the slot is ours after verification.
function claimSlot(kv, b, status, nowMs) {
  const key = dayKey(Date.parse(b.start));
  return withLock(key, async () => {
    const idx = await readIndex(kv, key);
    const others = idx.filter((e) => e.id !== b.id);
    const entry = { id: b.id, start: b.start, end: b.end, createdAt: b.createdAt, holdUntil: b.holdUntil, status };
    if (others.some((e) => isActive(e, nowMs) && overlaps(e, entry))) return false;
    await writeIndex(kv, key, [...others, entry]);

    const after = await readIndex(kv, key);
    const mine = after.find((e) => e.id === b.id);
    const lost = !mine || after.some((e) => e.id !== b.id && isActive(e, nowMs) && overlaps(e, mine) && beats(e, mine));
    if (lost) {
      const fresh = await readIndex(kv, key);
      await writeIndex(kv, key, fresh.filter((e) => e.id !== b.id));
      return false;
    }
    return true;
  });
}

function removeFromIndex(kv, b) {
  const key = dayKey(Date.parse(b.start));
  return withLock(key, async () => {
    const idx = await readIndex(kv, key);
    if (idx.some((e) => e.id === b.id)) await writeIndex(kv, key, idx.filter((e) => e.id !== b.id));
  });
}

function setIndexStatus(kv, b, status) {
  const key = dayKey(Date.parse(b.start));
  return withLock(key, async () => {
    const idx = await readIndex(kv, key);
    if (idx.some((e) => e.id === b.id)) {
      await writeIndex(kv, key, idx.map((e) => (e.id === b.id ? { ...e, status } : e)));
    }
  });
}

// ---- public API ------------------------------------------------------------

export async function createHold(kv, booking, now) {
  const nowMs = toMs(now, 'now');
  const startMs = toMs(booking?.start, 'start');
  const endMs = toMs(booking?.end, 'end');
  if (endMs <= startMs) throw new RangeError('end must be after start');

  const id = crypto.randomUUID();
  const record = {
    id,
    serviceId: booking.serviceId,
    serviceLabel: booking.serviceLabel,
    start: dubaiIso(startMs),
    end: dubaiIso(endMs),
    totalAed: booking.totalAed,
    depositAed: booking.depositAed,
    name: booking.name,
    contact: booking.contact,
    notes: booking.notes ?? '',
    quoteOnly: Array.isArray(booking.quoteOnly) ? [...booking.quoteOnly] : [],
    intentId: null,
    status: 'held',
    reason: null,
    createdAt: new Date(nowMs).toISOString(),
    holdUntil: new Date(nowMs + HOLD_MINUTES * 60000).toISOString(),
    paidAt: null,
  };

  if (!(await claimSlot(kv, record, 'held', nowMs))) return { ok: false, error: 'slot_taken' };
  await saveBooking(kv, record);
  return { ok: true, id };
}

export const getBooking = (kv, id) => loadBooking(kv, id);

export function attachIntent(kv, id, intentId) {
  return withLock(bookingKey(id), async () => {
    const b = await loadBooking(kv, id);
    if (!b) throw new BookingNotFound(id);
    const next = { ...b, intentId };
    await saveBooking(kv, next);
    return next;
  });
}

export function markPaid(kv, id, intent, now) {
  return withLock(bookingKey(id), async () => {
    const nowMs = toMs(now, 'now');
    const b = await loadBooking(kv, id);
    if (!b) throw new BookingNotFound(id);
    if (b.status === 'paid' || b.status === 'paid_needs_attention') return { changed: false, booking: b };
    if (!b.intentId || intent?.id !== b.intentId) throw new IntentMismatch();
    if (intent.status !== 'completed') throw new NotPaid();
    if (intent.currency !== 'AED' || intent.amountFils !== b.depositAed * 100) throw new AmountMismatch();

    const paidAt = new Date(nowMs).toISOString();
    // Upgrade (or, if the hold lapsed, re-claim) the slot as paid. A paid
    // entry never expires.
    const claimed = await claimSlot(kv, b, 'paid', nowMs);
    if (claimed) {
      const next = { ...b, status: 'paid', paidAt };
      await saveBooking(kv, next);
      return { changed: true, booking: next };
    }
    const next = { ...b, status: 'paid_needs_attention', reason: 'slot_taken_after_expiry', paidAt };
    await saveBooking(kv, next);
    return { changed: true, booking: next, conflict: true };
  });
}

export function markNeedsAttention(kv, id, reason) {
  return withLock(bookingKey(id), async () => {
    const b = await loadBooking(kv, id);
    if (!b) throw new BookingNotFound(id);
    const next = { ...b, status: 'paid_needs_attention', reason };
    await saveBooking(kv, next);
    await setIndexStatus(kv, b, 'paid_needs_attention');
    return next;
  });
}

export async function releaseExpired(kv, now) {
  const nowMs = toMs(now, 'now');
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'slots:', ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete === false ? page.cursor : undefined;
  } while (cursor);

  let released = 0;
  for (const key of keys) {
    const dropped = await withLock(key, async () => {
      const idx = await readIndex(kv, key);
      const gone = idx.filter((e) => !isActive(e, nowMs));
      if (gone.length) await writeIndex(kv, key, idx.filter((e) => isActive(e, nowMs)));
      return gone;
    });
    for (const e of dropped) {
      const marked = await withLock(bookingKey(e.id), async () => {
        const b = await loadBooking(kv, e.id);
        if (!b || b.status !== 'held') return false;
        await saveBooking(kv, { ...b, status: 'expired' });
        return true;
      });
      if (marked) released += 1;
    }
  }
  return released;
}
