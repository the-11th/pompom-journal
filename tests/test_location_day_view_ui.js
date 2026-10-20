/* Daily replay and photo-marker choices use only synthetic, local assets. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function dayPage(){
  const page=await browser.newPage({viewport:{width:360,height:844},hasTouch:true});page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.join(__dirname,'..',url.pathname)});
    if(url.pathname.includes('/file/'))return route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><body class="media-mobile"><main><section id="day"></section></main>'+['custom-select','media-ui','offline-map','location-day','location-day-view'].map(name=>'<script src="/static/'+name+'.js"></script>').join('')});
  });
  await page.addInitScript(()=>{
    window.fixture={assets:Object.fromEntries(['one','two','three'].map((id,i)=>[id,{id,filename:id+'.jpg',captured_at:'2026-09-10T10:10:00+08:00',location:{lat:31.2,lon:121.5+(i===2?.00005:0)}}])),groups:{},places:{},messages:{}};
    window.fixtureDoc=['one','two','three'].map(id=>({id,type:'photo',asset_id:id,caption:id+' memory'}));
    window.fixtureEntry={date:'2026-09-10',title:'Route day',document:fixtureDoc};window.photoRequests=[];
    const samples=Array.from({length:21},(_,i)=>({id:'fix'+i,at:'2026-09-10T10:'+String(i).padStart(2,'0')+':00+08:00',lat:31.2+i*.0002,lon:121.5+i*.0002,accuracy_m:8,session:'fixture',source_device:'phone'}));
    window.TodoPupNative={request(raw){const {id,path,body}=JSON.parse(raw);photoRequests.push({path,body});let value;
      if(path.startsWith('entry/'))value={entry:fixtureEntry};
      else if(path==='journal/2026-09-10/photo-details'){
        fixtureEntry={...fixtureEntry,document:fixtureEntry.document.map(block=>block.id===body.block_id?{...block,caption:body.caption,location_label:body.location_label}:block)};value={entry:fixtureEntry};
      }else value=path==='state'?fixture:path==='maps'?{packs:[]}:path.startsWith('tracking?')?{samples}:{};
      queueMicrotask(()=>PupMedia.reply(id,structuredClone(value)));}};
  });
  await page.goto('https://datapom.test/');
  await page.evaluate(async()=>{await PupMedia.refresh();window.day=PupLocationDayView.mount(document.getElementById('day'),'2026-09-10',{document:fixtureDoc});await day.ready;});
  return page;
}
async function tapPhotos(page){
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  const point=await page.evaluate(()=>{day.map.center=TodoPupMap.project(121.5,31.2);day.map.setZoom(18);const box=day.map.canvas.getBoundingClientRect(),p=day.map.pixel(121.5,31.2);return {x:box.x+p.x,y:box.y+p.y-22};});
  await page.touchscreen.tap(point.x,point.y);
}
test('nearby photo pins open a retained accessible strip and each original photo',async()=>{
  const page=await dayPage();
  try{
    await tapPhotos(page);
    const detail=page.getByRole('region',{name:'3 photos here',exact:true});await detail.waitFor();
    assert.equal(await detail.getByRole('button',{name:/memory/}).count(),3);
    if(process.env.DATAPOM_MAP_CAPTURE)await page.screenshot({path:process.env.DATAPOM_MAP_CAPTURE,fullPage:true});
    const before=await page.evaluate(()=>({center:day.map.center,zoom:day.map.zoom,photos:fixture.assets}));
    const second=detail.getByRole('button',{name:'two memory · 10:10',exact:true});await second.click();
    const viewer=page.getByRole('dialog',{name:'Photo',exact:true});await viewer.waitFor();
    await viewer.getByRole('button',{name:'Close Photo',exact:true}).click();
    assert.equal(await second.evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>day.refresh());await detail.waitFor();
    assert.equal(await detail.getByRole('button',{name:/memory/}).count(),3);
    assert.deepEqual(await page.evaluate(()=>({center:day.map.center,zoom:day.map.zoom,photos:fixture.assets})),before);
    await detail.getByRole('button',{name:'Close photo choices',exact:true}).click();
    assert.equal(await page.locator('canvas').evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>day.map.setZoom(22));await page.locator('canvas').press('Enter');
    const exact=page.getByRole('region',{name:'2 photos here',exact:true});await exact.waitFor();
    assert.equal(await exact.getByRole('button',{name:/memory/}).count(),2,'Deeper zoom separates nearby pins but retains identical coordinates');
    await exact.press('Escape');assert.equal(await exact.count(),0);
    assert.equal(await page.locator('canvas').evaluate(el=>el===document.activeElement),true);
  }finally{await page.close();}
});
test('photo choices fit a narrow mobile page with enlarged text',async()=>{
  const page=await dayPage();
  try{
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    await page.evaluate(()=>{day.map.center=TodoPupMap.project(121.5,31.2);day.map.setZoom(18);});await page.locator('canvas').press('Enter');
    if(process.env.DATAPOM_MAP_CAPTURE)await page.screenshot({path:process.env.DATAPOM_MAP_CAPTURE.replace('.png','-large.png'),fullPage:true});
    const detail=page.getByRole('region',{name:'3 photos here',exact:true});await detail.waitFor();
    assert.equal(await detail.getByRole('button',{name:/memory/}).count(),3);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await detail.getByRole('button',{name:'three memory · 10:10',exact:true}).press('Enter');
    await page.getByRole('dialog',{name:'Photo',exact:true}).waitFor();
    await page.getByRole('dialog',{name:'Photo',exact:true}).press('Escape');
    assert.equal(await detail.getByRole('button',{name:'three memory · 10:10',exact:true}).evaluate(el=>el===document.activeElement),true);
  }finally{await page.close();}
});
test('native route photos edit only their own entry and restore a refreshed strip button',async()=>{
  const page=await dayPage();
  try{
    await tapPhotos(page);const choices=page.getByRole('region',{name:'3 photos here',exact:true});
    await choices.getByRole('button',{name:'two memory · 10:10',exact:true}).click();
    const viewer=page.getByRole('dialog',{name:'Photo',exact:true});
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).click();
    await viewer.getByRole('textbox',{name:'Caption',exact:true}).fill('Route photo caption');
    await viewer.getByRole('textbox',{name:'Location name',exact:true}).fill('Riverside');
    await viewer.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>fixtureEntry.document.find(block=>block.id==='two').caption==='Route photo caption');
    await viewer.getByRole('button',{name:'Close Photo',exact:true}).click();
    const updated=choices.getByRole('button',{name:'Route photo caption · 10:10',exact:true});await updated.waitFor();
    assert.equal(await updated.evaluate(el=>el===document.activeElement),true);
    const saves=await page.evaluate(()=>photoRequests.filter(request=>request.path.includes('/photo-details')));
    assert.equal(saves.length,1);assert.equal(saves[0].path,'journal/2026-09-10/photo-details');assert.equal(saves[0].body.asset_id,'two');assert.equal(saves[0].body.block_id,'two');
    assert.deepEqual(await page.evaluate(()=>fixtureEntry.document.map(block=>block.caption)),['one memory','Route photo caption','three memory']);
    assert.equal(await page.evaluate(()=>fixtureEntry.title),'Route day');
  }finally{await page.close();}
});
test('unavailable or cancelled native photo opening leaves the route available',async()=>{
  const page=await dayPage();
  try{
    const button=page.getByRole('button',{name:'one memory · 10:10',exact:true});
    await page.evaluate(()=>PupMedia.openEntryPhoto=async()=>{throw Error('Photo entry unavailable. Try again.');});
    await button.click();await page.getByRole('status').filter({hasText:'Photo entry unavailable. Try again.'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await button.evaluate(el=>el===document.activeElement),true);
    await page.evaluate(()=>PupMedia.openEntryPhoto=async()=>null);await button.click();
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('canvas').count(),1);
  }finally{await page.close();}
});
test('slider pointer and keyboard input follow the dot at the current zoom and keep gaps empty',async()=>{
  const page=await dayPage();
  try{
    await page.evaluate(()=>{day.map.setZoom(20.5);day.map.center=TodoPupMap.project(0,0);});
    const slider=page.getByRole('slider',{name:'Time of day for recorded location',exact:true});
    await slider.press('End');
    const box=await slider.boundingBox();await page.mouse.click(box.x+box.width*(610/1440),box.y+box.height/2);
    await slider.press('ArrowRight');
    let snapshot=await page.evaluate(()=>({zoom:day.map.zoom,point:day.map.playback,center:TodoPupMap.unproject(day.map.center.x,day.map.center.y)}));
    assert.equal(snapshot.zoom,20.5);assert.ok(snapshot.point,'Recorded point at minute '+await slider.inputValue());assert.ok(Math.abs(snapshot.center.lon-snapshot.point.lon)<1e-8&&Math.abs(snapshot.center.lat-snapshot.point.lat)<1e-8);
    assert.equal(await page.getByRole('button',{name:'Follow dot',exact:true}).getAttribute('aria-pressed'),'true');
    await slider.press('Home');
    assert.equal(await page.evaluate(()=>day.map.playback),null);assert.equal(await page.evaluate(()=>day.map.zoom),20.5);
    assert.deepEqual(await page.evaluate(()=>TodoPupMap.unproject(day.map.center.x,day.map.center.y)),snapshot.center);
  }finally{await page.close();}
});
