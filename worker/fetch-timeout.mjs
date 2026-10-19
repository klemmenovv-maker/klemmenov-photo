// Timeout for outbound fetches (Ziina, Google, Telegram). Standard APIs only.
export const DEFAULT_TIMEOUT_MS = 8000;

// env.HTTP_TIMEOUT_MS (positive number) overrides the default; tests use it.
export function timeoutMs(env) {
  const raw = env?.HTTP_TIMEOUT_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// An AbortSignal that aborts after `ms`. Falls back to AbortController +
// setTimeout where AbortSignal.timeout is missing.
export function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  if (t && typeof t.unref === 'function') t.unref();
  return c.signal;
}
