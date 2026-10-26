// /admin/: the owner's area (Russian). Google sign-in, requests, edits, notes, reminders, free-time chart.
import { api, tokenStore, OWNER_KEY, OWNER_STATUS, formatWhen, toLocalInput, fromLocalInput, readHash } from './account.mjs';

const root = typeof document === 'undefined' ? null : document.querySelector('[data-admin]');

const KIND_RU = { photo: 'фотосъёмка', video: 'видеосъёмка', dayoff: 'выходной', studio: 'студия', hold: 'удержано' };

async function init() {
  const base = root.dataset.api;
  const store = tokenStore(localStorage, OWNER_KEY);
  const $ = (s) => root.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const btn = (text, cls = 'btn ghost', fn) => { const b = el('button', cls, text); b.type = 'button'; if (fn) b.addEventListener('click', fn); return b; };
  const field = (label, input) => { const l = el('label', 'acct-field'); l.append(el('span', 'small', label), input); return l; };
  const input = (type, value = '', max) => { const i = el('input'); i.type = type; i.value = value; if (max) i.maxLength = max; return i; };
  const ERR = { state: 'Ссылка входа устарела, попробуйте ещё раз.', denied: 'Вход отменён.', google: 'Google не подтвердил вход.', forbidden: 'Этот аккаунт Google не имеет доступа.' };

  const h = readHash(location.hash);
  if (h.session) store.set(h.session);
  if (h.session || h.error) history.replaceState(null, '', location.pathname);
  const sign = $('[data-signin]'), app = $('[data-app]'), msg = $('[data-msg]');
  sign.querySelector('a').href = `${base}/admin/login`;
  if (h.error) msg.textContent = ERR[h.error] || 'Не удалось войти.';

  let token = store.get(), all = [], filter = 'open';
  const signOut = () => { store.set(null); token = null; app.hidden = true; sign.hidden = false; };
  $('[data-logout]').addEventListener('click', signOut);
  const call = async (path, opts = {}) => {
    const r = await api(base, path, { token, ...opts });
    if (r.status === 401) { signOut(); msg.textContent = 'Сессия закончилась: войдите снова.'; }
    return r;
  };

  async function load() {
    const r = await call('/admin/requests');
    if (!r.ok) { if (r.status !== 401) msg.textContent = 'Не удалось загрузить заявки.'; return; }
    all = r.data.requests; render();
  }
  const replace = (rec) => { all = all.map((x) => (x.id === rec.id ? rec : x)); render(); };

  function render() {
    const open = (r) => r.status === 'new' || r.status === 'needs_details';
    const show = all.filter((r) => (filter === 'open' ? open(r) : filter === 'all' ? true : r.status === filter));
    const tabs = [['open', `Требуют ответа (${all.filter(open).length})`], ['confirmed', 'Подтверждённые'], ['all', 'Все'], ['done', 'Проведённые']];
    $('[data-tabs]').replaceChildren(...tabs.map(([k, t]) => { const b = btn(t, 'chip', () => { filter = k; render(); }); b.setAttribute('aria-pressed', String(filter === k)); return b; }));
    $('[data-list]').replaceChildren(...(show.length ? show.map(card) : [el('p', 'note', 'Заявок нет.')]));
  }

  function card(r) {
    const c = el('article', `acct-card st-${r.status}`);
    const top = el('div', 'acct-top');
    top.append(el('span', 'acct-status', OWNER_STATUS[r.status] || r.status), el('b', '', `${r.name} · ${r.contact}`));
    c.append(top, el('p', '', `${r.serviceLabel}${r.hours ? `, ${r.hours} ч` : ''} · ${r.totalAed} AED${r.quoteOnly?.length ? ' + по запросу' : ''}`),
      el('p', 'acct-when', r.start ? formatWhen(r.start, 'ru') : 'Время не выбрано'));
    if (r.addons?.length) c.append(el('p', 'small note', `Допы: ${r.addons.join(', ')}`));
    if (r.notes) c.append(el('p', 'small note', `Клиент: ${r.notes}`));
    c.append(el('p', 'small note', `Заявка от ${formatWhen(r.createdAt, 'ru')}`));
    const quick = el('div', 'actions');
    const setStatus = async (status) => { const x = await call(`/admin/requests/${r.id}`, { method: 'PATCH', body: { status } }); if (x.ok) replace(x.data.request); };
    if (r.status !== 'confirmed') quick.append(btn('Подтвердить', 'btn', () => setStatus('confirmed')));
    if (r.status !== 'needs_details') quick.append(btn('Нужны детали', 'btn ghost', () => setStatus('needs_details')));
    if (r.status === 'confirmed') quick.append(btn('Проведена', 'btn ghost', () => setStatus('done')));
    if (r.status !== 'declined') quick.append(btn('Отклонить', 'btn ghost', () => setStatus('declined')));
    c.append(quick);

    const d = el('details', 'acct-more'); d.append(el('summary', '', 'Править, заметки, напоминания'));
    const f = el('form', 'acct-form'); f.noValidate = true;
    const name = input('text', r.name, 80), contact = input('text', r.contact, 120), hours = input('number', r.hours ?? ''), total = input('number', r.totalAed ?? '');
    hours.min = 0; hours.step = 1; total.min = 0;
    const when = input('datetime-local', r.start ? toLocalInput(r.start) : '');
    const note = el('textarea'); note.rows = 3; note.maxLength = 4000; note.value = r.ownerNote || '';
    const toClient = input('text', r.messageToClient || '', 500);
    const state = el('select'); for (const [k, v] of Object.entries(OWNER_STATUS)) { const o = el('option', '', v); o.value = k; o.selected = k === r.status; state.append(o); }
    const save = btn('Сохранить', 'btn'); save.type = 'submit';
    const out = el('p', 'small note'); out.setAttribute('role', 'status');
    f.append(field('Имя', name), field('Контакт', contact), field('Статус', state), field('Время (Дубай)', when), field('Часов', hours), field('Сумма, AED', total),
      field('Моя заметка (клиент не видит)', note), field('Сообщение клиенту (видно в «Мои записи»)', toClient), save, out);
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = { name: name.value, contact: contact.value, status: state.value, hours: Number(hours.value || 0), totalAed: Number(total.value || 0), ownerNote: note.value, messageToClient: toClient.value, start: fromLocalInput(when.value) };
      const x = await call(`/admin/requests/${r.id}`, { method: 'PATCH', body });
      if (x.ok) replace(x.data.request); else out.textContent = 'Не сохранилось: проверьте поля.';
    });
    d.append(f);

    const rem = el('div', 'acct-rem'); rem.append(el('h3', 'sub3', 'Напоминания себе'));
    const ul = el('ul', 'acct-rem-list');
    for (const x of r.reminders || []) {
      const li = el('li', '', `${formatWhen(x.at, 'ru')}: ${x.text || '—'}${x.sentAt ? ' (отправлено)' : ''} `);
      li.append(btn('Удалить', 'linkbtn', async () => { const y = await call(`/admin/requests/${r.id}/reminders/${x.id}`, { method: 'DELETE' }); if (y.ok) replace(y.data.request); }));
      ul.append(li);
    }
    const rf = el('form', 'acct-form'); rf.noValidate = true;
    const at = input('datetime-local'), text = input('text', '', 300); text.placeholder = 'Например: позвонить, уточнить студию';
    const add = btn('Поставить напоминание', 'btn ghost'); add.type = 'submit';
    rf.append(field('Когда (Дубай)', at), field('О чём', text), add);
    rf.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const iso = fromLocalInput(at.value); if (!iso) return;
      const y = await call(`/admin/requests/${r.id}/reminders`, { method: 'POST', body: { at: iso, text: text.value } });
      if (y.ok) replace(y.data.request);
    });
    rem.append(ul, rf, el('p', 'small note', 'Напоминание придёт в Telegram. Если клиент не выбрал время, бот напомнит сам через сутки.'));
    d.append(rem);
    c.append(d);
    return c;
  }

  // free-time chart from the public /schedule (Google Calendar + holds): next 14 days, 30-min cells
  async function chart() {
    const box = $('[data-chart]'), today = new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
    const to = new Date(Date.parse(today) + 13 * 86400000).toISOString().slice(0, 10);
    const r = await api(base, `/schedule?service=personal&hours=1&from=${today}&to=${to}`);
    if (!r.ok || !r.data?.timeline) { box.replaceChildren(el('p', 'note', 'График недоступен: Google Календарь не ответил.')); return; }
    const rows = Object.entries(r.data.timeline).map(([day, cells]) => {
      const row = el('div', 'acct-day');
      row.append(el('b', '', formatWhen(`${day}T12:00:00+04:00`, 'ru').split(',')[0]));
      const bar = el('div', 'acct-bar');
      for (const c of cells) {
        const k = c.photographerClosed ? 'closed' : c.photographer ? 'free' : `k-${c.kind || 'photo'}`;
        const s = el('i', k); s.title = `${c.time} ${k === 'free' ? 'свободно' : k === 'closed' ? 'не работаю' : KIND_RU[c.kind || 'photo']}`; bar.append(s);
      }
      row.append(bar); return row;
    });
    const scale = el('div', 'acct-day'); scale.append(el('b', ''), el('div', 'small note', '10:00 ─────────────────────── 21:00'));
    const legend = el('p', 'small note', 'Зелёное: свободно · цветные: занято в Google Календаре (фото, видео, выходной, студия) или удержано · серое: не рабочее время');
    box.replaceChildren(scale, ...rows, legend);
  }

  if (!token) { sign.hidden = false; return; }
  sign.hidden = true; app.hidden = false;
  load(); chart();
}
if (root) init();
