const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const L=require('../static/laptop-location.js');
const KEY='datapom:laptop-location';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function recorder({storage=new Map(),permission='granted',locate,send}={}) {
  let time=Date.parse('2026-09-10T12:00:00+08:00'),id=0,captures=0;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
  const timers=new Map(),sent=[],status=new EventTarget(),document=new EventTarget(),window=new EventTarget();
  document.hidden=false;status.state=permission;window.document=document;
  const host={children:[],append(...nodes){this.children.push(...nodes);}};
  window.PupMedia={element:(_tag,_cls,text='')=>({textContent:text}),button:(text,action)=>({textContent:text,action})};
  const navigator={permissions:{query:async()=>status},locks:{request:(_name,callback)=>callback()},geolocation:{getCurrentPosition(resolve,reject){captures++;if(locate)locate(resolve,reject);else resolve({timestamp:time,coords:{latitude:31,longitude:121,accuracy:15}});}}};
  const localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/laptop-location.js'),'utf8'),{window,document,navigator,localStorage,crypto:{randomUUID:()=>String(++id)},Date:Clock,Event,CustomEvent,AbortController,setTimeout,clearTimeout,setInterval:callback=>{const id=Symbol();timers.set(id,callback);return id;},clearInterval:id=>timers.delete(id),fetch:async(path,options)=>{const batch=JSON.parse(options.body);sent.push({path,...batch});return send?send(batch,options):{ok:true,json:async()=>({ok:true,accepted:batch.samples.map(row=>row.id)})};}});
  window.PupLaptopLocation.mount(host);
  return {window,storage,sent,status,host,get captures(){return captures;},async tick(){time+=30000;for(const callback of [...timers.values()])callback();await settle();},close(){window.dispatchEvent(new Event('pagehide'));},permission(value){status.state=value;status.dispatchEvent(new Event('change'));},online(){window.dispatchEvent(new Event('online'));}};
}
const pending=(id='pending')=>({id,session:'earlier',source_device:'laptop',provider:'browser',mode:'precise',at:'2026-09-09T23:59:30+08:00',lat:31,lon:121,accuracy_m:15});

test('laptop observations carry origin and local date without stale or invalid fixes',()=>{
  const now=Date.parse('2026-09-10T12:00:00+08:00');
  const fix={timestamp:now,coords:{latitude:31.2,longitude:121.5,accuracy:20,speed:null,heading:null}};
  const row=L.observation(fix,'session','sample',now);
  assert.equal(row.source_device,'laptop');assert.equal(Date.parse(row.at),now);assert.equal(row.speed_mps,undefined);
  assert.equal(L.observation({...fix,timestamp:now-121000},'s','a',now),null);
  assert.equal(L.observation({...fix,coords:{...fix.coords,latitude:91}},'s','a',now),null);
});
test('granted location permission starts automatic saving without a journal save',async()=>{
  const page=recorder();try{await settle();assert.equal(page.storage.get(KEY),'1');assert.equal(page.sent.length,1);assert.equal(page.sent[0].path,'/journal/media/tracking');assert.equal(page.sent[0].samples[0].source_device,'laptop');assert.equal(page.storage.get(KEY+'.pending'),'[]');assert.match(page.host.children[0].textContent,/Auto-saving.*last saved/i);await page.tick();assert.equal(page.sent.length,2);}finally{page.close();}
});
test('an explicit pause remains paused after reload and permission changes',async()=>{
  const page=recorder({storage:new Map([[KEY,'0']])});try{await settle();page.permission('granted');await page.tick();assert.equal(page.captures,0);assert.equal(page.sent.length,0);}finally{page.close();}
});
test('offline fixes survive reopening and retry even while location is unavailable',async()=>{
  const storage=new Map([[KEY,'1']]);let fail=true;
  const page=recorder({storage,send:async batch=>({ok:!fail,json:async()=>({ok:true,accepted:batch.samples.map(row=>row.id)})})});
  await settle();const saved=JSON.parse(storage.get(KEY+'.pending'));assert.equal(saved.length,1);assert.match(page.host.children[0].textContent,/saved in this browser/i);page.close();
  const reopened=recorder({storage,permission:'denied',locate:()=>{throw Error('A new fix is not needed to retry');}});
  try{await settle();assert.equal(reopened.captures,0);assert.equal(reopened.sent.length,1);assert.deepEqual(reopened.sent[0].samples,saved);assert.equal(storage.get(KEY+'.pending'),'[]');}finally{reopened.close();}
});
test('pending saves retry while paused and clear only acknowledged observations',async()=>{
  const storage=new Map([[KEY,'0'],[KEY+'.pending',JSON.stringify([pending('one'),pending('two')])]]);let acknowledge=false;
  const page=recorder({storage,send:async()=>({ok:true,json:async()=>acknowledge?{ok:true,accepted:['one','two']}:{ok:true}})});
  try{await settle();assert.equal(JSON.parse(storage.get(KEY+'.pending')).length,2);acknowledge=true;page.online();await settle();assert.equal(storage.get(KEY+'.pending'),'[]');assert.equal(page.captures,0);}finally{page.close();}
});
test('a hanging location lookup does not block previously queued saves',async()=>{
  const storage=new Map([[KEY,'1'],[KEY+'.pending',JSON.stringify([pending()])]]);
  const page=recorder({storage,locate(){}});try{await settle();assert.equal(page.captures,1);assert.equal(page.sent[0].samples[0].at,pending().at);assert.equal(storage.get(KEY+'.pending'),'[]');}finally{page.close();}
});
test('granting permission begins auto-saving, but asking for permission is not automatic',async()=>{
  const page=recorder({permission:'prompt'});try{await settle();assert.equal(page.captures,0);page.permission('granted');await settle();assert.equal(page.sent.length,1);await page.window.PupLaptopLocation.setEnabled(false);await page.tick();assert.equal(page.captures,1);}finally{page.close();}
});
test('an older page cannot overwrite a queue after handing recording to another tab',async()=>{
  let resolveSend;const storage=new Map([[KEY,'1']]);const page=recorder({storage,send:()=>new Promise(resolve=>{resolveSend=resolve;})});
  await settle();assert.equal(JSON.parse(storage.get(KEY+'.pending')).length,1);page.close();
  const next=[pending('next-tab')];storage.set(KEY+'.pending',JSON.stringify(next));resolveSend({ok:true,json:async()=>({ok:true,accepted:page.sent[0].samples.map(row=>row.id)})});await settle();assert.deepEqual(JSON.parse(storage.get(KEY+'.pending')),next);
});
