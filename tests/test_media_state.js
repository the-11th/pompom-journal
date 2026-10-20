const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../static/media-ui.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(native=false) {
  const calls=[];
  const window=native?{TodoPupNative:{request(raw){calls.push(JSON.parse(raw));}}}:{};
  const context={window,document:{},crypto:require('node:crypto').webcrypto,
    fetch:async(url,options)=>new Promise((resolve,reject)=>calls.push({url,body:options?.body,resolve,reject})),
  };
  vm.runInNewContext(source,context);
  return {M:window.PupMedia,calls,reply(index,state){
    if(native)window.PupMedia.reply(calls[index].id,plain(state));
    else calls[index].resolve({ok:true,json:async()=>plain(state)});
  },fail(index){
    if(native)window.PupMedia.reply(calls[index].id,null,{message:'Response lost'});
    else calls[index].reject(Error('Response lost'));
  }};
}
function state(rev,record={id:'home',name:'Home',rev:1},extra={}) {
  return {rev,assets:{},groups:{},messages:{},places:record?{home:record}:{},...extra};
}
for(const native of [false,true])test(`${native?'native':'web'} delayed refresh cannot undo a newer mutation`,async()=>{
  const f=fixture(native);
  const initial=f.M.refresh();f.reply(0,state(1,undefined,native?{local_revision:1}:{}));await initial;
  const old=f.M.refresh();
  const saved=f.M.mutate('places','home',{name:'Updated'});
  f.reply(2,state(2,{id:'home',name:'Updated',rev:2},native?{local_revision:2}:{}));await saved;
  f.reply(1,state(1,undefined,native?{local_revision:1}:{}));await old;
  assert.equal(f.M.getState().places.home.name,'Updated');
});
test('web snapshots retain imported assets omitted by an older equal-global-revision snapshot',async()=>{
  const f=fixture();
  const first=f.M.refresh();f.reply(0,state(2,null,{assets:{new:{id:'new',rev:0}}}));await first;
  const next=f.M.refresh();f.reply(1,state(2,null,{groups:{people:{id:'people',name:'people',rev:0}}}));await next;
  assert.equal(f.M.getState().assets.new.id,'new');
  assert.equal(f.M.getState().groups.people.name,'people');
});
test('newer archives remain visible and cannot be restored by an old response',async()=>{
  const f=fixture();
  const first=f.M.refresh();f.reply(0,state(3,{id:'home',name:'Home',rev:3,archived:true}));await first;
  const old=f.M.refresh();f.reply(1,state(1));await old;
  assert.equal(f.M.getState().places.home.archived,true);
});
test('native snapshot revision permits ACK normalization of optimistic record revisions',async()=>{
  const f=fixture(true);
  const first=f.M.refresh();f.reply(0,state(1,{id:'home',name:'Local',rev:4},{local_revision:8}));await first;
  const ack=f.M.refresh();f.reply(1,state(2,{id:'home',name:'Local',rev:2},{local_revision:9}));await ack;
  assert.equal(f.M.getState().places.home.rev,2);
  const old=f.M.refresh();f.reply(2,state(1,{id:'home',name:'Before ACK',rev:4},{local_revision:8}));await old;
  assert.equal(f.M.getState().places.home.rev,2);
});
test('native equal-clock reply retains an asset just returned by the separate import path',async()=>{
  const f=fixture(true);
  const initial=f.M.refresh();f.reply(0,state(1,null,{local_revision:4}));await initial;
  const pending=f.M.refresh();
  f.M.getState().assets.imported={id:'imported',rev:0};
  f.reply(1,state(1,null,{local_revision:4}));await pending;
  assert.equal(f.M.getState().assets.imported.id,'imported');
});
for(const native of [false,true])test(`${native?'native':'web'} photo tag batch replays the committed operations after a lost response`,async()=>{
  const f=fixture(native),initial=state(2,null,{groups:{
    people:{id:'people',name:'people',tags:['alex'],rev:1},
    places:{id:'places',name:'places',tags:['home'],rev:2},
  }});
  const load=f.M.refresh();f.reply(0,initial);await load;
  const pickers=Object.values(plain(initial.groups)).map(group=>({group}));
  pickers[0].group.tags.push('sam');pickers[1].group.tags.push('park');
  const body=index=>native?f.calls[index].body:JSON.parse(f.calls[index].body);
  const first=f.M.savePhotoTagGroups(pickers);
  const committed=plain(body(1).changes);
  f.fail(1);await assert.rejects(first,/Response lost/);
  const retry=f.M.savePhotoTagGroups(pickers);
  assert.deepEqual(plain(body(2).changes),committed);
  const acknowledged=plain(initial);
  committed.forEach(change=>Object.assign(acknowledged.groups[change.id],change.patch,{rev:3}));
  f.reply(2,acknowledged);await retry;
  assert.deepEqual(plain(f.M.getState().groups.people.tags),['alex','sam']);
  assert.deepEqual(plain(f.M.getState().groups.places.tags),['home','park']);
  const unchanged=f.M.savePhotoTagGroups(pickers);await unchanged;
  assert.equal(f.calls.length,3);
});
