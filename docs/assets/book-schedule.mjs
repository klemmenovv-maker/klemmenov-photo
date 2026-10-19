import {monthDays,validateSchedule} from './schedule.mjs';
import {dubaiToday,slotWhen} from './book-ui.mjs';
export function initSchedule({root,S,el,getQuote,getSelection,refreshRequest}) {
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
  const scope=()=>box.querySelector('[name="calendar-place"]:checked').value;
  const free=s=>s.photographer&&(scope()==='other'||s.studio);
  function clearSelection(){selected=null;chosen.textContent='';refreshRequest();}
  function renderTimes(){
    times.replaceChildren();
    if(!day||!data) return;
    times.append(el('h3','sub3',dateFmt.format(new Date(`${day}T12:00:00+04:00`))));
    const slots=data.days[day]||[];
    if(!slots.some(free)) times.append(el('p','small note','No available start times for this duration. Please choose another day.'));
    const list=el('div','resource-slots');
    const blocked=el('div','resource-slots');
    for(const s of slots){
      const b=el('button','resource-slot');b.type='button';b.disabled=!free(s);
      b.setAttribute('aria-pressed',String(selected===s.start));
      b.setAttribute('aria-label',`${s.time}–${s.end.slice(11,16)}, photographer ${s.photographer?'free':'busy'}, Project K ${s.studio?'free':'busy'}`);
      b.append(el('strong','',`${s.time}–${s.end.slice(11,16)}`));
      b.append(el('span',s.photographer?'resource-free':'resource-busy',`Photographer · ${s.photographer?'free':'busy'}`));
      b.append(el('span',s.studio?'resource-free':'resource-busy',`Project K · ${s.studio?'free':'busy'}`));
      b.addEventListener('click',()=>{selected=s.start;chosen.textContent=`Selected: ${slotWhen(s.start)} · ${scope()==='other'?'other location':'Project K'}. Request confirmation below.`;renderTimes();refreshRequest();});
      (free(s)?list:blocked).append(b);
    }
    times.append(list);
    if(blocked.children.length){const details=el('details','calendar-blocked');details.append(el('summary','small note',`Show unavailable times (${blocked.children.length})`),blocked);times.append(details);}
  }
  function render(){
    heading.textContent=fmt.format(new Date(`${month}-15T12:00:00+04:00`));
    grid.replaceChildren();
    const offset=(new Date(`${month}-01T12:00:00+04:00`).getUTCDay()+6)%7;
    for(let i=0;i<offset;i++) grid.append(el('span','calendar-gap',''));
    for(const d of monthDays(month)){
      const slots=data?.days[d]; const count=slots?.filter(free).length||0;
      const b=el('button','calendar-date');b.type='button';b.disabled=!slots?.length||d<today;
      b.classList.toggle('has-slots',count>0);b.classList.toggle('is-selected',d===day);
      b.setAttribute('aria-pressed',String(d===day));
      b.setAttribute('aria-label',`${d}, ${slots?`${count} available start times`:'not loaded'}`);
      b.append(el('strong','',String(+d.slice(8))),el('span','',slots?(count?`${count} ${count===1?'time':'times'}`:'Full'):'—'));
      b.addEventListener('click',()=>{day=d;clearSelection();render();}); grid.append(b);
    }
    box.querySelector('[data-month-prev]').disabled=month<=today.slice(0,7);
    const horizon=dubaiToday(Date.now()+S.horizonDays*86400000).slice(0,7);
    box.querySelector('[data-month-next]').disabled=month>=horizon;
    renderTimes();
  }
  async function load(){
    const id=++seq;data=null;day=null;clearSelection();render();
    const selection=getQuote()?getSelection():null;
    if(!selection){status.textContent='Choose a shoot to see available times.';return;}
    if(!S.scheduleApi){status.textContent='Online availability is being connected. Send your preferred date in WhatsApp for confirmation.';return;}
    status.textContent='Checking photographer and studio availability…';
    const dates=monthDays(month);const from=dates[0]<today?today:dates[0];
    const horizon=dubaiToday(Date.now()+S.horizonDays*86400000);
    const to=dates.at(-1)>horizon?horizon:dates.at(-1);
    const params=new URLSearchParams({service:selection.serviceId,from,to});
    if(selection.hours!==undefined) params.set('hours',selection.hours);
    try{
      const response=await fetch(`${S.scheduleApi}/schedule?${params}`,{signal:AbortSignal.timeout(15000),cache:'no-store'});
      if(!response.ok) throw Error('Unavailable');
      const result=validateSchedule(await response.json());if(id!==seq)return;
      data=result;day=Object.keys(data.days).find(d=>data.days[d].some(free))||null;
      status.textContent=`${data.durationMin/60}-hour session · Dubai time (UTC+4). Times are checked again before confirmation.`;
      render();
    }catch{if(id!==seq)return;status.textContent='Availability could not be checked. Please retry or send your preferred date in WhatsApp.';}
  }
  box.querySelector('[data-month-prev]').addEventListener('click',()=>{const d=new Date(`${month}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()-1);month=d.toISOString().slice(0,7);load();});
  box.querySelector('[data-month-next]').addEventListener('click',()=>{const d=new Date(`${month}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+1);month=d.toISOString().slice(0,7);load();});
  box.querySelector('[data-calendar-retry]').addEventListener('click',load);
  box.querySelectorAll('[name="calendar-place"]').forEach(n=>n.addEventListener('change',()=>{clearSelection();render();}));
  return {preferredDate:()=>selected?`${slotWhen(selected)} · ${scope()==='other'?'Other location (venue to be confirmed)':'Project K'}`:'',summaryExtra:()=>[],onRender(){const s=getQuote()?getSelection():null;const k=JSON.stringify(s);if(k!==key){key=k;load();}}};
}
