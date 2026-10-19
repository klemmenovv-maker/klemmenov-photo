// /book/ wiring. Markup is rendered by tools/build.py; this file only reads it and keeps the summary current.
// Request mode: WhatsApp message only. Live mode (data-book has `api`): book-live.mjs adds dates and the deposit payment.
import { quote } from './pricing.mjs';
import { buildWhatsAppText, formatAed, parseServiceParam, waUrl } from './book-ui.mjs';

const root = document.querySelector('[data-book]');

async function init() {
  const S = JSON.parse(root.dataset.book);
  const $ = (s, c = root) => c.querySelector(s);
  const $$ = (s, c = root) => Array.from(c.querySelectorAll(s));
  const summary = $('[data-summary]');
  const request = $('[data-request]');
  const hoursBox = $('[data-hours]');
  const note = $('[data-package-note]');
  const hoursOut = $('output', hoursBox);

  let config;
  try {
    const res = await fetch('../assets/pricing.json');
    if (!res.ok) throw new Error(String(res.status));
    config = await res.json();
  } catch {
    summary.innerHTML = '';
    summary.append(el('p', 'err', S.errors.load));
    request.href = waUrl(S.wa, S.greeting);
    return;
  }

  let last = null;
  const state = { serviceId: null, hours: 2, addons: {}, quote: new Set() };
  const BLOCKED = ['makeup', 'makeup_hair'];
  const svc = () => (state.serviceId ? config.services[state.serviceId] : null);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const field = (id) => { const n = document.getElementById(id); return n ? n.value : ''; };

  function selectService(id) {
    state.serviceId = id;
    const sv = svc();
    if (sv.type === 'hourly') state.hours = Math.min(config.max_hours, Math.max(sv.min, state.hours));
    else for (const a of BLOCKED) delete state.addons[a];
    const radio = $(`input[name="service"][value="${id}"]`);
    if (radio) radio.checked = true;
  }

  const initial = parseServiceParam(location.search, config.services);
  if (initial) selectService(initial);

  // aria-disabled instead of disabled: a focused button must keep focus when it reaches its bound
  function lock(btn, on) { if (on) btn.setAttribute('aria-disabled', 'true'); else btn.removeAttribute('aria-disabled'); }

  function syncControls() {
    const sv = svc();
    const pkg = !!sv && sv.type === 'package';
    hoursBox.hidden = !sv || pkg;
    note.hidden = !pkg;
    if (sv && !pkg) {
      hoursOut.textContent = `${state.hours} ${state.hours === 1 ? S.hour : S.hours}`;
      lock($('.minus', hoursBox), state.hours <= sv.min);
      lock($('.plus', hoursBox), state.hours >= config.max_hours);
    }
    for (const row of $$('.xrow')) {
      const id = row.dataset.addon;
      const blocked = pkg && BLOCKED.includes(id);
      const q = state.addons[id] || 0;
      $('output', row).textContent = q;
      lock($('.minus', row), blocked || q <= 0);
      lock($('.plus', row), blocked || q >= Number(row.dataset.max));
      row.classList.toggle('off', blocked);
    }
  }

  function render() {
    syncControls();
    summary.innerHTML = '';
    last = null;
    request.href = waUrl(S.wa, S.greeting);
    if (!state.serviceId) { summary.append(el('p', 'small', S.empty)); if (live) live.onRender(); return; }

    const addons = { ...state.addons };
    for (const id of state.quote) addons[id] = 1;
    const r = quote(config, { serviceId: state.serviceId, hours: svc().type === 'hourly' ? state.hours : undefined, addons });
    if (!r.ok) { summary.append(el('p', 'err', S.errors[r.error] || S.errors.unknown_service)); if (live) live.onRender(); return; }

    const list = el('ul', 'sum-lines');
    r.lines.forEach((l, i) => {
      const li = el('li');
      let name = l.label;
      if (i === 0 && r.hours !== undefined) name += `, ${S.hoursText.replace('{n}', r.hours).replace('{unit}', r.hours === 1 ? S.hour : S.hours)}`;
      else if (state.addons[l.id] > 1) name += ` x ${state.addons[l.id]}`;
      li.append(el('span', '', name), el('strong', '', `${formatAed(l.amount)}`));
      list.append(li);
    });
    for (const id of r.quoteOnly) {
      const li = el('li', 'q');
      li.append(el('span', '', S.quoteLabels[id]), el('strong', '', S.quoteWord));
      list.append(li);
    }
    summary.append(list);
    const total = el('p', 'sum-total');
    total.append(el('span', 'small', S.total), (() => { const n = el('strong', '', formatAed(r.total)); n.append(el('small', '', ` ${S.currency}`)); return n; })());
    summary.append(total);
    if (live) summary.append(...live.summaryExtra(r));

    last = { r, addons };
    updateHref();
    if (live) live.onRender();
  }

  // text fields only touch the link, never the aria-live summary
  function updateHref() {
    if (!last) return;
    const text = buildWhatsAppText(last.r, {
      greeting: S.greeting, name: field('f-name'), reach: field('f-reach'), notes: field('f-notes'), preferredDate: (live && live.preferredDate()) || field('f-date'),
    }, last.addons, { quoteLabels: S.quoteLabels });
    request.href = waUrl(S.wa, text);
  }

  // live mode: loaded only when the build embedded an API base; on failure the WhatsApp request link keeps working
  let live = null;
  if (S.api) {
    try {
      const { initLive } = await import('./book-live.mjs');
      live = initLive({ root, S, el, field, lock, getQuote: () => last, getSelection: () => (state.serviceId ? { serviceId: state.serviceId, hours: svc().type === 'hourly' ? state.hours : undefined } : null), refreshRequest: updateHref });
    } catch {
      const err = $('[data-pay-error]');
      if (err) { err.textContent = S.errors.load; err.hidden = false; }
    }
  }

  if (!S.api) {
    const { initSchedule } = await import('./book-schedule.mjs');
    live = initSchedule({root,S,el,getQuote:()=>last,getSelection:()=>({serviceId:state.serviceId,hours:svc()?.type==='hourly'?state.hours:undefined}),getDurationBounds:()=>svc()?.type==='hourly'?{min:svc().min,max:config.max_hours,hours:state.hours}:null,setHours:(hours)=>{state.hours=hours;render();},refreshRequest:updateHref});
  }

  root.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'service') selectService(t.value);
    else if (t.name === 'quote') t.checked ? state.quote.add(t.value) : state.quote.delete(t.value);
    render();
  });
  root.addEventListener('input', (ev) => { if (ev.target.matches('input[type="text"], textarea')) updateHref(); });
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const dir = b.classList.contains('plus') ? 1 : b.classList.contains('minus') ? -1 : 0;
    if (!dir) return;
    if (b.getAttribute('aria-disabled') === 'true') return;
    const row = b.closest('.xrow');
    if (row) {
      const id = row.dataset.addon;
      const q = Math.max(0, (state.addons[id] || 0) + dir);
      if (q) state.addons[id] = q; else delete state.addons[id];
    } else if (b.closest('[data-hours]') && svc()) {
      state.hours = Math.min(config.max_hours, Math.max(svc().min, state.hours + dir));
    }
    render();
  });
  root.querySelector('form').addEventListener('submit', (ev) => ev.preventDefault());
  render();
}

if (root) init();
