// Owner reminders, run by the 5-minute cron. Everything goes to the owner's Telegram.
//   1. reminders the owner set on a request, once their time has come
//   2. an open request with no chosen time after NEEDS_DETAILS_HOURS (default 24): the client did not finish
//   3. a confirmed shoot starting within the next 24 hours (once)
import { OPEN_STATUSES, listAll, saveRequest } from './requests.mjs';

const DEFAULT_DETAILS_HOURS = 24;

export async function runReminders(env, deps, now) {
  if (!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) return 0;
  const nowMs = now.getTime();
  const hours = Number(env.NEEDS_DETAILS_HOURS) > 0 ? Number(env.NEEDS_DETAILS_HOURS) : DEFAULT_DETAILS_HOURS;
  let sent = 0;
  for (const rec of await listAll(env.BOOKINGS)) {
    const due = [];
    const next = { ...rec, reminders: rec.reminders.map((r) => ({ ...r })) };
    for (const r of next.reminders) {
      if (!r.sentAt && Date.parse(r.at) <= nowMs) { due.push(deps.telegram.formatReminder(next, r.text)); r.sentAt = now.toISOString(); }
    }
    if (OPEN_STATUSES.includes(next.status) && !next.start && !next.autoRemindedAt
      && Date.parse(next.createdAt) + hours * 3600000 <= nowMs) {
      due.push(deps.telegram.formatReminder(next, `Клиент не дописал детали (время не выбрано), прошло ${hours} ч.`));
      next.autoRemindedAt = now.toISOString();
    }
    if (next.status === 'confirmed' && next.start && !next.soonRemindedAt) {
      const t = Date.parse(next.start);
      if (t > nowMs && t - nowMs <= 24 * 3600000) { due.push(deps.telegram.formatReminder(next, 'Съёмка в ближайшие 24 часа.')); next.soonRemindedAt = now.toISOString(); }
    }
    if (!due.length) continue;
    try {
      for (const msg of due) await deps.telegram.notify(env, msg);
      await saveRequest(env.BOOKINGS, next);
      sent += due.length;
    } catch (e) { deps.log({ event: 'reminder_failed', requestId: rec.id, code: e?.name ?? 'Error' }); } // retried on the next tick
  }
  return sent;
}
