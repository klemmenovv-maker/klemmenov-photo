// Browser side of POST /request. Never throws: the caller shows `message` and,
// when `fallback` is "whatsapp", offers the WhatsApp link instead of losing the visitor.
const MESSAGES = {
  invalid_contact: 'Please check your phone, email or @username.',
  invalid_name: 'Please enter your name.',
  invalid_start: 'Please pick a time in the future.',
  invalid_notes: 'Please shorten the notes and remove extra links.',
  terms_not_accepted: 'Please accept the terms to continue.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
};

export async function submitRequest(api, payload, fetchImpl = fetch) {
  const url = `${String(api).replace(/\/+$/, '')}/request`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, fallback: 'whatsapp', error: 'network', message: 'Could not reach the booking service. Send your request in WhatsApp instead.' };
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (res.ok && data && data.ok === true) return { ok: true, id: data.id ?? null, token: data.token ?? null };
  const error = (data && data.error) || `http_${res.status}`;
  if (res.status >= 500 || res.status === 404) {
    return { ok: false, fallback: 'whatsapp', error, message: 'The booking service is unavailable. Send your request in WhatsApp instead.' };
  }
  return { ok: false, fallback: null, error, message: MESSAGES[error] || 'Please check the form and try again.' };
}
