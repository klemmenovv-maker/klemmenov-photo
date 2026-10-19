// Shared test doubles (no side effects at import time).
import * as bookings from './bookings.mjs';
import { computeSlots } from './availability.mjs';
import { formatPaid, formatAttention } from './telegram.mjs';
import { quote } from '../shared/pricing.mjs';
import pricing from './pricing.json' with { type: 'json' };
import config from './booking-config.json' with { type: 'json' };

// In-memory Cloudflare KV double used by bookings and route tests.
export class MemKV {
  constructor({ pageSize = 1000, yieldBetween = false } = {}) {
    this.m = new Map(); this.afterPut = null; this.pageSize = pageSize; this.yieldBetween = yieldBetween;
    this.puts = []; this.getCount = new Map(); this.stalePuts = 0;
    this.version = new Map(); this.lastRead = new Map();
  }
  async get(key, type) {
    this.getCount.set(key, (this.getCount.get(key) ?? 0) + 1);
    const ver = this.version.get(key) ?? 0;
    this.lastRead.set(key, ver);
    const v = this.m.get(key);
    await Promise.resolve();
    if (this.yieldBetween) for (let i = 0; i < 5; i++) await Promise.resolve();
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, opts) {
    await Promise.resolve(); await Promise.resolve();
    if ((this.version.get(key) ?? 0) !== (this.lastRead.get(key) ?? 0)) this.stalePuts += 1;
    this.puts.push({ key, opts });
    this.m.set(key, value);
    this.version.set(key, (this.version.get(key) ?? 0) + 1);
    if (this.afterPut) await this.afterPut(key);
  }
  async delete(key) { this.m.delete(key); this.version.set(key, (this.version.get(key) ?? 0) + 1); }
  async list({ prefix = '', cursor } = {}) {
    const all = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const page = all.slice(from, from + this.pageSize);
    const done = from + this.pageSize >= all.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, ...(done ? {} : { cursor: String(from + this.pageSize) }) };
  }
}

// ---- route test fakes (Task 13) ---------------------------------------------
// Every external service is a fake; secrets are dummies. `deps.fetch` throws so
// any accidental real network call fails loudly.

export const NOW = '2026-10-19T10:00:00+04:00';
export const DAY = '2026-10-21';
export const START = `${DAY}T09:00:00+04:00`;
export const ORIGIN = 'https://klemmenovv-maker.github.io';
export const SECRETS = {
  ziina: 'zt_SECRET_ziina_token_0001',
  telegram: '12345:SECRET_telegram_token_0002',
  hmac: 'whsec_SECRET_hmac_0003',
  google: 'SECRET_google_private_key_0004',
};

export function makeEnv(over = {}) {
  return {
    BOOKINGS: new MemKV(),
    ALLOWED_ORIGINS: `${ORIGIN}, https://staging.example.test`,
    SITE_URL: 'https://klemmenovv-maker.github.io/klemmenov-photo',
    ZIINA_TEST: 'true',
    REQUIRE_TERMS: 'true',
    ZIINA_TOKEN: SECRETS.ziina,
    TELEGRAM_BOT_TOKEN: SECRETS.telegram,
    TELEGRAM_CHAT_ID: '42',
    GOOGLE_SA_JSON: JSON.stringify({ client_email: 'sa@example.test', private_key: SECRETS.google }),
    GOOGLE_CALENDAR_ID: 'cal@example.test',
    ...over,
  };
}

export function makeCtx() {
  const pending = [];
  return {
    pending,
    waitUntil(p) { pending.push(p); },
    async drain() { while (pending.length) await pending.shift(); },
  };
}

export const validBody = (over = {}) => ({
  serviceId: 'personal', hours: 2, start: START,
  contact: { name: 'Anna Client', reach: '+971500000001' },
  notes: 'Golden hour please', accepted_terms: true, ...over,
});

let ipSeq = 0;
export const freshIp = () => `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

export function req(method, path, { body, headers = {}, ip = freshIp(), origin } = {}) {
  const h = new Headers(headers);
  if (ip) h.set('CF-Connecting-IP', ip);
  if (origin) h.set('Origin', origin);
  let b = body;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
    b = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  return new Request(`https://booking.example.test${path}`, { method, headers: h, body: b });
}

export function makeFakes({ now = NOW } = {}) {
  const calls = { createIntent: [], getIntent: [], getBusy: [], createEvent: [], notify: [], log: [] };
  const f = {
    calls,
    intents: new Map(),
    busy: [],
    nowIso: now,
    createIntentImpl: null,
    getIntentImpl: null,
    getBusyImpl: null,
    createEventImpl: null,
    notifyImpl: null,
    lastIntentId: null,
  };
  let n = 0;
  f.deps = {
    now: () => new Date(f.nowIso),
    ziina: {
      async createIntent(env, opts) {
        calls.createIntent.push(opts);
        if (f.createIntentImpl) return f.createIntentImpl(env, opts);
        const id = `zi_${++n}`;
        f.lastIntentId = id;
        f.intents.set(id, { id, status: 'pending', amountFils: opts.amountAed * 100, currency: 'AED' });
        return { id, redirectUrl: `https://pay.ziina.example.test/${id}` };
      },
      async getIntent(env, id) {
        calls.getIntent.push(id);
        if (f.getIntentImpl) return f.getIntentImpl(env, id);
        const i = f.intents.get(id);
        if (!i) throw new Error(`fake ziina: unknown intent ${id}`);
        return { ...i };
      },
    },
    google: {
      async getBusy(env, range) {
        calls.getBusy.push(range);
        if (f.getBusyImpl) return f.getBusyImpl(env, range);
        return f.busy.map((b) => ({ ...b }));
      },
      async createEvent(env, booking) {
        calls.createEvent.push(booking);
        if (f.createEventImpl) return f.createEventImpl(env, booking);
        return { eventId: `ev_${calls.createEvent.length}` };
      },
    },
    telegram: {
      async notify(env, text) {
        calls.notify.push(text);
        if (f.notifyImpl) return f.notifyImpl(env, text);
      },
      formatPaid,
      formatAttention,
    },
    bookings,
    computeSlots,
    quote,
    pricing,
    config,
    fetch: async () => { throw new Error('network is disabled in tests'); },
    log: (entry) => calls.log.push(entry),
  };
  return f;
}

// Mark the fake intent completed (as Ziina would after a payment).
export function complete(f, id, over = {}) {
  f.intents.set(id, { ...f.intents.get(id), status: 'completed', ...over });
}

export const webhookPayload = (id, over = {}) => ({
  event: 'payment_intent.status.updated',
  data: { id, status: 'completed', amount: 50000, currency_code: 'AED', ...over },
});

export async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}
