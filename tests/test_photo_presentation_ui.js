/* Photo labels and compact mobile controls; synthetic assets only. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function photoPage(view='photos') {
  const page=await browser.newPage({viewport:{width:393,height:852},hasTouch:true,isMobile:true});
  page.setDefaultTimeout(5000);
  await page.route('https://todopup.local/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.join(__dirname,'..',url.pathname)});
    if(url.pathname.includes('/file/'))return route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><body class="media-mobile"><main id="photos"></main>'+['custom-select','custom-color','datetime-picker','offline-map','media-ui','media-settings'].map(name=>'<script src="/static/'+name+'.js"></script>').join('')});
  });
  await page.addInitScript(()=>{
    window.fixture={rev:1,assets:{a:{id:'a',filename:'Walk.jpg',location:{lat:31.2,lon:121.4},location_label:'Near Riverside',rev:1}},groups:{locations:{id:'locations',name:'locations',tags:['near riverside']}},places:{},messages:{}};
    window.photo={id:'p',type:'photo',asset_id:'a',caption:'Afternoon walk',location_label:'Near Riverside',location_visible:true,tags:{locations:['near riverside']}};
    window.entries=[{date:'2026-09-11',document:[photo]}];window.calls=[];
    window.TodoPupNative={request(raw){
      const call=JSON.parse(raw);calls.push(call);let result;
      if(call.path==='state'){
        if(window.failSave&&call.body?.changes?.length){queueMicrotask(()=>PupMedia.reply(call.id,null,{status:503,message:'Could not save.'}));return;}
        for(const change of call.body?.changes||[]){Object.assign(fixture[change.kind][change.id],change.patch);fixture[change.kind][change.id].rev++;fixture.rev++;}
        result=fixture;
      }else if(call.path.startsWith('entry/'))result={entry:entries.find(e=>e.date===call.path.slice(6))||null};
      else if(call.path.endsWith('/photo-details')){
        if(window.failSave){queueMicrotask(()=>PupMedia.reply(call.id,null,{status:503,message:'Could not save.'}));return;}
        const entry=entries.find(e=>call.path.includes(e.date)),block=entry.document.find(b=>b.id===call.body.block_id);
        Object.assign(block,{caption:call.body.caption,location_label:call.body.location_label});result={entry};
      }else if(call.path==='maps')result={packs:[]};
      else if(call.path==='analytics')result={tags:{}};
      else if(call.path==='dialog-state')result={ok:true};
      else throw Error('Unexpected request '+call.path);
      queueMicrotask(()=>PupMedia.reply(call.id,JSON.parse(JSON.stringify(result))));
    }};
  });
  await page.goto('https://todopup.local/');
  await page.evaluate(async view=>{
    await PupMedia.refresh();
    if(view==='editor')window.editor=new PupMedia.Editor(document.querySelector('main'),[photo],'',()=>{});
    else await PupMedia.photos(document.querySelector('main'),entries);
  },view);
  return page;
}

test('a photo shows its location once without near or locations prefixes',async()=>{
  const page=await photoPage('editor');
  try{
    const block=page.locator('.media-block-photo');
    assert.equal(await block.locator('.media-location-label').innerText(),'Riverside');
    assert.equal(await block.locator('.entry-tag-chip').count(),0);
    assert.deepEqual(await page.evaluate(()=>editor.doc[0].tags),{locations:['near riverside']});
  }finally{await page.close();}
});

test('photo filters use equal margins and clean location names',async()=>{
  const page=await photoPage();
  try{
    const all=page.getByRole('button',{name:'All photos',exact:true});
    const location=page.getByRole('button',{name:'Riverside · 1',exact:true});
    await location.waitFor();
    const margins=await Promise.all([all,location].map(button=>button.evaluate(el=>{
      const s=getComputedStyle(el);return [s.marginTop,s.marginRight,s.marginBottom,s.marginLeft];
    })));
    assert.deepEqual(margins[0],margins[1]);
    await location.click();assert.equal(await page.locator('.media-gallery-card').count(),1);
  }finally{await page.close();}
});

test('holding a photo location previews its map without editing its coordinates',async()=>{
  const page=await photoPage('editor');
  try{
    const label=page.locator('.media-location-label'),box=await label.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.waitForTimeout(600);await page.mouse.up();
    const preview=page.getByRole('dialog',{name:'Riverside',exact:true});await preview.waitFor();
    assert.equal(await preview.locator('canvas').count(),1);
    assert.equal(await page.getByRole('dialog',{name:'Photo location',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>calls.some(c=>c.body?.changes?.length)),false);
    await preview.getByRole('button',{name:'Close Riverside',exact:true}).click();
    assert.equal(await label.evaluate(el=>el===document.activeElement),true);
  }finally{await page.close();}
});

test('scrolling off a held location cancels its map preview',async()=>{
  const page=await photoPage('editor');
  try{
    const label=page.locator('.media-location-label'),box=await label.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2,box.y+60);await page.waitForTimeout(600);await page.mouse.up();
    assert.equal(await page.getByRole('dialog').count(),0);
  }finally{await page.close();}
});

test('Photos caption and location editing stays inline and changes only the opened entry',async()=>{
  const page=await photoPage();
  try{
    await page.evaluate(()=>entries.push({date:'2026-09-10',document:[{...photo,id:'older',caption:'Yesterday'}]}));
    await page.locator('.media-gallery-card').click();
    const viewer=page.getByRole('dialog',{name:'Photo',exact:true});await viewer.waitFor();
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).click();
    await viewer.getByRole('textbox',{name:'Caption',exact:true}).fill('A new caption');
    await viewer.getByRole('textbox',{name:'Location name',exact:true}).fill('Riverside cafe');
    if(process.env.PHOTO_PRESENTATION_SCREENSHOT)await page.screenshot({path:process.env.PHOTO_PRESENTATION_SCREENSHOT});
    await viewer.getByRole('button',{name:'Save',exact:true}).click();
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),1);
    const saved=await page.evaluate(()=>({entries,calls,location:fixture.assets.a.location}));
    assert.equal(saved.entries[0].document[0].caption,'A new caption');
    assert.equal(saved.entries[0].document[0].location_label,'Riverside cafe');
    assert.equal(saved.entries[1].document[0].caption,'Yesterday');
    assert.deepEqual(saved.location,{lat:31.2,lon:121.4});
    const write=saved.calls.find(c=>c.path.endsWith('/photo-details'));
    assert.equal(write.body.base_caption,'Afternoon walk');
    assert.equal(write.body.base_location_label,'Near Riverside');
    assert.equal('location' in write.body,false);
    await viewer.getByRole('button',{name:'Close Photo',exact:true}).click();
    await page.getByRole('button',{name:'Riverside cafe · 1',exact:true}).waitFor();
  }finally{await page.close();}
});

test('the same photo viewer refreshes the gallery after two consecutive saves',async()=>{
  const page=await photoPage();
  try{
    await page.locator('.media-gallery-card').click();
    for(const caption of ['First save','Second save']){
      await page.getByRole('button',{name:'Edit caption',exact:true}).click();
      await page.getByRole('textbox',{name:'Caption',exact:true}).fill(caption);
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.getByRole('button',{name:'Edit caption',exact:true}).waitFor();
      assert.match(await page.locator('.media-gallery-card').innerText(),new RegExp(caption));
    }
  }finally{await page.close();}
});

test('failed inline photo saves keep typed values and allow a retry',async()=>{
  const page=await photoPage();
  try{
    await page.locator('.media-gallery-card').click();
    const viewer=page.getByRole('dialog',{name:'Photo',exact:true});
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).click();
    const caption=viewer.getByRole('textbox',{name:'Caption',exact:true});await caption.fill('Keep this');
    await page.evaluate(()=>window.failSave=true);
    await viewer.getByRole('button',{name:'Save',exact:true}).click();
    await viewer.getByText('Could not save.',{exact:true}).waitFor();
    assert.equal(await caption.inputValue(),'Keep this');
    await page.evaluate(()=>window.failSave=false);
    await viewer.getByRole('button',{name:'Save',exact:true}).click();
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>entries[0].document[0].caption),'Keep this');
  }finally{await page.close();}
});

test('leaving Photos prevents a delayed entry reply from opening its viewer',async()=>{
  const page=await photoPage();
  try{
    await page.evaluate(()=>{
      const request=TodoPupNative.request;
      TodoPupNative.request=raw=>{if(JSON.parse(raw).path.startsWith('entry/'))window.releasePhoto=()=>request(raw);else request(raw);};
    });
    await page.locator('.media-gallery-card').click();
    await page.waitForFunction(()=>!!window.releasePhoto);
    await page.evaluate(()=>{const host=document.querySelector('main');host._mediaCleanup();host.replaceChildren(PupMedia.element('h2','','Settings replacement'));releasePhoto();});
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('dialog').count(),0);
    await page.getByRole('heading',{name:'Settings replacement'}).waitFor();
  }finally{await page.close();}
});

test('saving one photo preserves another photo’s open inline draft',async()=>{
  const page=await photoPage('editor');
  try{
    await page.evaluate(()=>{
      editor.doc.push({...editor.doc[0],id:'second',asset_id:'b',caption:'Second original'});
      PupMedia.getState().assets.b={id:'b',filename:'Second.jpg'};editor.preview(editor.doc);
    });
    const figures=page.locator('.media-preview-photo');
    await figures.nth(0).getByRole('button',{name:'Edit caption',exact:true}).click();
    await figures.nth(0).getByRole('textbox',{name:'Caption',exact:true}).fill('Unsaved first draft');
    await figures.nth(1).getByRole('button',{name:'Edit caption',exact:true}).click();
    await figures.nth(1).getByRole('textbox',{name:'Caption',exact:true}).fill('Saved second draft');
    await figures.nth(1).getByRole('button',{name:'Save',exact:true}).click();
    await figures.nth(1).getByRole('button',{name:'Edit caption',exact:true}).waitFor();
    assert.equal(await figures.nth(0).getByRole('textbox',{name:'Caption',exact:true}).inputValue(),'Unsaved first draft');
    assert.deepEqual(await page.evaluate(()=>editor.doc.map(b=>b.caption)),['Afternoon walk','Saved second draft']);
    await figures.nth(0).getByRole('button',{name:'Save',exact:true}).click();
    assert.equal(await page.evaluate(()=>editor.doc[0].caption),'Unsaved first draft');
  }finally{await page.close();}
});

test('inline photo drafts pause other editors until saved or cancelled',async()=>{
  const page=await photoPage('editor');
  try{
    await page.evaluate(()=>editor.preview(editor.doc));
    const viewer=page.getByRole('dialog',{name:'Photo',exact:true});
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).click();
    await viewer.getByRole('textbox',{name:'Caption',exact:true}).fill('Unfinished caption');
    assert.equal(await viewer.getByRole('button',{name:'Photo details',exact:true}).count(),0);
    assert.equal(await viewer.getByRole('button',{name:'Edit photo',exact:true}).count(),0);
    await viewer.getByRole('button',{name:'Cancel',exact:true}).click();
    await viewer.getByRole('button',{name:'Photo details',exact:true}).waitFor();
    await viewer.getByRole('button',{name:'Edit photo',exact:true}).waitFor();
    await viewer.getByRole('button',{name:'Edit caption',exact:true}).click();
    await viewer.getByRole('textbox',{name:'Caption',exact:true}).fill('Finished caption');
    await viewer.getByRole('button',{name:'Save',exact:true}).click();
    await viewer.getByRole('button',{name:'Photo details',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>editor.doc[0].caption),'Finished caption');
  }finally{await page.close();}
});

test('opening a repeated asset edits the requested block in that entry',async()=>{
  const page=await photoPage();
  try{
    await page.evaluate(async()=>{
      entries[0].document.push({...photo,id:'second-appearance',caption:'Specific second appearance'});
      await PupMedia.openEntryPhoto(entries[0].date,entries[0].document[1]);
    });
    await page.getByRole('button',{name:'Edit caption',exact:true}).click();
    const caption=page.getByRole('textbox',{name:'Caption',exact:true});
    assert.equal(await caption.inputValue(),'Specific second appearance');
    await caption.fill('Changed second appearance');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>entries[0].document.map(b=>b.caption)),['Afternoon walk','Changed second appearance']);
  }finally{await page.close();}
});

test('a gallery representative opens the date that owns its displayed caption',async()=>{
  const page=await photoPage();
  try{
    await page.evaluate(async()=>{
      entries.push({date:'2026-09-12',document:[{id:'text',type:'text',text:'A memory',links:[{start:0,end:8,photos:['a']}]}]});
      await PupMedia.photos(document.querySelector('main'),entries);
    });
    const card=page.locator('.media-gallery-card');
    assert.match(await card.innerText(),/2026-09-11/);
    await card.click();
    await page.getByRole('button',{name:'Edit caption',exact:true}).click();
    const caption=page.getByRole('textbox',{name:'Caption',exact:true});
    assert.equal(await caption.inputValue(),'Afternoon walk');
    await caption.fill('Edited displayed entry');await page.getByRole('button',{name:'Save',exact:true}).click();
    const saved=await page.evaluate(()=>({entries,write:calls.find(c=>c.path.endsWith('/photo-details'))}));
    assert.equal(saved.write.path,'journal/2026-09-11/photo-details');
    assert.equal(saved.entries[1].document.length,1);
    assert.equal(saved.entries[1].document[0].type,'text');
  }finally{await page.close();}
});
