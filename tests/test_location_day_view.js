const assert = require('node:assert/strict');
const {test} = require('node:test');
const V = require('../static/location-day-view.js');

test('day photo pins use exactly the entry photo references and preserve edit previews', () => {
  const state={assets:{one:{id:'one',captured_at:'2026-09-09T10:00:00',location:{lat:31,lon:121}},two:{id:'two',location:{lat:32,lon:122}}}};
  const blocks=[{type:'text',text:'Hello'},{type:'photo',asset_id:'one',edited_asset_id:'edit',caption:'Lunch'},{type:'photo',asset_id:'one'},{type:'photo',asset_id:'missing'}];
  const photos=V.photoAssets(blocks,state);
  assert.equal(photos.length,1);
  assert.equal(photos[0].asset_id,'one');
  assert.equal(photos[0].preview_asset_id,'edit');
  assert.equal(photos[0].caption,'Lunch');
  assert.deepEqual(state.assets.one,{id:'one',captured_at:'2026-09-09T10:00:00',location:{lat:31,lon:121}});
});
test('clock and duration readouts handle midnight and short observations',()=>{
  assert.equal(V.clockLabel(0),'00:00');assert.equal(V.clockLabel(1440),'24:00');assert.equal(V.clockLabel(615),'10:15');assert.equal(V.clockLabel(615.9),'10:15');
  assert.equal(V.minuteAt('2026-09-09T18:45:30+08:00'),1125.5);
  assert.equal(V.duration(90),'2 min');assert.equal(V.duration(5400),'1 hr 30 min');assert.equal(V.duration(0),'0 min');
});
test('daily photo pins include linked-only photos and prefer full photo display details',()=>{
  const state={assets:{one:{id:'one',location:{lat:31,lon:121}},two:{id:'two',location:{lat:32,lon:122}}}};
  const blocks=[{id:'text',type:'text',text:'A memory',links:[{start:0,end:8,photos:['one','two','one']}]},
    {id:'photo',type:'photo',asset_id:'one',edited_asset_id:'edit',caption:'Lunch'}];
  const photos=V.photoAssets(blocks,state);
  assert.deepEqual(photos.map(photo=>photo.asset_id),['one','two']);
  assert.equal(photos[0].preview_asset_id,'edit');assert.equal(photos[0].caption,'Lunch');
});
test('fit extent covers route and photo pins without invalid or empty coordinates',()=>{
  assert.equal(V.dayBounds([]),null);
  assert.deepEqual(V.dayBounds([{lat:31,lon:121},{lat:32,lon:122},{lat:NaN,lon:120}]),[120.98,30.98,122.02,32.02]);
  const bounds=V.dayBounds([{lat:31,lon:121}]);assert.ok(bounds[0]<121&&bounds[2]>121&&bounds[1]<31&&bounds[3]>31);
});

