// /book/ week calendar (after the Project K studio calendar): service tabs, hours/extras card, free-time grid, request in WhatsApp.
// Markup comes from tools/build.py; this file reads it, loads free times from the schedule API and keeps the request text current.
import { quote } from './pricing.mjs';
import { addDays, buildWhatsAppText, dubaiToday, formatAed, parseServiceParam, waUrl } from './book-ui.mjs';
import { validateSchedule } from './schedule.mjs';
import { submitRequest } from './request-client.mjs';
import { tokenStore, CLIENT_KEY } from './account.mjs';

const root = typeof document === 'undefined' ? null : document.querySelector('[data-wk]');

// Monday of the week that holds `day` (YYYY-MM-DD)
export function weekStartOf(day) {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}
const hh = (t) => Number(t.slice(0, 2));
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// state of one grid cell (day, hour): 'free' (with the first start in that hour), 'busy' or 'closed'
export function cellState(data, day, h) {
  if (!data) return { kind: 'wait' };
  const slot = (data.days[day] || []).find((s) => s.photographer && hh(s.time) === h);
  if (slot) return { kind: 'free', start: slot.start, end: slot.end };
  const cells = (data.timeline?.[day] || []).filter((c) => hh(c.time) === h);
  const busy = cells.find((c) => !c.photographerClosed && !c.photographer);
  if (busy) return { kind: 'busy', what: busy.kind || 'photo' };
  return { kind: 'closed' };
}

// Minutes of consecutive free half-hours that begin exactly at `startIso`.
export function freeRun(data, day, startIso) {
  const cells = data?.timeline?.[day] || [];
  let i = cells.findIndex((c) => c.start === startIso), run = 0;
  if (i < 0) return 0;
  for (; i < cells.length && cells[i].photographer && !cells[i].photographerClosed; i++) run += 30;
  return run;
}

// Whole-hour durations a start can take: from the service minimum up to the free run (and the price list's maximum).
export function durationOptions(runMin, minH, maxH) {
  const out = [];
  for (let h = minH; h <= maxH && h * 60 <= runMin; h++) out.push(h);
  return out;
}

export const addMinutes = (iso, m) => {
  const t = new Date(Date.parse(iso) + 4 * 3600000 + m * 60000).toISOString();
  return `${t.slice(0, 19)}+04:00`;
};

