const assert=require('node:assert/strict');
const M=require('../static/media-ui.js');
assert.deepEqual(M.photoTagChoices({id:'people',name:'people',tags:['Alex']}, ['sam'], ['sam','past friend'], {jo:{section_name:'people'},elsewhere:{section_name:'work'}}), [
  {name:'alex',permanent:true}, {name:'jo',permanent:false}, {name:'past friend',permanent:false}, {name:'sam',permanent:false}
]);
assert.deepEqual(M.photoTagChoices({id:'foods',name:'foods'}, ['小笼包'], ['小笼包']), [{name:'小笼包',permanent:false}]);
assert.deepEqual(M.rebaseLinks('hello alex','well hello alex',[{start:6,end:10,photos:['p']}]),[{start:11,end:15,photos:['p']}]);
assert.deepEqual(M.rebaseLinks('hello alex','hello ',[{start:6,end:10,photos:['p']}]),[]);
assert.deepEqual(M.rebaseLinks('🐶 alex','🐶🐶 alex',[{start:2,end:6,photos:['p']}]),[{start:3,end:7,photos:['p']}]);
const doc=[{id:'a',type:'text',text:'Hello'},{id:'p',type:'photo',asset_id:'x',caption:'no',tags:{people:['alex']}},{id:'b',type:'text',text:'world'}];
assert.deepEqual(M.photoReferences([{id:'text',type:'text',text:'See photo',links:[{start:0,end:9,photos:['p']}]},doc[1]]),[doc[1]]);
assert.equal(M.documentBody(doc),'Hello\nworld');
assert.equal(M.photoStats([{date:'2026-09-08',document:[doc[1],{...doc[1],id:'p2'}]}]).photos,1);
const photoEntries = [
  {date:'2026-09-08',document:[{id:'old',type:'photo',asset_id:'a',caption:'Old caption',edited_asset_id:'old-edit',tags:{people:['sam']}}]},
  {date:'2026-09-10',document:[{id:'new',type:'photo',asset_id:'a',caption:'Recent caption',edited_asset_id:'new-edit',tags:{people:['alex']}}]},
  {date:'2026-09-11',document:[{id:'text',type:'text',text:'A memory',links:[{start:0,end:8,photos:['a','b','a']}]}]},
];
const photoEntriesBefore=JSON.stringify(photoEntries);
const photoSummary=M.photoStats(photoEntries);
assert.equal(photoSummary.photos,2);
assert.equal(photoSummary.gallery[0].date,'2026-09-11');
assert.equal(photoSummary.gallery[0].details_date,'2026-09-10');
assert.equal(photoSummary.gallery[0].caption,'Recent caption');
assert.equal(photoSummary.gallery[0].edited_asset_id,'new-edit');
assert.deepEqual(photoSummary.gallery[0].tags.people,['alex','sam']);
assert.deepEqual(photoSummary.series,{'2026-09-11':2});
assert.deepEqual(M.photoStats([...photoEntries].reverse()),photoSummary);
assert.equal(JSON.stringify(photoEntries),photoEntriesBefore);
console.log('media document contracts passed');

const datedPhotos = [{asset_id:'a',date:'2026-09-20'}, {asset_id:'b',date:'2026-09-24'}, {asset_id:'c',date:'2026-09-25'}];
const datedAssets = {a:{captured_at:'2026-09-24T23:59:59-07:00'}, b:{captured_at:null}, c:{captured_at:'2026-09-25T00:00:00'}};
assert.deepEqual(M.photosInRange(datedPhotos,datedAssets,'2026-09-24','2026-09-24'),datedPhotos.slice(0,2));
assert.deepEqual(M.photosInRange(datedPhotos,datedAssets,'',''),datedPhotos);
assert.deepEqual(M.photosInRange(datedPhotos,datedAssets,'2026-09-25','2026-09-24'),[]);
assert.equal(M.photoDate(datedPhotos[0],datedAssets),'2026-09-24');