test('day replay clears gaps, opens a stop and cleans up without saving journal input', async()=>{
  class Element {
    constructor(tag,cls,text){this.tagName=tag;this.className=cls||'';this.textContent=text||'';this.children=[];this.attributes={};this.style={};this.classList={add(){},toggle(){}};}
    append(...children){this.children.push(...children);children.forEach(child=>{child.parentElement=this;});}
    replaceChildren(...children){this.children=[];this.append(...children);}
    insertBefore(child,before){this.children.splice(this.children.indexOf(before),0,child);child.parentElement=this;}
    setAttribute(name,value){this.attributes[name]=value;}
    focus(){global.document.activeElement=this;}
    get lastChild(){return this.children.at(-1);}
  }
  const listeners=new Map(),listenerOptions=new Map(),removed=[],requests=[],mapCalls=[];
  const globals={document:global.document,addEventListener:global.addEventListener,removeEventListener:global.removeEventListener,PupMedia:global.PupMedia,PupLocationDay:global.PupLocationDay,TodoPupMap:global.TodoPupMap};
  global.document={addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(name){removed.push(name);}};
  global.addEventListener=(name,handler,options)=>{listeners.set(name,handler);listenerOptions.set(name,options);};global.removeEventListener=name=>removed.push(name);
  const visit={id:'cafe',name:'Cafe',lat:31,lon:121,start:'2026-09-09T10:00:00+08:00',end:'2026-09-09T10:30:00+08:00',duration_seconds:1800};
  const day={date:'2026-09-09',samples:[{lat:31,lon:121}],routes:[],visits:[visit],photos:[],segments:[],summary:{last_at:visit.end,stay_count:1,recorded_seconds:1800,avg_moving_speed_mps:1,max_speed_mps:2,transport:[{mode:'stationary',duration_seconds:1800,distance_m:0},{mode:'walking',duration_seconds:600,distance_m:600}]}};
  global.PupMedia={element:(...args)=>new Element(...args),button:(label,action,cls)=>Object.assign(new Element('button',cls,label),{action}),request:async path=>{requests.push(path);return path==='maps'?{packs:[]}:{samples:[]};},getState:()=>({assets:{},places:{}})};
  global.PupLocationDay={analyze:(_date,_samples,_places,_photos,source)=>source==='laptop'?{...day,source_device:source,samples:[],routes:[],segments:[],visits:[]}:{...day,source_device:source},positionAt:(day,minute)=>day.samples.length&&minute>=600&&minute<=630?{lat:31,lon:121,transport:'stationary',speed_mps:0}:null};
  global.TodoPupMap={project:(lon,lat)=>({x:lon,y:lat}),OfflineMap:class {constructor(){this.zoom=10;}setLines(lines){this.lines=lines;}setMarkers(){}fit(){}draw(){}setPlaybackLocations(points){this.playbacks=points;mapCalls.push(points[0]||null);}destroy(){mapCalls.push('destroy');}}};
  let controller;
  try {
    controller=V.mount(new Element('section'),'2026-09-09',{document:[],showAnalytics:true});await controller.ready;
    const order=controller.host.children.map(node=>node.className);
    assert.ok(order.indexOf('location-day-map')<order.indexOf('location-day-replay'));
    assert.ok(order.indexOf('location-day-replay')<order.indexOf('location-day-stats'),'The map and its slider precede daily totals');
    assert.ok(order.indexOf('location-day-stats')<order.indexOf('location-day-stops'));
    const movement=controller.host.children.find(node=>node.className==='location-day-movement');
    assert.ok(movement,'The daily view includes its own movement analysis');
    const copy=node=>[node.textContent,...node.children.map(copy)].join(' ');
    assert.match(copy(movement),/3\.6 km\/h/);assert.match(copy(movement),/7\.2 km\/h/);
    assert.match(copy(movement),/Walking/);assert.match(copy(movement),/10 min/);
    assert.doesNotMatch(copy(movement),/Stationary|Days tracked|weekday/);
    controller.setMinute(615);assert.equal(controller.clock.textContent,'10:15');assert.equal(controller.positionText.textContent,'Cafe · 30 min');assert.equal(mapCalls.at(-1).lat,31);
    controller.map.zoom=20.5;controller.map.center={x:0,y:0};controller.follow=false;
    controller.slider.value='620';controller.slider.oninput();
    assert.deepEqual(controller.map.center,{x:121,y:31},'Dragging the time slider follows the recorded dot');
    assert.equal(controller.map.zoom,20.5,'Scrubbing preserves the exact current zoom');
    assert.equal(controller.follow,true);assert.equal(controller.followButton.attributes['aria-pressed'],'true');
    controller.followButton.action();assert.equal(controller.follow,false);
    controller.map.center={x:0,y:0};controller.setMinute(615);
    assert.deepEqual(controller.map.center,{x:0,y:0},'Rendering a time without user input respects disabled follow');
    controller.slider.value='700';controller.slider.oninput();
    assert.deepEqual(controller.map.center,{x:0,y:0},'A recording gap does not invent a followed point');assert.equal(controller.map.zoom,20.5);
    controller.setMinute(700);assert.equal(controller.positionText.textContent,'No recorded position');assert.equal(mapCalls.at(-1),null);
    controller.showStop(visit);assert.equal(controller.detail.hidden,false);assert.equal(controller.detail.children[1].textContent,'30 min here · 10:00–10:30');controller.setMinute(700);assert.equal(controller.detail.hidden,true);
    global.PupLocationDay.positionAt=day=>day.samples.length?{lat:31,lon:121,transport:'unknown',speed_mps:null}:null;controller.setMinute(590);assert.equal(controller.positionText.textContent,'Transport unknown');
    assert.deepEqual(requests,['tracking?from=2026-09-09&to=2026-09-09','maps']);
    const filter=()=>controller.host.children.find(node=>node.className==='location-source-filter');
    filter().children.find(button=>button.attributes['data-source']==='laptop').action();
    assert.equal(controller.sourceFilter,'laptop');assert.equal(controller.map,null);
    assert.match(controller.notice.textContent,/No laptop recordings/);
    filter().children.find(button=>button.attributes['data-source']==='both').action();
    assert.equal(controller.sourceFilter,'both');assert.ok(controller.map);
    controller.sourceDays.laptop={...day,source_device:'laptop'};controller.render();
    assert.equal(controller.map.playbacks.length,2);assert.equal(controller.day.source_device,'phone');
    const positionAt=global.PupLocationDay.positionAt;global.PupLocationDay.positionAt=day=>day.source_device==='laptop'?{lat:32,lon:122}:null;
    controller.follow=true;controller.setMinute(620);assert.deepEqual(controller.map.center,{x:122,y:32});
    global.PupLocationDay.positionAt=positionAt;
    filter().children.find(button=>button.attributes['data-source']==='laptop').action();
    assert.equal(controller.map.playbacks.length,1);assert.equal(controller.day.source_device,'laptop');
    listeners.get('pagehide')({persisted:true});assert.equal(controller.destroyed,false);assert.notEqual(mapCalls.at(-1),'destroy');assert.equal(listenerOptions.get('pagehide')?.once,undefined);
    controller.setMinute(615);assert.equal(controller.clock.textContent,'10:15');
    listeners.get('pagehide')({persisted:false});assert.equal(controller.destroyed,true);assert.ok(removed.includes('journal:saved'));assert.ok(removed.includes('pagehide'));
  } finally {controller?.destroy();Object.assign(global,globals);}
});

test('replay coverage combines continuous fixes while retaining real gaps',()=>{
  const segments=[
    {start:'2026-09-09T10:00:00+08:00',end:'2026-09-09T10:00:05+08:00'},
    {start:'2026-09-09T10:00:05+08:00',end:'2026-09-09T10:00:10+08:00'},
    {start:'2026-09-09T10:00:20+08:00',end:'2026-09-09T10:00:25+08:00'},
  ];
  assert.deepEqual(V.coverageBands(segments),[{start:600,end:600+10/60},{start:600+20/60,end:600+25/60}]);
  assert.equal(V.coverageBands(Array.from({length:720},(_,index)=>({start:'2026-09-09T10:'+String(Math.floor(index/12)).padStart(2,'0')+':'+String(index%12*5).padStart(2,'0')+'+08:00',end:'2026-09-09T'+(index===719?'11:00:00':'10:'+String(Math.floor((index+1)/12)).padStart(2,'0')+':'+String((index+1)%12*5).padStart(2,'0'))+'+08:00'}))).length,1);
});
