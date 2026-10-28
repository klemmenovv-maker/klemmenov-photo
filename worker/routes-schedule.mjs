// Read-only schedule. No titles, contacts or event identifiers leave the server.
import { fail, reply } from './http.mjs';
import { durationFor, dubaiDay, dubaiIso } from './routes-availability.mjs';
const DAY = 86400000;
function validDay(s) {
  const ms = Date.parse(`${s}T00:00:00+04:00`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && Number.isFinite(ms) && dubaiDay(ms) === s;
}
export async function schedule(c) {
  const {url,env,deps,now} = c;
  const p = url.searchParams;
  const hours = p.has('hours') ? Number(p.get('hours')) : undefined;
  const q = deps.quote(deps.pricing, {serviceId:p.get('service'), hours});
  if (!q.ok) return fail(400,q.error);
  const from = p.get('from'), to = p.get('to');
  if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to)-Date.parse(from))/DAY > 30 || to > dubaiDay(now.getTime()+deps.config.horizonDays*DAY)) return fail(400,'bad_range');
  const durationMin = durationFor(deps.config,q);
  const cfg = deps.config;
  // Extend by the buffer so events immediately outside the window still block edge slots.
  const start = Date.parse(`${from}T00:00:00+04:00`);
  const end = Date.parse(`${to}T00:00:00+04:00`) + DAY;
  let busy,held;
  try {
    [busy,held] = await Promise.all([
      deps.google.getResourcesBusy(env,{from:dubaiIso(start-cfg.bufferMin*60000),to:dubaiIso(end+cfg.bufferMin*60000)},deps.fetch),
      deps.bookings.listActiveEntries(env.BOOKINGS,from,to,now),
    ]);
  } catch (e) { deps.log({event:'schedule_failed',code:e?.name??'Error',status:e?.status??0,reason:String(e?.message??'').slice(0,160)}); return fail(503,'calendar_unavailable'); }
  const options = {durationMin, workHours:cfg.workHours,bufferMin:cfg.bufferMin,minNoticeHours:cfg.minNoticeHours,horizonDays:cfg.horizonDays,stepMin:cfg.stepMin,now:now.toISOString()};
  const all = deps.computeSlots({...options,busy:[],held:[]});
  const photographer = new Set(deps.computeSlots({...options,busy:busy.photographer,held}));
  const studio = new Set(deps.computeSlots({...options,busy:busy.studio,held}));
  const days = {};
  for(let ms=start;ms<end;ms+=DAY) days[dubaiDay(ms)]=[];
  for(const s of all) {
    const d=s.slice(0,10); if(!days[d]) continue;
    days[d].push({start:s,end:dubaiIso(Date.parse(s)+durationMin*60000),time:s.slice(11,16),photographer:photographer.has(s),studio:studio.has(s),available:photographer.has(s)&&studio.has(s)});
  }
  const timeline = {};
  const overlaps=(ranges,start,end)=>ranges.some(r=>start<Date.parse(r.end)&&end>Date.parse(r.start));
  for(let ms=start;ms<end;ms+=DAY){
    const day=dubaiDay(ms);timeline[day]=[];
    for(let minute=10*60;minute<21*60;minute+=30){
      const s=ms+minute*60000,e=s+30*60000;
      const weekday=new Date(ms+4*3600000).getUTCDay();
      const hours=Object.hasOwn(cfg.workHours.byWeekday||{},weekday)?cfg.workHours.byWeekday[weekday]:cfg.workHours;
      const clock=v=>Number(v.slice(0,2))*60+Number(v.slice(3));
      const photographerClosed=!hours||minute<clock(hours.from)||minute+30>clock(hours.to);
      const hit=(ranges)=>ranges.find(r=>s<Date.parse(r.end)&&e>Date.parse(r.start));
      const cell={start:dubaiIso(s),end:dubaiIso(e),time:dubaiIso(s).slice(11,16),photographerClosed,photographer:!photographerClosed&&!overlaps([...busy.photographer,...held],s,e),studio:!overlaps([...busy.studio,...held],s,e)};
      // Only a category (photo, video, dayoff, studio, hold) is published, never an event title.
      const ph=hit(busy.photographer), k=ph?(ph.kind??'photo'):hit(held)?'hold':hit(busy.studio)?.kind;
      if(k&&!photographerClosed) cell.kind=k;
      timeline[day].push(cell);
    }
  }
  return reply(200,{timeline,timezone:'Asia/Dubai',durationMin,days,updatedAt:now.toISOString(),confirmation:'request',bufferMin:cfg.bufferMin});
}
