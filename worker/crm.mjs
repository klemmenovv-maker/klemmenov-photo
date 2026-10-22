// CRM adapter: POSTs one request as JSON to a webhook (a Google Apps Script web
// app that appends a row to a Google Sheet, Zapier, Make, n8n, any CRM inbound
// webhook). The URL and the optional shared secret live only in Worker secrets.
// Only fetch + standard APIs (Cloudflare Worker safe).
import { timeoutSignal, timeoutMs } from './fetch-timeout.mjs';

export class CrmError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
  }
}

export function crmConfigured(env) {
  return Boolean(env && typeof env.CRM_WEBHOOK_URL === 'string' && env.CRM_WEBHOOK_URL.trim());
}

// Errors never carry the URL, the secret or the response body: the URL is a
// credential for most webhook providers.
export async function sendToCrm(env, record, fetchImpl = fetch) {
  if (!crmConfigured(env)) throw new CrmError('CRM_WEBHOOK_URL is not configured');
  const payload = env.CRM_WEBHOOK_SECRET ? { ...record, secret: env.CRM_WEBHOOK_SECRET } : record;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: timeoutSignal(timeoutMs(env)),
  };
  let res;
  try {
    res = await fetchImpl(env.CRM_WEBHOOK_URL.trim(), init);
  } catch {
    if (init.signal.aborted) throw new CrmError('CRM request timed out');
    throw new CrmError('CRM request failed (network error)');
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  if (!res.ok) throw new CrmError(`CRM responded with HTTP ${res.status}`, res.status);
  // Apps Script answers 200 with {"ok":false,...} on a rejected secret/payload.
  let data = null;
  try { data = JSON.parse(text); } catch { /* plain-text 200 from Zapier/Make is fine */ }
  if (data && data.ok === false) throw new CrmError('CRM rejected the record', res.status);
}
