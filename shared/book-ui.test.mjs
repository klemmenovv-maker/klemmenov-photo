import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quote } from './pricing.mjs';
import { buildWhatsAppText, formatAed, parseServiceParam, waUrl } from './book-ui.mjs';

const config = JSON.parse(readFileSync(new URL('../worker/pricing.json', import.meta.url), 'utf8'));
const contact = { name: 'Anna', notes: '', preferredDate: '', greeting: 'Hello, I would like to book.' };

test('whatsapp_text_includes_lines_and_total', () => {
  const r = quote(config, { serviceId: 'event', hours: 3, addons: { makeup: 1 } });
  const lines = buildWhatsAppText(r, { ...contact, reach: '@anna', preferredDate: 'Sat 14 Nov, evening', notes: 'Rooftop' }, { makeup: 1 }).split('\n');
  assert.equal(lines[0], 'Hello, I would like to book.');
  assert.ok(lines.includes('Shoot: Event photography, 3 hours'));
  assert.ok(lines.includes('Makeup artist'));
  assert.ok(lines.includes('Total online: 5 200 AED'));
  assert.ok(lines.includes('Preferred date: Sat 14 Nov, evening'));
  assert.ok(lines.includes('Name: Anna'));
  assert.ok(lines.includes('Contact: @anna'));
  assert.ok(lines.includes('Notes: Rooftop'));
});

test('singular hour', () => {
  const r = quote(config, { serviceId: 'personal', hours: 1 });
  assert.match(buildWhatsAppText(r, contact), /Shoot: Personal photoshoot, 1 hour\n/);
});

test('package has no hours', () => {
  const r = quote(config, { serviceId: 'beauty' });
  const t = buildWhatsAppText(r, contact);
  assert.match(t, /Shoot: Studio Beauty Package\n/);
  assert.doesNotMatch(t, /hour/);
});

test('quantity shown when above one', () => {
  const r = quote(config, { serviceId: 'personal', hours: 2, addons: { extra_retouch: 5 } });
  assert.ok(buildWhatsAppText(r, contact, { extra_retouch: 5 }).split('\n').includes('Extra retouched photo x 5'));
});

test('quote-only line wording', () => {
  const r = quote(config, { serviceId: 'personal', hours: 2, addons: { travel: 1 } });
  const t = buildWhatsAppText(r, contact, { travel: 1 });
  assert.ok(t.split('\n').includes('travel (quote, confirmed by the photographer)'));
  const t2 = buildWhatsAppText(r, contact, { travel: 1 }, { quoteLabels: { travel: 'Travel' } });
  assert.ok(t2.split('\n').includes('Travel (quote, confirmed by the photographer)'));
});

test('empty optional fields skipped', () => {
  const r = quote(config, { serviceId: 'personal', hours: 1 });
  const t = buildWhatsAppText(r, { greeting: 'Hi', name: '  ', notes: '', preferredDate: '' });
  assert.doesNotMatch(t, /Name:|Notes:|Preferred date:/);
});

test('formatAed', () => {
  assert.equal(formatAed(5200), '5 200');
  assert.equal(formatAed(999), '999');
  assert.equal(formatAed(10200), '10 200');
});

test('parseServiceParam', () => {
  for (const id of ['personal', 'commercial', 'event', 'beauty', 'premium']) {
    assert.equal(parseServiceParam('?service=' + id, config.services), id);
  }
  for (const bad of ['', '?service=', '?service=nope', '?service=__proto__', '?service=constructor', '?x=1', '?service=event%00', null, undefined]) {
    assert.equal(parseServiceParam(bad, config.services), null, String(bad));
  }
});

test('waUrl encodes newlines and text', () => {
  assert.equal(waUrl('971557087169', 'a b\nc&d'), 'https://wa.me/971557087169?text=a%20b%0Ac%26d');
});

// ---------------------------------------------------------------- live mode
import {
  BookingApiError, loadSlots, submitCheckout, pollBooking, friendlyError, canPay, payMissing,
  isAllowedRedirect, dayLabel, addDays, dubaiToday, slotWhen, isUuid, tzDiffers,
} from './book-ui.mjs';

