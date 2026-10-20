/* Selected-day navigation through the real bundled mobile controller. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

async function mobilePage({date='2026-09-08',search='',save=true}={}) {
  class Node {
    constructor(tag='div',cls='',text=''){this.tagName=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.attributes={};this.hidden=false;this.classList={add(){},toggle(){}};}
    append(...nodes){for(const node of nodes){this.children.push(node);node.parentElement=this;}if(this===document.body)for(const node of nodes)if(node.tagName==='script')queueMicrotask(()=>node.onload?.());}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    insertBefore(node,before){this.children.splice(this.children.indexOf(before),0,node);node.parentElement=this;}
    setAttribute(key,value){this.attributes[key]=value;}
    querySelectorAll(tag){return this.children.flatMap(node=>[...(node.tagName===tag?[node]:[]),...node.querySelectorAll(tag)]);}
    addEventListener(){} dispatchEvent(){} scrollIntoView(){}
  }
  const root=new Node(),document={createElement:tag=>new Node(tag),getElementById:id=>id==='mobile-root'?root:[root,...root.querySelectorAll('form'),...root.querySelectorAll('section')].find(node=>node.id===id)};
  document.body=new Node('body');
  const calls=[],mounts=[],doc=[{type:'photo',asset_id:'draft-photo'}],location={search,href:''};
  const M={element:(...args)=>new Node(...args),button:(label,action,cls)=>Object.assign(new Node('button',cls,label),{action}),
    field:(label,value='',tag='input')=>({wrap:new Node('label'),input:Object.assign(new Node(tag),{value})}),
    refresh:async()=>calls.push('state'),
    request:async(path,body)=>{calls.push(path);if(path==='bootstrap')return {entry:{date,updated:'revision'},sections:[]};if(path==='choose-date')return {date:'2026-09-07'};if(path==='entries')return {entries:[]};return {};},
    timeline:async()=>calls.push('all-history'),photos:async()=>calls.push('photos'),settings:async()=>{},notice:()=>{}};
  const editor={editor:{doc},save:async()=>save,prepareNavigation:async()=>save};
  const window=Object.assign(new EventTarget(),{PupMedia:M,PupJournalEditor:editor,PupLocationDayView:{mount(host,day,options){const view={host,day,options,ready:Promise.resolve(),destroy(){view.destroyed=true;}};mounts.push(view);return view;}}});
  const context=vm.createContext({window,document,location,URLSearchParams,Event,console,queueMicrotask});
  await vm.runInContext(fs.readFileSync(require.resolve('../static/mobile-journal.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  const button=name=>root.querySelectorAll('button').find(node=>node.textContent===name);
  return {root,calls,mounts,doc,location,button,form:document.getElementById('journal-form')};
}

test('mobile Places uses the selected journal day and current photos, not all-history analytics',async()=>{
  const page=await mobilePage();
  await page.button('Places').action();
  assert.equal(page.mounts.length,1);
  const view=page.mounts[0];assert.equal(view.day,'2026-09-08');
  assert.equal(view.options.getDocument(),page.doc);
  assert.equal(view.options.showAnalytics,true);assert.equal(view.options.showHeading,false);
  assert.equal(page.calls.includes('all-history'),false);assert.equal(page.calls.includes('entries'),false);
  assert.equal(page.form.hidden,true);
  const date=page.button('2026-09-08 ▾');assert.equal(date.parentElement.hidden,false);
  assert.notEqual(date.parentElement.parentElement,page.form,'Date stays visible above the daily map');
  await date.action();assert.match(page.location.href,/date=2026-09-07/);assert.match(page.location.href,/view=places/);
  await page.button('Entry').action();assert.equal(view.destroyed,true);assert.equal(page.form.hidden,false);
});

test('opening another date preserves the Places view and its exact date',async()=>{
  const page=await mobilePage({date:'2026-09-07',search:'?date=2026-09-07&view=places'});
  assert.equal(page.mounts.length,1);assert.equal(page.mounts[0].day,'2026-09-07');assert.equal(page.form.hidden,true);
});

test('a save failure leaves the journal visible instead of opening a stale daily map',async()=>{
  const page=await mobilePage({save:false});await page.button('Places').action();
  assert.equal(page.mounts.length,0);assert.equal(page.form.hidden,false);
});
