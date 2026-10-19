// /book/ live mode: step 3 free times from the booking Worker, step 4 deposit payment.
// Loaded by book.mjs only when the build embedded an API base (content.json booking_api).
// Server and visitor text is only ever set with textContent. Nothing is stored in the browser.
import {
  formatAed, loadSlots, submitCheckout, friendlyError, payMissing,
  dayLabel, addDays, dubaiToday, slotWhen, tzDiffers,
} from './book-ui.mjs';

const DEBOUNCE_MS = 350;
const WINDOW_DAYS = 14;
const net = (url, init) => fetch(url, init);

export function initLive({ root, S, el, field, lock, getQuote, getSelection, refreshRequest }) {
  const LV = S.live;
  const $ = (s) => root.querySelector(s);
  const status = $('[data-slots-status]');
  const retry = $('[data-retry]');
  const daysBox = $('[data-days]');
  const more = $('[data-more]');
  const timesBox = $('[data-times-box]');
  const times = $('[data-times]');
  const chosen = $('[data-chosen]');
  const pay = $('[data-pay]');
  const missingEl = $('[data-pay-missing]');
  const errEl = $('[data-pay-error]');
  const terms = document.getElementById('f-terms');

  const st = { key: null, sel: null, days: [], to: null, day: null, start: null, seq: 0, timer: 0, busy: false, showMissing: false, retryReset: true };
  const lastDay = () => addDays(dubaiToday(Date.now()), S.horizonDays);

  let device = false;
  try { device = Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Dubai' && tzDiffers(-new Date().getTimezoneOffset()); } catch { device = false; }
  $('[data-tz-note]').hidden = !device;

  function setStatus(text, isErr = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle('err', isErr);
  }

  function clearSlots() {
    st.seq++;
    clearTimeout(st.timer);
    st.days = []; st.to = null; st.day = null; st.start = null;
    daysBox.replaceChildren();
    times.replaceChildren();
    timesBox.hidden = true;
    more.hidden = true;
    retry.hidden = true;
    chosen.textContent = '';
  }

  async function fetchRange(reset) {
    const seq = ++st.seq;
    const from = reset ? addDays(dubaiToday(Date.now()), 1) : addDays(st.to, 1);
    const end = lastDay();
    if (from > end) { more.hidden = true; return; }
    const to = addDays(from, WINDOW_DAYS - 1) < end ? addDays(from, WINDOW_DAYS - 1) : end;
    retry.hidden = true;
    more.setAttribute('aria-busy', 'true');
    if (reset) setStatus(LV.slots_loading);
    try {
      const res = await loadSlots(S.api, st.sel, { from, to }, net);
      if (seq !== st.seq) return;
      const before = st.days.filter((d) => d.slots.length).length;
      st.days = reset ? res.days : st.days.concat(res.days.filter((d) => d.date > st.to));
      st.to = to;
      renderDays(reset ? -1 : before);
    } catch (e) {
      if (seq !== st.seq) return;
      setStatus(friendlyError(e && e.code), true);
      st.retryReset = reset;
      retry.hidden = false;
    } finally {
      more.removeAttribute('aria-busy');
    }
  }

  // focusFrom: index of the first new day to focus after "Show more days" (-1: keep focus where it is)
  function renderDays(focusFrom) {
    const avail = st.days.filter((d) => d.slots.length);
    setStatus(avail.length ? '' : LV.slots_empty);
    daysBox.replaceChildren(...avail.map((d) => {
      const b = el('button', 'day', dayLabel(d.date));
      b.type = 'button';
      b.dataset.date = d.date;
      b.setAttribute('aria-pressed', String(d.date === st.day));
      return b;
    }));
    const canMore = addDays(st.to, 1) <= lastDay();
    const hadFocus = document.activeElement === more;
    more.hidden = !canMore;
    if (focusFrom >= 0 && (hadFocus || !canMore)) {
      const target = daysBox.children[focusFrom] || daysBox.lastElementChild;
      if (target && (hadFocus || document.activeElement === document.body)) target.focus();
    }
  }

  function renderTimes() {
    const d = st.days.find((x) => x.date === st.day);
    timesBox.hidden = !d;
    if (!d) { times.replaceChildren(); return; }
    times.replaceChildren(...d.slots.map((s) => {
      const b = el('button', 'time', s.time);
      b.type = 'button';
      b.dataset.start = s.start;
      b.setAttribute('aria-pressed', String(s.start === st.start));
      return b;
    }));
  }

  function pressed(box, attr, value) {
    for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
  }

  function choose(start) {
    st.start = start;
    chosen.textContent = start ? LV.chosen.replace('{when}', slotWhen(start)) : '';
    refreshRequest();
    updatePay();
  }

  daysBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('button.day');
    if (!b || b.dataset.date === st.day) return;
    st.day = b.dataset.date;
    pressed(daysBox, 'date', st.day);
    renderTimes();
    choose(null);
  });
  times.addEventListener('click', (ev) => {
    const b = ev.target.closest('button.time');
    if (!b) return;
    pressed(times, 'start', b.dataset.start);
    choose(b.dataset.start);
  });
  more.addEventListener('click', () => { if (!more.hasAttribute('aria-busy')) fetchRange(false); });
  retry.addEventListener('click', () => {
    if (st.retryReset) clearSlots();
    fetchRange(st.retryReset);
  });

  // ---- payment
  const payState = () => {
    const q = getQuote();
    return { quote: q && q.r, start: st.start, name: field('f-name'), reach: field('f-reach'), terms: !!(terms && terms.checked) };
  };

  function showMissing(miss) {
    const text = miss.length ? LV.missing.replace('{list}', miss.map((k) => LV.missing_items[k]).join(', ')) : '';
    if (missingEl.textContent !== text) missingEl.textContent = text;
  }

  function updatePay() {
    if (st.busy) return;
    const miss = payMissing(payState());
    lock(pay, miss.length > 0);
    if (st.showMissing) showMissing(miss);
  }

  function setBusy(on) {
    st.busy = on;
    pay.textContent = on ? LV.pay_busy : LV.pay_btn;
    if (on) { pay.setAttribute('aria-busy', 'true'); lock(pay, true); } else { pay.removeAttribute('aria-busy'); updatePay(); }
  }

  pay.addEventListener('click', async () => {
    if (st.busy) return;
    const s = payState();
    const miss = payMissing(s);
    if (miss.length) { st.showMissing = true; showMissing(miss); return; }
    errEl.hidden = true;
    errEl.textContent = '';
    const q = getQuote();
    const payload = {
      serviceId: q.r.serviceId,
      ...(q.r.hours !== undefined ? { hours: q.r.hours } : {}),
      addons: q.addons,
      start: st.start,
      contact: { name: s.name.trim(), reach: s.reach.trim() },
      notes: field('f-notes').trim(),
      accepted_terms: true,
    };
    setBusy(true);
    try {
      const res = await submitCheckout(S.api, payload, net);
      location.assign(res.redirectUrl); // stays busy while the browser leaves the page
      return;
    } catch (e) {
      const code = e && e.code;
      errEl.textContent = friendlyError(code);
      errEl.hidden = false;
      // focus stays on Pay; the message must still be visible on small screens (also after the slot list reflows)
      const reveal = () => errEl.scrollIntoView({ block: 'nearest' });
      if (code === 'slot_taken' || code === 'slot_unavailable' || code === 'invalid_start') {
        clearSlots();
        refreshRequest();
        fetchRange(true).then(reveal);
      }
      reveal();
    }
    setBusy(false);
  });
  // Back from the payment page can restore this page from the bfcache with the button still busy.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && st.busy) setBusy(false); });
  root.addEventListener('input', updatePay);
  root.addEventListener('change', updatePay);

  return {
    preferredDate: () => (st.start ? LV.date_pref.replace('{when}', slotWhen(st.start)) : ''),
    summaryExtra(r) {
      const dep = r.deposit; // quote() computes it with depositFor and the same config
      const box = el('div', 'sum-deposit');
      box.append(el('p', 'sum-due', LV.deposit.replace('{n}', formatAed(dep))), el('p', 'small', LV.remaining.replace('{n}', formatAed(r.total - dep))));
      return [box];
    },
    // called after every summary render: reload free times when the service or hours change
    onRender() {
      const sel = getQuote() ? getSelection() : null;
      const key = sel ? `${sel.serviceId}|${sel.hours ?? ''}` : '';
      if (key !== st.key) {
        st.key = key;
        clearSlots();
        st.sel = sel;
        if (!sel) setStatus(LV.slots_pick_service);
        else {
          setStatus(LV.slots_loading);
          st.timer = setTimeout(() => fetchRange(true), DEBOUNCE_MS);
        }
        refreshRequest();
      }
      updatePay();
    },
  };
}
