import {monthDays,validateSchedule} from './schedule.mjs';
import {dubaiToday,slotWhen} from './book-ui.mjs';
export function initSchedule({root,S,el,getQuote,getSelection,getDurationBounds,setHours,refreshRequest}) {
  const box=root.querySelector('[data-schedule]');
  const status=box.querySelector('[data-calendar-status]');
  const grid=box.querySelector('[data-calendar-grid]');
  const times=box.querySelector('[data-resource-times]');
  const heading=box.querySelector('[data-month-title]');
  const chosen=box.querySelector('[data-calendar-chosen]');
  const today=dubaiToday(Date.now());
  let month=today.slice(0,7), data=null, day=null, selected=null, key='',seq=0;
  const fmt=new Intl.DateTimeFormat('en',{month:'long',year:'numeric',timeZone:'Asia/Dubai'});
  const dateFmt=new Intl.DateTimeFormat('en',{weekday:'long',day:'numeric',month:'long',timeZone:'Asia/Dubai'});
  const free=s=>s.photographer;
  function clearSelection(){selected=null;chosen.textContent='';refreshRequest();}
  function choose(start){
    selected=start;
    const slot=data.days[day].find(s=>s.start===start);
    chosen.textContent=`Selected: ${slotWhen(start)}–${slot.end.slice(11,16)} · ${data.durationMin/60} hours. Request confirmation below.`;
    renderTimes();refreshRequest();
  }
  function updateDuration(){
    const bounds=getDurationBounds();
    box.querySelector('[data-duration-label]').textContent=bounds?'Choose how many hours you need':getQuote()?`Fixed package · ${data?data.durationMin/60:'—'} hours`:'Choose a shoot first';
    box.querySelector('.duration-stepper').hidden=!bounds;
    if(bounds){box.querySelector('[data-duration-value]').textContent=`${bounds.hours} ${bounds.hours===1?'hour':'hours'}`;box.querySelector('[data-duration-less]').setAttribute('aria-disabled',String(bounds.hours<=bounds.min));box.querySelector('[data-duration-more]').setAttribute('aria-disabled',String(bounds.hours>=bounds.max));}
  }
  box.querySelector('[data-duration-less]').addEventListener('click',()=>{const b=getDurationBounds();if(b&&b.hours>b.min)setHours(b.hours-1);});
  box.querySelector('[data-duration-more]').addEventListener('click',()=>{const b=getDurationBounds();if(b&&b.hours<b.max)setHours(b.hours+1);});
  function renderTimes(){
    times.replaceChildren();
    if(!day||!data) return;
    times.append(el('h3','sub3',dateFmt.format(new Date(`${day}T12:00:00+04:00`))));
    const slots=data.days[day]||[];
    const timeline=data.timeline?.[day];
    if(timeline){
      const board=el('div','day-timeline');
      board.append(el('p','small note','Day at a glance · Dubai time'));
      const legend=el('div','timeline-legend');legend.append(el('span','legend-free','Free'),el('span','legend-busy','Booked'),el('span','legend-selected','Your session'));board.append(legend);
      const tracks=el('div','timeline-scroll');
      const axis=el('div','timeline-axis');axis.append(el('span','track-label','Time'));
      for(let h=10;h<=20;h++)axis.append(el('span','',String(h).padStart(2,'0')+':00'));tracks.append(axis);
      for(const [resource,label] of [['photographer','Photographer']]){
        const row=el('div','timeline-track');row.append(el('span','track-label',label));
        for(const cell of timeline){
          const closed=resource==='photographer'&&cell.photographerClosed;
          const b=el('button',`timeline-cell ${closed?'is-closed':cell[resource]?'is-free':'is-busy'}`);b.type='button';
          b.title=`${cell.time}–${cell.end.slice(11,16)} · ${label} ${closed?'outside working hours':cell[resource]?'free':'booked'}`;b.setAttribute('aria-label',b.title);
          if(selected&&Date.parse(cell.start)>=Date.parse(selected)&&Date.parse(cell.start)<Date.parse(selected)+data.durationMin*60000)b.classList.add('is-session');
          const candidate=slots.find(s=>s.start===cell.start&&free(s));
          b.disabled=!candidate;
          b.addEventListener('click',()=>choose(candidate.start));row.append(b);
        }
        tracks.append(row);
      }
      board.append(tracks,el('p','small note','Choose a start time below. Your full session must fit inside the free time.'));times.append(board);
    }
    times.append(el('p','available-heading',`Available start times · ${data.durationMin/60} ${data.durationMin===60?'hour':'hours'}`));
    if(!slots.some(free)) times.append(el('p','small note','No available start times for this duration. Please choose another day.'));
    const list=el('div','resource-slots');
    const blocked=el('div','resource-slots');
    for(const s of slots){
      const b=el('button','resource-slot');b.type='button';b.disabled=!free(s);
      b.setAttribute('aria-pressed',String(selected===s.start));
      b.setAttribute('aria-label',`${s.time}–${s.end.slice(11,16)}, photographer ${s.photographer?'free':'busy'}`);
      b.append(el('strong','',`${s.time}–${s.end.slice(11,16)}`));
      b.append(el('span',s.photographer?'resource-free':'resource-busy',`Photographer · ${s.photographer?'free':'busy'}`));
      b.addEventListener('click',()=>choose(s.start));
      (free(s)?list:blocked).append(b);
    }
    times.append(list);
    if(blocked.children.length){const details=el('details','calendar-blocked');details.append(el('summary','small note',`Show unavailable times (${blocked.children.length})`),blocked);times.append(details);}
  }
  function render(){
    updateDuration();
    heading.textContent=fmt.format(new Date(`${month}-15T12:00:00+04:00`));
    grid.replaceChildren();
    const offset=(new Date(`${month}-01T12:00:00+04:00`).getUTCDay()+6)%7;
    for(let i=0;i<offset;i++) grid.append(el('span','calendar-gap',''));
    for(const d of monthDays(month)){
      const slots=data?.days[d]; const count=slots?.filter(free).length||0;
      const loaded=Object.hasOwn(data?.days||{},d);
      const closed=data?.timeline?.[d]?.every(cell=>cell.photographerClosed);
      const b=el('button','calendar-date');b.type='button';b.disabled=!loaded||d<today;
      b.classList.toggle('has-slots',count>0);b.classList.toggle('is-selected',d===day);
      b.setAttribute('aria-pressed',String(d===day));
      b.setAttribute('aria-label',`${d}, ${slots?`${count} available start times`:'not loaded'}`);
      b.append(el('strong','',String(+d.slice(8))),el('span','',slots?(count?`${count} ${count===1?'time':'times'}`:closed?'Closed':'No times'):'—'));
      b.addEventListener('click',()=>{day=d;clearSelection();render();}); grid.append(b);
    }
    box.querySelector('[data-month-prev]').disabled=month<=today.slice(0,7);
    const horizon=dubaiToday(Date.now()+S.horizonDays*86400000).slice(0,7);
    box.querySelector('[data-month-next]').disabled=month>=horizon;
    renderTimes();
  }
  async function load(){
    const id=++seq;const previousDay=day,previousStart=selected;data=null;day=null;clearSelection();render();
    const selection=getQuote()?getSelection():null;
    if(!selection){status.textContent='Choose a shoot to see available times.';return;}
    if(!S.scheduleApi){status.textContent='Online availability is being connected. Send your preferred date in WhatsApp for confirmation.';return;}
    status.textContent='Checking available times…';
    const dates=monthDays(month);const from=dates[0]<today?today:dates[0];
    const horizon=dubaiToday(Date.now()+S.horizonDays*86400000);
    const to=dates.at(-1)>horizon?horizon:dates.at(-1);
    const params=new URLSearchParams({service:selection.serviceId,from,to});
    if(selection.hours!==undefined) params.set('hours',selection.hours);
    try{
      const response=await fetch(`${S.scheduleApi}/schedule?${params}`,{signal:AbortSignal.timeout(15000),cache:'no-store'});
      if(!response.ok) throw Error('Unavailable');
      const result=validateSchedule(await response.json());if(id!==seq)return;
      data=result;day=previousDay?.startsWith(month)&&data.days[previousDay]?previousDay:Object.keys(data.days).find(d=>data.days[d].some(free))||null;
      status.textContent=`${data.durationMin/60}-hour session · Dubai time (UTC+4). Confirm your selected time in WhatsApp.`;
      render();
      if(previousStart&&data.days[day]?.some(s=>s.start===previousStart&&free(s)))choose(previousStart);
      else if(previousStart)chosen.textContent='That start time does not fit this duration. Please choose another time.';
    }catch{if(id!==seq)return;status.textContent='Availability could not be checked. Please retry or send your preferred date in WhatsApp.';}
  }
  box.querySelector('[data-month-prev]').addEventListener('click',()=>{const d=new Date(`${month}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,7);load();});
  box.querySelector('[data-month-next]').addEventListener('click',()=>{const d=new Date(`${month}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,7);load();});
  box.querySelector('[data-calendar-retry]').addEventListener('click',load);
  return {preferredDate:()=>selected?`${slotWhen(selected)}–${data.days[day].find(s=>s.start===selected).end.slice(11,16)}`:'',summaryExtra:()=>[],onRender(){updateDuration();const s=getQuote()?getSelection():null;const k=JSON.stringify(s);if(k!==key){key=k;load();}}};
}
