/* Photo metadata controls with synthetic assets and delayed local responses. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});

async function photoPage(respond) {
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(4000);
  const asset={id:'a'.repeat(64),filename:'QA photo',rev:0,captured_at:'2026-09-12T09:30:00',location:{lat:31.2,lon:121.5},location_label:'Original place'};
  const state={rev:0,assets:{[asset.id]:asset},groups:{},places:{},messages:{}};
  await page.route('https://datapom.test/**',route=>{
    const url=new URL(route.request().url()),result=respond?.(route,url,state);if(result)return result;
    if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.join(__dirname,'..',url.pathname)});
    if(url.pathname.startsWith('/journal/media/file/'))return route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')});
    if(url.pathname==='/journal/media/state'){
      for(const change of route.request().postDataJSON()?.changes||[]){Object.assign(state[change.kind][change.id],change.patch);state[change.kind][change.id].rev++;state.rev++;}
      return route.fulfill({json:state});
    }
    if(url.pathname==='/journal/media/analytics')return route.fulfill({json:{tags:{}}});
    if(url.pathname==='/journal/media/maps')return route.fulfill({json:{packs:[]}});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><main><div id="editor"></div></main>'+['custom-select','custom-color','datetime-picker','media-ui','offline-map'].map(name=>'<script src="/static/'+name+'.js"></script>').join('')});
  });
  await page.goto('https://datapom.test/');
  await page.evaluate(async()=>{
    await PupMedia.refresh();const asset=Object.values(PupMedia.getState().assets)[0];
    window.editor=new PupMedia.Editor(document.getElementById('editor'),[PupMedia.photoBlock(asset,'photo')],'',()=>{});
  });
  await page.getByRole('button',{name:'Details',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).waitFor();
  return {page,state};
}

test('photo map loading failure offers retry while retaining the place name',async()=>{
  let requests=0;
  const {page}=await photoPage((route,url)=>{
    if(url.pathname!=='/journal/media/maps')return;
    return ++requests===1?route.fulfill({status:503,json:{error:'Maps unavailable'}}):route.fulfill({json:{packs:[]}});
  });
  try {
    await page.getByRole('button',{name:'Correct location on map…',exact:true}).click();
    await page.getByRole('textbox',{name:'Place name',exact:true}).fill('Keep this place');
    await page.getByRole('button',{name:'Retry maps',exact:true}).click();
    await page.getByRole('button',{name:'Retry maps',exact:true}).waitFor({state:'hidden'});
    assert.equal(requests,2);
    assert.equal(await page.getByRole('textbox',{name:'Place name',exact:true}).inputValue(),'Keep this place');
    await page.getByRole('dialog',{name:'Photo location',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.getByRole('dialog',{name:'Photo details',exact:true}).count(),1);
  }finally{await page.close();}
});

test('closing a photo location dialog during map loading cleans up its map',async()=>{
  let release;
  const {page}=await photoPage((route,url)=>{
    if(url.pathname==='/journal/media/maps')return new Promise(resolve=>{release=()=>resolve(route.fulfill({json:{packs:[]}}));});
  });
  try {
    await page.evaluate(()=>{
      const Map=TodoPupMap.OfflineMap;window.reviewMaps=[];
      TodoPupMap.OfflineMap=class extends Map{constructor(host,options){super(host,options);reviewMaps.push(this);}destroy(){this.reviewDestroyed=true;super.destroy();}};
    });
    await page.getByRole('button',{name:'Correct location on map…',exact:true}).click();
    await page.getByRole('button',{name:'Close Photo location',exact:true}).click();
    release();await page.waitForTimeout(50);
    assert.equal(await page.evaluate(()=>reviewMaps.every(map=>map.reviewDestroyed)),true);
    assert.equal(await page.getByRole('dialog',{name:'Photo location',exact:true}).count(),0);
  }finally{await page.close();}
});

test('photo location saves pause editing and keep the submitted label in its event',async()=>{
  let release,posted;
  const {page,state}=await photoPage((route,url,store)=>{
    if(url.pathname!=='/journal/media/state'||route.request().method()!=='POST')return;
    posted=route.request().postDataJSON().changes[0];
    return new Promise(resolve=>{release=()=>{Object.assign(store.assets[posted.id],posted.patch);store.assets[posted.id].rev++;resolve(route.fulfill({json:store}));};});
  });
  try {
    await page.evaluate(()=>document.addEventListener('media:location-changed',event=>window.changedLocation=event.detail));
    await page.getByRole('button',{name:'Correct location on map…',exact:true}).click();
    const location=page.getByRole('dialog',{name:'Photo location',exact:true});
    await page.getByRole('textbox',{name:'Place name',exact:true}).fill('Saved place');
    await location.getByRole('button',{name:'Save location',exact:true}).click();
    assert.equal(await location.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    await page.keyboard.press('Escape');assert.equal(await location.count(),1);
    release();await location.waitFor({state:'hidden'});
    assert.equal(Object.values(state.assets)[0].location_label,'Saved place');
    assert.equal(await page.evaluate(()=>changedLocation.label),'Saved place');
  }finally{await page.close();}
});

test('photo time edits wait for acknowledgement and offer retry without discarding the chosen time',async()=>{
  let release,attempts=0; const changes=[];
  const {page,state}=await photoPage((route,url,store)=>{
    if(url.pathname!=='/journal/media/state'||route.request().method()!=='POST')return;
    const change=route.request().postDataJSON().changes[0];changes.push(change);attempts++;
    return new Promise(resolve=>{release=()=>{
      if(attempts===1)resolve(route.fulfill({status:503,json:{error:'Time could not be saved.'}}));
      else{Object.assign(store.assets[change.id],change.patch);store.assets[change.id].rev++;resolve(route.fulfill({json:store}));}
    };});
  });
  try {
    const trigger=page.getByRole('button',{name:'Taken at · saves separately: 2026-09-12 09:30',exact:true});
    await trigger.click();await page.locator('.dt-popover [data-date="2026-09-13"]').click();
    await page.waitForTimeout(30);
    assert.equal(attempts,1);
    assert.equal(await page.locator('.dt-trigger').isDisabled(),true);
    assert.equal(await page.locator('.dt-popover').count(),0);
    release();
    const retry=page.getByRole('button',{name:'Retry time',exact:true});await retry.waitFor();
    assert.equal(await page.locator('input[type="datetime-local"]').inputValue(),'2026-09-13T09:30');
    await retry.click();await page.waitForTimeout(30);assert.equal(attempts,2);release();
    await page.waitForFunction(()=>document.querySelector('.dt-trigger').disabled===false);
    assert.equal(Object.values(state.assets)[0].captured_at,'2026-09-13T09:30');
    assert.equal(await retry.isVisible(),false);
    assert.equal(await page.getByRole('dialog',{name:'Photo details',exact:true}).count(),1);
    assert.equal(changes[0].op_id,changes[1].op_id);
    await page.locator('.dt-trigger').click();await page.locator('.dt-popover [data-date="2026-09-14"]').click();
    await page.waitForTimeout(30);assert.equal(attempts,3);assert.equal(changes[2].base_rev,1);release();
    await page.waitForFunction(()=>document.querySelector('.dt-trigger').disabled===false);
    assert.equal(Object.values(state.assets)[0].captured_at,'2026-09-14T09:30');
  }finally{await page.close();}
});