assert.deepEqual(M.splitText('🐶 hello',3,[{start:0,end:5,photos:['p']}]),{before:{text:'🐶 ',links:[{start:0,end:2,photos:['p']}]},after:{text:'hello',links:[{start:0,end:3,photos:['p']}]}});
const submitted=[{id:'t',type:'text',text:'[] walk\nHello',links:[]}];
const committed=[{id:'t',type:'text',text:'[task:abc123] walk\nHello',links:[]}];
assert.equal(M.mergeCommittedDocument(submitted,committed,[{...submitted[0],text:'[] walk\nHello again'}])[0].text,'[task:abc123] walk\nHello again');
assert.equal(M.mergeCommittedDocument(submitted,committed,[{...submitted[0],text:'A note\n[] walk\nHello'}])[0].text,'A note\n[task:abc123] walk\nHello');
assert.equal(M.mergeCommittedDocument(submitted,committed,[{...submitted[0],text:'[ ] walk\nHello'}]),null);
const taskText='[] walk\nquiet afternoon\n[] dinner';
const rewrittenTaskText='[task:abc123] walk\nquiet afternoon\n[task:def456] dinner';
const newerLink={start:8,end:23,photos:['p']};
const mergedLink=M.mergeCommittedDocument(
  [{id:'t',type:'text',text:taskText,links:[]}],
  [{id:'t',type:'text',text:rewrittenTaskText,links:[]}],
  [{id:'t',type:'text',text:taskText,links:[newerLink]}]
)[0];
assert.equal(mergedLink.text,rewrittenTaskText);
assert.deepEqual(mergedLink.links,[{start:19,end:34,photos:['p']}]);
const photo=M.photoBlock({id:'asset',location:{lat:31,lon:121},location_label:'The Bund'},'block');
assert.equal(photo.location_visible,true);assert.deepEqual(photo.tags,{locations:['the bund']});
assert.deepEqual(M.captionTagNames('@meeting @alex',{},[{id:'people',name:'people'}],{meeting:{section_name:'work'},alex:{section_name:'people'}}),{people:['alex']});
assert.deepEqual(M.captionTagNames('@noodles',{foods:['noodles']},[{id:'foods',name:'foods'}],{}),{foods:['noodles']});
const chineseMentions=Object.fromEntries(['小李','李.明','家人 臺灣','𠀀家','work'].map(name=>[name,{section_name:'人物'}]));
assert.deepEqual(M.captionTagNames('中文@小李 @work朋友',{},[{id:'people',name:'人物'}],chineseMentions),{});
assert.deepEqual(M.captionTagNames('@小李. @李.明。 @家人_臺灣 @𠀀家',{},[{id:'people',name:'人物'}],chineseMentions),{people:['小李','李.明','家人 臺灣','𠀀家']});
assert.deepEqual(M.captionTagNames('@constructor @__proto__',{},[],{}),{});
assert.deepEqual(M.captionTagNames('@constructor @__proto__',{},[{id:'people',name:'people'}],JSON.parse('{"constructor":{"section_name":"people"},"__proto__":{"section_name":"people"}}')),{people:['constructor','__proto__']});
assert.deepEqual(M.draftRecovery({base_updated:'new',recovery_reason:'task-rewrite'},'new'),{sameVersion:true,blocked:true,reason:'task-rewrite'});
assert.deepEqual(M.draftRecovery({base_updated:'new'},'new'),{sameVersion:true,blocked:false,reason:null});
assert.deepEqual(M.draftRecovery({base_updated:'old'},'new'),{sameVersion:false,blocked:true,reason:'version'});
assert.deepEqual(M.draftRecovery({base_updated:'old',base_edit_revision:'same'},'new','same'),{sameVersion:true,blocked:false,reason:null});
assert.deepEqual(M.draftRecovery({base_updated:'old',base_edit_revision:'before'},'new','after'),{sameVersion:false,blocked:true,reason:'version'});
assert.deepEqual(M.mergePhotoTagFields({archived_group:['old'],people:['alex'],foods:['noodles']},[['people',' Alex, Jamie, alex '],['foods','']]),{archived_group:['old'],people:['alex','jamie']});
assert.equal(M.selectedPassage('hello',2,2),null);
assert.equal(M.selectedPassage('  hello',0,2),null);
assert.deepEqual(M.selectedPassage('🐶 quiet walk',3,13),{start:2,end:12,text:'quiet walk'});
assert.deepEqual(M.selectedPassage('hello',0,99),{start:0,end:5,text:'hello'});

