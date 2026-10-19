export function monthDays(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match || +match[2] < 1 || +match[2] > 12) throw new RangeError('Invalid month');
  const count = new Date(Date.UTC(+match[1], +match[2], 0)).getUTCDate();
  return Array.from({length:count},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
}
export function validateSchedule(data) {
  if (!data || data.timezone !== 'Asia/Dubai' || !Number.isInteger(data.durationMin) || data.durationMin < 1 || !data.days || typeof data.days !== 'object' || Array.isArray(data.days)) throw Error('Invalid schedule');
  for (const [day,slots] of Object.entries(data.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(slots)) throw Error('Invalid schedule');
    for (const slot of slots) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) || slot.start !== `${day}T${slot.time}:00+04:00` || !Number.isFinite(Date.parse(slot.end)) || Date.parse(slot.end)-Date.parse(slot.start)!==data.durationMin*60000 || !['photographer','studio','available'].every(k=>typeof slot[k]==='boolean') || slot.available !== (slot.photographer&&slot.studio)) throw Error('Invalid slot');
    }
  }
  return data;
}
