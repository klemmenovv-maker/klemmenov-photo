// Account areas.
//   Client (Bearer = private client token, kept in the visitor's browser):
//     GET  /my                  their requests with status
//     POST /my/requests/:id     add details (start, notes) or cancel
//   Owner (Bearer = signed session from the Google sign-in):
//     GET    /admin/login, /admin/callback   Google sign-in, then back to the site
//     GET    /admin/requests                 all requests, newest first
//     PATCH  /admin/requests/:id             edit status, name, contact, hours, start, price, notes
//     POST   /admin/requests/:id/reminders   {at, text}
//     DELETE /admin/requests/:id/reminders/:rid
import { fail, reply, redirect, readBody, isJsonContentType } from './http.mjs';
import { bearer, verifySession, signSession, randomToken, googleAuthUrl } from './auth.mjs';
import { STATUSES, OPEN_STATUSES, getRequest, saveRequest, listForClient, listAll, clientView, adminView } from './requests.mjs';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_TTL_S = 600;
const MAX_REMINDERS = 20;
const chars = (s) => Array.from(s).length;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

async function json(c, max) {
  if (!isJsonContentType(c.request)) return { err: fail(415, 'unsupported_media_type') };
  const raw = await readBody(c.request, max ?? c.deps.config.max_body_bytes);
  if (!raw.ok) return { err: fail(raw.error === 'payload_too_large' ? 413 : 400, raw.error) };
  try {
    const body = JSON.parse(raw.text);
    return isObj(body) ? { body } : { err: fail(400, 'bad_request') };
  } catch { return { err: fail(400, 'bad_request') }; }
}

// ---- client ----------------------------------------------------------------
export async function my(c) {
  const token = bearer(c.request);
  if (!token) return fail(401, 'unauthorized');
  const list = await listForClient(c.env.BOOKINGS, token);
  if (!list) return fail(401, 'unauthorized');
  return reply(200, { requests: list.map(clientView) });
}

export async function myUpdate(c) {
  const token = bearer(c.request);
  const id = c.url.pathname.split('/')[3];
  if (!token || !UUID_RE.test(id ?? '')) return fail(token ? 404 : 401, token ? 'not_found' : 'unauthorized');
  const mine = await listForClient(c.env.BOOKINGS, token);
  const rec = mine?.find((r) => r.id === id);
  if (!rec) return fail(mine ? 404 : 401, mine ? 'not_found' : 'unauthorized');
  if (!['new', 'needs_details', 'confirmed'].includes(rec.status)) return fail(409, 'not_editable');
  const j = await json(c);
  if (j.err) return j.err;
  const { body } = j;
  const next = { ...rec };
  if (body.cancel === true) next.status = 'cancelled';
  else {
    if (body.start !== undefined) {
      if (!isIso(body.start) || Date.parse(body.start) < c.now.getTime()) return fail(400, 'invalid_start');
      next.start = body.start;
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || chars(body.notes) > 1000) return fail(400, 'invalid_notes');
      next.notes = body.notes.trim();
    }
    // A confirmed time that the client changes goes back to the owner for approval.
    if (rec.status === 'confirmed' && next.start !== rec.start) next.status = 'new';
    else if (rec.status === 'needs_details') next.status = 'new';
  }
  next.updatedAt = c.now.toISOString();
  next.autoRemindedAt = null;
  await saveRequest(c.env.BOOKINGS, next);
  if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
    try { await c.deps.telegram.notify(c.env, c.deps.telegram.formatClientUpdate(next, body.cancel === true)); }
    catch { c.deps.log({ event: 'client_update_notify_failed', requestId: id }); }
  }
  return reply(200, { request: clientView(next) });
}

// ---- owner sign-in ---------------------------------------------------------
const redirectUri = (c) => c.env.ADMIN_REDIRECT_URI || `${c.url.origin}/admin/callback`;
const adminHome = (c) => `${String(c.env.SITE_URL).replace(/\/+$/, '')}/admin/`;
const configured = (env) => env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.SESSION_SECRET && env.OWNER_EMAIL && env.SITE_URL;

export async function adminLogin(c) {
  if (!configured(c.env)) return fail(503, 'admin_not_configured');
  const state = randomToken();
  await c.env.BOOKINGS.put(`oas:${state}`, '1', { expirationTtl: STATE_TTL_S });
  return redirect(googleAuthUrl(c.env, redirectUri(c), state));
}