async function init() {
  const S = JSON.parse(root.dataset.wk);
  const I = S.i;
  const $ = (s, c = root) => c.querySelector(s);
  const $$ = (s, c = root) => Array.from(c.querySelectorAll(s));
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const card = $('[data-card]'), grid = $('[data-grid]'), status = $('[data-status]'), retry = $('[data-retry]');
  const chosenEl = $('[data-chosen]'), cont = $('[data-continue]'), details = $('[data-details]'), extras = $('[data-extras]');
  const send = $('[data-send]'), sendTg = $('[data-send-tg]'), copied = $('[data-copied]');
  const lock = (b, on) => (on ? b.setAttribute('aria-disabled', 'true') : b.removeAttribute('aria-disabled'));

  let config;
  try {
    const res = await fetch('../assets/pricing.json');
    if (!res.ok) throw new Error(String(res.status));
    config = await res.json();
  } catch {
    card.replaceChildren(el('p', 'err', I.price_load));
    send.removeAttribute('hidden');
    return;
  }

  const today = dubaiToday(Date.now());
  const horizon = addDays(today, S.horizonDays);
  const state = { serviceId: null, hours: 2, addons: {}, quote: new Set(), week: weekStartOf(today), slot: null, data: null, offline: false };
  const BLOCKED = ['makeup', 'makeup_hair'];
  const svc = () => config.services[state.serviceId];
  const hourlyNow = () => svc().type === 'hourly';
  let seq = 0, last = null;

  function select(id) {
    state.serviceId = id; state.slot = null;
    const sv = svc();
    if (sv.type === 'hourly') state.hours = Math.min(config.max_hours, Math.max(sv.min, state.hours));
    else for (const a of BLOCKED) delete state.addons[a];
    $$('[role=tab]').forEach((t) => { const on = t.dataset.service === id; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
    extras.hidden = false;
    renderCard(); load();
  }

  function result() {
    const addons = { ...state.addons };
    for (const id of state.quote) addons[id] = 1;
    return { r: quote(config, { serviceId: state.serviceId, hours: hourlyNow() ? state.hours : undefined, addons }), addons };
  }

  // The time is set on the calendar itself (drag, or tap the start and then the end). Only without a
  // calendar (offline) the length is a plain list.
  function timeRow(sv) {
    const row = el('div', 'trow');
    if (state.offline) {
      const lab = el('label', 'tsel'); lab.append(el('span', 'small', I.hours));
      const s = el('select');
      for (let h = sv.min; h <= config.max_hours; h++) { const o = el('option', '', `${h} ${h === 1 ? I.hour_w : I.hours_w}`); o.value = h; o.selected = h === state.hours; s.append(o); }
      s.addEventListener('change', () => { state.hours = Number(s.value); renderCard(); });
      lab.append(s); row.append(lab);
    } else {
      row.append(el('p', 'small note drag-hint', state.slot ? I.drag_more : I.drag_hint));
    }
    return row;
  }
  // choose a start: the shoot gets the current length, cut down to the free time that is left
  function setSlot(start) {
    const day = start.slice(0, 10), sv = svc();
    const opts = durationOptions(freeRun(state.data, day, start), sv.min, config.max_hours);
    if (opts.length) state.hours = Math.min(Math.max(state.hours, sv.min), opts[opts.length - 1]);
    state.slot = { start, end: addMinutes(start, state.hours * 60) };
    renderGrid(); renderCard();
  }
  const pickStart = (day, start) => setSlot(start);

  function renderCard() {
    const sv = svc(), info = S.info[state.serviceId];
    const { r } = result();
    const head = el('div', 'wk-card-head');
    head.append(el('h3', '', info.name));
    const hrs = hourlyNow() ? state.hours : (S.pkgMin[state.serviceId] || 0) / 60;
    head.append(el('span', 'small note', hrs ? `${hrs} ${hrs === 1 ? I.hour_w : I.hours_w}` : ''));
    const price = el('p', 'wk-price');
    if (r.ok) { price.append(formatAed(r.total), el('small', '', I.aed)); } else price.append(el('span', 'err small', I.errors[r.error] || I.errors.unknown_service));
    const parts = [head, price];
    if (hourlyNow()) parts.push(timeRow(sv));
    else parts.push(el('p', 'small note', `${I.per_pkg} · ${I.pkg_note}`));
    const ul = el('ul', 'wk-lines'); info.lines.forEach((l) => ul.append(el('li', '', l))); parts.push(ul);
    card.replaceChildren(...parts);
    syncExtras(); renderRequest();
  }

  function syncExtras() {
    const pkg = svc().type === 'package';
    for (const row of $$('.xrow')) {
      const id = row.dataset.addon, blocked = pkg && BLOCKED.includes(id), q = state.addons[id] || 0;
      $('output', row).textContent = q;
      lock($('.minus', row), blocked || q <= 0); lock($('.plus', row), blocked || q >= Number(row.dataset.max));
      row.classList.toggle('off', blocked);
    }
  }

  const rangeFmt = (a, b) => {
    const [, ma, da] = a.split('-').map(Number), [, mb, db] = b.split('-').map(Number), y = b.slice(0, 4);
    return ma === mb ? `${da} – ${db} ${I.months[mb - 1]} ${y}` : `${da} ${I.months[ma - 1]} – ${db} ${I.months[mb - 1]} ${y}`;
  };

  function renderGrid() {
    const days = Array.from({ length: 7 }, (_, k) => addDays(state.week, k));
    $('[data-range]').textContent = rangeFmt(days[0], days[6]);
    $('[data-prev]').disabled = state.week <= weekStartOf(today);
    $('[data-next]').disabled = addDays(state.week, 7) > horizon;
    const nodes = [el('div', 'wk-h')];
    nodes[0].append(el('span', '', I.time));
    days.forEach((d, k) => {
      const h = el('div', `wk-h${d === today ? ' is-today' : ''}${d < today ? ' is-past' : ''}`);
      h.append(el('span', '', I.days[k]), el('b', '', String(Number(d.slice(8)))));
      nodes.push(h);
    });
    for (let h = S.openHour; h < S.closeHour; h++) {
      nodes.push(el('div', 'wk-t', `${String(h).padStart(2, '0')}:00`));
      days.forEach((d) => {
        const c = d < today || d > horizon ? { kind: 'closed' } : cellState(state.data, d, h);
        const sl = state.slot;
        const inSel = sl && sl.start.slice(0, 10) === d && mins(sl.start.slice(11)) < (h + 1) * 60 && mins(sl.end.slice(11)) > h * 60;
        let n;
        if (c.kind === 'free') {
          n = el('button', 'wk-c free'); n.type = 'button';
          n.setAttribute('aria-label', I.free_aria.replace('{when}', `${I.days[days.indexOf(d)]} ${Number(d.slice(8))} ${I.months[Number(d.slice(5, 7)) - 1]}, ${String(h).padStart(2, '0')}:00`));
          n.setAttribute('aria-pressed', String(!!inSel));
          n.onclick = () => {
            const sl0 = state.slot;
            // a second tap later the same day stretches the shoot to the end of that hour, if all of it is free
            if (sl0 && hourlyNow() && sl0.start.slice(0, 10) === d && c.start > sl0.start && state.data && !state.offline) {
              const need = Math.ceil((mins(c.end.slice(11, 16)) - mins(sl0.start.slice(11, 16))) / 60);
              if (need >= svc().min && need <= config.max_hours && need * 60 <= freeRun(state.data, d, sl0.start)) { state.hours = need; setSlot(sl0.start); return; }
            }
            setSlot(c.start);
          };
          n.dataset.day = d; n.dataset.h = String(h); n.dataset.start = c.start;
        } else if (c.kind === 'busy') {
          n = el('div', `wk-c busy k-${c.what}`, I.kinds[c.what] || ''); n.setAttribute('aria-label', I.kinds[c.what] || I.legend[1]);
        } else n = el('div', `wk-c ${c.kind}`);
        if (inSel) { n.classList.add('sel'); if (mins(sl.start.slice(11)) >= h * 60 && mins(sl.start.slice(11)) < (h + 1) * 60) { n.classList.add('first'); n.dataset.t = `${sl.start.slice(11, 16)} · ${state.hours} ${I.h_short}`; } if (c.kind !== 'free') n.setAttribute('aria-hidden', 'true'); }
        nodes.push(n);
      });
    }
    grid.replaceChildren(...nodes);
    drawNow(days);
  }

  // the red line of the current time (Dubai), like a wall clock
  function drawNow(days) {
    const t = new Date(Date.now() + 4 * 3600000), day = t.toISOString().slice(0, 10), h = t.getUTCHours();
    if (!days.includes(day) || h < S.openHour || h >= S.closeHour) return;
    const row = h - S.openHour, perRow = 8;
    const top = `${(t.getUTCMinutes() / 60) * 100}%`;
    const cells = Array.from(grid.children).slice(perRow * (row + 1), perRow * (row + 2));
    cells.forEach((c, i) => { const line = el('i', i === 1 + days.indexOf(day) ? 'now dot' : 'now'); line.style.top = top; line.setAttribute('aria-hidden', 'true'); c.append(line); });
  }
  setInterval(() => { if (document.visibilityState === 'visible' && state.data) renderGrid(); }, 60000);

  // hover preview of the length that one tap would select
  grid.addEventListener('mouseover', (ev) => {
    grid.querySelectorAll('.peek').forEach((n) => n.classList.remove('peek'));
    const c = ev.target.closest('.wk-c.free'); if (!c || !hourlyNow()) return;
    for (let k = 0; k < state.hours; k++) {
      const n = grid.querySelector(`.wk-c[data-day="${c.dataset.day}"][data-h="${Number(c.dataset.h) + k}"]`);
      if (!n || !n.classList.contains('free')) break;
      n.classList.add('peek');
    }
  });
  grid.addEventListener('mouseleave', () => grid.querySelectorAll('.peek').forEach((n) => n.classList.remove('peek')));

  // Drag over the free hours of one day to set the start and the end in one move (mouse and pen).
  // On a touch screen vertical drag scrolls the page, so there it is: tap the start, then tap the end.
  let drag = null, suppressClick = false;
  const cellAt = (x, y) => { const n = document.elementFromPoint(x, y)?.closest?.('.wk-c'); return n && n.dataset.day ? n : null; };
  const rangeFor = (anchor, h) => {
    const lo = Math.min(anchor.h, h), hi = Math.max(anchor.h, h), first = grid.querySelector(`.wk-c.free[data-day="${anchor.day}"][data-h="${lo}"]`);
    if (!first) return null;
    let hours = Math.min(hi - lo + 1, config.max_hours);
    hours = Math.min(hours, Math.floor(freeRun(state.data, anchor.day, first.dataset.start) / 60));
    return hours >= svc().min ? { lo, hours, start: first.dataset.start } : { lo, hours: svc().min, start: first.dataset.start };
  };
  const paint = (r) => {
    grid.querySelectorAll('.peek').forEach((n) => n.classList.remove('peek'));
    if (r) for (let k = 0; k < r.hours; k++) grid.querySelector(`.wk-c[data-day="${drag.day}"][data-h="${r.lo + k}"]`)?.classList.add('peek');
  };
  grid.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch' || ev.button !== 0 || !hourlyNow() || !state.data || state.offline) return;
    const c = ev.target.closest('.wk-c.free'); if (!c) return;
    drag = { day: c.dataset.day, h: Number(c.dataset.h), moved: false, range: null };
  });
  grid.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const c = cellAt(ev.clientX, ev.clientY);
    if (!c || c.dataset.day !== drag.day) return;
    const h = Number(c.dataset.h);
    if (h !== drag.h && !drag.moved) { drag.moved = true; grid.setPointerCapture(ev.pointerId); grid.classList.add('dragging'); }
    if (drag.moved) { drag.range = rangeFor(drag, h); paint(drag.range); }
  });
  const endDrag = (commit) => {
    const d = drag; drag = null; grid.classList.remove('dragging');
    if (!d) return;
    paint(null);
    if (commit && d.moved && d.range) { suppressClick = true; state.hours = d.range.hours; setSlot(d.range.start); }
  };
  grid.addEventListener('pointerup', () => endDrag(true));
  grid.addEventListener('pointercancel', () => endDrag(false));
  grid.addEventListener('click', (ev) => { if (suppressClick) { suppressClick = false; ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);

  async function load() {
    const id = ++seq; state.data = null; retry.hidden = true; renderGrid();
    if (!S.scheduleApi) { goOffline(); return; }
    const from = state.week < today ? today : state.week, to0 = addDays(state.week, 6), to = to0 > horizon ? horizon : to0;
    if (from > to) { state.data = { days: {}, timeline: {}, durationMin: 60 }; status.textContent = ''; renderGrid(); return; }
    status.textContent = I.loading;
    const p = new URLSearchParams({ service: state.serviceId, from, to });
    if (hourlyNow()) p.set('hours', svc().min);
    try {
      const res = await fetch(`${S.scheduleApi}/schedule?${p}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
      if (!res.ok) throw new Error('unavailable');
      const data = validateSchedule(await res.json());
      if (id !== seq) return;
      state.data = data; state.offline = false;
      status.textContent = I.ready.replace('{n}', data.durationMin / 60);
      applyOffline(); renderGrid(); renderCard();
    } catch { if (id === seq) goOffline(true); }
  }
  function goOffline(failed) {
    state.offline = true; state.data = { days: {}, timeline: {}, durationMin: 60 };
    status.textContent = failed ? I.error : I.error; retry.hidden = false; applyOffline(); renderGrid();
  }
  function applyOffline() { $('[data-date-field]').hidden = !state.offline; renderRequest(); }

  function renderRequest() {
    const sl = state.slot;
    const when = sl ? `${I.days[(new Date(`${sl.start.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7]} ${Number(sl.start.slice(8, 10))} ${I.months[Number(sl.start.slice(5, 7)) - 1]}, ${sl.start.slice(11, 16)}–${sl.end.slice(11, 16)}` : '';
    chosenEl.textContent = sl ? I.chosen.replace('{when}', when) : I.pick;
    chosenEl.classList.toggle('is-set', !!sl);
    lock(cont, !(sl || state.offline));
    const { r, addons } = result();
    last = r.ok ? { r, addons, when } : null;
    const text = last ? buildWhatsAppText(last.r, {
      greeting: I.greeting, name: val('f-name'), reach: val('f-reach'), notes: val('f-notes'),
      preferredDate: when || val('f-date'), email: val('f-email'), location: locText(),
    }, addons, { quoteLabels: I.quote_labels }) : I.greeting;
    send.href = waUrl(S.wa, text); send.dataset.text = text;
  }
  const val = (id) => (document.getElementById(id) || {}).value || '';
  const locText = () => { const sel = document.getElementById('f-loc'); return sel ? [sel.options[sel.selectedIndex].text, val('f-loc-d')].filter(Boolean).join(': ') : ''; };

  cont.addEventListener('click', () => {
    if (cont.getAttribute('aria-disabled') === 'true') return;
    details.hidden = false; cont.hidden = true; renderRequest();
    const h = document.getElementById('wk-dh'); h.scrollIntoView({ block: 'start' }); h.focus({ preventScroll: true });
  });
  sendTg.addEventListener('click', () => {
    const t = send.dataset.text || '';
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => { copied.textContent = I.copied; }, () => {});
  });
  const submitBtn = $('[data-submit]'), submitStatus = $('[data-submit-status]');
  // Remember the visitor's details in this browser so the next request is one tap.
  const profile = tokenStore(localStorage, 'klemmenov.profile');
  try {
    const p = JSON.parse(profile.get() || '{}');
    for (const [id, k] of [['f-name', 'name'], ['f-reach', 'reach'], ['f-email', 'email']]) if (typeof p[k] === 'string') document.getElementById(id).value = p[k];
  } catch { /* no saved details */ }
  const locSel = document.getElementById('f-loc'), locField = $('[data-loc-field]');
  const syncLoc = () => { locField.hidden = locSel.value === 'studio'; };
  locSel.addEventListener('change', syncLoc); syncLoc();
  if (submitBtn) submitBtn.addEventListener('click', async () => {
    renderRequest();
    const name = val('f-name').trim(), reach = val('f-reach').trim(), email = val('f-email').trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    if (!last || !name || reach.length < 7 || !emailOk || !document.getElementById('f-terms').checked) { submitStatus.textContent = I.fill; return; }
    const loc = { type: locSel.value, details: val('f-loc-d').trim() };
    if (loc.type === 'client' && loc.details.length < 3) { submitStatus.textContent = I.loc_need; return; }
    const store = tokenStore(localStorage, CLIENT_KEY);
    const when = last.when || val('f-date');
    lock(submitBtn, true); submitStatus.textContent = I.submitting;
    const res = await submitRequest(S.scheduleApi, {
      serviceId: state.serviceId, hours: hourlyNow() ? state.hours : undefined, addons: last.addons,
      start: state.slot ? state.slot.start : undefined, contact: { name, reach, email }, location: loc,
      notes: [!state.slot && when ? `${I.date}: ${when}` : '', val('f-notes').trim()].filter(Boolean).join('\n'),
      accepted_terms: true, clientToken: store.get() || undefined,
    });
    lock(submitBtn, false);
    if (!res.ok) { submitStatus.textContent = res.fallback ? I.submit_fail : res.message; return; }
    if (res.token) store.set(res.token);
    profile.set(JSON.stringify({ name, reach, email }));
    submitStatus.replaceChildren(I.submitted + ' ');
    const a = el('a', '', I.view_mine); a.href = '../my/'; submitStatus.append(a);
  });
  details.addEventListener('input', renderRequest);
  details.addEventListener('submit', (e) => e.preventDefault());

  // controls
  $$('[role=tab]').forEach((t) => {
    t.addEventListener('click', () => select(t.dataset.service));
    t.addEventListener('keydown', (e) => {
      const tabs = $$('[role=tab]'), i = tabs.indexOf(t); let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length; else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = tabs.length - 1;
      if (j >= 0) { e.preventDefault(); tabs[j].focus(); select(tabs[j].dataset.service); }
    });
  });
  const shift = (n) => { state.week = addDays(state.week, n * 7); state.slot = null; renderRequest(); load(); };
  $('[data-prev]').addEventListener('click', () => shift(-1));
  $('[data-next]').addEventListener('click', () => shift(1));
  $('[data-today]').addEventListener('click', () => { state.week = weekStartOf(today); load(); });
  retry.addEventListener('click', load);
  root.addEventListener('change', (ev) => { if (ev.target.name === 'quote') { ev.target.checked ? state.quote.add(ev.target.value) : state.quote.delete(ev.target.value); renderCard(); } });
  extras.addEventListener('click', (ev) => {
    const b = ev.target.closest('.stepper button'); if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const row = b.closest('.xrow'), id = row.dataset.addon, dir = b.classList.contains('plus') ? 1 : -1;
    const q = Math.max(0, (state.addons[id] || 0) + dir); if (q) state.addons[id] = q; else delete state.addons[id];
    renderCard();
  });

  select(parseServiceParam(location.search, config.services) || 'personal');
}

if (root) init();
