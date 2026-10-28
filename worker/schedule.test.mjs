import test from 'node:test';
import assert from 'node:assert/strict';
import {getResourcesBusy,classifyBusyEvent,_resetTokenCacheForTests,GoogleError} from './google.mjs';
import {schedule} from './routes-schedule.mjs';
import {computeSlots} from './availability.mjs';
import {validateSchedule} from '../shared/schedule.mjs';
const env={GOOGLE_OAUTH_CLIENT_ID:'client',GOOGLE_OAUTH_CLIENT_SECRET:'secret_value',GOOGLE_OAUTH_REFRESH_TOKEN:'refresh_value',GOOGLE_CALENDAR_ID:'mixed'};
const stamp=t=>`2026-10-21T${t}:00+04:00`;
const event=(summary,start,end,other={})=>({summary,start:{dateTime:stamp(start)},end:{dateTime:stamp(end)},...other});
test('mixed calendar classifies studio, photographer, tentative and transparent entries',()=>{
 assert.deepEqual(classifyBusyEvent(event('Rent <> Project K','11:00','12:00',{status:'tentative'})),{studio:true,photographer:false,kind:'studio'});
 assert.deepEqual(classifyBusyEvent(event('Rent Yevhenii Klemenov <> Project K','11:00','12:00')),{studio:true,photographer:true,kind:'studio'});
 assert.deepEqual(classifyBusyEvent(event('Shoot','11:00','12:00')),{studio:false,photographer:true,kind:'photo'});
 assert.equal(classifyBusyEvent(event('Video shoot Anna','11:00','12:00')).kind,'video');
 assert.equal(classifyBusyEvent(event('Видеосъёмка','11:00','12:00')).kind,'video');
 assert.equal(classifyBusyEvent({summary:'Project K',transparency:'transparent'}),null);
 assert.equal(classifyBusyEvent({summary:'Shoot',status:'cancelled'}),null);
 assert.equal(classifyBusyEvent({summary:'Roma DAYOFF'}),null);
 assert.equal(classifyBusyEvent({summary:'Рома снимает'}),null);
 assert.deepEqual(classifyBusyEvent({summary:'Женя OFF'}),{studio:false,photographer:true,kind:'dayoff'});
});
test('OAuth refresh, paginated events, exclusive all-day end and no private fields',async()=>{
 _resetTokenCacheForTests();let pages=0;
 const busy=await getResourcesBusy(env,{from:stamp('00:00'),to:'2026-10-22T00:00:00+04:00'},async(url,init)=>{
  if(url.includes('oauth2')){const body=new URLSearchParams(init.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),env.GOOGLE_OAUTH_REFRESH_TOKEN);return Response.json({access_token:'test_access',expires_in:3600});}
  assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer test_access');pages++;
  return Response.json(pages===1?{items:[event('Private client <> Project K','11:00','12:00')],nextPageToken:'page2'}:{items:[{summary:'Away',start:{date:'2026-10-21'},end:{date:'2026-10-22'}}]});
 });
 assert.equal(pages,2);assert.deepEqual(busy.studio,[{start:stamp('11:00'),end:stamp('12:00'),kind:'studio'}]);
 assert.deepEqual(busy.photographer,[{start:stamp('00:00'),end:'2026-10-22T00:00:00+04:00',kind:'photo'}]);assert.doesNotMatch(JSON.stringify(busy),/Private|summary|access/);
});
test('OAuth failures redact client secret and refresh token',async()=>{
 _resetTokenCacheForTests();await assert.rejects(getResourcesBusy(env,{from:stamp('00:00'),to:stamp('23:00')},async()=>new Response(JSON.stringify(env),{status:400})),e=>e instanceof GoogleError&&!e.body.includes(env.GOOGLE_OAUTH_CLIENT_SECRET)&&!e.body.includes(env.GOOGLE_OAUTH_REFRESH_TOKEN));
});
const ctx=()=>({env:{},url:new URL('https://test/schedule?service=personal&hours=1&from=2026-10-21&to=2026-10-21'),now:new Date('2026-10-19T12:00:00+04:00'),deps:{log:()=>{},quote:()=>({ok:true,serviceId:'personal',hours:1}),pricing:{},config:{workHours:{from:'09:00',to:'20:00'},bufferMin:30,minNoticeHours:24,horizonDays:60,stepMin:30},computeSlots,bookings:{listActiveEntries:async()=>[]},google:{getResourcesBusy:async()=>({photographer:[{start:stamp('15:00'),end:stamp('16:00')}],studio:[{start:stamp('11:00'),end:stamp('12:00')}]})}}});
test('schedule returns separate resources, joint availability, buffer and no event details',async()=>{
 const r=await schedule(ctx());assert.equal(r.status,200);const d=validateSchedule(r.body);const slots=d.days['2026-10-21'];
 assert.equal(slots.find(s=>s.time==='10:00').available,false);assert.equal(slots.find(s=>s.time==='10:00').photographer,true);
 assert.equal(slots.find(s=>s.time==='12:30').available,true);assert.equal(slots.find(s=>s.time==='15:00').photographer,false);
});
test('schedule fails closed on calendar failure',async()=>{
 const c=ctx();c.deps.google.getResourcesBusy=async()=>{throw Error('provider down');};const r=await schedule(c);assert.equal(r.status,503);
});
test('schedule rejects malformed/reversed/excessive windows',async()=>{
 for(const range of ['from=2026-02-31&to=2026-03-01','from=2026-10-22&to=2026-10-21','from=2026-10-21&to=2026-12-01']){const c=ctx();c.url=new URL('https://test/schedule?service=personal&hours=1&'+range);assert.equal((await schedule(c)).status,400);}
});