const API = 'https://api.example.test';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(url, init) : r;
  };
  fn.calls = calls;
  return fn;
}
const AVAIL = {
  service: 'event', durationMin: 180, timezone: 'Asia/Dubai',
  days: {
    '2026-10-21': [{ time: '10:00', start: '2026-10-21T10:00:00+04:00' }, { time: '10:30', start: '2026-10-21T10:30:00+04:00' }],
    '2026-10-20': [],
  },
};

test('loadSlots builds the query and returns sorted days', async () => {
  const f = fakeFetch(json(200, AVAIL));
  const r = await loadSlots(API + '/', { serviceId: 'event', hours: 3 }, { from: '2026-10-20', to: '2026-10-21' }, f);
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.example.test/availability');
  assert.equal(u.searchParams.get('service'), 'event');
  assert.equal(u.searchParams.get('hours'), '3');
  assert.equal(u.searchParams.get('from'), '2026-10-20');
  assert.equal(u.searchParams.get('to'), '2026-10-21');
  assert.ok(f.calls[0].init.signal, 'fetch gets a timeout signal');
  assert.deepEqual(r, {
    timezone: 'Asia/Dubai', durationMin: 180,
    days: [
      { date: '2026-10-20', slots: [] },
      { date: '2026-10-21', slots: [{ time: '10:00', start: '2026-10-21T10:00:00+04:00' }, { time: '10:30', start: '2026-10-21T10:30:00+04:00' }] },
    ],
  });
});

test('loadSlots omits hours for packages', async () => {
  const f = fakeFetch(json(200, { ...AVAIL, durationMin: 120 }));
  await loadSlots(API, { serviceId: 'beauty' }, { from: '2026-10-20', to: '2026-10-21' }, f);
  assert.equal(new URL(f.calls[0].url).searchParams.has('hours'), false);
});

test('loadSlots rejects malformed responses', async () => {
  const bad = [
    null, [], {}, { ...AVAIL, days: [] }, { ...AVAIL, timezone: 5 }, { ...AVAIL, durationMin: '180' },
    { ...AVAIL, days: { '2026-13-01': [] } },
    { ...AVAIL, days: { 'x': [] } },
    { ...AVAIL, days: { '2026-10-21': 'nope' } },
    { ...AVAIL, days: { '2026-10-21': [{ time: '10:00', start: '2026-10-22T10:00:00+04:00' }] } },
    { ...AVAIL, days: { '2026-10-21': [{ time: '10:00', start: '2026-10-21T10:00:00Z' }] } },
    { ...AVAIL, days: { '2026-10-21': [{ time: '25:00', start: '2026-10-21T10:00:00+04:00' }] } },
    { ...AVAIL, days: { '2026-10-21': [{ time: '10:00', start: '2026-10-21T11:00:00+04:00' }] } },
    { ...AVAIL, days: { '2026-10-21': [null] } },
  ];
  for (const body of bad) {
    await assert.rejects(loadSlots(API, { serviceId: 'event', hours: 3 }, { from: '2026-10-20', to: '2026-10-21' }, fakeFetch(json(200, body))),
      (e) => e instanceof BookingApiError && e.code === 'bad_response', JSON.stringify(body));
  }
});

test('loadSlots maps worker errors and network failure', async () => {
  const sel = { serviceId: 'event', hours: 3 }, range = { from: '2026-10-20', to: '2026-10-21' };
  await assert.rejects(loadSlots(API, sel, range, fakeFetch(json(503, { error: 'calendar_unavailable' }))),
    (e) => e instanceof BookingApiError && e.code === 'calendar_unavailable' && e.status === 503);
  await assert.rejects(loadSlots(API, sel, range, fakeFetch(json(429, { error: 'rate_limited' }))),
    (e) => e.code === 'rate_limited' && e.status === 429);
  await assert.rejects(loadSlots(API, sel, range, fakeFetch(json(500, 'nope'))),
    (e) => e.code === 'http_error' && e.status === 500);
  await assert.rejects(loadSlots(API, sel, range, fakeFetch(new TypeError('Failed to fetch'))),
    (e) => e instanceof BookingApiError && e.code === 'network' && e.status === 0);
  await assert.rejects(loadSlots(API, sel, range, fakeFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } })),
    (e) => e.code === 'bad_response');
});

