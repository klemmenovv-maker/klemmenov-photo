// Pure pricing rules shared by the browser calculator and the Cloudflare Worker.
// Reads only the `config` argument (see content.json -> pricing.json). No imports.

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fail = (error) => ({ ok: false, error });
const isPosInt = (n) => typeof n === 'number' && Number.isInteger(n) && n > 0;
const PACKAGE_BLOCKED = ['makeup', 'makeup_hair'];

export function depositFor(config, serviceId, total) {
  const d = config.deposit;
  if (serviceId === 'personal') return d.personal;
  return Math.ceil((total * d.default_percent) / 100);
}

export function quote(config, selection) {
  if (!selection || typeof selection !== 'object') return fail('unknown_service');
  const { serviceId, hours, addons } = selection;
  if (typeof serviceId !== 'string' || !has(config.services, serviceId)) return fail('unknown_service');
  const svc = config.services[serviceId];

  const lines = [];
  let usedHours;
  if (svc.type === 'hourly') {
    if (!isPosInt(hours) || hours > config.max_hours) return fail('invalid_hours');
    if (hours < svc.min) return fail('below_minimum');
    usedHours = hours;
    lines.push({ id: serviceId, label: svc.label, amount: svc.rate * hours });
  } else {
    lines.push({ id: serviceId, label: svc.label, amount: svc.price });
  }

  let sel = addons;
  if (sel === undefined || sel === null) sel = {};
  if (typeof sel !== 'object' || Array.isArray(sel)) return fail('invalid_quantity');

  const quoteOnly = [];
  for (const id of Object.keys(sel)) {
    const isFixed = has(config.fixed_addons, id);
    const isQuote = has(config.quote_addons, id);
    if (!isFixed && !isQuote) return fail('unknown_addon');
    if (!isPosInt(sel[id])) return fail('invalid_quantity');
    if (isFixed && svc.type === 'package' && PACKAGE_BLOCKED.includes(id)) return fail('not_available');
    if (isFixed) {
      const a = config.fixed_addons[id];
      lines.push({ id, label: a.label, amount: a.price * sel[id] });
    } else {
      quoteOnly.push(id);
    }
  }

  const total = lines.reduce((s, l) => s + l.amount, 0);
  return {
    ok: true,
    serviceId,
    hours: usedHours,
    lines,
    total,
    deposit: depositFor(config, serviceId, total),
    quoteOnly,
  };
}
