import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, getBusy, createEvent, eventIdFor, GoogleError, _resetTokenCacheForTests } from './google.mjs';

const EMAIL = 'booking-bot@proj-123.iam.gserviceaccount.com';
const CAL = 'studio@example.com';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const b64uDecode = (s) => Buffer.from(s, 'base64url');

const kp = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const B64KEY = b64(pkcs8).match(/.{1,64}/g).join('\n');
const PEM = `-----BEGIN PRIVATE KEY-----\n${B64KEY}\n-----END PRIVATE KEY-----\n`;
const sa = { type: 'service_account', client_email: EMAIL, private_key: PEM };
const baseEnv = (extra = {}) => ({ GOOGLE_SA_JSON: JSON.stringify(sa), GOOGLE_CALENDAR_ID: CAL, ...extra });

// Fake fetch: routes by URL, records calls.
function fake(handlers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const h = handlers(url, init, calls);
    if (h instanceof Error) throw h;
    return new Response(typeof h.json === 'string' ? h.json : JSON.stringify(h.json), { status: h.status ?? 200 });
  };
  f.calls = calls;
  return f;
}
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const okToken = (tok = 'ya29.TOKEN-ONE', expires = 3600) => ({ json: { access_token: tok, expires_in: expires } });
const FB_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';

beforeEach(() => _resetTokenCacheForTests());

test('signJwt produces a verifiable RS256 JWT with exact header and claims', async () => {
  const jwt = await signJwt(sa, SCOPE, 1760000000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(b64uDecode(parts[0]).toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(b64uDecode(parts[1]).toString()), {
    iss: EMAIL, scope: SCOPE, aud: TOKEN_URL, iat: 1760000000, exp: 1760003600,
  });
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', kp.publicKey, b64uDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  assert.equal(ok, true);
});

test('signJwt tolerates a PEM with literal backslash-n sequences', async () => {
  const lit = { ...sa, private_key: PEM.replace(/\n/g, '\\n') };
  const jwt = await signJwt(lit, SCOPE, 1760000000);
  const [h, c, s] = jwt.split('.');
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, b64uDecode(s), new TextEncoder().encode(`${h}.${c}`)), true);
});

test('getBusy gets a token, posts the exact freeBusy body and returns ranges', async () => {
  const f = fake((url) => {
    if (url === TOKEN_URL) return okToken();
    return { json: { calendars: { [CAL]: { busy: [
      { start: '2026-10-20T08:00:00Z', end: '2026-10-20T09:00:00Z' },
      { start: '2026-10-20T14:00:00+04:00', end: '2026-10-20T15:30:00+04:00' },
    ] } } } };
  });
  const r = await getBusy(baseEnv(), { from: '2026-10-20T00:00:00+04:00', to: '2026-10-21T00:00:00+04:00' }, f);
  assert.deepEqual(r, [
    { start: '2026-10-20T08:00:00Z', end: '2026-10-20T09:00:00Z' },
    { start: '2026-10-20T14:00:00+04:00', end: '2026-10-20T15:30:00+04:00' },
  ]);
  const tok = f.calls[0];
  assert.equal(tok.url, TOKEN_URL);
  assert.equal(tok.init.method, 'POST');
  assert.equal(tok.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(tok.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(form.get('assertion').split('.').length, 3);
  const fb = f.calls[1];
  assert.equal(fb.url, FB_URL);
  assert.equal(fb.init.method, 'POST');
  assert.equal(fb.init.headers.Authorization, 'Bearer ya29.TOKEN-ONE');
  assert.deepEqual(JSON.parse(fb.init.body), {
    timeMin: '2026-10-20T00:00:00+04:00', timeMax: '2026-10-21T00:00:00+04:00',
    timeZone: 'Asia/Dubai', items: [{ id: CAL }],
  });
});

test('getBusy rejects busy ranges without an explicit offset', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken()
    : { json: { calendars: { [CAL]: { busy: [{ start: '2026-10-20T08:00:00', end: '2026-10-20T09:00:00' }] } } } });
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), (e) => e instanceof GoogleError);
});

