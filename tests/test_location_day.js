const assert = require('node:assert/strict');
const L = require('../static/location-day.js');
function point(minute, lon=121.5, extra={}) {
  return {id:String(minute),at:`2026-09-08T12:${String(minute).padStart(2,'0')}:00+08:00`,lat:31.2,lon,accuracy_m:10,session:'one',...extra};
}
const home={id:'home',name:'Home',lat:31.2,lon:121.5,radius_m:100};
const rows=[point(0),point(5,121.50002),point(10),point(11,121.5008,{speed_mps:1.2}),point(12,121.5038,{speed_mps:4.8}),point(13,121.5138,{speed_mps:15}),point(14,121.52,{accuracy_m:500}),point(15,121.521),point(16,121.522,{session:'two'}),point(35,121.53)];
const day=L.analyze('2026-09-08',rows,[home]);
const phoneRows=[0,5,10,15].map(n=>point(n,121.5,{source_device:'phone'}));
const laptopRows=phoneRows.map(p=>({...p,id:'laptop-'+p.id,source_device:'laptop',lon:121.55}));
assert.equal(L.analyze('2026-09-08',[...phoneRows,...laptopRows]).summary.recorded_seconds,900);
assert.equal(L.analyze('2026-09-08',[...phoneRows,...laptopRows],[],[],'laptop').samples[0].lon,121.55);
assert.equal(L.analyze('2026-09-08',[...phoneRows,...laptopRows]).source_device,'phone');
assert.equal(L.analyze('2026-09-08',laptopRows).source_device,'laptop');
assert.equal(L.sourceDevice(point(0)),'phone');
assert.equal(L.analyze('2026-09-08',[point(0,121.5,{mode:'precise'})],[]).samples[0].mode,'precise');
assert.equal(day.summary.recorded_seconds,780);
assert.equal(day.summary.stop_seconds,600);
assert.equal(day.visits.length,1);
assert.deepEqual(day.segments.map(s=>s.mode),['stationary','stationary','walking','cycling','vehicle']);
assert.equal(day.routes.length,4);
assert.equal(L.positionAt(day,731.5).lon,121.5023);
assert.equal(L.positionAt(day,734),null);
assert.equal(L.positionAt(day,735.5),null);
assert.equal(L.positionAt(day,745),null);
assert.equal(L.positionAt(day,NaN),null);
// A shared endpoint belongs to the earlier interval, preserving its arrival
// speed/mode instead of prematurely selecting the next interval's movement.
assert.equal(L.atTime(day,'2026-09-08T12:10:00+08:00').transport,'stationary');
assert.equal(L.atTime(day,'2026-09-08T12:11:00+08:00').speed_mps,1.2);
assert.equal(L.atTime(day,'2026-09-08T12:12:00+08:00').transport,'cycling');
assert.equal(L.atTime(day,'2026-09-08T12:13:00+08:00').transport,'vehicle');
assert.equal(L.atTime(day,'2026-09-08T12:15:00+08:00').estimated,false);
assert.equal(L.atTime(day,'2026-09-08T12:15:01+08:00'),null);
assert.equal(L.atTime(day,'2026-09-08T11:59:59+08:00'),null);
const exact=L.analyze('1970-01-01',[
  {...point(0),at:'1970-01-01T00:00:00.000Z'},
  {...point(1),at:'1970-01-01T00:00:00.001Z',session:'two',lon:122},
],[]);
assert.equal(L.atTime(exact,1).lon,122);
assert.equal(L.analyze('2026-09-08',[],[]).summary.avg_moving_speed_mps,null);
assert.equal(L.photoLocation({id:'route',captured_at:'2026-09-08T12:11:30'},day).source,'route');
assert.equal(L.photoLocation({id:'gps',location:{lat:1,lon:2}},day).source,'gps');
assert.equal(L.photoLocation({id:'gap',captured_at:'2026-09-08T12:14:00'},day),null);
assert.equal(L.photoLocation({id:'bad',location:{lat:91,lon:2}},day),null);
assert.equal(L.photoLocation({id:'missing'},day),null);
assert.equal(L.analyze('2026-09-08',[point(0),point(1,-122),point(2)],[]).segments.length,0);
const jitter=L.analyze('2026-09-08',Array.from({length:12},(_,i)=>point(i,121.5+(i%2)*.00003)),[]);
assert.equal(jitter.summary.distance_m,0);
assert.equal(jitter.summary.moving_seconds,0);
assert.equal(jitter.visits[0].duration_seconds,660);
const next=L.analyze('2026-09-09',rows.map(r=>({...r,id:r.id+'next',at:r.at.replace('2026-09-08','2026-09-09')})),[home]);
const compact=d=>({date:d.date,summary:d.summary,visits:d.visits,hourly:d.hourly});
const aggregate=L.aggregate([compact(day),compact(next)]);
assert.equal(aggregate.summary.days_tracked,2);
assert.equal(aggregate.place_totals[0].duration_seconds,1200);
assert.equal(aggregate.hourly[12].recorded_seconds,1560);
assert.equal(aggregate.dow.reduce((s,r)=>s+r.recorded_seconds,0),1560);
assert.deepEqual(L.aggregate([]).days,[]);
// A repeated clock hour has two possible physical locations, so naive EXIF
// and the hour slider must not silently select one side of a timezone change.
const repeated=L.analyze('2026-11-01',[
  {...point(0),at:'2026-11-01T01:00:00-04:00'},
  {...point(5),at:'2026-11-01T01:05:00-04:00'},
  {...point(10),at:'2026-11-01T01:00:00-05:00',session:'two'},
  {...point(15),at:'2026-11-01T01:05:00-05:00',session:'two'},
],[]);
assert.equal(L.positionAt(repeated,62),null);
assert.equal(L.photoLocation({id:'ambiguous',captured_at:'2026-11-01T01:02:00'},repeated),null);
assert.ok(L.photoLocation({id:'offset',captured_at:'2026-11-01T01:02:00-04:00'},repeated));
// After opening a full five-second tracking day, scrubbing near its end must
// not parse tens of thousands of historical timestamps on every input event.
const full=L.analyze('2026-09-08',Array.from({length:17000},(_,i)=>({...point(0),id:String(i),at:new Date(Date.UTC(2026,8,8)+i*5000).toISOString()})),[]);
const payloadKeys=Object.keys(full);
assert.ok(L.positionAt(full,1390));
const originalParse=Date.parse;let parseCalls=0;
try {
  Date.parse=function(value){parseCalls++;return originalParse(value);};
  for(let i=0;i<20;i++)assert.ok(L.positionAt(full,1390+i/10));
} finally {Date.parse=originalParse;}
assert.ok(parseCalls<=100,'Repeated slider input should reuse parsed tracking times, got '+parseCalls+' date parses');
assert.deepEqual(Object.keys(full),payloadKeys);
console.log('location day contracts passed');
