// Cloudflare Worker entry point for the booking system.
//   GET  /availability   free slots (Google busy + KV holds), fail closed
//   POST /checkout       server-priced hold + Ziina payment intent
//   POST /webhook/ziina  payment confirmation (always re-checked with Ziina)
//   GET  /booking/:id    public status of one booking (no personal data)
//   GET  /my, POST /my/requests/:id   the client's own requests (private token)
//   /admin/login, /admin/callback, /admin/requests...   owner area (Google sign-in), see routes-account.mjs
// Everything external is reached through `deps`, so tests inject fakes.
import pricing from './pricing.json' with { type: 'json' };
import config from './booking-config.json' with { type: 'json' };
import { quote } from '../shared/pricing.mjs';
import { computeSlots } from './availability.mjs';
import * as bookings from './bookings.mjs';
import { createIntent, getIntent } from './ziina.mjs';
import { getBusy, createEvent, getResourcesBusy } from './google.mjs';
import { notify, formatPaid, formatAttention, formatPaymentAlert, formatRequest, formatReminder, formatClientUpdate } from './telegram.mjs';
import { sendToCrm, crmConfigured } from './crm.mjs';
import { corsFor, toResponse, preflight, overLimit, createMemoryLimiter, fail, reply, log } from './http.mjs';
import { schedule } from './routes-schedule.mjs';
import { availability } from './routes-availability.mjs';
import { checkout } from './routes-checkout.mjs';
import { webhook } from './routes-webhook.mjs';
import { request } from './routes-request.mjs';
import { my, myUpdate, adminLogin, adminCallback, adminList, adminUpdate, reminderAdd, reminderDelete } from './routes-account.mjs';
import { exchangeCode } from './auth.mjs';
import { runReminders } from './reminders.mjs';