export async function adminCallback(c) {
  if (!configured(c.env)) return fail(503, 'admin_not_configured');
  const p = c.url.searchParams;
  const state = p.get('state') ?? '';
  const ok = /^[A-Za-z0-9_-]{16,64}$/.test(state) && await c.env.BOOKINGS.get(`oas:${state}`);
  if (!ok) return redirect(`${adminHome(c)}#error=state`);
  await c.env.BOOKINGS.delete(`oas:${state}`); // single use
  const code = p.get('code');
  if (!code || p.has('error')) return redirect(`${adminHome(c)}#error=denied`);
  let who;
  try { who = await c.deps.auth.exchangeCode(c.env, code, redirectUri(c), c.deps.fetch); }
  catch { c.deps.log({ event: 'admin_login_failed' }); return redirect(`${adminHome(c)}#error=google`); }
  if (!who.verified || who.email !== String(c.env.OWNER_EMAIL).trim().toLowerCase()) {
    c.deps.log({ event: 'admin_login_refused' });
    return redirect(`${adminHome(c)}#error=forbidden`);
  }
  const session = await signSession(c.env, who.email, c.now.getTime());
  return redirect(`${adminHome(c)}#s=${session}`);
}

// ---- owner area ------------------------------------------------------------
async function owner(c) {
  return (await verifySession(c.env, bearer(c.request), c.now.getTime())) !== null;
}

export async function adminList(c) {
  if (!(await owner(c))) return fail(401, 'unauthorized');
  return reply(200, { requests: (await listAll(c.env.BOOKINGS)).map(adminView), statuses: STATUSES });
}

const text = (v, max) => typeof v === 'string' && chars(v) <= max;

export async function adminUpdate(c) {
  if (!(await owner(c))) return fail(401, 'unauthorized');
  const id = c.url.pathname.split('/')[3];
  if (!UUID_RE.test(id ?? '')) return fail(404, 'not_found');
  const rec = await getRequest(c.env.BOOKINGS, id);
  if (!rec) return fail(404, 'not_found');
  const j = await json(c, 16384);
  if (j.err) return j.err;
  const b = j.body;
  const next = { ...rec };
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return fail(400, 'invalid_status'); next.status = b.status; }
  if (b.name !== undefined) { if (!text(b.name, 80) || !b.name.trim()) return fail(400, 'invalid_name'); next.name = b.name.trim(); }
  if (b.contact !== undefined) { if (!text(b.contact, 120) || chars(b.contact.trim()) < 3) return fail(400, 'invalid_contact'); next.contact = b.contact.trim(); }
  if (b.hours !== undefined) {
    if (!Number.isFinite(b.hours) || b.hours < 0 || b.hours > c.deps.pricing.max_hours) return fail(400, 'invalid_hours');
    next.hours = b.hours;
  }
  if (b.start !== undefined) { if (b.start !== null && !isIso(b.start)) return fail(400, 'invalid_start'); next.start = b.start; }
  if (b.totalAed !== undefined) { if (!Number.isFinite(b.totalAed) || b.totalAed < 0 || b.totalAed > 1e6) return fail(400, 'invalid_total'); next.totalAed = b.totalAed; }
  if (b.ownerNote !== undefined) { if (!text(b.ownerNote, 4000)) return fail(400, 'invalid_note'); next.ownerNote = b.ownerNote; }
  if (b.messageToClient !== undefined) { if (!text(b.messageToClient, 500)) return fail(400, 'invalid_message'); next.messageToClient = b.messageToClient.trim(); }
  next.updatedAt = c.now.toISOString();
  if (OPEN_STATUSES.includes(next.status) && next.status !== rec.status) next.autoRemindedAt = null; // re-arm the auto reminder
  await saveRequest(c.env.BOOKINGS, next);
  return reply(200, { request: adminView(next) });
}

export async function reminderAdd(c) {
  if (!(await owner(c))) return fail(401, 'unauthorized');
  const id = c.url.pathname.split('/')[3];
  const rec = UUID_RE.test(id ?? '') ? await getRequest(c.env.BOOKINGS, id) : null;
  if (!rec) return fail(404, 'not_found');
  const j = await json(c);
  if (j.err) return j.err;
  const { at, text: msg } = j.body;
  if (!isIso(at)) return fail(400, 'invalid_time');
  if (!text(msg ?? '', 300)) return fail(400, 'invalid_text');
  if (rec.reminders.length >= MAX_REMINDERS) return fail(409, 'too_many_reminders');
  const reminder = { id: randomToken(6), at: new Date(at).toISOString(), text: (msg ?? '').trim(), sentAt: null };
  const next = { ...rec, reminders: [...rec.reminders, reminder], updatedAt: c.now.toISOString() };
  await saveRequest(c.env.BOOKINGS, next);
  return reply(200, { request: adminView(next) });
}

export async function reminderDelete(c) {
  if (!(await owner(c))) return fail(401, 'unauthorized');
  const [, , , id, , rid] = c.url.pathname.split('/');
  const rec = UUID_RE.test(id ?? '') ? await getRequest(c.env.BOOKINGS, id) : null;
  if (!rec) return fail(404, 'not_found');
  const next = { ...rec, reminders: rec.reminders.filter((r) => r.id !== rid), updatedAt: c.now.toISOString() };
  await saveRequest(c.env.BOOKINGS, next);
  return reply(200, { request: adminView(next) });
}