const PAYLOAD = {
  serviceId: 'event', hours: 3, addons: { makeup: 1 }, start: '2026-10-21T10:00:00+04:00',
  contact: { name: 'Anna', reach: '@anna' }, notes: 'Rooftop', accepted_terms: true,
};
const CHECKOUT_OK = { bookingId: '3f2c1a9e-5b7d-4c1e-9a2b-1234567890ab', redirectUrl: 'https://pay.ziina.com/test', totalAed: 5200, depositAed: 2600 };

test('submitCheckout posts JSON and returns the redirect', async () => {
  const f = fakeFetch(json(200, CHECKOUT_OK));
  const r = await submitCheckout(API, PAYLOAD, f);
  assert.deepEqual(r, CHECKOUT_OK);
  assert.equal(f.calls[0].url, 'https://api.example.test/checkout');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), PAYLOAD);
  assert.ok(f.calls[0].init.signal);
});

test('submitCheckout errors', async () => {
  await assert.rejects(submitCheckout(API, PAYLOAD, fakeFetch(json(409, { error: 'slot_taken' }))),
    (e) => e instanceof BookingApiError && e.code === 'slot_taken' && e.status === 409);
  await assert.rejects(submitCheckout(API, PAYLOAD, fakeFetch(new TypeError('offline'))), (e) => e.code === 'network');
  await assert.rejects(submitCheckout(API, PAYLOAD, fakeFetch(json(200, { bookingId: 'x' }))), (e) => e.code === 'bad_response');
});

test('redirect allow-list', async () => {
  for (const ok of ['https://ziina.com/pay/1', 'https://pay.ziina.com/test', 'https://a.b.ziina.com/x?y=1']) {
    assert.equal(isAllowedRedirect(ok), true, ok);
  }
  const bad = ['https://ziina.com.evil.com/', 'http://ziina.com/', 'javascript:alert(1)', 'https://evilziina.com/',
    'https://ziina.com@evil.com/', 'https://evil.com/?r=ziina.com', '//ziina.com/', 'https://user:pw@ziina.com/',
    'https://ziina.com:8443/', 'data:text/html,x', '', null, 42];
  for (const b of bad) {
    assert.equal(isAllowedRedirect(b), false, String(b));
    await assert.rejects(submitCheckout(API, PAYLOAD, fakeFetch(json(200, { ...CHECKOUT_OK, redirectUrl: b }))),
      (e) => e instanceof BookingApiError && e.code === 'bad_redirect', String(b));
  }
});

const ID = '3f2c1a9e-5b7d-4c1e-9a2b-1234567890ab';
const BOOKING = { id: ID, serviceLabel: 'Event photography', start: '2026-10-21T10:00:00+04:00', end: '2026-10-21T13:00:00+04:00', depositAed: 2600, totalAed: 5200 };

test('pollBooking polls until paid', async () => {
  const sleeps = [];
  const f = fakeFetch(json(200, { ...BOOKING, status: 'held' }), new TypeError('blip'), json(502, { error: 'x' }), json(200, { ...BOOKING, status: 'paid' }));
  const r = await pollBooking(API, ID, f, { intervalMs: 3000, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(r.status, 'paid');
  assert.equal(r.serviceLabel, 'Event photography');
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].url, `${API}/booking/${ID}`);
  assert.deepEqual(sleeps, [3000, 3000, 3000]);
});

test('pollBooking stops on expired and unknown', async () => {
  const sleep = async () => {};
  assert.equal((await pollBooking(API, ID, fakeFetch(json(200, { ...BOOKING, status: 'expired' })), { sleep })).status, 'expired');
  assert.equal((await pollBooking(API, ID, fakeFetch(json(404, { error: 'not_found' })), { sleep })).status, 'unknown');
});

test('pollBooking times out as pending', async () => {
  let n = 0;
  const f = fakeFetch(json(200, { ...BOOKING, status: 'held' }));
  const r = await pollBooking(API, ID, f, { intervalMs: 3000, timeoutMs: 60000, now: () => 0, sleep: async () => { n++; } });
  assert.deepEqual(r, { status: 'pending' });
  assert.equal(n, 20);
  assert.equal(f.calls.length, 21);
});

test('pollBooking rejects a bad id without fetching', async () => {
  const f = fakeFetch(json(200, {}));
  assert.deepEqual(await pollBooking(API, '../x', f, { sleep: async () => {} }), { status: 'unknown' });
  assert.equal(f.calls.length, 0);
});

