/* Run with Node and Playwright available on NODE_PATH; all journal data is synthetic. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
const assetRoot=process.env.MOBILE_UI_ASSET_ROOT || path.join(__dirname,'..','static');
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

async function journalPage(body = '', editRevision = null, options = {}) {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => console.error('Mobile editor error:', error));
  await page.route('https://todopup.local/static/**', route => route.fulfill({
    path: path.join(assetRoot, new URL(route.request().url()).pathname.slice(8)),
  }));
  await page.route('https://todopup.local/journal/media/file/**',route=>route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')}));
  await page.addInitScript(({ body, editRevision, options }) => {
    const sections = [{ id: 'people', name: 'people', type: 'tag', color: '#e0a955',
      tags: options.tagNames || ['alex', 'sam'], archived_tags: options.archivedTags || [], mention_tags: ['alex', 'sam', 'old friend', 'past trip'] }, ...(options.sections || [])];
    let resolutionConflict = null;
    let taskIndex=options.taskIndex||{};
    window.setNativeTaskIndex=value=>{taskIndex=value;};
    let entry = { date: '2026-09-09', title: 'A quiet day', body,
      tags: { people: ['old friend'] }, numbers: {}, updated: null, edit_revision: editRevision, ...options.entry };
    window.setNativeEntry = value => { entry = {...entry, ...value}; };
    window.nativeEntry = () => entry;
    window.nativeSections = () => sections;
    window.conflictOnNextResolution = value => { resolutionConflict = value; };
    window.nativeHeldReads = [];
    window.releaseNativeReads = () => window.nativeHeldReads.splice(0).forEach(({id, result}) => window.PupMedia.reply(id, result));
    window.nativeRequests = [];
    window.TodoPupNative = { request(raw) {
      const call = JSON.parse(raw); window.nativeRequests.push(call);
      let result = {};
      if (call.path === 'bootstrap') result = { entry, sections,task_ref_index:taskIndex };
      if (call.path === 'state') result = { assets: options.assets || {}, places: {}, groups: options.groups || {}, messages: {} };
      if (call.path.startsWith('tracking')) result = {samples:options.samples || []};
      if (call.path === 'maps') result = {packs:[]};
      if (call.path === 'pick-photos') result = {assets:[]};
      if (call.path === 'entries') result = {entries:options.entries||[]};
      if (call.path === 'choose-date') result = { date: entry.date };
      if (call.path === 'journal-tags/archive') {
        if(window.failNativeArchive){queueMicrotask(()=>window.PupMedia.reply(call.id,null,{status:500,message:'Could not archive on phone.'}));return;}
        const section=sections.find(section=>section.id===call.body.section_id);
        section.tags=section.tags.filter(name=>name!==call.body.name);
        section.archived_tags=[...new Set([...(section.archived_tags||[]),call.body.name])];
        result={sections:JSON.parse(JSON.stringify(sections))};
        if(window.holdNativeArchive){window.releaseNativeArchive=()=>window.PupMedia.reply(call.id,result);return;}
      }
      if(call.path==='open-task'&&options.missingTask){queueMicrotask(()=>window.PupMedia.reply(call.id,null,{status:404,message:'Task is no longer available.',task_ref_index:{[call.body.id]:{status:'missing',done:false,title:''}}}));return;}
      if (call.path === 'entry/' + entry.date) {
        result = {entry,task_ref_index:taskIndex};
        if (window.holdNativeReads) { window.nativeHeldReads.push({id:call.id,result:JSON.parse(JSON.stringify(result))}); return; }
      }
      if (call.path === 'journal-conflicts/resolve') {
        if (resolutionConflict) { entry=resolutionConflict;resolutionConflict=null;queueMicrotask(()=>window.PupMedia.reply(call.id,null,{status:409,message:'Entry changed again',current:entry}));return; }
        entry = call.body.choice === 'remote' ? {...entry.server_version, sync_state:'SYNCED',server_version:null,updated:'resolved'} : {...entry,...call.body.draft,sync_state:'PENDING',server_version:null,updated:'resolved'};
        if(call.body.choice==='local')for(const tag of entry.new_tags || []){
          const section=sections.find(section=>section.id===tag.section_id);
          if(section && tag.kind==='permanent' && !section.tags.includes(tag.name))section.tags.push(tag.name);
        }
        result = {entry,sections};
        if(window.holdNativeResolution){window.releaseNativeResolution=()=>window.PupMedia.reply(call.id,result);return;}
      }
      if (/\/(autosave|commit)$/.test(call.path)) {
        if(window.failNativeSave){queueMicrotask(()=>window.PupMedia.reply(call.id,null,{status:500,message:'Could not save on phone.'}));return;}
        const tags=Object.fromEntries(Object.entries(call.body.tags || {}).map(([sid,names])=>[sid,[...new Set(names.map(name=>name.trim().toLowerCase()))]]));
        for(const tag of call.body.new_tags || []){
          const section=sections.find(section=>section.id===tag.section_id);
          const name=tag.name.trim().toLowerCase();
          if(call.path.endsWith('/commit') && section)section.archived_tags=(section.archived_tags||[]).filter(n=>n!==name);
          if(call.path.endsWith('/commit') && section && tag.kind==='permanent' && !section.tags.includes(name))section.tags.push(name);
        }
        entry = { ...entry, ...call.body, updated: 'saved-version' };
        entry.tags=tags;
        result = { entry, sections,task_ref_index:taskIndex };
        if(window.holdNativeSave){window.releaseNativeSave=()=>window.PupMedia.reply(call.id,result);return;}
      }
      queueMicrotask(() => window.PupMedia.reply(call.id, result));
    } };
  }, { body, editRevision, options });
  await page.goto('https://todopup.local/static/mobile-journal.html'+(options.settings?'?settings=1':''));
  await page.waitForFunction(() => !!window.PupJournalEditor);
  return page;
}

test('adding journal photos passes the selected journal day to the native gallery',async()=>{
  const page=await journalPage();
  try{
    await page.getByRole('button',{name:'＋ Photos',exact:true}).click();
    await page.waitForFunction(()=>nativeRequests.some(r=>r.path==='pick-photos'));
    assert.deepEqual(await page.evaluate(()=>nativeRequests.find(r=>r.path==='pick-photos').body),{date:'2026-09-09'});
  }finally{await page.close();}
});

test('mobile photos filters capture dates, maps thumbnails, opens clustered photos and cleans up',async()=>{
  const document=[
    {id:'a',type:'photo',asset_id:'a',caption:'First',tags:{locations:['Park']}},
    {id:'b',type:'photo',asset_id:'b',caption:'Second'},
    {id:'c',type:'photo',asset_id:'c',caption:'No GPS'},
    {id:'d',type:'photo',asset_id:'d',caption:'Later'},
  ];
  const page=await journalPage('',null,{entry:{document},entries:[{date:'2026-09-09',document}],assets:{
    a:{id:'a',captured_at:'2026-09-08T12:00:00',location:{lat:37.77,lon:-122.42}},
    b:{id:'b',captured_at:'2026-09-08T18:00:00',location:{lat:37.77,lon:-122.42}},
    c:{id:'c'},d:{id:'d',captured_at:'2026-09-10T00:00:00',location:{lat:37.78,lon:-122.43}},
  }});
  try{
    await page.evaluate(()=>{window.photoMaps=[];const Base=TodoPupMap.OfflineMap;TodoPupMap.OfflineMap=class extends Base{constructor(...args){super(...args);photoMaps.push(this);}destroy(){this.testDestroyed=true;super.destroy();}};});
    await page.getByRole('button',{name:'Photos',exact:true}).click();
    await page.locator('.media-photo-map canvas').waitFor();
    assert.equal(await page.getByRole('button',{name:'Park · 1',exact:true}).count(),0);
    assert.equal(await page.locator('.media-gallery-card').count(),4);
    assert.deepEqual(await page.evaluate(()=>photoMaps.at(-1).markers.map(p=>p.asset_id).sort()),['a','b','d']);
    await page.getByRole('button',{name:'From: 2026-09-08',exact:true}).click();
    assert.equal(await page.getByRole('spinbutton',{name:'Hour',exact:true}).count(),0);
    await page.getByRole('button',{name:'September 8, 2026',exact:true}).click();
    await page.getByRole('button',{name:'To: 2026-09-10',exact:true}).click();
    await page.getByRole('button',{name:'September 8, 2026',exact:true}).click();
    assert.equal(await page.locator('.media-gallery-card').count(),2);
    assert.deepEqual(await page.evaluate(()=>photoMaps.at(-1).markers.map(p=>p.asset_id).sort()),['a','b']);
    const zoom=await page.evaluate(()=>photoMaps.at(-1).zoom);
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    assert.ok(await page.evaluate(z=>photoMaps.at(-1).zoom>z,zoom));
    const point=await page.evaluate(()=>{const map=photoMaps.at(-1),p=map.pixel(-122.42,37.77);return{x:p.x,y:p.y-22};});
    await page.locator('.media-photo-map canvas').click({position:point});
    const choices=page.getByRole('dialog',{name:'Photos at this location',exact:true});await choices.waitFor();
    await choices.getByRole('button',{name:'First',exact:true}).click();
    await page.getByRole('dialog',{name:'Photo',exact:true}).waitFor();
    await page.locator('.media-full-image').waitFor();
    await page.getByRole('button',{name:'Close Photo',exact:true}).click();
    await page.getByRole('button',{name:'All dates',exact:true}).click();
    assert.equal(await page.locator('.media-gallery-card').count(),4);
    await page.getByText('1 photo without a location', {exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.PHOTO_QA_SCREENSHOT)await page.screenshot({path:process.env.PHOTO_QA_SCREENSHOT,fullPage:true});
    await page.getByRole('button',{name:'Entry',exact:true}).click();
    assert.equal(await page.evaluate(()=>photoMaps.every(m=>m.testDestroyed)),true);
  }finally{await page.close();}
});

test('photo ranges survive refresh and handle empty, reversed and unlocated results',async()=>{
  const document=[{id:'a',type:'photo',asset_id:'a',caption:'On the map'},{id:'b',type:'photo',asset_id:'b',caption:'At home'}];
  const page=await journalPage('',null,{entry:{document},entries:[{date:'2026-09-09',document}],assets:{
    a:{id:'a',captured_at:'2026-09-08T12:00:00',location:{lat:37.77,lon:-122.42}},b:{id:'b'},
  }});
  try{
    await page.evaluate(()=>{window.photoMaps=[];const Base=TodoPupMap.OfflineMap;TodoPupMap.OfflineMap=class extends Base{constructor(...args){super(...args);photoMaps.push(this);}destroy(){this.testDestroyed=true;super.destroy();}};});
    await page.getByRole('button',{name:'Photos',exact:true}).click();await page.locator('.media-photo-map canvas').waitFor();
    async function range(from,to){await page.evaluate(([from,to])=>{for(const [name,value] of [['From',from],['To',to]]){const input=document.querySelector('.media-photo-range input[aria-label="'+name+'"]');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));}},[from,to]);}
    await range('2026-09-08','2026-09-08');
    await page.evaluate(()=>document.querySelector('.media-photo-map').parentElement._refreshPhotos());
    assert.equal(await page.getByRole('button',{name:'To: 2026-09-08',exact:true}).count(),1);
    assert.equal(await page.locator('.media-gallery-card').count(),1);
    assert.equal(await page.evaluate(()=>photoMaps[0].testDestroyed),true);
    const point=await page.evaluate(()=>{const map=photoMaps.at(-1),p=map.pixel(-122.42,37.77);return{x:p.x,y:p.y-22};});
    await page.locator('.media-photo-map canvas').click({position:point});
    await page.getByRole('dialog',{name:'Photo',exact:true}).waitFor();
    await page.getByRole('button',{name:'Close Photo',exact:true}).click();
    await range('2026-09-09','2026-09-09');
    assert.equal(await page.locator('.media-gallery-card').count(),1);
    assert.equal(await page.evaluate(()=>photoMaps.at(-1).markers.length),0);
    await page.getByText('1 photo without a location',{exact:true}).waitFor();
    await range('2026-09-10','2026-09-10');assert.equal(await page.locator('.media-gallery-card').count(),0);
    await range('2026-09-10','2026-09-08');await page.getByText('From must be on or before To.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>photoMaps.at(-1).markers.length),0);
    await page.setViewportSize({width:360,height:800});
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';document.body.style.fontSize='28px';});
    await page.getByRole('button',{name:'All dates',exact:true}).click();
    assert.equal(await page.locator('.media-gallery-card').count(),2);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await page.close();}
});

test('photo date controls never overlap at phone widths or enlarged text',async()=>{
  const page=await journalPage('',null,{assets:{photo:{id:'photo',captured_at:'2026-09-10T12:00:00'}},entries:[{date:'2026-09-10',document:[{id:'photo',type:'photo',asset_id:'photo'}]}]});
  try{
    await page.getByRole('button',{name:'Photos',exact:true}).click();
    await page.getByRole('button',{name:'From: 2026-09-10',exact:true}).waitFor();
    for(const width of [320,360,393,600,780])for(const scale of [1,1.3,2]){
      await page.setViewportSize({width,height:852});
      await page.evaluate(scale=>{document.documentElement.style.fontSize=16*scale+'px';document.body.style.fontSize=14*scale+'px';},scale);
      const layout=await page.locator('.media-photo-range').evaluate(range=>{
        const rect=el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        return{range:rect(range),controls:[...range.querySelectorAll('button')].map(button=>({box:rect(button),field:rect(button.closest('.media-field')||range),text:button.querySelector('.cs-value')?rect(button.querySelector('.cs-value')):null})),overflow:document.documentElement.scrollWidth>innerWidth};
      });
      const context=JSON.stringify({width,scale,layout});
      assert.equal(layout.overflow,false,context);
      for(const {box,field,text}of layout.controls){
        assert.ok(box.left>=field.left-.5&&box.right<=field.right+.5,context);
        assert.ok(box.left>=layout.range.left-.5&&box.right<=layout.range.right+.5,context);
        if(text)assert.ok(text.left>=box.left&&text.right<=box.right,context);
      }
      for(let i=0;i<layout.controls.length;i++)for(let j=i+1;j<layout.controls.length;j++){
        const a=layout.controls[i].box,b=layout.controls[j].box;
        assert.ok(a.right+4<=b.left||b.right+4<=a.left||a.bottom+4<=b.top||b.bottom+4<=a.top,context);
      }
    }
    await page.setViewportSize({width:393,height:852});
    await page.evaluate(()=>{document.documentElement.style.fontSize='16px';document.body.style.fontSize='14px';});
    for(const name of ['From','To']){
      await page.getByRole('button',{name:name+': 2026-09-10',exact:true}).click();
      const calendar=page.getByRole('dialog',{name,exact:true});await calendar.waitFor();
      const box=await calendar.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=393);
      await calendar.getByRole('button',{name:'September 10, 2026',exact:true}).click();
      await calendar.waitFor({state:'detached'});
    }
    if(process.env.PHOTO_SPACING_SCREENSHOT)await page.screenshot({path:process.env.PHOTO_SPACING_SCREENSHOT,fullPage:true});
  }finally{await page.close();}
});

test('mobile tag Enter explicitly adds and selects without relying on implicit submit',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true});
    await field.fill('  New Friend  ');
    await field.evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
    const chip=page.locator('.media-tag-chips input[value="new friend"]');await chip.waitFor();
    assert.equal(await chip.isChecked(),true);
    assert.equal(await field.inputValue(),'');
    assert.equal(await field.getAttribute('enterkeyhint'),'done');
    assert.equal(await field.evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.evaluate(()=>nativeRequests.filter(call=>call.path.endsWith('/commit')).length),1);
    await field.fill('composing');
    await field.evaluate(input=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})));
    assert.equal(await field.inputValue(),'composing');
    assert.equal(await page.evaluate(()=>nativeRequests.filter(call=>call.path.endsWith('/commit')).length),1);
  }finally{await page.close();}
});

test('Chinese tags add selected with Enter, archive, and restore temporarily',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true});
    for(const name of ['朋友','臺灣家人','Work 工作2','𠀀家']){
      await field.fill(name);await field.press('Enter');
      await page.waitForFunction(name=>Array.from(document.querySelectorAll('.media-tag-chips input')).some(el=>el.value===name.toLowerCase()&&el.checked),name);
      await page.waitForFunction(()=>document.querySelector('[name="newtag-name:people"]').value==='');
      assert.ok((await page.evaluate(()=>nativeEntry().tags.people)).includes(name.toLowerCase()));
    }
    const chip=page.locator('.media-tag-chips input[value="朋友"]').locator('..');
    await chip.dispatchEvent('contextmenu');
    await page.getByRole('button',{name:'Archive tag',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(await chip.isVisible(),false);
    assert.ok((await page.evaluate(()=>nativeEntry().tags.people)).includes('朋友'));
    await field.fill('朋友');await field.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[name="newtag-name:people"]').value==='');
    assert.equal(await page.locator('.media-tag-chips input[value="朋友"]').isChecked(),true);
    assert.equal(await page.locator('.media-tag-chips input[value="朋友"]').locator('..').isVisible(),true);
    const state=await page.evaluate(()=>nativeSections()[0]);
    assert.equal(state.tags.includes('朋友'),false);assert.equal(state.archived_tags.includes('朋友'),false);
  }finally{await page.close();}
});

test('Chinese tag length counts characters and retains an overlong draft',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true}),name='𠀀'.repeat(200);
    await page.evaluate(()=>window.holdNativeSave=true);
    await field.fill(name);await field.press('Enter');
    assert.equal(await page.locator('.media-tag-chips input').evaluateAll((els,name)=>els.some(el=>el.value===name&&el.checked),name),true);
    await page.evaluate(()=>{window.holdNativeSave=false;releaseNativeSave();});
    await page.waitForFunction(()=>document.querySelector('[name="newtag-name:people"]').value==='');
    await field.fill(name+'家');await field.press('Enter');
    assert.equal(await field.inputValue(),name+'家');
    assert.equal(await page.locator('#draft-status').textContent(),'Add people tag: use at most 200 characters.');
    assert.equal(await page.evaluate(()=>nativeRequests.filter(call=>call.path.endsWith('/commit')).length),1);
  }finally{await page.close();}
});

test('Chinese mentions reflect without selecting an ASCII prefix or swallowing punctuation',async()=>{
  const page=await journalPage('',null,{tagNames:['朋友','家人 臺灣','work','𠀀家','李.明']});
  try{
    await page.getByRole('textbox',{name:'Journal paragraph'}).fill('和 @朋友、@家人_臺灣，@李.明。@𠀀家 @work朋友');
    await page.locator('[name="title"]').click();
    assert.deepEqual(await page.locator('.media-paragraph-view .mention-highlight').allTextContents(),['朋友','家人 臺灣','李.明','𠀀家']);
    const selected=await page.evaluate(()=>PupJournalEditor.collect().tags.people);
    for(const name of ['朋友','家人 臺灣','李.明','𠀀家'])assert.ok(selected.includes(name));
    assert.equal(selected.includes('work'),false);
  }finally{await page.close();}
});

test('Enter selects an existing tag before its reply and retains newer typing',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true}),chip=page.locator('.media-tag-chips input[value="alex"]');
    await page.evaluate(()=>window.holdNativeSave=true);await field.fill('alex');await field.press('Enter');
    await page.waitForFunction(()=>!!window.releaseNativeSave);
    assert.equal(await chip.isChecked(),true);
    await field.fill('next friend');await page.evaluate(()=>{window.holdNativeSave=false;releaseNativeSave();});
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent==='New changes waiting to save');
    assert.equal(await field.inputValue(),'next friend');assert.equal(await chip.isChecked(),true);
    assert.ok((await page.evaluate(()=>PupJournalEditor.collect().tags.people)).includes('alex'));
  }finally{await page.close();}
});

test('unchecking an Enter-added tag while saving wins over the delayed reply',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true});
    await page.evaluate(()=>window.holdNativeSave=true);await field.fill('entered friend');await field.press('Enter');
    const chip=page.locator('.media-tag-chips input[value="entered friend"]');await chip.waitFor();
    await chip.uncheck();await page.evaluate(()=>{window.holdNativeSave=false;releaseNativeSave();});
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent==='New changes waiting to save');
    assert.equal(await field.inputValue(),'');assert.equal(await chip.isChecked(),false);
    assert.equal((await page.evaluate(()=>PupJournalEditor.collect().tags.people)).includes('entered friend'),false);
  }finally{await page.close();}
});

test('deselecting a tag after failed Enter stays deselected when saving again',async()=>{
  const page=await journalPage();
  try{
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true});
    await page.evaluate(()=>window.failNativeSave=true);await field.fill('new friend');await field.press('Enter');
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent.includes('retrying'));
    const chip=page.locator('.media-tag-chips input[value="new friend"]');await chip.uncheck();
    await page.evaluate(()=>window.failNativeSave=false);await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent==='Saved on phone · ready for USB sync');
    assert.equal(await chip.isChecked(),false);
    assert.equal((await page.evaluate(()=>nativeEntry().tags.people)).includes('new friend'),false);
  }finally{await page.close();}
});

test('holding a journal tag offers Archive and preserves its historical selection',async()=>{
  const page=await journalPage();
  try{
    const input=page.locator('.media-tag-chips input[value="old friend"]');
    const chip=input.locator('..'),box=await chip.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(600);await page.mouse.up();
    const dialog=page.getByRole('dialog',{name:'Tag options',exact:true});await dialog.waitFor();
    assert.equal(await input.isChecked(),true);
    await dialog.getByRole('button',{name:'Archive tag',exact:true}).click();
    await dialog.waitFor({state:'detached'});
    assert.equal(await chip.isVisible(),false);
    assert.equal(await input.isChecked(),true);
    assert.ok((await page.evaluate(()=>PupJournalEditor.collect().tags.people)).includes('old friend'));
    assert.equal(await page.getByRole('textbox',{name:'Add people tag',exact:true}).evaluate(el=>el===document.activeElement),true);
    const stored=await page.evaluate(()=>({entry:nativeEntry(),archived:nativeSections()[0].archived_tags}));
    assert.deepEqual(stored.entry.tags.people,['old friend']);assert.deepEqual(stored.archived,['old friend']);
  }finally{await page.close();}
});

for(const duration of [650,1800])test('releasing a '+duration+'ms tag hold cannot press the newly opened Archive button',async()=>{
  const page=await journalPage();
  try{
    const touch=await page.context().newCDPSession(page),chip=page.locator('.media-tag-chips input[value="old friend"]').locator('..'),box=await chip.boundingBox();
    await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width-5,y:box.y+box.height-5}]});
    await page.waitForTimeout(duration);
    await page.getByRole('dialog',{name:'Tag options',exact:true}).waitFor();
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>nativeRequests.filter(c=>c.path==='journal-tags/archive').length),0);
    const archive=page.getByRole('button',{name:'Archive tag',exact:true}),action=await archive.boundingBox();
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:action.x+action.width/2,y:action.y+action.height/2}]});
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(()=>nativeRequests.some(c=>c.path==='journal-tags/archive'));
    assert.equal(await page.getByRole('dialog').count(),0);
  }finally{await page.close();}
});

test('scrolling cancels tag hold; failed archiving keeps the tag and offers retry',async()=>{
  const page=await journalPage();
  try{
    const input=page.locator('.media-tag-chips input[value="alex"]'),chip=input.locator('..'),box=await chip.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y+80);await page.waitForTimeout(600);await page.mouse.up();
    assert.equal(await page.getByRole('dialog').count(),0);
    await chip.dispatchEvent('contextmenu');
    const dialog=page.getByRole('dialog',{name:'Tag options',exact:true});await dialog.waitFor();
    await page.evaluate(()=>window.failNativeArchive=true);
    await dialog.getByRole('button',{name:'Archive tag',exact:true}).click();
    await dialog.getByText('Could not archive on phone.',{exact:true}).waitFor();assert.equal(await chip.isVisible(),true);
    await page.evaluate(()=>window.failNativeArchive=false);
    await dialog.getByRole('button',{name:'Archive tag',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal(await chip.isVisible(),false);
  }finally{await page.close();}
});

test('archived tags stay hidden after reload and explicit temporary re-add restores the chip',async()=>{
  const page=await journalPage('',null,{archivedTags:['old friend']});
  try{
    const input=page.locator('.media-tag-chips input[value="old friend"]');assert.equal(await input.locator('..').isVisible(),false);
    const field=page.getByRole('textbox',{name:'Add people tag',exact:true});await field.fill('old friend');await field.press('Enter');
    await page.waitForFunction(()=>!document.querySelector('input[value="old friend"]').closest('label').hidden);
    assert.equal(await input.isChecked(),true);assert.equal(await input.locator('..').evaluate(el=>el.classList.contains('temp')),true);
    assert.equal(await page.locator('.media-tag-chips input[value="old friend"]').count(),1);
    assert.equal(await page.evaluate(()=>nativeSections()[0].tags.includes('old friend')),false);
  }finally{await page.close();}
});

test('an archived mention keeps its entry data without recreating a visible chip',async()=>{
  const page=await journalPage('',null,{archivedTags:['past trip']});
  try{
    const paragraph=page.getByRole('textbox',{name:'Journal paragraph',exact:true}).first();await paragraph.fill('@past_trip');await paragraph.blur();
    const input=page.locator('.media-tag-chips input[value="past trip"]');await input.waitFor({state:'attached'});
    assert.equal(await input.locator('..').isVisible(),false);
    assert.equal(await input.isChecked(),true);
    assert.ok((await page.evaluate(()=>PupJournalEditor.collect().tags.people)).includes('past trip'));
  }finally{await page.close();}
});

test('adopting a photo-only reply keeps the journal clean',async()=>{
  const page=await journalPage('Original paragraph',null,{entry:{updated:'photo-v1',mood:4,document:[{id:'text',type:'text',text:'Original paragraph'}]}});
  try{
    const result=await page.evaluate(async()=>{
      const accepted=PupJournalEditor.acceptPhotoEntry({...nativeEntry(),updated:'photo-v2',title:'Photo reply title'});
      await PupJournalEditor.save();
      return {accepted,writes:nativeRequests.filter(r=>r.path.endsWith('/autosave')).length};
    });
    assert.deepEqual(result,{accepted:true,writes:0});
  }finally{await page.close();}
});

test('a photo-only reply cannot replace newer journal typing',async()=>{
  const page=await journalPage('Original paragraph');
  try{
    const title=page.locator('[name=title]');await title.fill('Newer title');
    assert.equal(await page.evaluate(()=>PupJournalEditor.acceptPhotoEntry({...nativeEntry(),title:'Stale title'})),false);
    assert.equal(await title.inputValue(),'Newer title');
  }finally{await page.close();}
});

test('only permanent and current-entry tags are choices; circles still allow multiple selections', async () => {
  const page = await journalPage();
  try {
    const choices = page.locator('input[name="tag:people"]');
    assert.deepEqual(await choices.evaluateAll(inputs => inputs.map(input => input.value)), ['alex', 'sam', 'old friend']);
    const ring = await choices.first().evaluate(input => {
      const style = getComputedStyle(input), theme = getComputedStyle(document.documentElement);
      return { size: style.width, borderWidth: style.borderWidth, borderColor: style.borderColor,
        background: style.backgroundColor, border: theme.getPropertyValue('--border').trim(),
        bg: theme.getPropertyValue('--bg').trim() };
    });
    const rgb = hex => 'rgb(' + hex.slice(1).match(/../g).map(part => parseInt(part, 16)).join(', ') + ')';
    assert.equal(ring.size, '17px');
    assert.equal(ring.borderWidth, '1px');
    assert.equal(ring.borderColor, rgb(ring.border));
    assert.equal(ring.background, rgb(ring.bg));
    await page.locator('input[value="alex"]').check();
    await page.locator('input[value="sam"]').check();
    assert.equal(await choices.evaluateAll(inputs => inputs.filter(input => input.checked).length), 3);
    for (const radius of await choices.evaluateAll(inputs => inputs.map(input => getComputedStyle(input).borderRadius))) assert.equal(radius, '50%');
    assert.ok(await choices.evaluateAll(inputs => inputs.every(input => {
      const box = input.getBoundingClientRect(); return box.width === box.height;
    })));
    assert.ok(await choices.first().evaluate(input => getComputedStyle(input).boxShadow.includes('inset')));
  } finally { await page.close(); }
});

test('the mobile editor sends its bootstrap content revision with journal saves', async () => {
  const page = await journalPage('A note', 'server-content');
  try {
    await page.locator('.media-paragraph-view').click();
    await page.getByRole('textbox', {name: 'Journal paragraph'}).fill('An edited note');
    await page.getByRole('button', {name: 'Save entry', exact: true}).click();
    await page.waitForFunction(() => window.nativeRequests.some(r => r.path.endsWith('/commit')));
    const payload = await page.evaluate(() => window.nativeRequests.find(r => r.path.endsWith('/commit')).body);
    assert.equal(payload.base_edit_revision, 'server-content');
    assert.equal(payload.body, 'An edited note');
  } finally { await page.close(); }
});

test('shared mobile dialogs match native gutters and heading typography', async () => {
  const page = await journalPage();
  try {
    await page.evaluate(() => {
      const d = window.PupMedia.dialog('Photo details', true);
      d.actions.append(window.PupMedia.button('Cancel', d.close), window.PupMedia.button('Save details', d.close, 'save'));
    });
    const metrics = await page.getByRole('dialog', {name: 'Photo details'}).evaluate(dialog => {
      const title = dialog.querySelector('h3'), titleStyle = getComputedStyle(title), box = dialog.getBoundingClientRect();
      return {left: box.left, right: innerWidth - box.right, fontSize: titleStyle.fontSize,
        color: titleStyle.color, text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim()};
    });
    assert.equal(metrics.left, 18); assert.equal(metrics.right, 18);
    assert.equal(metrics.fontSize, '18px');
    assert.equal(metrics.color, 'rgb(' + metrics.text.slice(1).match(/../g).map(part => parseInt(part, 16)).join(', ') + ')');
    assert.ok((await page.getByRole('button', {name: 'Save details', exact: true}).boundingBox()).height >= 44);
    await page.setViewportSize({width: 360, height: 800});
    await page.locator('.media-dialog-actions').evaluate(actions => {
      actions.style.width = '288px';
      for (const button of actions.children) button.style.fontSize = '20px';
    });
    const cancel = await page.getByRole('button', {name: 'Cancel', exact: true}).boundingBox();
    const save = await page.getByRole('button', {name: 'Save details', exact: true}).boundingBox();
    assert.equal(cancel.height, save.height, 'footer controls remain aligned when a label wraps');
  } finally { await page.close(); }
});

test('historical temporary mentions appear only when used and remain selected on save', async () => {
  const page = await journalPage();
  try {
    const input = page.getByRole('textbox', { name: 'Journal paragraph' });
    await input.fill('Remembering @past_trip.');
    await page.locator('[name="title"]').click();
    assert.equal(await page.locator('input[name="tag:people"][value="past trip"]').isChecked(), true);
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await page.waitForFunction(() => window.nativeRequests.some(r => r.path.endsWith('/commit')));
    const saved = await page.evaluate(() => window.nativeRequests.find(r => r.path.endsWith('/commit')).body);
    assert.deepEqual(saved.tags.people, ['old friend', 'past trip']);
    assert.equal(await page.locator('input[value="past trip"]').evaluate(input => getComputedStyle(input).borderRadius), '50%');
  } finally { await page.close(); }
});

test('added and recorded temporary tags are kept without exposing the rest of history', async () => {
  const page = await journalPage();
  try {
    await page.getByRole('textbox', { name: 'Add people tag' }).fill('new friend');
    await page.evaluate(() => window.PupDictationCapture({ text: 'An afternoon walk.', tags: { people: ['voice friend'] } }));
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await page.waitForFunction(() => window.nativeRequests.some(r => r.path.endsWith('/commit'))).catch(async error => {
      throw Error(error.message + JSON.stringify(await page.evaluate(() => ({
        calls: window.nativeRequests, status: document.getElementById('draft-status').textContent,
        invalid: [...document.querySelectorAll(':invalid')].map(el => ({name:el.name, message:el.validationMessage})),
        fields: window.PupJournalEditor.collect(),
      }))));
    });
    const saved = await page.evaluate(() => window.nativeRequests.find(r => r.path.endsWith('/commit')).body);
    assert.deepEqual([...saved.tags.people].sort(), ['new friend', 'old friend', 'voice friend']);
    assert.deepEqual(saved.new_tags, [{ section_id: 'people', name: 'new friend', kind: 'temporary' }]);
    assert.equal(await page.locator('input[value="past trip"]').count(), 0);
    assert.equal(await page.locator('input[value="voice friend"]').evaluate(input => getComputedStyle(input).borderRadius), '50%');
  } finally { await page.close(); }
});

test('recording is in the textbox corner and date spacing is compact', async () => {
  const page = await journalPage('Hello there');
  try {
    assert.equal(await page.getByRole('button', { name: 'Writing / dictation', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Dictate', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Stop dictation', exact: true }).count(), 0);
    const record = page.getByRole('button', { name: 'Record voice', exact: true });
    const button = await record.boundingBox();
    assert.equal(button.width,26); assert.equal(button.height,26);
    const dot=await record.locator('.dictation-mic-dot').boundingBox();
    assert.equal(dot.width,8); assert.equal(dot.height,8);
    assert.ok(Math.abs(dot.x+dot.width/2-button.x-button.width/2)<.5);
    assert.ok(Math.abs(dot.y+dot.height/2-button.y-button.height/2)<.5);
    assert.equal(await record.evaluate(el => getComputedStyle(el).borderRadius), '50%');
    const assertEqualInsets = async textbox => {
      const box = await textbox.boundingBox(), mic = await record.boundingBox();
      const top = mic.y - box.y, right = box.x + box.width - mic.x - mic.width;
      assert.ok(top > 0 && right > 0);
      assert.ok(Math.abs(top - right) < .5, `Record insets differ: top ${top}px, right ${right}px`);
    };
    await assertEqualInsets(page.locator('.media-paragraph-view'));
    await page.locator('.media-paragraph-view').click();
    await assertEqualInsets(page.getByRole('textbox', { name: 'Journal paragraph' }));
    await record.click();
    assert.ok(await page.evaluate(() => window.nativeRequests.some(r => r.path === 'dictation' && r.body.action === 'start')));
    await page.evaluate(() => window.PupDictationCapture({text:' A recorded note.'}));
    const paragraph = page.getByRole('textbox', { name: 'Journal paragraph' });
    assert.equal(await paragraph.isVisible(), true);
    assert.equal(await paragraph.inputValue(), 'Hello there A recorded note.');
    await assertEqualInsets(paragraph);
    await page.locator('[name="title"]').click();
    const heading = page.locator('.media-mobile-heading');
    assert.ok((await heading.boundingBox()).height <= 36);
    assert.ok(await heading.evaluate(el => parseFloat(getComputedStyle(el).marginBottom) <= 4));
    await page.getByRole('button', { name: /Choose journal date/ }).click();
    assert.ok(await page.evaluate(() => window.nativeRequests.some(r => r.path === 'choose-date')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.MOBILE_UI_SCREENSHOT) await page.screenshot({ path: process.env.MOBILE_UI_SCREENSHOT });
  } finally { await page.close(); }
});

test('mobile tag entry uses one section label and a compact input row', async () => {
  const page = await journalPage();
  try {
    const section = page.locator('.media-entry-section').first();
    const input = section.getByRole('textbox', {name: 'Add people tag', exact: true});
    await input.waitFor();
    const layout = await section.evaluate(el => {
      const input = el.querySelector('input[name^="newtag-name:"]');
      const kinds = el.querySelector('.kind-toggle');
      return {
        font: getComputedStyle(document.body).fontFamily,
        fontSize: getComputedStyle(document.body).fontSize,
        repeatedLabel: [...el.querySelectorAll('.media-field > .label')].some(label => label.getClientRects().length),
        inputY: input.getBoundingClientRect().top,
        kindsY: kinds.getBoundingClientRect().top,
        overflow: el.scrollWidth > el.clientWidth,
      };
    });
    assert.equal(layout.font, '"Courier New", ui-monospace, "SF Mono", Menlo, monospace');
    assert.equal(layout.fontSize, '16px');
    assert.equal(layout.repeatedLabel, false);
    assert.ok(Math.abs(layout.inputY - layout.kindsY) < 5, JSON.stringify(layout));
    assert.equal(layout.overflow, false);
    await input.fill('a new friend');
    await page.getByRole('button', {name: 'Save entry', exact: true}).click();
    await page.waitForFunction(() => window.nativeRequests.some(r => r.path.endsWith('/commit')));
    assert.ok((await page.evaluate(() => window.nativeRequests.find(r => r.path.endsWith('/commit')).body.tags.people)).includes('a new friend'));
  } finally { await page.close(); }
});

test('saving added tags shows selected chips and keeps only permanent choices on other days', async () => {
  const page = await journalPage();
  let otherDay;
  try {
    const group=page.locator('.media-entry-section').first();
    const input=group.getByRole('textbox',{name:'Add people tag',exact:true});
    await input.fill('  New Friend  ');
    await group.locator('.kind-opt').filter({has:page.locator('input[value="permanent"]')}).click();
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    const permanent=group.locator('.media-tag-chips input[value="new friend"]');
    await permanent.waitFor();
    assert.equal(await permanent.isChecked(),true);
    assert.equal(await permanent.evaluate(el=>el.closest('label').classList.contains('temp')),false);
    assert.equal(await input.inputValue(),'');
    await input.fill('one day only');
    await group.locator('.kind-opt').filter({has:page.locator('input[value="temporary"]')}).click();
    await input.press('Enter');
    const temporary=group.locator('.media-tag-chips input[value="one day only"]');
    await temporary.waitFor();
    assert.equal(await temporary.isChecked(),true);
    assert.equal(await temporary.evaluate(el=>el.closest('label').classList.contains('temp')),true);
    assert.equal(await input.inputValue(),'');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.MOBILE_TAG_SCREENSHOT)await page.screenshot({path:process.env.MOBILE_TAG_SCREENSHOT});
    const stored=await page.evaluate(()=>({entry:window.nativeEntry(),sections:window.nativeSections()}));
    assert.deepEqual([...stored.entry.tags.people].sort(),['new friend','old friend','one day only']);
    otherDay=await journalPage('',null,{entry:{date:'2026-09-10',tags:{}},tagNames:stored.sections[0].tags});
    assert.equal(await otherDay.locator('input[value="new friend"]').isChecked(),false);
    assert.equal(await otherDay.locator('input[value="one day only"]').count(),0);
    // A second save can deselect an added tag without re-adding it from the input.
    await temporary.uncheck();
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await page.waitForFunction(()=>!window.nativeEntry().tags.people.includes('one day only'));
  } finally { await otherDay?.close(); await page.close(); }
});

test('tag save replies preserve newer typing and failed saves keep the chosen kind', async () => {
  const page=await journalPage();
  try {
    const group=page.locator('.media-entry-section').first();
    const input=group.getByRole('textbox',{name:'Add people tag',exact:true});
    await input.fill('first friend');
    await group.locator('.kind-opt').filter({has:page.locator('input[value="permanent"]')}).click();
    await page.evaluate(()=>{window.holdNativeSave=true;});
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await page.waitForFunction(()=>!!window.releaseNativeSave);
    await input.fill('second friend');
    await page.evaluate(()=>{window.holdNativeSave=false;window.releaseNativeSave();});
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent==='New changes waiting to save');
    assert.equal(await input.inputValue(),'second friend');
    assert.equal(await group.locator('.media-tag-chips input[value="first friend"]').isChecked(),true);
    assert.equal(await group.getByRole('radio',{name:'permanent',exact:true}).isChecked(),true);
    await page.evaluate(()=>{window.failNativeSave=true;});
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('draft-status').textContent.includes('retrying'));
    assert.equal(await input.inputValue(),'second friend');
    assert.equal(await group.getByRole('radio',{name:'permanent',exact:true}).isChecked(),true);
    await page.evaluate(()=>{window.failNativeSave=false;});
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await group.locator('.media-tag-chips input[value="second friend"]').waitFor();
    assert.equal(await input.inputValue(),'');
    assert.ok((await page.evaluate(()=>window.nativeEntry().tags.people)).includes('first friend'));
  } finally { await page.close(); }
});

test('making a temporary tag permanent updates the existing chip without duplicating it', async () => {
  const page=await journalPage();
  try {
    const group=page.locator('.media-entry-section').first();
    await group.getByRole('textbox',{name:'Add people tag',exact:true}).fill('old friend');
    await group.locator('.kind-opt').filter({has:page.locator('input[value="permanent"]')}).click();
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    await page.waitForFunction(()=>window.nativeSections()[0].tags.includes('old friend'));
    const choice=group.locator('.media-tag-chips input[value="old friend"]');
    assert.equal(await choice.count(),1);
    assert.equal(await choice.isChecked(),true);
    assert.equal(await choice.evaluate(el=>el.closest('label').classList.contains('temp')),false);
    assert.equal(await group.getByRole('textbox',{name:'Add people tag',exact:true}).inputValue(),'');
  } finally { await page.close(); }
});


test('native conflict status appears without reload and compares all changed fields before resolution', async () => {
  const page = await journalPage('Phone paragraph.', 'phone-content', {entry:{updated:'phone-local-v1',mood:2,numbers:{hours:3},tags:{people:['alex']}},sections:[{id:'hours',name:'sleep hours',type:'numeric',color:'#e0a955'}]});
  try {
    await page.evaluate(() => window.setNativeEntry({sync_state:'CONFLICT',server_version:{title:'Mac title',body:'Mac paragraph.',document:[{id:'remote',type:'text',text:'Mac paragraph.',links:[]}],mood:6,tags:{people:['sam']},numbers:{hours:8},updated:'mac-v2'}}));
    await page.getByRole('button',{name:'Review Mac changes',exact:true}).waitFor();
    assert.match(await page.locator('#draft-status').textContent(),/review/);
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'Review entry',exact:true});
    const phone = dialog.getByRole('region',{name:'Phone',exact:true});
    const mac = dialog.getByRole('region',{name:'Mac',exact:true});
    assert.match(await phone.textContent(),/A quiet day/); assert.match(await mac.textContent(),/Mac title/);
    assert.match(await phone.textContent(),/Phone paragraph/); assert.match(await mac.textContent(),/Mac paragraph/);
    assert.match(await phone.textContent(),/alex/); assert.match(await mac.textContent(),/sam/);
    assert.match(await phone.textContent(),/2/); assert.match(await mac.textContent(),/6/);
    assert.match(await phone.textContent(),/sleep hours.*3/s); assert.match(await mac.textContent(),/sleep hours.*8/s);
    await dialog.getByRole('button',{name:'Use Mac',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.equal(await page.locator('[name=title]').inputValue(),'Mac title');
    assert.equal(await page.getByRole('button',{name:'Review Mac changes',exact:true}).count(),0);
    const resolution = await page.evaluate(() => window.nativeRequests.find(r=>r.path==='journal-conflicts/resolve').body);
    assert.equal(resolution.expected_updated,'phone-local-v1');
    assert.equal(resolution.expected_server_version.title,'Mac title');
  } finally { await page.close(); }
});

test('initial conflict includes archived fields and long paragraphs without nested clipping', async () => {
  const page = await journalPage('Phone paragraph. '.repeat(30), null, {entry:{updated:'phone-v1',sync_state:'CONFLICT',tags:{retired:['phone history']},server_version:{title:'Mac title',body:'Mac paragraph.',tags:{retired:['Mac history']},updated:'mac-v1'}},sections:[{id:'retired',name:'past interests',type:'tag',archived:true}]});
  try {
    await page.setViewportSize({width:360,height:800});
    await page.getByRole('textbox',{name:'Add people tag',exact:true}).fill('review friend');
    await page.locator('.kind-opt').filter({has:page.locator('input[name="newtag-kind:people"][value="permanent"]')}).click();
    await page.getByRole('button',{name:'Review Mac changes',exact:true}).click();
    const phone=page.getByRole('region',{name:'Phone',exact:true});
    assert.match(await phone.textContent(),/past interests.*phone history/s);
    assert.match(await page.getByRole('region',{name:'Mac',exact:true}).textContent(),/past interests.*Mac history/s);
    const dimensions=await phone.evaluate(el=>({maxHeight:getComputedStyle(el).maxHeight,scroll:el.scrollHeight,height:el.clientHeight}));
    assert.equal(dimensions.maxHeight,'none');
    assert.ok(dimensions.scroll<=dimensions.height+1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('button',{name:'Keep phone',exact:true}).click();
    await page.getByRole('dialog',{name:'Review entry',exact:true}).waitFor({state:'hidden'});
    const resolution=await page.evaluate(()=>window.nativeRequests.find(r=>r.path==='journal-conflicts/resolve').body);
    assert.deepEqual(resolution.draft.tags.retired,['phone history']);
    const added=page.locator('.media-tag-chips input[value="review friend"]');
    assert.equal(await added.isChecked(),true);
    assert.equal(await added.evaluate(el=>el.closest('label').classList.contains('temp')),false);
    assert.equal(await page.getByRole('textbox',{name:'Add people tag',exact:true}).inputValue(),'');
    assert.equal(await page.evaluate(()=>window.nativeRequests.filter(r=>/\/(autosave|commit)$/.test(r.path)).length),0,'native resolution already queues the chosen draft');
  } finally { await page.close(); }
});

test('native bridge retains the phone revision supplied with a conflict response', async () => {
  const page=await journalPage();
  try {
    const local={updated:'phone-current',title:'Saved phone draft'};
    const result=await page.evaluate(async local=>{
      window.TodoPupNative.request=raw=>queueMicrotask(()=>window.PupMedia.reply(JSON.parse(raw).id,null,{status:409,current:{title:'Mac'},local}));
      try { await window.PupMedia.request('synthetic-conflict'); } catch(error) { return error.local; }
    },local);
    assert.deepEqual(result,local);
  } finally { await page.close(); }
});

test('stale conflict choices refresh the comparison and retain the phone draft', async () => {
  const remote={title:'First Mac title',body:'Mac paragraph.',updated:'mac-v1'};
  const page=await journalPage('Phone paragraph.',null,{entry:{updated:'phone-v1',sync_state:'CONFLICT',server_version:remote}});
  try {
    await page.getByRole('button',{name:'Review Mac changes',exact:true}).click();
    await page.evaluate(()=>window.conflictOnNextResolution({...window.nativeEntry(),updated:'phone-v2',server_version:{title:'Newer Mac title',body:'Newer Mac paragraph.',updated:'mac-v2'}}));
    await page.getByRole('button',{name:'Use Mac',exact:true}).click();
    await page.getByRole('region',{name:'Mac',exact:true}).getByText('Newer Mac title',{exact:true}).waitFor();
    assert.equal(await page.locator('[name=title]').inputValue(),'A quiet day');
    assert.match(await page.getByRole('region',{name:'Phone',exact:true}).textContent(),/Phone paragraph/);
    await page.getByRole('button',{name:'Keep phone',exact:true}).click();
    await page.getByRole('dialog',{name:'Review entry',exact:true}).waitFor({state:'hidden'});
    const choices=await page.evaluate(()=>window.nativeRequests.filter(r=>r.path==='journal-conflicts/resolve').map(r=>r.body));
    assert.equal(choices[0].expected_updated,'phone-v1');
    assert.equal(choices[1].expected_updated,'phone-v2');
    assert.equal(choices[1].expected_server_version.title,'Newer Mac title');
    assert.equal(choices[1].draft.body,'Phone paragraph.');
    assert.equal(await page.getByRole('button',{name:'Review Mac changes',exact:true}).count(),0);
  } finally { await page.close(); }
});

test('a status read started before resolution cannot revive its conflict', async () => {
  const page=await journalPage('Phone paragraph.',null,{entry:{updated:'phone-v1',sync_state:'CONFLICT',server_version:{title:'Mac title',body:'Mac paragraph.',updated:'mac-v1'}}});
  try {
    await page.evaluate(()=>{window.holdNativeReads=true;void window.PupJournalEditor.refreshNativeStatus();});
    await page.waitForFunction(()=>window.nativeHeldReads.length===1);
    await page.getByRole('button',{name:'Review Mac changes',exact:true}).click();
    await page.getByRole('button',{name:'Use Mac',exact:true}).click();
    await page.getByRole('dialog',{name:'Review entry',exact:true}).waitFor({state:'hidden'});
    await page.evaluate(()=>{window.holdNativeReads=false;window.releaseNativeReads();});
    assert.equal(await page.getByRole('button',{name:'Review Mac changes',exact:true}).count(),0);
    assert.equal(await page.locator('[name=title]').inputValue(),'Mac title');
    assert.match(await page.locator('#draft-status').textContent(),/restored/);
  } finally { await page.close(); }
});

test('typing arriving during a native choice is retained and saved after its acknowledgement', async () => {
  const page=await journalPage('Phone paragraph.',null,{entry:{updated:'phone-v1',sync_state:'CONFLICT',server_version:{title:'Mac title',body:'Mac paragraph.',updated:'mac-v1'}}});
  try {
    await page.evaluate(()=>{window.holdNativeResolution=true;});
    await page.getByRole('button',{name:'Review Mac changes',exact:true}).click();
    await page.getByRole('button',{name:'Keep phone',exact:true}).click();
    await page.waitForFunction(()=>!!window.releaseNativeResolution);
    await page.evaluate(()=>{
      const title=document.querySelector('[name=title]');title.value='Newer phone typing';title.dispatchEvent(new Event('input',{bubbles:true}));
      window.releaseNativeResolution();
    });
    await page.waitForFunction(()=>window.nativeRequests.some(r=>r.path.endsWith('/autosave')));
    const saved=await page.evaluate(()=>window.nativeRequests.find(r=>r.path.endsWith('/autosave')).body);
    assert.equal(saved.title,'Newer phone typing');assert.equal(saved.base_updated,'resolved');
    assert.equal(await page.locator('[name=title]').inputValue(),'Newer phone typing');
    assert.equal(await page.getByRole('button',{name:'Review Mac changes',exact:true}).count(),0);
  } finally { await page.close(); }
});

for(const scale of [1.3,2])test(`mobile Places labels and map footer remain clear at ${scale*100}% text`,async()=>{
  const samples=Array.from({length:26},(_,minute)=>({id:'qa-'+minute,at:'2026-09-09T12:'+String(minute).padStart(2,'0')+':00+08:00',lat:31.2,lon:minute<=12?121.5:121.501,accuracy_m:5,source_device:'phone',session:'qa'}));
  const page=await journalPage('',null,{samples});
  try{
    await page.setViewportSize({width:360,height:800});
    await page.evaluate(scale=>document.documentElement.style.fontSize=16*scale+'px',scale);
    await page.getByRole('button',{name:'Places',exact:true}).click();
    const map=page.locator('.location-mobile-day .offline-map');await map.waitFor();
    const footer=await map.evaluate(map=>{
      const data={mapBottom:map.getBoundingClientRect().bottom};for(const name of ['map-scale','map-note','map-credit']){const el=map.querySelector('.'+name),b=el.getBoundingClientRect();data[name]={top:b.top,bottom:b.bottom,left:b.left,right:b.right,clipped:el.scrollWidth>el.clientWidth};}return data;
    });
    assert.ok(footer['map-scale'].bottom<=footer['map-note'].top,JSON.stringify(footer));
    assert.ok(footer['map-note'].bottom<=footer['map-credit'].top,JSON.stringify(footer));
    assert.ok(['map-scale','map-note','map-credit'].map(key=>footer[key]).every(box=>!box.clipped&&box.left>=18&&box.right<=342&&box.bottom<=footer.mapBottom),JSON.stringify(footer));
    const laptop=page.getByRole('button',{name:'Laptop',exact:true});
    const geometry=await laptop.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);return {rects:range.getClientRects().length,whiteSpace:getComputedStyle(el).whiteSpace,direction:getComputedStyle(el).flexDirection,overflow:el.scrollWidth>el.clientWidth};});
    assert.equal(geometry.rects,1,JSON.stringify(geometry));assert.equal(geometry.direction,'column');assert.equal(geometry.overflow,false);
    const scaleStyle=await map.locator('.map-scale').evaluate(el=>{el.style.width='42px';el.style.fontSize='20px';return {width:el.style.width,border:getComputedStyle(el).borderLeftWidth,bar:getComputedStyle(el,'::after').borderBottomWidth};});
    assert.equal(scaleStyle.width,'42px');assert.equal(scaleStyle.border,'0px');assert.equal(scaleStyle.bar,'1px');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await page.close();}
});

test('mobile number validation uses the themed status and never opens browser validation chrome',async()=>{
  const page=await journalPage('',null,{entry:{numbers:{hours:3.25}},sections:[{id:'hours',name:'sleep hours',type:'numeric',unit:'hrs'}]});
  try{
    await page.evaluate(()=>{window.nativeInvalidEvents=0;document.getElementById('journal-form').addEventListener('invalid',()=>window.nativeInvalidEvents++,true);});
    const number=page.getByRole('spinbutton',{name:'sleep hours · hrs',exact:true});
    await number.fill('1');await number.press('e');
    await page.getByRole('button',{name:'Places',exact:true}).click();
    assert.equal(await number.evaluate(el=>document.activeElement===el),true,'manual navigation points to the field that needs attention');
    assert.equal(await page.getByRole('button',{name:'Entry',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'Save entry',exact:true}).click();
    assert.match(await page.locator('#draft-status').textContent(),/sleep hours.*enter a valid number/i);
    assert.equal(await number.evaluate(el=>getComputedStyle(el).borderColor),'rgb(224, 82, 77)','invalid input keeps the danger color while focused');
    assert.equal(await page.evaluate(()=>window.nativeInvalidEvents),0);
    assert.equal(await page.evaluate(()=>window.nativeRequests.some(r=>/\/(autosave|commit)$/.test(r.path))),false);
  }finally{await page.close();}
});

test('mobile settings names retain their own line at 200% text',async()=>{
  const page=await journalPage('',null,{settings:true,groups:{people:{id:'people',name:'people',tags:[],rev:1}}});
  try{
    await page.setViewportSize({width:360,height:800});
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';document.body.style.fontSize='28px';});
    const group=page.getByRole('group',{name:'people',exact:true});await group.waitFor();
    assert.equal(await group.getByRole('checkbox',{name:'Also tag entries',exact:true}).count(),0);
    const row=await group.evaluate(el=>{const title=el.querySelector('.media-settings-copy'),a=title.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(title);return{width:a.width,lines:range.getClientRects().length};});
    assert.equal(row.lines,1,JSON.stringify(row));assert.ok(row.width>=300,JSON.stringify(row));
    await group.getByRole('button',{name:'Manage tags',exact:true}).click();
    await page.getByRole('dialog',{name:'people photo tags',exact:true}).getByRole('checkbox',{name:'Also tag entries',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{await page.close();}
});

test('mobile document names follow the visible screen for accessibility',async()=>{
  const page=await journalPage();
  try{
    assert.equal(await page.title(),'Journal · Datapom');
    await page.getByRole('button',{name:'Photos',exact:true}).click();
    assert.equal(await page.title(),'Photos · Datapom');
    await page.getByRole('button',{name:'Places',exact:true}).click();
    assert.equal(await page.title(),'Places · Datapom');
    await page.getByRole('button',{name:'Entry',exact:true}).click();
    assert.equal(await page.title(),'Journal · Datapom');
  }finally{await page.close();}
  const settings=await journalPage('',null,{settings:true});
  try{assert.equal(await settings.title(),'Photos & places · Datapom');}
  finally{await settings.close();}
});

test('photo insert controls identify their group and keep keyboard focus after moving',async()=>{
  const page=await journalPage('',null,{assets:{photo:{id:'photo',filename:'QA photo'}},entry:{document:[
    {id:'first',type:'text',text:'Before',links:[]},
    {id:'photo',type:'photo',asset_id:'photo',caption:'QA caption'},
    {id:'last',type:'text',text:'After',links:[]}
  ]}});
  try{
    const group=page.getByRole('group',{name:'Photo insert: QA caption',exact:true});
    assert.equal(await group.count(),1,'photo actions have the caption as their accessible context');
    await group.getByRole('button',{name:'Remove photo',exact:true}).waitFor();
    await group.getByRole('button',{name:'Move insert down',exact:true}).click();
    assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-block-id]')?.dataset.blockId),'photo');
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Move insert up','focus stays on an available move action at the boundary');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(()=>PupJournalEditor.editor.doc.map(b=>b.id)),['first','photo','last']);
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Move insert up');
  }finally{await page.close();}
});

test('removing a photo returns keyboard focus to the following paragraph',async()=>{
  const page=await journalPage('',null,{assets:{photo:{id:'photo',filename:'QA photo'}},entry:{document:[
    {id:'first',type:'text',text:'Before',links:[]},{id:'photo',type:'photo',asset_id:'photo'},
    {id:'last',type:'text',text:'After',links:[]}
  ]}});
  try{
    await page.getByRole('button',{name:'Remove photo',exact:true}).click();
    await page.getByRole('dialog',{name:'Datapom',exact:true}).getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Remove photo',exact:true}).evaluate(x=>document.activeElement===x),true);
    await page.getByRole('button',{name:'Remove photo',exact:true}).click();
    await page.getByRole('dialog',{name:'Datapom',exact:true}).getByRole('button',{name:'Remove',exact:true}).click();
    await page.waitForFunction(()=>PupJournalEditor.editor.doc.length===2);
    assert.equal(await page.evaluate(()=>document.activeElement.closest('[data-block-id]')?.dataset.blockId),'last');
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('textbox',{name:'Journal paragraph',exact:true}).evaluate(x=>document.activeElement===x),true);
  }finally{await page.close();}
});

test('saving photo details returns focus to that insert despite the editor repaint',async()=>{
  const page=await journalPage('',null,{assets:{photo:{id:'photo',filename:'QA photo'}},entry:{document:[{id:'photo',type:'photo',asset_id:'photo',caption:'Before'}]}});
  try{
    await page.getByRole('button',{name:'Details',exact:true}).click();
    const details=page.getByRole('dialog',{name:'Photo details',exact:true});
    await details.getByRole('textbox',{name:'Caption',exact:true}).fill('After');
    await details.getByRole('button',{name:'Save',exact:true}).click();
    await details.waitFor({state:'detached'});
    assert.equal(await page.getByRole('button',{name:'Details',exact:true}).evaluate(x=>document.activeElement===x),true);
    assert.equal(await page.evaluate(()=>PupJournalEditor.editor.doc[0].caption),'After');
    await page.keyboard.press('Enter');await details.waitFor();
    assert.equal(await details.getByRole('textbox',{name:'Caption',exact:true}).inputValue(),'After');
  }finally{await page.close();}
});

test('native journal task links use cached state and open the native task after saving',async()=>{
  const page=await journalPage('[task:aaa] Walk',null,{taskIndex:{aaa:{title:'Walk',status:'active',done:false}}});
  try{
    const link=page.getByRole('link',{name:'Open task: Walk',exact:true});await link.waitFor();
    await page.locator('[name=title]').fill('Changed before opening task');
    await link.click();
    await page.waitForFunction(()=>nativeRequests.some(r=>r.path==='open-task'));
    const calls=await page.evaluate(()=>nativeRequests.filter(r=>r.path==='open-task'||/\/(autosave|commit)$/.test(r.path)));
    assert.match(calls[0].path,/\/autosave$/);assert.equal(calls[0].body.title,'Changed before opening task');
    assert.equal(calls.at(-1).path,'open-task');assert.deepEqual(calls.at(-1).body,{id:'aaa'});
    assert.match(page.url(),/mobile-journal\.html/,'native task links never navigate the WebView to a web-only page');
  }finally{await page.close();}
});

test('native task index refresh changes only task glyphs and preserves paragraph typing',async()=>{
  const page=await journalPage('[task:bbb] Finished\n[task:ccc] Waiting',null,{taskIndex:{bbb:{title:'Finished',status:'active',done:false}}});
  try{
    const input=page.getByRole('textbox',{name:'Journal paragraph',exact:true});
    await page.locator('.media-paragraph-view').click();await input.fill('[task:bbb] Finished\n[task:ccc] Waiting\nTyping stays');
    await input.press('ArrowLeft');const before=await input.evaluate(x=>({value:x.value,start:x.selectionStart,end:x.selectionEnd}));
    await page.evaluate(()=>{setNativeTaskIndex({bbb:{title:'Finished',status:'done',done:true},ccc:{title:'Waiting',status:'active',done:false}});return PupJournalEditor.refreshNativeStatus();});
    assert.deepEqual(await input.evaluate(x=>({value:x.value,start:x.selectionStart,end:x.selectionEnd})),before);
    assert.equal(await input.evaluate(x=>document.activeElement===x),true);
    await page.locator('[name=title]').click();
    await page.getByRole('link',{name:'Open task: Waiting',exact:true}).waitFor();
    assert.equal(await page.locator('.media-paragraph-view [data-task-id="bbb"]').textContent(),'☑');
    assert.equal(await page.locator('.media-paragraph-view [data-task-id="bbb"]').getAttribute('href'),'/archive');
  }finally{await page.close();}
});

test('native task navigation reports missing tasks in place and refreshes the stale link',async()=>{
  const page=await journalPage('[task:aaa] Walk',null,{taskIndex:{aaa:{title:'Walk',status:'active',done:false}},missingTask:true});
  try{
    await page.getByRole('link',{name:'Open task: Walk',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Task is no longer available.'}).waitFor();
    assert.equal(await page.getByRole('link',{name:'Open task: Walk',exact:true}).count(),0);
    assert.equal(await page.locator('.media-paragraph-view [data-task-id="aaa"]').evaluate(x=>x.tagName),'SPAN');
    assert.match(page.url(),/mobile-journal\.html/);
  }finally{await page.close();}
});

test('native mention and numeric indexes retain registered names matching object properties',async()=>{
  const page=await journalPage('@constructor @__proto__ #__proto__ 7',null,{sections:[
    {id:'literal-tags',name:'literal tags',type:'tag',color:'#e0a955',tags:['constructor','__proto__']},
    {id:'literal-number',name:'__proto__',type:'numeric',color:'#e0a955',unit:'count'}
  ]});
  try{
    const indexes=JSON.parse(await page.evaluate(()=>JSON.stringify({mentions:JSON.parse(document.getElementById('mention-index').textContent),numbers:JSON.parse(document.getElementById('numeric-index').textContent)})));
    assert.equal(indexes.mentions.constructor.section_id,'literal-tags');
    assert.equal(indexes.mentions.__proto__.section_id,'literal-tags');
    assert.equal(indexes.numbers.__proto__.section_id,'literal-number');
    assert.deepEqual(await page.locator('.media-paragraph-view .mention-highlight').allTextContents(),['constructor','__proto__']);
  }finally{await page.close();}
});

test('journal task glyphs do not inherit the circular task-input decoration',async()=>{
  const page=await journalPage('[task:aaa] Walk\n[] Fresh task',null,{taskIndex:{aaa:{title:'Walk',status:'active',done:false}}});
  try{
    const glyphs=await page.locator('.media-paragraph-view .task-check').evaluateAll(xs=>xs.map(x=>{const s=getComputedStyle(x);return{border:s.borderTopWidth,background:s.backgroundColor,width:x.getBoundingClientRect().width};}));
    assert.ok(glyphs.every(x=>x.border==='0px'&&x.background==='rgba(0, 0, 0, 0)'));
    const input=await page.evaluate(()=>{const x=document.createElement('input');x.type='checkbox';x.className='task-check';document.body.append(x);const s=getComputedStyle(x);return{border:s.borderTopWidth,radius:s.borderRadius,width:s.width};});
    assert.deepEqual(input,{border:'2px',radius:'50%',width:'18px'});
  }finally{await page.close();}
});

test('Android Back closes only the frontmost date, select, color or tag popup',async()=>{
  const page=await journalPage();
  try{
    await page.evaluate(()=>{
      const M=PupMedia,d=M.dialog('Edit draft'),caption=M.field('Draft caption','Keep this caption'),date=M.field('Taken at','2026-09-10T09:00','datetime-local'),select=M.select('Width',[['full','Full width'],['small','Small']],'full'),color=M.field('Ink','#e0a955','color'),tags=M.photoTagPicker({id:'people',name:'people',tags:['alex']});
      d.body.append(caption.wrap,date.wrap,select.wrap,color.wrap,tags.wrap);enhanceDatetime(date.input);
    });
    const dialog=page.getByRole('dialog',{name:'Edit draft',exact:true});
    for(const control of [page.getByRole('button',{name:/^Taken at:/}),page.getByRole('button',{name:'Width: Full width',exact:true}),page.getByRole('button',{name:'Ink: #e0a955',exact:true})]){
      await control.click();assert.equal(await page.evaluate(()=>PupMedia.closeTopDialog()),true);
      await dialog.waitFor();assert.equal(await page.getByRole('textbox',{name:'Draft caption',exact:true}).inputValue(),'Keep this caption');
      assert.equal(await control.getAttribute('aria-expanded'),'false');assert.equal(await control.evaluate(x=>document.activeElement===x),true);
    }
    const add=page.getByRole('combobox',{name:'Add people tag',exact:true});await add.fill('al');
    await page.getByRole('option',{name:'alex',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>PupMedia.closeTopDialog()),true);await dialog.waitFor();assert.equal(await add.inputValue(),'al');assert.equal(await add.getAttribute('aria-expanded'),'false');
    assert.equal(await page.evaluate(()=>PupMedia.closeTopDialog()),true);assert.equal(await dialog.count(),0);
    assert.equal(await page.evaluate(()=>PupMedia.closeTopDialog()),false);
  }finally{await page.close();}
});

test('short mobile dialogs scroll the whole form so enlarged fields remain usable',async()=>{
  const page=await journalPage('',null,{assets:{photo:{id:'photo',filename:'QA photo'}},entry:{document:[{id:'photo',type:'photo',asset_id:'photo',caption:'A full caption field'}]}});
  try{
    await page.setViewportSize({width:727,height:224});
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';document.body.style.fontSize='28px';});
    await page.getByRole('button',{name:'Details',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Photo details',exact:true}),caption=dialog.getByRole('textbox',{name:'Caption',exact:true});
    const geometry=await caption.evaluate(x=>({input:x.offsetHeight,body:x.closest('.media-dialog-body').clientHeight,scroller:getComputedStyle(x.closest('.media-dialog')).overflowY}));
    assert.ok(geometry.body>=geometry.input,JSON.stringify(geometry));assert.equal(geometry.scroller,'auto');
    await caption.fill('Still readable in landscape');
    await dialog.getByRole('button',{name:'Save',exact:true}).scrollIntoViewIfNeeded();
    const footer=await dialog.getByRole('button',{name:'Save',exact:true}).boundingBox();
    assert.ok(footer.y>=0&&footer.y+footer.height<=224,JSON.stringify(footer));
    await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>PupJournalEditor.editor.doc[0].caption),'Still readable in landscape');
  }finally{await page.close();}
});

test('native navigation remains blocked through nested dialogs and failed saves',async()=>{
  const page=await journalPage();
  try{
    await page.evaluate(()=>{window.qaParent=PupMedia.dialog('Parent draft');window.qaChild=PupMedia.dialog('Nested edit');});
    await page.evaluate(()=>qaChild.setBusy(true));
    assert.equal(await page.evaluate(()=>PupMedia.closeTopDialog()),true);
    assert.equal(await page.getByRole('dialog',{name:'Nested edit',exact:true}).count(),1);
    await page.evaluate(()=>{qaChild.setBusy(false);PupMedia.closeTopDialog();});
    await page.getByRole('dialog',{name:'Parent draft',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>nativeRequests.filter(r=>r.path==='dialog-state').map(r=>r.body.open)),[true,true,true]);
    await page.evaluate(()=>PupMedia.closeTopDialog());
    assert.deepEqual(await page.evaluate(()=>nativeRequests.filter(r=>r.path==='dialog-state').map(r=>r.body.open)),[true,true,true,false]);
  }finally{await page.close();}
});

test('mobile photo columns follow text size and keep dates on one line',async()=>{
  const page=await journalPage('',null,{assets:{one:{id:'one',filename:'One'},two:{id:'two',filename:'Two'}},entries:[{date:'2026-09-10',document:[{id:'first',type:'photo',asset_id:'one'},{id:'second',type:'photo',asset_id:'two'}]}]});
  try{
    await page.setViewportSize({width:360,height:800});await page.getByRole('button',{name:'Photos',exact:true}).click();
    for(const [size,columns]of[[14,2],[18.2,1],[28,1]]){
      await page.evaluate(size=>{document.body.style.fontSize=size+'px';},size);
      const layout=await page.locator('.media-gallery').evaluate(x=>({columns:getComputedStyle(x).gridTemplateColumns.split(' ').length,dates:[...x.querySelectorAll('.media-gallery-card>span:first-of-type')].map(x=>{const r=document.createRange();r.selectNodeContents(x);return r.getClientRects().length;})}));
      assert.equal(layout.columns,columns,JSON.stringify({size,layout}));assert.ok(layout.dates.every(x=>x===1),JSON.stringify({size,layout}));
    }
  }finally{await page.close();}
});

test('the selected photo filter remains visibly distinct from an inactive filter',async()=>{
  const page=await journalPage('',null,{assets:{one:{id:'one',filename:'One'}},groups:{people:{id:'people',name:'people',tags:['alex']}},entries:[{date:'2026-09-10',document:[{id:'first',type:'photo',asset_id:'one',tags:{people:['alex']}}]}]});
  try{
    await page.getByRole('button',{name:'Photos',exact:true}).click();
    const all=page.getByRole('button',{name:'All photos',exact:true}),tag=page.getByRole('button',{name:'people: alex · 1',exact:true});
    const colors=x=>x.evaluate(x=>({background:getComputedStyle(x).backgroundColor,border:getComputedStyle(x).borderColor}));
    for(const mobile of [true,false]){
      await page.evaluate(mobile=>{document.body.classList.toggle('media-mobile',mobile);document.body.classList.toggle('mobile-shell',mobile);},mobile);
      await all.click();await page.getByRole('button',{name:'Photos',exact:true}).hover();
      assert.notDeepEqual(await colors(all),await colors(tag),mobile?'mobile':'web');
      await tag.click();await page.getByRole('button',{name:'Photos',exact:true}).hover();
      assert.equal(await tag.getAttribute('aria-pressed'),'true');assert.equal(await all.getAttribute('aria-pressed'),'false');
      assert.notDeepEqual(await colors(all),await colors(tag));assert.equal((await colors(tag)).border,'rgb(224, 169, 85)');
    }
  }finally{await page.close();}
});
