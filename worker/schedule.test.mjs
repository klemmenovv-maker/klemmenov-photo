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
 assert.deepEqual(classifyBusyEvent(event('Rent <> Project K','11:00','12:00',{status:'tentative'})),{studio:true,photographer:false});
 assert.deepEqual(classifyBusyEvent(event('Rent Yevhenii Klemenov <> Project K','11:00','12:00')),{studio:true,photographer:true});
 assert.deepEqual(classifyBusyEvent(event('Shoot','11:00','12:00')),{studio:false,photographer:true});
 assert.equal(classifyBusyEvent({summary:'Project K',transparency:'transparent'}),null);
 assert.equal(classifyBusyEvent({summary:'Shoot',status:'cancelled'}),null);
 assert.equal(classifyBusyEvent({summary:'Roma DAYOFF'}),null);
 assert.equal(classifyBusyEvent({summary:'Рома снимает'}),null);
 assert.deepEqual(classifyBusyEvent({summary:'Женя OFF'}),{studio:false,photographer:true});
});
test('OAuth refresh, paginated events, exclusive all-day end and no private fields',async()=>{
 _resetTokenCacheForTests();let pages=0;
 const busy=await getResourcesBusy(env,{from:stamp('00:00'),to:'2026-10-22T00:00:00+04:00'},async(url,init)=>{
  if(url.includes('oauth2')){const body=new URLSearchParams(init.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),env.GOOGLE_OAUTH_REFRESH_TOKEN);return Response.json({access_token:'test_access',expires_in:3600});}
  assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer test_access');pages++;
  return Response.json(pages===1?{items:[event('Private client <> Project K','11:00','12:00')],nextPageToken:'page2'}:{items:[{summary:'Away',start:{date:'2026-10-21'},end:{date:'2026-10-22'}}]});
 });
 assert.equal(pages,2);assert.deepEqual(busy.studio,[{start:stamp('11:00'),end:stamp('12:00')}]);
 assert.deepEqual(busy.photographer,[{start:stamp('00:00'),end:'2026-10-22T00:00:00+04:00'}]);assert.doesNotMatch(JSON.stringify(busy),/Private|summary|access/);
});
test('OAuth failures redact client secret and refresh token',async()=>{
 _resetTokenCacheForTests();await assert.rejects(getResourcesBusy(env,{from:stamp('00:00'),to:stamp('23:00')},async()=>new Response(JSON.stringify(env),{status:400})),e=>e instanceof GoogleError&&!e.body.includes(env.GOOGLE_OAUTH_CLIENT_SECRET)&&!e.body.includes(env.GOOGLE_OAUTH_REFRESH_TOKEN));
});
const ctx=()=>({env:{},url:new URL('https://test/schedule?service=personal&hours=1&from=2026-10-21&to=2026-10-21'),now:new Date('2026-10-19T12:00:00+04:00'),deps:{quote:()=>({ok:true,serviceId:'personal',hours:1}),pricing:{},config:{workHours:{from:'09:00',to:'20:00'},bufferMin:30,minNoticeHours:24,horizonDays:60,stepMin:30},computeSlots,bookings:{listActiveEntries:async()=>[]},google:{getResourcesBusy:async()=>({photographer:[{start:stamp('15:00'),end:stamp('16:00')}],studio:[{start:stamp('11:00'),end:stamp('12:00')}]})}}});
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