export const defaultDeps = {
  now: () => new Date(),
  ziina: { createIntent, getIntent },
  google: { getBusy, createEvent, getResourcesBusy },
  telegram: { notify, formatPaid, formatAttention, formatPaymentAlert, formatRequest, formatReminder, formatClientUpdate },
  auth: { exchangeCode },
  crm: { send: sendToCrm, configured: crmConfigured },
  bookings,
  computeSlots,
  quote,
  pricing,
  config,
  fetch: (...args) => fetch(...args), // unbound global fetch throws "Illegal invocation" in Workers
  log,
  memoryLimiter: createMemoryLimiter(), // per isolate, best effort
  intentLimiter: createMemoryLimiter({ maxKeys: 2000 }), // Ziina lookups per intent id
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function bookingLookup({ url, env, deps, now }) {
  const id = url.pathname.slice('/booking/'.length);
  if (!UUID_RE.test(id)) return fail(404, 'not_found');
  const b = await deps.bookings.getBooking(env.BOOKINGS, id);
  if (!b) return fail(404, 'not_found');
  let status = b.status === 'paid_needs_attention' ? 'paid' : b.status;
  if (status === 'held' && !(Date.parse(b.holdUntil) > now.getTime())) status = 'expired';
  return reply(200, {
    id: b.id, status, serviceLabel: b.serviceLabel, start: b.start, end: b.end,
    depositAed: b.depositAed, totalAed: b.totalAed,
  });
}

// Rate limiting:
//   kv     - KV counter (only /checkout: the expensive, abusable route); fails open
//   memory - per-isolate in-memory counter, best effort, no KV writes
//   null   - never limited: the webhook is protected by HMAC + getIntent, and
//            blocking Ziina's retries could lose a payment confirmation.
// (config.rate_limit.webhook_per_min is intentionally unused.)
const ROUTES = [
  { path: (p) => p === '/schedule', method: 'GET', name: 'schedule', limit: ['memory', 'availability_per_min'], originCheck: true, run: schedule },
  { path: (p) => p === '/availability', method: 'GET', name: 'availability', limit: ['memory', 'availability_per_min'], originCheck: true, run: availability },
  { path: (p) => p === '/checkout', method: 'POST', name: 'checkout', limit: ['kv', 'checkout_per_min'], originCheck: true, run: checkout },
  { path: (p) => p === '/request', method: 'POST', name: 'request', limit: ['kv', 'request_per_min'], originCheck: true, run: request },
  { path: (p) => p === '/webhook/ziina', method: 'POST', name: 'webhook', limit: null, originCheck: false, run: webhook },
  { path: (p) => p === '/my', method: 'GET', name: 'my', limit: ['memory', 'availability_per_min'], originCheck: true, run: my },
  { path: (p) => /^\/my\/requests\/[^/]+$/.test(p), method: 'POST', name: 'my-update', limit: ['memory', 'request_per_min'], originCheck: true, run: myUpdate },
  { path: (p) => p === '/admin/login', method: 'GET', name: 'admin-login', limit: ['memory', 'request_per_min'], originCheck: false, run: adminLogin },
  { path: (p) => p === '/admin/callback', method: 'GET', name: 'admin-callback', limit: ['memory', 'request_per_min'], originCheck: false, run: adminCallback },
  { path: (p) => p === '/admin/requests', method: 'GET', name: 'admin-list', limit: ['memory', 'availability_per_min'], originCheck: true, run: adminList },
  { path: (p) => /^\/admin\/requests\/[^/]+$/.test(p), method: 'PATCH', name: 'admin-update', limit: ['memory', 'availability_per_min'], originCheck: true, run: adminUpdate },
  { path: (p) => /^\/admin\/requests\/[^/]+\/reminders$/.test(p), method: 'POST', name: 'admin-reminder-add', limit: ['memory', 'availability_per_min'], originCheck: true, run: reminderAdd },
  { path: (p) => /^\/admin\/requests\/[^/]+\/reminders\/[^/]+$/.test(p), method: 'DELETE', name: 'admin-reminder-del', limit: ['memory', 'availability_per_min'], originCheck: true, run: reminderDelete },
  { path: (p) => p.startsWith('/booking/'), method: 'GET', name: 'booking', limit: ['memory', 'availability_per_min'], originCheck: false, run: bookingLookup },
];

async function limited(route, request, env, deps, nowMs) {
  if (!route.limit) return false;
  const [kind, key] = route.limit;
  const max = deps.config.rate_limit[key];
  if (kind === 'memory') return deps.memoryLimiter.hit(route.name, request, nowMs, max);
  try {
    return await overLimit(env.BOOKINGS, route.name, request, nowMs, max);
  } catch {
    deps.log({ event: 'rate_limit_unavailable' }); // fail open: KV trouble must not block bookings
    return false;
  }
}

export async function handle(request, env, ctx, deps = defaultDeps) {
  const cors = corsFor(request, env);
  try {
    if (request.method === 'OPTIONS') return preflight(cors);
    const url = new URL(request.url);
    const matches = ROUTES.filter((r) => r.path(url.pathname));
    const route = matches.find((r) => r.method === request.method) ?? matches[0];
    if (env.SCHEDULE_ONLY === 'true' && route && ['checkout','webhook'].includes(route.name)) return toResponse(fail(503,'booking_not_enabled'),cors);
    if (!route) return toResponse(fail(404, 'not_found'), cors);
    if (request.method !== route.method) return toResponse(fail(405, 'method_not_allowed'), cors);
    // A browser request from a foreign page is refused outright. No Origin
    // header (curl, Ziina's servers) is allowed.
    if (route.originCheck && cors.origin !== null && !cors.allowed) {
      return toResponse(fail(403, 'origin_not_allowed'), cors);
    }
    const now = deps.now();
    if (await limited(route, request, env, deps, now.getTime())) {
      return toResponse(fail(429, 'rate_limited'), cors);
    }
    return toResponse(await route.run({ request, env, ctx, deps, url, now }), cors);
  } catch (e) {
    try { deps.log({ event: 'internal_error', code: e?.name ?? 'Error' }); } catch { /* ignore */ }
    return toResponse(fail(500, 'internal_error'), cors);
  }
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx, defaultDeps);
  },
  scheduled(event, env, ctx) {
    const p = bookings.releaseExpired(env.BOOKINGS, new Date())
      .then((n) => log({ event: 'released_expired', count: n }))
      .catch((e) => log({ event: 'release_expired_failed', code: e?.name ?? 'Error' }));
    const r = runReminders(env, defaultDeps, new Date())
      .then((n) => { if (n) log({ event: 'reminders_sent', count: n }); })
      .catch((e) => log({ event: 'reminders_failed', code: e?.name ?? 'Error' }));
    ctx.waitUntil(r);
    return Promise.all([p, r]);
  },
};
