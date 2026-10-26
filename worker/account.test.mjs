import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './index.mjs';
import { runReminders } from './reminders.mjs';
import { makeEnv, makeCtx, makeFakes, req, validBody, ORIGIN } from './_helpers.mjs';

const CRM_URL = 'https://script.example.test/macros/s/SECRET_CRM_URL_0005/exec';
const envFor = (over = {}) => makeEnv({
  CRM_WEBHOOK_URL: CRM_URL, GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  SESSION_SECRET: 'SECRET_session_0006', OWNER_EMAIL: 'Owner@Example.test', ...over,
});

async function call(f, env, method, path, { body, token, headers } = {}) {
  const ctx = makeCtx();
  const h = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers };
  const res = await handle(req(method, path, { body, origin: ORIGIN, headers: h }), env, ctx, f.deps);
  await ctx.drain();
  const t = await res.text();
  let json = null; try { json = JSON.parse(t); } catch { /* redirect */ }
  return { status: res.status, json, res };
}

async function ownerSession(f, env) {
  const login = await call(f, env, 'GET', '/admin/login');
  assert.equal(login.status, 302);
  const url = new URL(login.res.headers.get('Location'));
  assert.equal(url.host, 'accounts.google.com');
  const state = url.searchParams.get('state');
  const cb = await call(f, env, 'GET', `/admin/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 302);
  const loc = cb.res.headers.get('Location');
  assert.match(loc, /^https:\/\/klemmenovv-maker\.github\.io\/klemmenov-photo\/admin\/#s=/);
  return loc.split('#s=')[1];
}

async function submit(f, env, over = {}) {
  const r = await call(f, env, 'POST', '/request', { body: validBody(over) });
  assert.equal(r.status, 200);
  return r.json;
}

test('client: request returns a private token and the client sees only their own requests', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env);
  assert.ok(a.token && a.id);
  const mine = await call(f, env, 'GET', '/my', { token: a.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.requests.length, 1);
  const v = mine.json.requests[0];
  assert.equal(v.status, 'new');
  for (const k of ['ownerNote', 'reminders', 'clientHash', 'contact', 'name']) assert.equal(k in v, false, k);
  // a second request from the same browser joins the same list
  const b = await call(f, env, 'POST', '/request', { body: validBody({ contact: { name: 'Anna Client', reach: '+971500000002', email: 'x@example.test' }, clientToken: a.token }) });
  assert.equal(b.json.token, a.token);
  assert.equal((await call(f, env, 'GET', '/my', { token: a.token })).json.requests.length, 2);
  // another client sees nothing of theirs
  const other = await submit(f, env, { contact: { name: 'Bob', reach: '+971500000003', email: 'x@example.test' } });
  assert.equal((await call(f, env, 'GET', '/my', { token: other.token })).json.requests.length, 1);
  assert.equal((await call(f, env, 'GET', '/my', { token: 'x'.repeat(30) })).status, 401);
  assert.equal((await call(f, env, 'GET', '/my')).status, 401);
});

test('client: can add details and cancel, only their own request', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env, { start: undefined });
  const other = await submit(f, env, { contact: { name: 'Bob', reach: '+971500000003', email: 'x@example.test' } });
  const upd = await call(f, env, 'POST', `/my/requests/${a.id}`, { token: a.token, body: { start: '2026-10-25T10:00:00+04:00', notes: 'Studio please' } });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal(upd.json.request.start, '2026-10-25T10:00:00+04:00');
  assert.match(f.calls.notify.at(-1), /Клиент обновил/);
  assert.equal((await call(f, env, 'POST', `/my/requests/${a.id}`, { token: other.token, body: { cancel: true } })).status, 404);
  assert.equal((await call(f, env, 'POST', `/my/requests/${a.id}`, { token: a.token, body: { start: '2020-01-01T10:00:00+04:00' } })).status, 400);
  const c = await call(f, env, 'POST', `/my/requests/${a.id}`, { token: a.token, body: { cancel: true } });
  assert.equal(c.json.request.status, 'cancelled');
  assert.equal((await call(f, env, 'POST', `/my/requests/${a.id}`, { token: a.token, body: { cancel: true } })).status, 409);
});

test('owner: google sign-in only lets the owner in; client tokens never open the admin', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env);
  assert.equal((await call(f, env, 'GET', '/admin/requests')).status, 401);
  assert.equal((await call(f, env, 'GET', '/admin/requests', { token: a.token })).status, 401);
  assert.equal((await call(f, env, 'GET', '/admin/requests', { token: 'abc.def' + 'x'.repeat(20) })).status, 401);
  // wrong Google account
  f.authImpl = async () => ({ email: 'stranger@example.test', verified: true });
  const login = await call(f, env, 'GET', '/admin/login');
  const state = new URL(login.res.headers.get('Location')).searchParams.get('state');
  const cb = await call(f, env, 'GET', `/admin/callback?code=abc&state=${state}`);
  assert.match(cb.res.headers.get('Location'), /#error=forbidden$/);
  // forged state, reused state
  assert.match((await call(f, env, 'GET', '/admin/callback?code=abc&state=forged-forged-forged')).res.headers.get('Location'), /#error=state$/);
  assert.match((await call(f, env, 'GET', `/admin/callback?code=abc&state=${state}`)).res.headers.get('Location'), /#error=state$/);
  // unverified email
  f.authImpl = async () => ({ email: 'owner@example.test', verified: false });
  const l2 = await call(f, env, 'GET', '/admin/login');
  const s2 = new URL(l2.res.headers.get('Location')).searchParams.get('state');
  assert.match((await call(f, env, 'GET', `/admin/callback?code=abc&state=${s2}`)).res.headers.get('Location'), /#error=forbidden$/);
  // the owner (case-insensitive email)
  f.authImpl = null;
  const session = await ownerSession(f, env);
  const list = await call(f, env, 'GET', '/admin/requests', { token: session });
  assert.equal(list.status, 200);
  assert.equal(list.json.requests.length, 1);
  assert.equal('clientHash' in list.json.requests[0], false);
  // expired session
  const late = makeFakes({ now: '2026-12-31T10:00:00+04:00' });
  assert.equal((await call(late, env, 'GET', '/admin/requests', { token: session })).status, 401);
});

test('owner: not configured -> 503, no secrets in the redirect', async () => {
  const f = makeFakes();
  const r = await call(f, envFor({ SESSION_SECRET: undefined }), 'GET', '/admin/login');
  assert.equal(r.status, 503);
  const ok = await call(f, envFor(), 'GET', '/admin/login');
  assert.doesNotMatch(ok.res.headers.get('Location'), /csecret|SECRET/);
});

test('owner: edit, notes, message to client, reminders', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env);
  const s = await ownerSession(f, env);
  const patch = (body) => call(f, env, 'PATCH', `/admin/requests/${a.id}`, { token: s, body });
  const ok = await patch({ status: 'confirmed', hours: 3, totalAed: 4200, name: 'Anna K', ownerNote: 'Bring red dress', messageToClient: 'See you at the studio', start: '2026-10-22T11:00:00+04:00' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.request.ownerNote, 'Bring red dress');
  const mine = (await call(f, env, 'GET', '/my', { token: a.token })).json.requests[0];
  assert.equal(mine.status, 'confirmed');
  assert.equal(mine.message, 'See you at the studio');
  assert.equal(mine.totalAed, 4200);
  assert.equal(JSON.stringify(mine).includes('red dress'), false, 'owner note stays private');
  assert.equal((await patch({ status: 'bogus' })).status, 400);
  assert.equal((await patch({ hours: -1 })).status, 400);
  assert.equal((await patch({ start: 'tomorrow' })).status, 400);
  const withR = await call(f, env, 'POST', `/admin/requests/${a.id}/reminders`, { token: s, body: { at: '2026-10-20T09:00:00+04:00', text: 'Call Anna' } });
  assert.equal(withR.json.request.reminders.length, 1);
  assert.equal((await call(f, env, 'POST', `/admin/requests/${a.id}/reminders`, { token: s, body: { at: 'soon', text: 'x' } })).status, 400);
  const rid = withR.json.request.reminders[0].id;
  const del = await call(f, env, 'DELETE', `/admin/requests/${a.id}/reminders/${rid}`, { token: s });
  assert.equal(del.json.request.reminders.length, 0);
  assert.equal((await call(f, env, 'PATCH', `/admin/requests/${a.id}`, { body: { status: 'done' } })).status, 401);
});

test('reminders: manual, auto "client did not finish", and shoot soon; each sent once', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env, { start: undefined });
  const b = await submit(f, env, { contact: { name: 'Bob', reach: '+971500000003', email: 'x@example.test' } });
  const s = await ownerSession(f, env);
  await call(f, env, 'POST', `/admin/requests/${b.id}/reminders`, { token: s, body: { at: '2026-10-19T12:00:00+04:00', text: 'Send price list' } });
  await call(f, env, 'PATCH', `/admin/requests/${b.id}`, { token: s, body: { status: 'confirmed', start: '2026-10-20T10:00:00+04:00' } });
  const before = f.calls.notify.length;
  const t = (iso) => new Date(iso);
  assert.equal(await runReminders(env, f.deps, t('2026-10-19T11:00:00+04:00')), 1, 'only the shoot-soon one is due');
  assert.match(f.calls.notify.at(-1), /Съёмка в ближайшие 24 часа/);
  assert.equal(await runReminders(env, f.deps, t('2026-10-20T11:00:00+04:00')), 2, 'manual + auto');
  const texts = f.calls.notify.slice(before).join('\n');
  assert.match(texts, /Send price list/);
  assert.match(texts, /не дописал детали/);
  assert.equal(await runReminders(env, f.deps, t('2026-10-21T11:00:00+04:00')), 0, 'nothing repeats');
});

test('reminders: a Telegram failure keeps them for the next tick', async () => {
  const f = makeFakes(); const env = envFor();
  const a = await submit(f, env, { start: undefined });
  f.notifyImpl = async () => { throw new Error('down'); };
  const later = new Date('2026-10-21T10:00:00+04:00');
  assert.equal(await runReminders(env, f.deps, later), 0);
  f.notifyImpl = null;
  assert.equal(await runReminders(env, f.deps, later), 1);
  assert.ok(a.id);
});
