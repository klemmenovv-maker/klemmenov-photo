// GET /availability and the slot computation shared with /checkout.
import { fail, reply } from './http.mjs';

const DUBAI_OFFSET_MS = 4 * 3600000;
const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 31;

export const dubaiDay = (ms) => new Date(ms + DUBAI_OFFSET_MS).toISOString().slice(0, 10);
export const dubaiIso = (ms) => new Date(ms + DUBAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, '+04:00');
const dayStartMs = (day) => Date.parse(`${day}T00:00:00+04:00`);
const addDays = (day, n) => dubaiDay(dayStartMs(day) + n * DAY_MS);

// A strict YYYY-MM-DD that is a real calendar date.
function parseDay(v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return null;
  const ms = dayStartMs(v);
  return Number.isFinite(ms) && dubaiDay(ms) === v ? v : null;
}

// Duration in minutes for a successful quote: hourly -> hours * 60, package ->
// the configured package duration.
export function durationFor(config, q) {
  if (Number.isInteger(q.hours)) return q.hours * 60;
  const min = config.package_duration_min?.[q.serviceId];
  if (!Number.isInteger(min) || min <= 0) throw new RangeError(`no package duration for ${q.serviceId}`);
  return min;
}

export class CalendarUnavailable extends Error {
  constructor() { super('calendar unavailable'); this.name = 'CalendarUnavailable'; }
}

// Free slot starts ("YYYY-MM-DDTHH:MM:00+04:00") for Dubai days fromDay..toDay.
// Busy ranges come from Google (fail closed) and active holds/paid entries from
// KV; both are read in parallel.
export async function freeSlots({ env, deps, now }, durationMin, fromDay, toDay) {
  const cfg = deps.config;
  const range = { from: `${fromDay}T00:00:00+04:00`, to: `${addDays(toDay, 1)}T00:00:00+04:00` };
  const [busy, held] = await Promise.all([
    deps.google.getBusy(env, range, deps.fetch).catch(() => { throw new CalendarUnavailable(); }),
    deps.bookings.listActiveEntries(env.BOOKINGS, fromDay, toDay, now),
  ]);
  const slots = deps.computeSlots({
    busy: busy.map((b) => ({ start: b.start, end: b.end })),
    held,
    durationMin,
    workHours: cfg.workHours,
    bufferMin: cfg.bufferMin,
    minNoticeHours: cfg.minNoticeHours,
    horizonDays: cfg.horizonDays,
    stepMin: cfg.stepMin,
    now: now.toISOString(),
  });
  return slots.filter((s) => s.slice(0, 10) >= fromDay && s.slice(0, 10) <= toDay);
}

// Query-string hours: only plain digits become a number; anything else is
// passed through unchanged so quote() rejects it.
function queryHours(v) {
  if (v === null) return undefined;
  return /^\d{1,3}$/.test(v) ? Number(v) : v;
}

export async function availability(c) {
  const { url, deps, now } = c;
  const p = url.searchParams;
  const q = deps.quote(deps.pricing, { serviceId: p.get('service') ?? undefined, hours: queryHours(p.get('hours')) });
  if (!q.ok) return fail(400, q.error);
  const durationMin = durationFor(deps.config, q);

  const today = dubaiDay(now.getTime());
  const lastDay = dubaiDay(now.getTime() + deps.config.horizonDays * DAY_MS);
  let from = p.has('from') ? parseDay(p.get('from')) : addDays(today, 1);
  let to = p.has('to') ? parseDay(p.get('to')) : (from && addDays(from, 14));
  if (!from || !to || to < from) return fail(400, 'bad_range');
  if (from < today) from = today;
  if (to > lastDay) to = lastDay;
  if (to < from) return fail(400, 'bad_range');
  if ((dayStartMs(to) - dayStartMs(from)) / DAY_MS + 1 > MAX_SPAN_DAYS) return fail(400, 'bad_range');

  let slots;
  try {
    slots = await freeSlots(c, durationMin, from, to);
  } catch (e) {
    if (e instanceof CalendarUnavailable) return fail(503, 'calendar_unavailable');
    throw e;
  }
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = [];
  for (const s of slots) days[s.slice(0, 10)].push({ time: s.slice(11, 16), start: s });
  return reply(200, { service: q.serviceId, durationMin, timezone: 'Asia/Dubai', days });
}
