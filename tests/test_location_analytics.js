const assert = require('node:assert/strict');
const {test} = require('node:test');
const A = require('../static/location-analytics.js');

// Missing days break a trend instead of appearing to have zero travel.
assert.deepEqual(A.trendSeries([
  {date:'2026-09-10',summary:{distance_m:2000}},
  {date:'2026-09-08',summary:{distance_m:0}},
  {date:'2026-09-11',summary:{distance_m:3000}},
], 'distance_m'), [
  {date:'2026-09-08',value:0}, null,
  {date:'2026-09-10',value:2000}, {date:'2026-09-11',value:3000},
]);
assert.deepEqual(A.trendSeries([], 'distance_m'), []);
assert.equal(A.duration(0), '0 min');
assert.equal(A.duration(3660), '1 hr 1 min');
assert.equal(A.duration(7199), '2 hr');
assert.equal(A.duration(null), '—');
assert.equal(A.distance(12500), '12.5 km');
assert.equal(A.distance(null), '—');
assert.equal(A.speed(null), '—');
assert.equal(A.speed(5), '18.0 km/h');
assert.deepEqual(A.trendSeries([{date:'2026-09-08',summary:{sample_count:0,distance_m:0}}], 'distance_m'), [{date:'2026-09-08',value:null}]);
console.log('location analytics contracts passed');

test('web location analytics leads with range patterns and loads a daily map only on request', async () => {
  class Element {
    constructor(tag,cls,text){this.tagName=tag;this.className=cls||'';this.textContent=text||'';this.children=[];this.attributes={};this.dataset={};this.style={};this.events={};this.isConnected=true;this.classList={add(){}};}
    append(...children){this.children.push(...children);children.forEach(child=>child.parentElement=this);}
    replaceChildren(...children){this.children=[];this.append(...children);}
    setAttribute(name,value){this.attributes[name]=String(value);}
    addEventListener(name,handler){this.events[name]=handler;}
    dispatchEvent(event){this.dispatched=(this.dispatched||0)+1;this.events[event.type]?.(event);}
    scrollIntoView(){this.scrolled=true;}
    get value(){return this._value??(this.tagName==='select'?this.children[0]?.value:'');}
    set value(value){this._value=value;}
  }
  const all=node=>[node,...node.children.flatMap(all)];
  const globals={document:global.document,PupMedia:global.PupMedia,PupLocationDayView:global.PupLocationDayView,TodoPupNative:global.TodoPupNative,enhanceSelect:global.enhanceSelect};
  const requests=[],mounts=[],destroyed=[];
  const visit=date=>({place_id:'home',name:'Home',arrival:date+'T09:00:00+08:00',departure_after:date+'T10:00:00+08:00',duration_seconds:3600});
  const days=['2026-09-07','2026-09-08'].map(date=>({date,summary:{sample_count:100,distance_m:2000,moving_seconds:1200,recorded_seconds:4800,stay_count:1},visits:[visit(date)]}));
  const data={days,summary:{days_tracked:2,distance_m:4000,moving_seconds:2400,recorded_seconds:9600,stationary_seconds:7200,stay_count:2,avg_moving_speed_mps:2,max_speed_mps:5,transport:[{mode:'stationary',duration_seconds:7200,distance_m:0},{mode:'walking',duration_seconds:2400,distance_m:4000}]},place_totals:[{place_id:'home',name:'Home',duration_seconds:7200,visits:2}],hourly:[{hour:10,moving_seconds:2400}],dow:[{day:0,distance_m:2000,days_tracked:1},{day:1,distance_m:2000,days_tracked:1}]};
  global.document={createElementNS:(_ns,tag)=>new Element(tag)};
  global.PupMedia={element:(...args)=>new Element(...args),button:(label,action,cls)=>Object.assign(new Element('button',cls,label),{action}),refresh:async()=>{},request:async path=>{requests.push(path);return data;}};
  global.PupLocationDayView={mount:(host,date)=>{mounts.push(date);host.append(new Element('canvas'));return {destroy:()=>destroyed.push(date)};}};
  global.TodoPupNative=undefined;global.enhanceSelect=picker=>picker.enhanced=true;
  const host=new Element('div');
  try {
    await A.render(host,{from:'2026-09-01',to:'2026-09-09'});
    assert.deepEqual(requests,['tracking?summary=1&from=2026-09-01&to=2026-09-09']);
    assert.deepEqual(host.children.filter(el=>el.tagName==='section').map(el=>el.children.find(child=>child.tagName==='h3')?.textContent),['Where you spend time','Travel over time','How you get around','Movement by hour','Movement by weekday','Recording coverage','Explore a day']);
    assert.equal(host.children.find(el=>el.className==='stat-cards location-stat-cards').children.length,4);
    assert.ok(!all(host).some(el=>el.textContent==='All recorded history'),'the dashboard must honor the web Analytics date controls');
    assert.ok(!all(host).some(el=>el.textContent==='Stationary'),'stationary time is not a form of transport');
    assert.deepEqual(mounts,[],'cross-day analytics should not fetch and draw a daily map immediately');
    const picker=all(host).find(el=>el.tagName==='select');assert.equal(picker.enhanced,true);
    const open=all(host).find(el=>el.tagName==='button'&&el.textContent==='Open daily map');
    open.action();assert.equal(open.attributes['aria-expanded'],'true');assert.deepEqual(mounts,['2026-09-08']);
    picker.value='2026-09-07';picker.dispatchEvent({type:'change'});assert.deepEqual(mounts,['2026-09-08','2026-09-07']);assert.deepEqual(destroyed,['2026-09-08']);
    open.action();assert.equal(open.attributes['aria-expanded'],'false');assert.deepEqual(destroyed,['2026-09-08','2026-09-07']);
    all(host).find(el=>el.tagName==='button'&&el.textContent==='Home').action();
    const changes=picker.dispatched||0;
    all(host).find(el=>el.tagName==='button'&&el.textContent.startsWith('2026-09-08 ·')).action();
    assert.equal(open.attributes['aria-expanded'],'true');assert.equal(picker.value,'2026-09-08');assert.equal(mounts.at(-1),'2026-09-08');
    assert.equal(picker.dispatched,changes+1,'programmatic visit navigation must refresh the themed dropdown label');
    host._mediaCleanup();assert.equal(destroyed.at(-1),'2026-09-08');
  } finally {host._mediaCleanup?.();Object.assign(global,globals);}
});
