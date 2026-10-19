// Minimal Ziina payments client. Only fetch + standard APIs (Cloudflare Worker safe).
import { timeoutSignal, timeoutMs } from './fetch-timeout.mjs';
const DEFAULT_BASE = 'https://api-v2.ziina.com/api';

export class ZiinaError extends Error {
  // `secret` (the API token) is scrubbed from body before truncation.
  constructor(message, status = 0, body = '', secret = '') {
    super(message);
    this.name = 'ZiinaError';
    this.status = status;
    let b = String(body);
    if (secret) b = b.split(secret).join('[redacted]');
    this.body = b.slice(0, 500);
  }
}

function baseUrl(env) {
  return String((env && env.ZIINA_BASE) || DEFAULT_BASE).replace(/\/+$/, '');
}

function checkUrl(name, value) {
  if (typeof value !== 'string') throw new RangeError(`${name} must be a string`);
  let u;
  try { u = new URL(value); } catch { throw new RangeError(`${name} is not a valid URL`); }
  if (u.username || u.password) throw new RangeError(`${name} must not contain credentials`);
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
  if (!ok) throw new RangeError(`${name} must be https:// or http://localhost`);
}

async function call(env, method, path, payload, fetchImpl) {
  if (!env || !env.ZIINA_TOKEN) throw new ZiinaError('ZIINA_TOKEN is not configured', 0);
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${env.ZIINA_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  init.signal = timeoutSignal(timeoutMs(env));
  let res;
  try {
    res = await fetchImpl(`${baseUrl(env)}${path}`, init);
  } catch {
    if (init.signal.aborted) throw new ZiinaError('Ziina request timed out', 0);
    throw new ZiinaError('Ziina request failed (network error)', 0);
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  if (init.signal.aborted) throw new ZiinaError('Ziina request timed out', 0);
  if (!res.ok) throw new ZiinaError(`Ziina responded with HTTP ${res.status}`, res.status, text, env.ZIINA_TOKEN);
  let data;
  try { data = JSON.parse(text); } catch { throw new ZiinaError('Ziina returned invalid JSON', res.status, text, env.ZIINA_TOKEN); }
  if (!data || typeof data !== 'object' || !data.id) {
    throw new ZiinaError('Ziina response is missing id', res.status, text, env.ZIINA_TOKEN);
  }
  return data;
}

export async function createIntent(env, opts, fetchImpl = fetch) {
  const { amountAed, message, successUrl, cancelUrl, failureUrl, expiryMs, test } = opts || {};
  if (!Number.isSafeInteger(amountAed) || amountAed <= 0 || !Number.isSafeInteger(amountAed * 100)) {
    throw new RangeError('amountAed must be a positive integer of whole dirhams');
  }
  if (!Number.isSafeInteger(expiryMs) || expiryMs <= 0) {
    throw new RangeError('expiryMs must be a positive integer (ms epoch)');
  }
  checkUrl('successUrl', successUrl);
  checkUrl('cancelUrl', cancelUrl);
  if (failureUrl !== undefined) checkUrl('failureUrl', failureUrl);

  const body = {
    amount: amountAed * 100,
    currency_code: 'AED',
    message: Array.from(String(message ?? '')).slice(0, 200).join(''),
    success_url: successUrl,
    cancel_url: cancelUrl,
    expiry: String(expiryMs),
    test: test === true,
  };
  if (failureUrl !== undefined) body.failure_url = failureUrl;

  const data = await call(env, 'POST', '/payment_intent', body, fetchImpl);
  if (!data.redirect_url) throw new ZiinaError('Ziina response is missing redirect_url', 200, JSON.stringify(data), env.ZIINA_TOKEN);
  return { id: data.id, redirectUrl: data.redirect_url };
}

export async function getIntent(env, id, fetchImpl = fetch) {
  if (typeof id !== 'string' || id === '') throw new RangeError('id must be a non-empty string');
  const data = await call(env, 'GET', `/payment_intent/${encodeURIComponent(id)}`, undefined, fetchImpl);
  return {
    id: data.id,
    status: data.status,
    amountFils: data.amount,
    currency: data.currency_code,
    ...('test' in data ? { test: Boolean(data.test) } : {}),
  };
}

export function registerWebhookBody(url, secret) {
  const body = { url };
  if (secret !== undefined) body.secret = secret;
  return body;
}
