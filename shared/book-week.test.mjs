import test from 'node:test';
import assert from 'node:assert/strict';
import { cellState, weekStartOf } from './book-week.mjs';
import { schedule } from '../tests/e2e/fake-schedule.mjs';

test('weekStartOf returns the Monday of the week', () => {
  assert.equal(weekStartOf('2026-10-26'), '2026-10-26');
  assert.equal(weekStartOf('2026-11-01'), '2026-10-26');
  assert.equal(weekStartOf('2026-11-02'), '2026-11-02');
});

test('cellState: free, busy and closed hours', () => {
  const slot = (time, photographer) => ({ time, start: `2026-10-27T${time}:00+04:00`, end: `2026-10-27T${String(+time.slice(0, 2) + 1).padStart(2, '0')}:${time.slice(3)}:00+04:00`, photographer, studio: true, available: photographer });
  const cell = (time, photographerClosed, photographer) => ({ time, photographerClosed, photographer, studio: true });
  const data = {
    days: { '2026-10-27': [slot('10:00', true), slot('11:00', false)] },
    timeline: { '2026-10-27': [cell('10:00', false, true), cell('10:30', false, true), cell('11:00', false, false), cell('11:30', false, false), cell('20:00', true, false), cell('20:30', true, false)] },
  };
  assert.deepEqual(cellState(data, '2026-10-27', 10), { kind: 'free', start: '2026-10-27T10:00:00+04:00', end: '2026-10-27T11:00:00+04:00' });
  assert.equal(cellState(data, '2026-10-27', 11).kind, 'busy');
  assert.equal(cellState(data, '2026-10-27', 20).kind, 'closed');
  assert.equal(cellState(data, '2026-10-28', 10).kind, 'closed');
  assert.equal(cellState(null, '2026-10-27', 10).kind, 'wait');
});

test('fake schedule has the shape the page validates', async () => {
  const { validateSchedule } = await import('./schedule.mjs');
  const q = new URLSearchParams({ service: 'personal', from: '2026-10-26', to: '2026-10-28', hours: '2' });
  const data = validateSchedule(schedule(q));
  assert.equal(data.durationMin, 120);
  assert.ok(Object.keys(data.days).length === 3);
});