test('friendlyError codes', () => {
  const codes = ['slot_taken', 'slot_unavailable', 'calendar_unavailable', 'payment_unavailable', 'rate_limited',
    'terms_not_accepted', 'below_minimum', 'invalid_hours', 'network', 'invalid_contact', 'invalid_name', 'bad_redirect', 'bad_response'];
  const seen = new Set();
  for (const c of codes) {
    const m = friendlyError(c);
    assert.equal(typeof m, 'string');
    assert.ok(m.length > 10 && m.length < 160, c);
    assert.doesNotMatch(m, /_/, c);
    seen.add(m);
  }
  assert.ok(seen.size >= 8);
  assert.match(friendlyError('slot_taken'), /another time/i);
  assert.match(friendlyError('calendar_unavailable'), /WhatsApp/);
  assert.match(friendlyError('network'), /WhatsApp/);
  assert.match(friendlyError('payment_unavailable'), /WhatsApp/);
  assert.equal(friendlyError('whatever'), friendlyError(undefined));
  assert.match(friendlyError('__proto__'), /WhatsApp/);
});

test('canPay and payMissing', () => {
  const q = quote(config, { serviceId: 'event', hours: 3 });
  const full = { quote: q, start: '2026-10-21T10:00:00+04:00', name: 'Anna', reach: '@anna', terms: true };
  assert.equal(canPay(full), true);
  assert.deepEqual(payMissing(full), []);
  const cases = [
    [{ quote: null }, ['service']],
    [{ quote: quote(config, { serviceId: 'event', hours: 1 }) }, ['service']],
    [{ start: '' }, ['date']],
    [{ start: null }, ['date']],
    [{ name: '   ' }, ['name']],
    [{ reach: 'ab' }, ['contact']],
    [{ reach: undefined }, ['contact']],
    [{ terms: false }, ['terms']],
    [{ terms: 'yes' }, ['terms']],
    [{ name: '', terms: false }, ['name', 'terms']],
  ];
  for (const [patch, missing] of cases) {
    const s = { ...full, ...patch };
    assert.equal(canPay(s), false, JSON.stringify(patch));
    assert.deepEqual(payMissing(s), missing, JSON.stringify(patch));
  }
  assert.equal(canPay(null), false);
});

test('date helpers', () => {
  assert.equal(dayLabel('2026-10-20'), 'Tue 20 Oct');
  assert.equal(dayLabel('2027-01-03'), 'Sun 3 Jan');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-25', 14), '2027-01-08');
  assert.equal(dubaiToday(Date.parse('2026-10-19T19:59:00Z')), '2026-10-19');
  assert.equal(dubaiToday(Date.parse('2026-10-19T20:00:00Z')), '2026-10-20');
  assert.equal(slotWhen('2026-10-21T18:30:00+04:00'), 'Wed 21 Oct, 18:30');
  assert.equal(slotWhen('nope'), '');
  assert.equal(isUuid(ID), true);
  for (const b of ['', 'x', ID + 'a', '../' + ID, null]) assert.equal(isUuid(b), false, String(b));
  assert.equal(tzDiffers(240), false);
  assert.equal(tzDiffers(0), true);
  assert.equal(tzDiffers(-300), true);
});

test('friendlyError: holds, bad_range and field codes', () => {
  for (const c of ['slot_taken', 'slot_unavailable']) assert.match(friendlyError(c), /15 minutes/, c);
  assert.match(friendlyError('bad_range'), /reload the page/i);
  assert.notEqual(friendlyError('bad_range'), friendlyError('unknown_thing'));
  assert.match(friendlyError('invalid_name'), /name/i);
  assert.match(friendlyError('invalid_contact'), /WhatsApp|Telegram/);
  assert.match(friendlyError('invalid_notes'), /notes/i);
});

test('pollBooking counts request time toward the timeout (injected now)', async () => {
  let t = 0;
  const f = fakeFetch(async () => { t += 25000; return json(200, { ...BOOKING, status: 'held' }); });
  const r = await pollBooking(API, ID, f, { intervalMs: 3000, timeoutMs: 60000, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.deepEqual(r, { status: 'pending' });
  // 25 s fetch + 3 s sleep per round: fetches at t=0, 28 s, 56 s; next round would start after 60 s
  assert.equal(f.calls.length, 3);
});
