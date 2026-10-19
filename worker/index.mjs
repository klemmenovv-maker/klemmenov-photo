// Cloudflare Worker entry point for the booking system.
//   GET  /availability   free slots (Google busy + KV holds), fail closed
//   POST /checkout       server-priced hold + Ziina payment intent
//   POST /webhook/ziina  payment confirmation (always re-checked with Ziina)
//   GET  /booking/:id    public status of one booking (no personal data)
// Everything external is reached through `deps`, so tests inject fakes.
import pricing from './pricing.json' with { type: 'json' };
import config from './booking-config.json' with { type: 'json' };
import { quote } from '../shared/pricing.mjs';
import { computeSlots } from './availability.mjs';
import * as bookings from './bookings.mjs';
import { createIntent, getIntent } from './ziina.mjs';
import { getBusy, createEvent } from './google.mjs';
import { notify, formatPaid, formatAttention } from './telegram.mjs';
import { corsFor, toResponse, preflight, overLimit, fail, reply, log } from './http.mjs';
import { availability } from './routes-availability.mjs';
import { checkout } from './routes-checkout.mjs';
import { webhook } from './routes-webhook.mjs';

export const defaultDeps = {
  now: () => new Date(),
  ziina: { createIntent, getIntent },
  google: { getBusy, createEvent },
  telegram: { notify, formatPaid, formatAttention },
  bookings,
  computeSlots,
  quote,
  pricing,
  config,
  fetch: (...args) => fetch(...args), // unbound global fetch throws "Illegal invocation" in Workers
  log,
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

const ROUTES = [
  { path: (p) => p === '/availability', method: 'GET', name: 'availability', limit: 'availability_per_min', originCheck: true, run: availability },
  { path: (p) => p === '/checkout', method: 'POST', name: 'checkout', limit: 'checkout_per_min', originCheck: true, run: checkout },
  { path: (p) => p === '/webhook/ziina', method: 'POST', name: 'webhook', limit: 'webhook_per_min', originCheck: false, run: webhook },
  { path: (p) => p.startsWith('/booking/'), method: 'GET', name: 'booking', limit: 'availability_per_min', originCheck: false, run: bookingLookup },
];

export async function handle(request, env, ctx, deps = defaultDeps) {
  const cors = corsFor(request, env);
  try {
    if (request.method === 'OPTIONS') return preflight(cors);
    const url = new URL(request.url);
    const route = ROUTES.find((r) => r.path(url.pathname));
    if (!route) return toResponse(fail(404, 'not_found'), cors);
    if (request.method !== route.method) return toResponse(fail(405, 'method_not_allowed'), cors);
    // A browser request from a foreign page is refused outright. No Origin
    // header (curl, Ziina's servers) is allowed.
    if (route.originCheck && cors.origin !== null && !cors.allowed) {
      return toResponse(fail(403, 'origin_not_allowed'), cors);
    }
    const now = deps.now();
    if (await overLimit(env.BOOKINGS, route.name, request, now.getTime(), deps.config.rate_limit[route.limit])) {
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
    ctx.waitUntil(p);
    return p;
  },
};