test('owner work hours: Wednesday ends at 18, Friday closed, notice 48 hours',()=>{
 const options={busy:[],durationMin:60,workHours:{from:'10:00',to:'21:00',byWeekday:{3:{from:'10:00',to:'18:00'},5:null}},bufferMin:30,minNoticeHours:48,horizonDays:7,stepMin:30,now:'2026-10-19T17:00:00+04:00'};
 const slots=computeSlots(options);
 assert.ok(slots.includes('2026-10-21T17:00:00+04:00'));
 assert.ok(!slots.includes('2026-10-21T17:30:00+04:00'));
 assert.ok(!slots.some(s=>s.startsWith('2026-10-23')));
 assert.ok(!slots.some(s=>s.startsWith('2026-10-20')));
 assert.ok(slots.includes('2026-10-22T20:00:00+04:00'));
});

test('no buffer allows sessions adjacent to a studio booking; timeline still shows booked cells',async()=>{
 const c=ctx();c.deps.config.bufferMin=0;
 const r=await schedule(c);const d=validateSchedule(r.body);const slots=d.days['2026-10-21'];
 assert.equal(slots.find(s=>s.time==='10:00').available,true);
 assert.equal(slots.find(s=>s.time==='11:00').studio,false);
 assert.equal(slots.find(s=>s.time==='12:00').available,true);
 assert.equal(d.timeline['2026-10-21'].find(s=>s.time==='11:30').studio,false);
 assert.equal(d.timeline['2026-10-21'].find(s=>s.time==='12:00').studio,true);
});

test('timeline names the kind of every busy cell, never a title',async()=>{
 const c=ctx();c.deps.google.getResourcesBusy=async()=>({photographer:[{start:stamp('15:00'),end:stamp('16:00'),kind:'video'}],studio:[{start:stamp('11:00'),end:stamp('12:00'),kind:'studio'}]});
 c.deps.bookings.listActiveEntries=async()=>[{start:stamp('17:00'),end:stamp('18:00')}];
 const cells=(await schedule(c)).body.timeline['2026-10-21'];const at=(t)=>cells.find(x=>x.time===t);
 assert.equal(at('15:00').kind,'video');assert.equal(at('15:30').kind,'video');assert.equal(at('17:00').kind,'hold');
 assert.equal(at('11:00').kind,'studio');assert.equal(at('13:00').kind,undefined);
});

test('studio calendar blocks the studio; an unreadable one is skipped',async()=>{
 _resetTokenCacheForTests();
 const e={...env,GOOGLE_STUDIO_CALENDAR_ID:'studio@example.test'};
 const calls=[];
 const fetcher=async(url,init)=>{
  if(url.includes('oauth2'))return Response.json({access_token:'t',expires_in:3600});
  calls.push(url);
  if(url.includes(encodeURIComponent('studio@example.test')))return Response.json({items:[{summary:'Anyone',start:{dateTime:stamp('13:00')},end:{dateTime:stamp('14:00')}},{summary:'Free',transparency:'transparent',start:{dateTime:stamp('15:00')},end:{dateTime:stamp('16:00')}}]});
  return Response.json({items:[]});
 };
 const busy=await getResourcesBusy(e,{from:stamp('00:00'),to:'2026-10-22T00:00:00+04:00'},fetcher);
 assert.deepEqual(busy.studio,[{start:stamp('13:00'),end:stamp('14:00'),kind:'studio'}]);
 assert.deepEqual(busy.photographer,[]);
 _resetTokenCacheForTests();
 const failing=async(url)=>url.includes('oauth2')?Response.json({access_token:'t',expires_in:3600}):url.includes(encodeURIComponent('studio@example.test'))?new Response('{}',{status:404}):Response.json({items:[]});
 const ok=await getResourcesBusy(e,{from:stamp('00:00'),to:'2026-10-22T00:00:00+04:00'},failing);
 assert.deepEqual(ok,{photographer:[],studio:[]});
});
