// Local fake of the booking Worker for browser checks of /book/ live mode. Dev only, never deployed.
//   node tests/e2e/fake-api.mjs            (PORT, default 8787)
// Failure switches, from the environment at start or at runtime via GET /__set?availability=..&checkout=..
//   FAKE_AVAILABILITY_ERROR=calendar_unavailable  -> GET /availability answers 503 with that code
//   FAKE_CHECKOUT_ERROR=slot_taken                 -> POST /checkout answers 409 with that code
//   value "drop" closes the connection (the browser sees a network error)
// Booking ids for the thanks page:
//   any id returned by /checkout   held for two polls, then paid
//   00000000-0000-4000-8000-00000000e001  expired
//   00000000-0000-4000-8000-00000000e002  held forever (pending)
//   any other UUID                        404 not_found
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const mode = {
  availability: process.env.FAKE_AVAILABILITY_ERROR || '',
  checkout: process.env.FAKE_CHECKOUT_ERROR || '',
};
const STATUS = { calendar_unavailable: 503, rate_limited: 429, slot_taken: 409, slot_unavailable: 409, payment_unavailable: 502, terms_not_accepted: 400 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DURATION = { beauty: 120, premium: 240 };
const bookings = new Map([
  ['00000000-0000-4000-8000-00000000e001', { status: 'expired', polls: 0 }],
  ['00000000-0000-4000-8000-00000000e002', { status: 'held', polls: -Infinity }],
]);

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function send(res, req, status, body) {
  const origin = req.headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  });
  res.end(JSON.stringify(body));
}

function fail(res, req, code) {
  if (code === 'drop') { req.socket.destroy(); return; }
  send(res, req, STATUS[code] || 400, { error: code });
}

function availability(req, res, url) {
  if (mode.availability) return fail(res, req, mode.availability);
  const p = url.searchParams;
  const service = p.get('service');
  const hours = Number(p.get('hours'));
  const durationMin = DURATION[service] || (hours > 0 ? hours * 60 : 0);
  if (!durationMin) return send(res, req, 400, { error: 'invalid_hours' });
  const from = p.get('from'), to = p.get('to');
  const days = {};
  for (let d = from, i = 0; d <= to && i < 31; d = addDays(d, 1), i++) {
    const n = Number(d.slice(8, 10));
    days[d] = n % 3 === 0 ? [] : ['10:00', '10:30', '13:00', '15:30', '17:00'].slice(0, 2 + (n % 4))
      .map((t) => ({ time: t, start: `${d}T${t}:00+04:00` }));
  }
  send(res, req, 200, { service, durationMin, timezone: 'Asia/Dubai', days });
}

async function checkout(req, res) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, req, 415, { error: 'unsupported_media_type' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, req, 400, { error: 'bad_request' }); }
  console.log('checkout', JSON.stringify({ ...body, contact: '[redacted]', notes: body.notes ? '[redacted]' : '' }));
  if (mode.checkout) return fail(res, req, mode.checkout);
  if (body.accepted_terms !== true) return send(res, req, 400, { error: 'terms_not_accepted' });
  const id = randomUUID();
  const total = 5200, deposit = 2600;
  bookings.set(id, { status: 'held', polls: 0, serviceLabel: 'Event photography', start: body.start, totalAed: total, depositAed: deposit });
  send(res, req, 200, { bookingId: id, redirectUrl: `https://pay.ziina.com/test?booking=${id}`, totalAed: total, depositAed: deposit });
}

function booking(req, res, id) {
  if (!UUID_RE.test(id) || !bookings.has(id)) return send(res, req, 404, { error: 'not_found' });
  const b = bookings.get(id);
  b.polls++;
  if (b.status === 'held' && b.polls > 2) b.status = 'paid';
  send(res, req, 200, {
    id, status: b.status, serviceLabel: b.serviceLabel || 'Personal photoshoot', start: b.start || '2026-10-22T10:00:00+04:00',
    end: null, depositAed: b.depositAed || 500, totalAed: b.totalAed || 2400,
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      Vary: 'Origin',
    });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/__set') {
    for (const k of Object.keys(mode)) if (url.searchParams.has(k)) mode[k] = url.searchParams.get(k);
    return send(res, req, 200, mode);
  }
  if (req.method === 'GET' && url.pathname === '/availability') return availability(req, res, url);
  if (req.method === 'POST' && url.pathname === '/checkout') return checkout(req, res);
  if (req.method === 'GET' && url.pathname.startsWith('/booking/')) return booking(req, res, url.pathname.slice(9));
  send(res, req, 404, { error: 'not_found' });
}).listen(PORT, '127.0.0.1', () => console.log(`fake booking API on http://localhost:${PORT}`));