// A save response can arrive while a caption, photo-edit, or link dialog holds
// a block reference. Keep those references attached to the current document.
const openPhoto = {id:'photo-open',type:'photo',asset_id:'original',caption:'before',location_label:'old'};
const openPassage = {id:'text-open',type:'text',text:'[] walk',links:[]};
const replacement = [
  {id:'text-open',type:'text',text:'[task:abc123] walk',links:[]},
  {id:'photo-open',type:'photo',asset_id:'original',caption:'before'},
  {id:'new',type:'text',text:''}
];
const acceptedDocument = M.reconcileDocument([openPhoto,openPassage], replacement);
assert.equal(acceptedDocument[0],openPassage);
assert.equal(acceptedDocument[1],openPhoto);
assert.equal(openPassage.text,'[task:abc123] walk');
assert.equal('location_label' in openPhoto,false);
openPhoto.caption='caption saved after the response';
openPhoto.edited_asset_id='drawing-saved-after-response';
openPassage.links.push({start:0,end:5,photos:['photo-open']});
assert.equal(acceptedDocument[1].caption,'caption saved after the response');
assert.equal(acceptedDocument[1].edited_asset_id,'drawing-saved-after-response');
assert.equal(acceptedDocument[0].links.length,1);
assert.equal(replacement[1].caption,'before');
assert.equal(replacement[0].links.length,0);
assert.deepEqual(M.reconcileDocument(acceptedDocument,[]),[]);
const passageBlock={id:'passage',type:'text',text:'quiet afternoon',links:[
  {start:0,end:5,photos:['p']},{start:6,end:15,photos:['q']}
]};
M.setPassagePhotos(passageBlock,{text:'quiet afternoon',start:0,end:5},[]);
assert.deepEqual(passageBlock.links,[{start:6,end:15,photos:['q']}]);
M.setPassagePhotos(passageBlock,{text:'quiet afternoon',start:0,end:5},['p','p']);
assert.deepEqual(passageBlock.links.at(-1),{start:0,end:5,photos:['p']});
assert.throws(()=>M.setPassagePhotos(passageBlock,{text:'outdated text',start:0,end:5},[]),/Text changed/);
assert.equal(passageBlock.links.length,2);

// Keep the browser chooser's input alive until its cancel/change event arrives.
(async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  let chooser;
  const document={body:{append(input){input.isConnected=true;}},createElement(){return {
    isConnected:false,files:[],click(){assert.equal(this.isConnected,true);chooser=this;},remove(){this.isConnected=false;}
  };}};
  const window={};
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/media-ui.js'),'utf8'),{window,document});
  const cancelled=window.PupMedia.choosePhotoFiles();
  assert.equal(chooser.accept,'image/*'); assert.equal(chooser.multiple,true); assert.equal(chooser.capture,undefined);
  chooser.oncancel(); assert.equal((await cancelled).length,0); assert.equal(chooser.isConnected,false);
  const empty=window.PupMedia.choosePhotoFiles();
  await chooser.onchange(); assert.equal((await empty).length,0); assert.equal(chooser.isConnected,false);
})().catch(error=>{console.error(error);process.exitCode=1;});

// Preserve native acknowledgement reasons so recovery cannot recreate tasks.
(async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  let envelope;
  const window={TodoPupNative:{request(value){envelope=JSON.parse(value);}}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../static/media-ui.js'),'utf8'),
    {window,document:{},crypto:require('node:crypto').webcrypto});
  const saving=window.PupMedia.request('/journal/2026-09-07/autosave',{});
  window.PupMedia.reply(envelope.id,null,{status:409,reason:'task-rewrite',message:'Review current copy',current:{body:'[task:abc123] walk'}});
  await assert.rejects(saving,error=>error.status===409&&error.reason==='task-rewrite'&&error.current.body==='[task:abc123] walk');
})().catch(error=>{console.error(error);process.exitCode=1;});
