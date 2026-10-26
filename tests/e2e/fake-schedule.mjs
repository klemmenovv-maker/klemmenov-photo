// Local fake of GET /schedule for browser checks of the /book/ week calendar. Dev only, never deployed.
//   node tests/e2e/fake-schedule.mjs   (PORT, default 8788)
import http from 'node:http';
const PORT = Number(process.env.PORT || 8788);
const DURATION = { beauty: 120, premium: 240 };
const pad = (n) => String(n).padStart(2, '0');
const iso = (day, min) => `${day}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00+04:00`;
const busy = (day, min) => { const k = Number(day.slice(8)) * 7 + Math.floor(min / 60); return k % 5 === 0 || (day.endsWith('-29') && min >= 14 * 60 && min < 17 * 60); };
export function schedule(q) {
  const durationMin = (DURATION[q.get('service')] || Number(q.get('hours') || 1) * 60);
  const days = {}, timeline = {};
  for (let ms = Date.parse(`${q.get('from')}T00:00:00Z`); ms <= Date.parse(`${q.get('to')}T00:00:00Z`); ms += 86400000) {
    const d = new Date(ms), day = d.toISOString().slice(0, 10), wd = d.getUTCDay();
    const open = wd === 5 ? null : { from: 10 * 60, to: wd === 3 ? 18 * 60 : 21 * 60 };
    days[day] = []; timeline[day] = [];
    for (let m = 10 * 60; m < 21 * 60; m += 30) {
      const closed = !open || m < open.from || m + 30 > open.to;
      timeline[day].push({ start: iso(day, m), end: iso(day, m + 30), time: iso(day, m).slice(11, 16), photographerClosed: closed, photographer: !closed && !busy(day, m), studio: true });
    }
    if (!open) continue;
    for (let m = open.from; m + durationMin <= open.to; m += 30) {
      const ok = timeline[day].filter((c) => { const t = Number(c.time.slice(0, 2)) * 60 + Number(c.time.slice(3)); return t >= m && t < m + durationMin; }).every((c) => c.photographer);
      days[day].push({ start: iso(day, m), end: iso(day, m + durationMin), time: iso(day, m).slice(11, 16), photographer: ok, studio: true, available: ok });
    }
  }
  return { timeline, timezone: 'Asia/Dubai', durationMin, days, confirmation: 'request', bufferMin: 0 };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(schedule(u.searchParams)));
  }).listen(PORT, '127.0.0.1', () => console.log(`fake schedule on http://localhost:${PORT}`));
}
