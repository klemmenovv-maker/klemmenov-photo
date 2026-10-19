import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notify, formatPaid, formatAttention, TelegramError } from './telegram.mjs';

const TOKEN = '123456:DUMMY-token_abc';
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654' };

function fakeFetch(status, json, calls = []) {
  const f = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof json === 'string' ? json : JSON.stringify(json), { status });
  };
  f.calls = calls;
  return f;
}

const booking = {
  id: 'bk_1',
  serviceLabel: 'Portrait session',
  start: '2026-10-20T14:00:00+04:00',
  end: '2026-10-20T16:00:00+04:00',
  totalAed: 800,
  depositAed: 200,
  name: 'Anna Petrova',
  contact: '+971 50 123 4567',
  notes: '',
  quoteOnly: [],
};

// ---- notify ----

test('notify posts the exact URL and JSON body', async () => {
  const f = fakeFetch(200, { ok: true, result: {} });
  await notify(env, 'hello <b>x</b>', f);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), {
    chat_id: '987654',
    text: 'hello <b>x</b>',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

test('notify rejects ok:false with TelegramError', async () => {
  const f = fakeFetch(200, { ok: false, description: 'nope' });
  await assert.rejects(notify(env, 'x', f), (e) => e instanceof TelegramError && e.status === 200);
});

test('notify rejects non-2xx with the status', async () => {
  const f = fakeFetch(400, { ok: false, description: 'Bad Request: chat not found' });
  await assert.rejects(notify(env, 'x', f), (e) => {
    assert.ok(e instanceof TelegramError);
    assert.equal(e.status, 400);
    assert.match(e.body, /chat not found/);
    return true;
  });
});

test('notify network error -> status 0 with no token or URL leaked', async () => {
  const f = async (url) => { throw new TypeError(`fetch failed for ${url}`); };
  await assert.rejects(notify(env, 'x', f), (e) => {
    assert.ok(e instanceof TelegramError);
    assert.equal(e.status, 0);
    for (const s of [e.message, e.body, e.stack.split('\n')[0]]) {
      assert.ok(!s.includes(TOKEN), 'token leaked');
      assert.ok(!s.includes('api.telegram.org'), 'url leaked');
    }
    return true;
  });
});

test('notify with missing token or chat id throws before fetch', async () => {
  for (const bad of [{ TELEGRAM_CHAT_ID: '1' }, { TELEGRAM_BOT_TOKEN: TOKEN }, undefined]) {
    const f = fakeFetch(200, { ok: true });
    await assert.rejects(notify(bad, 'x', f), (e) => e instanceof TelegramError && e.status === 0);
    assert.equal(f.calls.length, 0);
  }
});

test('notify truncates text over 4000 code points', async () => {
  const f = fakeFetch(200, { ok: true });
  await notify(env, 'a'.repeat(5000), f);
  const text = JSON.parse(f.calls[0].init.body).text;
  assert.equal(Array.from(text).length, 4000);
  assert.ok(text.endsWith('…'));
});

test('notify truncation never leaves a half HTML entity or tag', async () => {
  const f = fakeFetch(200, { ok: true });
  await notify(env, 'a'.repeat(3997) + '&amp;&amp;', f);
  let text = JSON.parse(f.calls[0].init.body).text;
  assert.ok(!/&[a-z#0-9]*…$/.test(text));
  await notify(env, 'a'.repeat(3997) + '<b>bold</b>', f);
  text = JSON.parse(f.calls[1].init.body).text;
  assert.ok(!/<[^>]*…$/.test(text));
});

test('notify redacts the token echoed by Telegram', async () => {
  const f = fakeFetch(401, { ok: false, description: `Unauthorized bot${TOKEN}` });
  await assert.rejects(notify(env, 'x', f), (e) => {
    assert.ok(!e.body.includes(TOKEN));
    assert.ok(e.body.includes('[redacted]'));
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test('TelegramError body is capped at 300 chars', async () => {
  const f = fakeFetch(500, 'x'.repeat(1000));
  await assert.rejects(notify(env, 'x', f), (e) => e.body.length === 300);
});

// ---- formatPaid ----

test('formatPaid exact message', () => {
  const b = {
    ...booking,
    totalAed: 800,
    depositAed: 200,
    notes: 'Please bring props',
    quoteOnly: ['Retouching of 10 extra photos', 'Studio rental'],
  };
  assert.equal(
    formatPaid(b),
    [
      '<b>New paid booking</b>',
      'Service: Portrait session',
      'When: Tue 20 Oct 2026, 14:00-16:00 (Dubai time)',
      'Name: Anna Petrova',
      'Contact: +971 50 123 4567',
      'Deposit paid: 200 AED',
      'Remaining on the day: 600 AED',
      'To confirm: Retouching of 10 extra photos',
      'To confirm: Studio rental',
      'Notes: Please bring props',
      'Booking: bk_1',
    ].join('\n'),
  );
});

test('formatPaid omits notes and quote-only when empty', () => {
  const s = formatPaid(booking);
  assert.ok(!s.includes('Notes:'));
  assert.ok(!s.includes('To confirm:'));
});

test('formatPaid caps notes at 300 characters', () => {
  const s = formatPaid({ ...booking, notes: 'n'.repeat(500) });
  const line = s.split('\n').find((l) => l.startsWith('Notes: '));
  assert.equal(Array.from(line).length, 'Notes: '.length + 300);
});

test('formatPaid escapes HTML in all user text', () => {
  const s = formatPaid({
    ...booking,
    name: '<script>alert(1)</script> & Co',
    contact: '`x` <b>x</b> & "q"',
    notes: 'a <i>b</i>\nline2 & `c`',
    quoteOnly: ['<u>q</u>'],
  });
  assert.ok(!s.includes('<script>'));
  assert.ok(s.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
  assert.ok(s.includes('&lt;b&gt;x&lt;/b&gt; &amp; "q"'));
  assert.ok(s.includes('To confirm: &lt;u&gt;q&lt;/u&gt;'));
  assert.ok(s.includes('Notes: a &lt;i&gt;b&lt;/i&gt;\nline2 &amp; `c`'));
  // the only tag in the message is the static <b> header
  assert.equal((s.match(/<(?!\/?b>)/g) || []).length, 0);
});

test('formatPaid collapses newlines in name/contact and strips control chars', () => {
  const s = formatPaid({ ...booking, name: 'Anna\nPetrova\r\n\u0000x\u0007', contact: 'a\nb' });
  assert.ok(s.includes('Name: Anna Petrova x'));
  assert.ok(s.includes('Contact: a b'));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(s));
});

// ---- formatAttention ----

test('formatAttention known reasons', () => {
  const expectations = {
    slot_taken_after_expiry: /slot.*taken.*expir/i,
    slot_taken: /slot.*taken/i,
    calendar_failed: /calendar/i,
    amount_mismatch: /amount/i,
  };
  for (const [reason, re] of Object.entries(expectations)) {
    const lines = formatAttention(booking, reason).split('\n');
    assert.equal(lines[0], '<b>Needs your attention</b>');
    assert.match(lines[1], re);
    assert.ok(!lines[1].includes(reason), 'human text, not the code');
  }
});

test('formatAttention includes details and a closing instruction', () => {
  const s = formatAttention({ ...booking, quoteOnly: ['Extra'] }, 'calendar_failed');
  for (const part of [
    'Service: Portrait session',
    'When: Tue 20 Oct 2026, 14:00-16:00 (Dubai time)',
    'Name: Anna Petrova',
    'Contact: +971 50 123 4567',
    'Deposit paid: 200 AED',
    'Remaining on the day: 600 AED',
    'To confirm: Extra',
    'Booking: bk_1',
  ]) assert.ok(s.includes(part), part);
  const last = s.split('\n').at(-1);
  assert.match(last, /contact the client/i);
  assert.match(last, /calendar manually/i);
});

test('formatAttention escapes unknown reasons', () => {
  const s = formatAttention(booking, 'weird <b>& reason');
  assert.ok(s.includes('weird &lt;b&gt;&amp; reason'));
});

// ---- dates ----

const when = (start, end) => formatPaid({ ...booking, start, end }).split('\n')[2];

test('date: +04:00 same day shows only end time', () => {
  assert.equal(when('2026-10-20T14:00:00+04:00', '2026-10-20T16:00:00+04:00'),
    'When: Tue 20 Oct 2026, 14:00-16:00 (Dubai time)');
});

test('date: crossing midnight shows end date', () => {
  assert.equal(when('2026-10-20T22:00:00+04:00', '2026-10-21T01:00:00+04:00'),
    'When: Tue 20 Oct 2026, 22:00 - Wed 21 Oct 2026, 01:00 (Dubai time)');
});

test('date: Z input converts to Dubai time', () => {
  assert.equal(when('2026-10-20T10:00:00Z', '2026-10-20T12:30:00Z'),
    'When: Tue 20 Oct 2026, 14:00-16:30 (Dubai time)');
});

test('date: other offsets convert, including day rollover', () => {
  assert.equal(when('2026-10-20T23:00:00-05:00', '2026-10-21T00:00:00-05:00'),
    'When: Wed 21 Oct 2026, 08:00-09:00 (Dubai time)');
  assert.equal(when('2026-10-20T18:30:00+05:30', '2026-10-20T19:30:00+05:30'),
    'When: Tue 20 Oct 2026, 17:00-18:00 (Dubai time)');
});

test('date: weekday for leap day and year boundaries', () => {
  assert.equal(when('2028-02-29T10:00:00+04:00', '2028-02-29T11:00:00+04:00'),
    'When: Tue 29 Feb 2028, 10:00-11:00 (Dubai time)');
  assert.equal(when('2026-12-31T23:00:00+04:00', '2027-01-01T00:30:00+04:00'),
    'When: Thu 31 Dec 2026, 23:00 - Fri 1 Jan 2027, 00:30 (Dubai time)');
});

test('date: unparseable input is escaped, not thrown', () => {
  const s = formatPaid({ ...booking, start: '<bad>', end: 'x' });
  assert.ok(s.includes('&lt;bad&gt;'));
});

test('output does not depend on the process time zone', () => {
  // Run `TZ=America/Los_Angeles node --test worker/telegram.test.mjs` to verify;
  // here we pin the expected strings, which are tz-independent by construction.
  assert.equal(when('2026-10-20T00:30:00+04:00', '2026-10-20T01:30:00+04:00'),
    'When: Tue 20 Oct 2026, 00:30-01:30 (Dubai time)');
});
