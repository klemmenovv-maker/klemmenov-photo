// Slot computation. Dubai is a fixed UTC+04:00 (no DST); all math is integer
// minutes since the Unix epoch.
const DUBAI_OFFSET_MIN = 240;
const DAY_MIN = 1440;

function parseIso(value, field) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`${field}: invalid ISO date ${JSON.stringify(value)}`);
  return Math.floor(ms / 60000);
}

function parseClock(value, field) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new RangeError(`${field}: invalid time ${JSON.stringify(value)}`);
  return +m[1] * 60 + +m[2];
}

function toBlocked(list, field, bufferMin) {
  return (list ?? []).map((b) => ({
    start: parseIso(b?.start, `${field}.start`) - bufferMin,
    end: parseIso(b?.end, `${field}.end`) + bufferMin,
  }));
}

const pad = (n) => String(n).padStart(2, '0');

function formatDubai(epochMin) {
  const local = epochMin + DUBAI_OFFSET_MIN;
  const d = new Date(local * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+04:00`;
}

export function computeSlots({
  busy = [], durationMin, workHours = { from: '09:00', to: '20:00' },
  bufferMin = 30, minNoticeHours = 24, horizonDays = 60, now, held = [], stepMin = 30,
}) {
  if (!Number.isInteger(durationMin) || durationMin <= 0) {
    throw new RangeError('durationMin must be a positive integer');
  }
  if (!Number.isInteger(stepMin) || stepMin <= 0) throw new RangeError('stepMin must be a positive integer');
  const from = parseClock(workHours?.from, 'workHours.from');
  const to = parseClock(workHours?.to, 'workHours.to');
  if (from >= to) throw new RangeError('workHours.from must be before workHours.to');

  const nowMin = parseIso(now, 'now');
  const earliest = nowMin + minNoticeHours * 60;
  const horizon = nowMin + horizonDays * DAY_MIN;
  const blocked = [...toBlocked(busy, 'busy', bufferMin), ...toBlocked(held, 'held', bufferMin)];

  const firstDay = Math.floor((earliest + DUBAI_OFFSET_MIN) / DAY_MIN);
  const lastDay = Math.floor((horizon + DUBAI_OFFSET_MIN) / DAY_MIN);
  const slots = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const midnight = day * DAY_MIN - DUBAI_OFFSET_MIN;
    const weekday = new Date(day * DAY_MIN * 60000).getUTCDay();
    const overrides = workHours.byWeekday || {};
    const hours = Object.hasOwn(overrides, weekday) ? overrides[weekday] : workHours;
    if (hours === null) continue;
    const dailyFrom = parseClock(hours.from, 'workHours.day.from');
    const dailyTo = parseClock(hours.to, 'workHours.day.to');
    if (dailyFrom >= dailyTo) throw new RangeError('Invalid daily work hours');
    for (let t = dailyFrom; t + durationMin <= dailyTo; t += stepMin) {
      const s = midnight + t;
      if (s < earliest || s >= horizon) continue;
      if (blocked.some((b) => s < b.end && s + durationMin > b.start)) continue;
      slots.push(formatDubai(s));
    }
  }
  return slots;
}
