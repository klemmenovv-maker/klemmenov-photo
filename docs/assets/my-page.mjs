// /my/: the client's own requests and their status. The private token lives in this browser only.
import { api, tokenStore, CLIENT_KEY, CLIENT_STATUS, formatWhen } from './account.mjs';

const root = typeof document === 'undefined' ? null : document.querySelector('[data-my]');

async function init() {
  const base = root.dataset.api;
  const store = tokenStore(localStorage, CLIENT_KEY);
  const list = root.querySelector('[data-list]'), status = root.querySelector('[data-status]');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');   // a link sent by the owner: /my/#t=...
  if (fromHash && /^[A-Za-z0-9_-]{16,64}$/.test(fromHash)) { store.set(fromHash); history.replaceState(null, '', location.pathname); }
  const token = store.get();
  if (!token) { status.textContent = root.dataset.empty; return; }

  async function load() {
    status.textContent = root.dataset.loading;
    const r = await api(base, '/my', { token });
    if (r.status === 401) { store.set(null); status.textContent = root.dataset.empty; list.replaceChildren(); return; }
    if (!r.ok) { status.textContent = root.dataset.error; return; }
    status.textContent = r.data.requests.length ? '' : root.dataset.empty;
    list.replaceChildren(...r.data.requests.map(card));
  }

  function card(q) {
    const c = el('article', `acct-card st-${q.status}`);
    c.append(el('span', 'acct-status', CLIENT_STATUS[q.status] || q.status));
    c.append(el('h2', '', `${q.serviceLabel}${q.hours ? `, ${q.hours} h` : ''}`));
    c.append(el('p', 'acct-when', q.start ? formatWhen(q.start) : root.dataset.nowhen));
    c.append(el('p', 'small note', `${q.totalAed} AED · ${root.dataset.sent} ${formatWhen(q.createdAt)}`));
    if (q.message) { const m = el('blockquote', 'msg-text', q.message); c.append(m); }
    if (q.notes) c.append(el('p', 'small note', q.notes));
    if (['new', 'needs_details', 'confirmed'].includes(q.status)) {
      const f = el('form', 'acct-form'); f.noValidate = true;
      const when = el('input'); when.type = 'datetime-local'; when.setAttribute('aria-label', root.dataset.pick);
      const note = el('input'); note.type = 'text'; note.maxLength = 1000; note.placeholder = root.dataset.noteph; note.setAttribute('aria-label', root.dataset.noteph);
      const save = el('button', 'btn', root.dataset.save); save.type = 'submit';
      const cancel = el('button', 'btn ghost', root.dataset.cancel); cancel.type = 'button';
      const msg = el('p', 'small note'); msg.setAttribute('role', 'status');
      f.append(when, note, save, cancel, msg);
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = {};
        if (when.value) body.start = `${when.value}:00+04:00`;
        if (note.value.trim()) body.notes = note.value.trim();
        if (!Object.keys(body).length) return;
        const r = await api(base, `/my/requests/${q.id}`, { method: 'POST', token, body });
        if (r.ok) load(); else msg.textContent = r.status === 400 ? root.dataset.bad : root.dataset.error;
      });
      cancel.addEventListener('click', async () => {
        if (!confirm(root.dataset.confirm)) return;
        const r = await api(base, `/my/requests/${q.id}`, { method: 'POST', token, body: { cancel: true } });
        if (r.ok) load(); else msg.textContent = root.dataset.error;
      });
      c.append(f);
    }
    return c;
  }
  load();
}
if (root) init();
