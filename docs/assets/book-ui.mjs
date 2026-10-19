// Pure helpers for the /book/ page (no DOM). Copied to docs/assets by tools/build.py.

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function formatAed(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function parseServiceParam(search, services) {
  if (typeof search !== 'string' || !services) return null;
  let id;
  try { id = new URLSearchParams(search).get('service'); } catch { return null; }
  return typeof id === 'string' && has(services, id) ? id : null;
}

export function waUrl(number, text) {
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

// result: successful quote() result. contact: {name, reach, notes, preferredDate, greeting}.
// addons: optional {id: quantity} to show quantities. opts.quoteLabels: optional {id: label} for quote-only add-ons.
export function buildWhatsAppText(result, contact, addons = {}, opts = {}) {
  const c = contact || {};
  const clean = (s) => (typeof s === 'string' ? s.trim() : '');
  const out = [];
  if (clean(c.greeting)) out.push(clean(c.greeting));
  const [base, ...extras] = result.lines;
  const hours = result.hours === undefined ? '' : `, ${result.hours} ${result.hours === 1 ? 'hour' : 'hours'}`;
  out.push(`Shoot: ${base.label}${hours}`);
  for (const l of extras) {
    const q = addons[l.id];
    out.push(q > 1 ? `${l.label} x ${q}` : l.label);
  }
  const labels = opts.quoteLabels || {};
  for (const id of result.quoteOnly || []) {
    out.push(`${has(labels, id) ? labels[id] : id.replace(/_/g, ' ')} (quote, confirmed by the photographer)`);
  }
  out.push(`Total online: ${formatAed(result.total)} AED`);
  if (clean(c.preferredDate)) out.push(`Preferred date: ${clean(c.preferredDate)}`);
  if (clean(c.name)) out.push(`Name: ${clean(c.name)}`);
  if (clean(c.reach)) out.push(`Contact: ${clean(c.reach)}`);
  if (clean(c.notes)) out.push(`Notes: ${clean(c.notes)}`);
  return out.join('\n');
}
