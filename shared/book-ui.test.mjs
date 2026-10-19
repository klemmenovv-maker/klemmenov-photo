import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quote } from './pricing.mjs';
import { buildWhatsAppText, formatAed, parseServiceParam, waUrl } from './book-ui.mjs';

const config = JSON.parse(readFileSync(new URL('../worker/pricing.json', import.meta.url), 'utf8'));
const contact = { name: 'Anna', notes: '', preferredDate: '', greeting: 'Hello, I would like to book.' };

test('whatsapp_text_includes_lines_and_total', () => {
  const r = quote(config, { serviceId: 'event', hours: 3, addons: { makeup: 1 } });
  const lines = buildWhatsAppText(r, { ...contact, reach: '@anna', preferredDate: 'Sat 14 Nov, evening', notes: 'Rooftop' }, { makeup: 1 }).split('\n');
  assert.equal(lines[0], 'Hello, I would like to book.');
  assert.ok(lines.includes('Shoot: Event photography, 3 hours'));
  assert.ok(lines.includes('Makeup artist'));
  assert.ok(lines.includes('Total online: 5 200 AED'));
  assert.ok(lines.includes('Preferred date: Sat 14 Nov, evening'));
  assert.ok(lines.includes('Name: Anna'));
  assert.ok(lines.includes('Contact: @anna'));
  assert.ok(lines.includes('Notes: Rooftop'));
});

test('singular hour', () => {
  const r = quote(config, { serviceId: 'personal', hours: 1 });
  assert.match(buildWhatsAppText(r, contact), /Shoot: Personal photoshoot, 1 hour\n/);
});

test('package has no hours', () => {
  const r = quote(config, { serviceId: 'beauty' });
  const t = buildWhatsAppText(r, contact);
  assert.match(t, /Shoot: Studio Beauty Package\n/);
  assert.doesNotMatch(t, /hour/);
});

test('quantity shown when above one', () => {
  const r = quote(config, { serviceId: 'personal', hours: 2, addons: { extra_retouch: 5 } });
  assert.ok(buildWhatsAppText(r, contact, { extra_retouch: 5 }).split('\n').includes('Extra retouched photo x 5'));
});

test('quote-only line wording', () => {
  const r = quote(config, { serviceId: 'personal', hours: 2, addons: { travel: 1 } });
  const t = buildWhatsAppText(r, contact, { travel: 1 });
  assert.ok(t.split('\n').includes('travel (quote, confirmed by the photographer)'));
  const t2 = buildWhatsAppText(r, contact, { travel: 1 }, { quoteLabels: { travel: 'Travel' } });
  assert.ok(t2.split('\n').includes('Travel (quote, confirmed by the photographer)'));
});

test('empty optional fields skipped', () => {
  const r = quote(config, { serviceId: 'personal', hours: 1 });
  const t = buildWhatsAppText(r, { greeting: 'Hi', name: '  ', notes: '', preferredDate: '' });
  assert.doesNotMatch(t, /Name:|Notes:|Preferred date:/);
});

test('formatAed', () => {
  assert.equal(formatAed(5200), '5 200');
  assert.equal(formatAed(999), '999');
  assert.equal(formatAed(10200), '10 200');
});

test('parseServiceParam', () => {
  for (const id of ['personal', 'commercial', 'event', 'beauty', 'premium']) {
    assert.equal(parseServiceParam('?service=' + id, config.services), id);
  }
  for (const bad of ['', '?service=', '?service=nope', '?service=__proto__', '?service=constructor', '?x=1', '?service=event%00', null, undefined]) {
    assert.equal(parseServiceParam(bad, config.services), null, String(bad));
  }
});

test('waUrl encodes newlines and text', () => {
  assert.equal(waUrl('971557087169', 'a b\nc&d'), 'https://wa.me/971557087169?text=a%20b%0Ac%26d');
});
