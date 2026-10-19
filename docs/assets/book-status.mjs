// /book/thanks/?id=<uuid>: polls the booking Worker and shows the booking status.
// Only fields returned by GET /booking/:id are shown, always via textContent.
import { formatAed, isUuid, pollBooking, slotWhen } from './book-ui.mjs';

const root = document.querySelector('[data-status]');
const net = (url, init) => fetch(url, init);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function show(box, title, lead, rows = []) {
  const out = [el('h2', 'sub', title)];
  if (rows.length) {
    const dl = el('dl', 'status-facts');
    for (const [k, v] of rows) dl.append(el('dt', '', k), el('dd', '', v));
    out.push(dl);
  }
  if (lead) out.push(el('p', 'lead', lead));
  box.replaceChildren(...out);
}

async function init() {
  const S = JSON.parse(root.dataset.status);
  const T = S.text;
  const box = root.querySelector('[data-status-box]');
  let id = null;
  try { id = new URLSearchParams(location.search).get('id'); } catch { id = null; }
  if (!isUuid(id)) { show(box, T.unknown_h, T.unknown_note); return; }

  show(box, T.pending_h, T.pending_note);
  const b = await pollBooking(S.api, id, net, { intervalMs: 3000, timeoutMs: 60000 });
  if (b.status === 'paid') {
    const rows = [];
    if (typeof b.serviceLabel === 'string') rows.push([T.service, b.serviceLabel]);
    const when = slotWhen(b.start);
    if (when) rows.push([T.when, T.when_value.replace('{when}', when)]);
    if (Number.isFinite(b.depositAed)) rows.push([T.deposit_paid, `${formatAed(b.depositAed)} AED`]);
    if (Number.isFinite(b.depositAed) && Number.isFinite(b.totalAed)) rows.push([T.remaining, `${formatAed(b.totalAed - b.depositAed)} AED`]);
    show(box, T.paid_h, T.paid_note, rows);
  } else if (b.status === 'expired') {
    show(box, T.expired_h, T.expired_note);
  } else if (b.status === 'unknown') {
    show(box, T.unknown_h, T.unknown_note);
  } else {
    show(box, T.pending_h, T.pending_still);
  }
}

if (root) init();