test('getBusy throws GoogleError when the calendar reports errors', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken()
    : { json: { calendars: { [CAL]: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } } });
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), (e) => e instanceof GoogleError && /notFound/.test(e.body));
});

test('getBusy throws when the calendar is missing from the response', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { json: { calendars: {} } });
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), GoogleError);
});

const booking = {
  serviceLabel: 'Portrait session',
  startIso: '2026-10-22T10:00:00+04:00',
  endIso: '2026-10-22T11:30:00+04:00',
  name: 'Anna K',
  contact: '@anna_k',
  notes: 'Bring the red dress',
  quoteOnly: ['Retouching of 20 extra photos', 'Studio rental'],
  depositAed: 200,
  totalAed: 900,
  bookingId: '3F2504E0-4F89-41D3-9A0C-0305E82C3301',
};
const EVENT_ID = 'kb3f2504e04f8941d39a0c0305e82c3301';

test('createEvent posts to the encoded calendar URL with exact fields', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { json: { id: 'evt1' } });
  const r = await createEvent(baseEnv(), booking, f);
  assert.deepEqual(r, { eventId: 'evt1' });
  const c = f.calls[1];
  assert.equal(c.url, `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer ya29.TOKEN-ONE');
  const b = JSON.parse(c.init.body);
  assert.equal(b.summary, 'Portrait session \u00b7 Anna K');
  assert.deepEqual(b.start, { dateTime: booking.startIso, timeZone: 'Asia/Dubai' });
  assert.deepEqual(b.end, { dateTime: booking.endIso, timeZone: 'Asia/Dubai' });
  const lines = b.description.split('\n');
  assert.ok(lines.includes('Contact: @anna_k'));
  assert.ok(lines.includes('Notes:'));
  assert.ok(lines.includes('> Bring the red dress'));
  assert.ok(lines.includes('Deposit paid: 200 AED'));
  assert.ok(lines.includes('Online total: 900 AED'));
  assert.ok(lines.includes('Quote-only items:'));
  assert.ok(lines.includes('- Retouching of 20 extra photos'));
  assert.ok(lines.includes('- Studio rental'));
  assert.ok(lines.includes('Booking id: 3F2504E0-4F89-41D3-9A0C-0305E82C3301'));
  assert.equal(b.id, EVENT_ID);
});

test('createEvent omits Notes and Quote-only sections when empty', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { json: { id: 'e' } });
  await createEvent(baseEnv(), { ...booking, notes: '', quoteOnly: [] }, f);
  const d = JSON.parse(f.calls[1].init.body).description;
  assert.ok(!/Notes:/.test(d));
  assert.ok(!/Quote-only/.test(d));
});

async function ev(over, env = baseEnv()) {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { json: { id: 'e' } });
  await createEvent(env, { ...booking, ...over }, f);
  return JSON.parse(f.calls.at(-1).init.body);
}
const FORGE = 'x\nDeposit paid: 5000 AED\r\nBooking id: forged\u2028Online total: 1 AED';
const fieldLines = (d) => d.split('\n').filter((l) => /^(Contact|Deposit paid|Online total|Booking id): /.test(l));

test('forged field lines in single-line fields are neutralised', async () => {
  // bookingId is no longer free text: a non-UUID is rejected before any fetch (see below)
  for (const k of ['name', 'contact', 'serviceLabel']) {
    const b = await ev({ [k]: FORGE });
    const d = b.description;
    assert.equal(d.split('\n').filter((l) => l.startsWith('Deposit paid:')).length, 1, k);
    assert.ok(d.includes('Deposit paid: 200 AED'), k);
    assert.equal(fieldLines(d).length, 4, k);
    assert.ok(!b.summary.includes('\n'), k);
  }
  const b = await ev({ quoteOnly: [FORGE] });
  assert.equal(fieldLines(b.description).length, 4);
  assert.ok(b.description.split('\n').includes('- x Deposit paid: 5000 AED Booking id: forgedOnline total: 1 AED'));
});

test('notes are last, every line is prefixed, and cannot forge fields', async () => {
  const d = (await ev({ notes: FORGE + '\n\nBooking id: z' })).description;
  const lines = d.split('\n');
  const i = lines.indexOf('Notes:');
  assert.ok(i > lines.indexOf(`Booking id: ${booking.bookingId}`));
  for (const l of lines.slice(i + 1)) assert.ok(l.startsWith('> '), l);
  assert.equal(fieldLines(d).length, 4);
  assert.equal(lines.at(-1).startsWith('> '), true);
});

test('HTML in the description is escaped; the summary stays plain text', async () => {
  const b = await ev({ name: '<b>Eve</b> & co\u0000\u0007', serviceLabel: 'A&B', notes: '<script>alert(1)</script>\nline2\u0001\r\ttab', quoteOnly: ['<img src=x>'] });
  assert.equal(b.summary, 'A&B \u00b7 <b>Eve</b> & co');
  assert.ok(b.description.includes('> &lt;script&gt;alert(1)&lt;/script&gt;\n> line2\n> tab'));
  assert.ok(b.description.includes('- &lt;img src=x&gt;'));
  assert.ok(!/<|>/.test(b.description.split('\n').map((l) => l.replace(/^> /, '')).join('\n')));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(b.description));
});

test('bidi, zero-width and line separators are stripped from all user text', async () => {
  const dirty = 'a\u200bb\u202ec\u2066d\ufeffe\u2028f\u2029g';
  const b = await ev({ name: dirty, contact: dirty, notes: dirty, serviceLabel: dirty, quoteOnly: [dirty] });
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029]/.test(b.summary + b.description));
  assert.ok(b.summary.endsWith('abcdef g'.replace(' ', '') ) || b.summary.includes('abcde'));
});

test('exact caps: name 80, serviceLabel 120, contact 120, quote line 200, notes 1000', async () => {
  const b = await ev({ name: 'N'.repeat(200), serviceLabel: 'S'.repeat(300), contact: 'x'.repeat(500),
    quoteOnly: ['q'.repeat(500)], notes: 'n'.repeat(1001) });
  assert.equal(b.summary, 'S'.repeat(120) + ' \u00b7 ' + 'N'.repeat(80));
  const lines = b.description.split('\n');
  assert.ok(lines.includes('Contact: ' + 'x'.repeat(120)));
  assert.ok(lines.includes('- ' + 'q'.repeat(200)));
  assert.ok(lines.includes('> ' + 'n'.repeat(1000)));
  const exact = await ev({ notes: 'n'.repeat(1000) });
  assert.ok(exact.description.split('\n').includes('> ' + 'n'.repeat(1000)));
});

test('createEvent validates times and amounts before any fetch', async () => {
  const f = fake(() => { throw new Error('should not fetch'); });
  const bad = [{ startIso: '' }, { startIso: '2026-10-22T10:00:00' }, { endIso: undefined }, { endIso: 'nope' },
    { depositAed: NaN }, { depositAed: '200' }, { totalAed: Infinity }, { totalAed: undefined }];
  for (const o of bad) {
    await assert.rejects(createEvent(baseEnv(), { ...booking, ...o }, f), (e) => e instanceof GoogleError && e.status === 0, JSON.stringify(o));
  }
  assert.equal(f.calls.length, 0);
});

test('401 from the API evicts the token and retries once with a fresh one', async () => {
  let n = 0, apiN = 0;
  const f = fake((url) => {
    if (url === TOKEN_URL) return okToken('ya29.T' + ++n);
    return ++apiN === 1 ? { status: 401, json: '{}' } : { json: { id: 'ok' } };
  });
  assert.deepEqual(await createEvent(baseEnv(), booking, f), { eventId: 'ok' });
  assert.equal(n, 2);
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer ya29.T2');
});

test('a second 401 throws GoogleError (single retry)', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { status: 401, json: '{}' });
  await assert.rejects(createEvent(baseEnv(), booking, f), (e) => e instanceof GoogleError && e.status === 401);
  assert.equal(f.calls.filter((c) => c.url !== TOKEN_URL).length, 2);
});

test('token cache is keyed per account', async () => {
  const sa2 = { ...sa, client_email: 'other@proj-9.iam.gserviceaccount.com' };
  let n = 0;
  const f = fake((url) => url === TOKEN_URL ? okToken('ya29.A' + ++n) : { json: { calendars: { [CAL]: { busy: [] } } } });
  await getBusy(baseEnv(), { from: 'a', to: 'b' }, f);
  await getBusy(baseEnv({ GOOGLE_SA_JSON: JSON.stringify(sa2) }), { from: 'a', to: 'b' }, f);
  assert.equal(f.calls.filter((c) => c.url === TOKEN_URL).length, 2);
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer ya29.A2');
});

test('token failures are not cached', async () => {
  let n = 0;
  const f = fake((url) => {
    if (url === TOKEN_URL) return ++n === 1 ? { status: 400, json: '{"error":"x"}' } : okToken();
    return { json: { calendars: { [CAL]: { busy: [] } } } };
  });
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), (e) => e.status === 400);
  assert.deepEqual(await getBusy(baseEnv(), { from: 'a', to: 'b' }, f), []);
  assert.equal(n, 2);
});

test('PEM with CRLF line endings and trailing spaces signs correctly', async () => {
  const messy = { ...sa, private_key: PEM.replace(/\n/g, '  \r\n') };
  const [h, c, s] = (await signJwt(messy, SCOPE, 1760000000)).split('.');
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, b64uDecode(s), new TextEncoder().encode(`${h}.${c}`)), true);
});

test('token endpoint 400 -> GoogleError status 400 with no secrets in message/body', async () => {
  const f = fake(() => ({ status: 400, json: `{"error":"invalid_grant","detail":"${EMAIL} ${PEM.replace(/\n/g, '\\n')} ${B64KEY.split('\n')[1]}"}` }));
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), (e) => {
    assert.ok(e instanceof GoogleError);
    assert.equal(e.status, 400);
    assert.ok(e.body.length <= 500);
    for (const s of [e.message, e.body]) {
      assert.ok(!s.includes(EMAIL));
      assert.ok(!s.includes(B64KEY.split('\n')[1]));
      assert.ok(!s.includes('PRIVATE KEY'));
    }
    return true;
  });
});

test('API error body has the access token redacted and is truncated', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken('ya29.SECRETTOKEN')
    : { status: 403, json: 'denied ya29.SECRETTOKEN ' + 'z'.repeat(2000) });
  await assert.rejects(createEvent(baseEnv(), booking, f), (e) => {
    assert.equal(e.status, 403);
    assert.ok(!e.body.includes('ya29.SECRETTOKEN'));
    assert.ok(!e.message.includes('ya29.SECRETTOKEN'));
    assert.ok(e.body.length <= 500);
    return true;
  });
});

test('network failure -> GoogleError status 0', async () => {
  const f = fake(() => new Error('boom ' + EMAIL));
  await assert.rejects(getBusy(baseEnv(), { from: 'a', to: 'b' }, f), (e) => {
    assert.ok(e instanceof GoogleError);
    assert.equal(e.status, 0);
    assert.ok(!e.message.includes(EMAIL));
    return true;
  });
});

test('invalid GOOGLE_SA_JSON -> GoogleError without content in message', async () => {
  const f = fake(() => { throw new Error('should not fetch'); });
  await assert.rejects(getBusy({ GOOGLE_SA_JSON: '{secret-not-json', GOOGLE_CALENDAR_ID: CAL }, { from: 'a', to: 'b' }, f),
    (e) => e instanceof GoogleError && e.message === 'GOOGLE_SA_JSON is not valid JSON' && e.status === 0);
  assert.equal(f.calls.length, 0);
});

test('missing env values -> GoogleError status 0 before any fetch', async () => {
  const f = fake(() => { throw new Error('should not fetch'); });
  for (const env of [{}, { GOOGLE_SA_JSON: JSON.stringify(sa) }, { GOOGLE_CALENDAR_ID: CAL },
    baseEnv({ GOOGLE_SA_JSON: JSON.stringify({ client_email: EMAIL }) })]) {
    await assert.rejects(getBusy(env, { from: 'a', to: 'b' }, f), (e) => e instanceof GoogleError && e.status === 0);
    await assert.rejects(createEvent(env, booking, f), (e) => e instanceof GoogleError && e.status === 0);
  }
  assert.equal(f.calls.length, 0);
});

test('access token is reused across calls within its lifetime', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : url === FB_URL
    ? { json: { calendars: { [CAL]: { busy: [] } } } } : { json: { id: 'e' } });
  const env = baseEnv({ _nowSeconds: 1760000000 });
  await getBusy(env, { from: 'a', to: 'b' }, f);
  await createEvent(env, booking, f);
  assert.equal(f.calls.filter((c) => c.url === TOKEN_URL).length, 1);
});

test('access token is refreshed after expiry (minus 60s margin)', async () => {
  let n = 0;
  const f = fake((url) => url === TOKEN_URL ? okToken('ya29.T' + ++n, 3600)
    : { json: { calendars: { [CAL]: { busy: [] } } } });
  await getBusy(baseEnv({ _nowSeconds: 1760000000 }), { from: 'a', to: 'b' }, f);
  await getBusy(baseEnv({ _nowSeconds: 1760003539 }), { from: 'a', to: 'b' }, f); // still valid (<3540)
  assert.equal(f.calls.filter((c) => c.url === TOKEN_URL).length, 1);
  await getBusy(baseEnv({ _nowSeconds: 1760003540 }), { from: 'a', to: 'b' }, f); // expired
  assert.equal(f.calls.filter((c) => c.url === TOKEN_URL).length, 2);
  assert.equal(f.calls.at(-1).init.headers.Authorization, 'Bearer ya29.T2');
});

// ---- deterministic event id (idempotent inserts) ----

test('eventIdFor: "kb" + lowercase hex of the UUID, valid base32hex', () => {
  assert.equal(eventIdFor('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), EVENT_ID);
  assert.match(EVENT_ID, /^[a-v0-9]{5,1024}$/);
  for (const bad of ['bk_123', '', undefined, 42, '3f2504e0-4f89-41d3-9a0c-0305e82c330', '3f2504e0-4f89-41d3-9a0c-0305e82c3301x']) {
    assert.throws(() => eventIdFor(bad), (e) => e instanceof GoogleError && e.status === 0, String(bad));
  }
});

test('createEvent rejects a non-UUID bookingId before any fetch', async () => {
  const f = fake(() => { throw new Error('should not fetch'); });
  for (const bookingId of ['bk_123', 'i'.repeat(500), undefined]) {
    await assert.rejects(createEvent(baseEnv(), { ...booking, bookingId }, f), (e) => e instanceof GoogleError && e.status === 0);
  }
  assert.equal(f.calls.length, 0);
});

test('createEvent: HTTP 409 (event id already exists) is success with duplicate: true', async () => {
  const f = fake((url) => url === TOKEN_URL ? okToken() : { status: 409, json: { error: { code: 409, message: 'The requested identifier already exists.' } } });
  assert.deepEqual(await createEvent(baseEnv(), booking, f), { eventId: EVENT_ID, duplicate: true });
  assert.equal(JSON.parse(f.calls[1].init.body).id, EVENT_ID);
});

test('createEvent: other 4xx still throw', async () => {
  for (const status of [400, 404, 410, 412, 429]) {
    _resetTokenCacheForTests();
    const f = fake((url) => url === TOKEN_URL ? okToken() : { status, json: { error: { code: status } } });
    await assert.rejects(createEvent(baseEnv(), booking, f), (e) => e instanceof GoogleError && e.status === status, String(status));
  }
});
