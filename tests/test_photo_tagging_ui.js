/* Shared photo controls exercised through web fetch and the offline Android bridge. */
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');
let browser;
before(async()=>{browser=await chromium.launch({channel:'chrome',headless:true});});
after(async()=>{await browser?.close();});
async function photoPage(native=false,width=393) {
  const page=await browser.newPage({viewport:{width,height:852},isMobile:native,hasTouch:native});
  page.setDefaultTimeout(5000);
  await page.route('https://todopup.local/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/static/'))return route.fulfill({path:path.join(__dirname,'..',url.pathname)});
    if(url.pathname.startsWith('/journal/media/file/'))return route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')});
    return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><body class="${native?'media-mobile':''}"><main><h2>Photo journal</h2><script id="mention-index" type="application/json">{"jo":{"section_name":"people"}}</script><div id="editor"></div></main><script src="/static/custom-select.js"></script><script src="/static/media-ui.js"></script></body>`});
  });
  await page.addInitScript(({native})=>{
    const asset={id:'a'.repeat(64),filename:'Shanghai.jpg',created:'2026-09-09',location:{lat:31.208333,lon:121.504167}};
    window.fixture={assets:{[asset.id]:asset},groups:{people:{id:'people',name:'people',tags:['alex'],rev:0},foods:{id:'foods',name:'foods',rev:0,tags:['noodles']}},places:{},messages:{}};
    window.changes=[];
    const handle=(path,body)=>{
      if(path==='state'){
        if(body) for(const c of body.changes){window.changes.push(c);Object.assign(window.fixture[c.kind][c.id],c.patch);window.fixture[c.kind][c.id].rev++;}
        return window.fixture;
      }
      if(path==='analytics')return {tags:{people:{sam:2,'past friend':2,'past neighbor':1}}};
      throw Error('Unexpected fixture request '+path);
    };
    if(native)window.TodoPupNative={request(raw){const {id,path,body}=JSON.parse(raw);const result=handle(path,body);queueMicrotask(()=>window.PupMedia.reply(id,JSON.parse(JSON.stringify(result))));}};
    else {const fetch=window.fetch;window.fetch=async(url,options)=>String(url).startsWith('/journal/media/')&&!String(url).includes('/file/')?new Response(JSON.stringify(handle(String(url).replace('/journal/media/',''),options?.body?JSON.parse(options.body):null)),{headers:{'Content-Type':'application/json'}}):fetch(url,options);}
  },{native});
  await page.goto('https://todopup.local/qa');
  await page.evaluate(async()=>{
    await PupMedia.refresh();
    window.editor=new PupMedia.Editor(document.getElementById('editor'),[{...PupMedia.photoBlock(Object.values(window.fixture.assets)[0],'photo'),tags:{people:['sam'],archived:['kept']}}],'',()=>{});
  });
  await page.getByRole('button',{name:'Details',exact:true}).click();
  await page.getByRole('button',{name:'Save',exact:true}).waitFor();
  return page;
}
for(const native of [false,true])test(`${native?'mobile':'web'} Chinese photo tags wait for IME composition before Enter`,async()=>{
  const page=await photoPage(native);
  try{
    const field=page.getByRole('combobox',{name:'Add people tag'});
    await field.fill('朋友');
    for(const properties of [{isComposing:true},{keyCode:229}]){
      await field.evaluate((input,properties)=>input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...properties})),properties);
      assert.equal(await field.inputValue(),'朋友');
      assert.equal(await page.getByRole('checkbox',{name:'朋友',exact:true}).count(),0);
    }
    await field.press('Enter');
    assert.equal(await field.inputValue(),'');
    assert.equal(await page.getByRole('checkbox',{name:'朋友',exact:true}).isChecked(),true);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.ok((await page.evaluate(()=>editor.doc[0].tags.people)).includes('朋友'));
  }finally{await page.close();}
});

test('photo details retry a lost successful tag response without a second write',async()=>{
  const page=await photoPage();
  try {
    await page.evaluate(()=>{
      const fetch=window.fetch;let committed=null;
      window.fetch=async(url,options)=>{
        if(String(url)!=='/journal/media/state'||!options?.body)return fetch(url,options);
        const body=JSON.parse(options.body);
        if(!committed){
          committed=body.changes;
          await fetch(url,options);
          throw Error('Response lost. Try Save again.');
        }
        if(JSON.stringify(body.changes)!==JSON.stringify(committed))return new Response(JSON.stringify({conflicts:[{id:'people'}]}));
        return new Response(JSON.stringify(fixture));
      };
    });
    await page.getByRole('textbox',{name:'Caption',exact:true}).fill('Retained after retry');
    const people=page.locator('.media-photo-tag-group').filter({has:page.getByRole('heading',{name:'people',exact:true})});
    await people.getByRole('combobox',{name:'Add people tag'}).fill('retry friend');
    await people.getByText('permanent',{exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Response lost'}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Caption',exact:true}).inputValue(),'Retained after retry');
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.equal(await page.evaluate(()=>changes.length),1);
    assert.equal(await page.evaluate(()=>editor.doc[0].caption),'Retained after retry');
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','retry friend']);
  }finally{await page.close();}
});
test('photo gallery images align at the top when captions have different lengths',async()=>{
  const page=await photoPage(true);
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.addScriptTag({url:'https://todopup.local/static/media-settings.js'});
    await page.evaluate(async()=>{
      const host=document.getElementById('editor');
      await PupMedia.photos(host,[{date:'2026-09-09',document:[
        {id:'one',type:'photo',asset_id:'a'.repeat(64),caption:'A longer caption that wraps across several lines',tags:{}},
        {id:'two',type:'photo',asset_id:'b'.repeat(64),caption:'',tags:{}},
      ]}]);
    });
    const tops=await page.locator('.media-gallery-card img').evaluateAll(images=>images.map(image=>image.getBoundingClientRect().top));
    assert.equal(tops.length,2);
    assert.ok(Math.abs(tops[0]-tops[1])<1,JSON.stringify(tops));
  } finally {await page.close();}
});
for(const native of [false,true]) test(`${native?'Android bridge':'web'}: photo circles, tag kinds, cancel, and persistence`,async()=>{
  const page=await photoPage(native);
  try {
    const people=page.locator('.media-photo-tag-group').filter({has:page.getByRole('heading',{name:'people',exact:true})});
    assert.equal(await people.getByRole('checkbox',{name:'sam',exact:true}).isChecked(),true);
    await people.getByRole('checkbox',{name:'alex',exact:true}).check();
    await people.getByRole('combobox',{name:'Add people tag'}).fill('new friend');
    await people.getByText('permanent',{exact:true}).click();
    await people.getByRole('button',{name:'Add tag',exact:true}).click();
    await people.getByRole('combobox',{name:'Add people tag'}).fill('today only');
    await people.getByText('temporary',{exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.deepEqual(await page.evaluate(()=>editor.doc[0].tags),{people:['sam','alex','new friend','today only'],archived:['kept']});
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','new friend']);
    await page.getByRole('button',{name:'Details',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).waitFor();
    assert.equal(await people.getByRole('checkbox',{name:'today only',exact:true}).isChecked(),true);
    for(const radius of await people.locator('input[type="checkbox"]').evaluateAll(inputs=>inputs.map(i=>getComputedStyle(i).borderRadius)))assert.equal(radius,'50%');
    await people.getByRole('button',{name:'Make sam permanent',exact:true}).click();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','new friend']);
    await page.getByRole('button',{name:'Details',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).waitFor();
    await people.getByRole('button',{name:'Make alex temporary',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['new friend']);
    assert.ok((await page.evaluate(()=>editor.doc[0].tags.people)).includes('alex'));
  } finally {await page.close();}
});
for(const native of [false,true])test(`${native?'Android bridge':'web'}: temporary photo tags appear only in typing suggestions or current selection`,async()=>{
  const page=await photoPage(native);
  try {
    const people=page.locator('.media-photo-tag-group').filter({has:page.getByRole('heading',{name:'people',exact:true})});
    const input=people.getByRole('combobox',{name:'Add people tag'});
    assert.deepEqual(await people.getByRole('checkbox').evaluateAll(nodes=>nodes.map(n=>n.value)),['alex','sam']);
    assert.equal(await people.locator('.media-photo-tag-zone').count(),0);
    assert.equal(await people.getByRole('listbox').isVisible(),false);
    await input.fill('PAST');
    assert.deepEqual(await people.getByRole('option').allTextContents(),['past friend','past neighbor']);
    if(process.env.PHOTO_UI_SCREENSHOT&&!native)await page.screenshot({path:process.env.PHOTO_UI_SCREENSHOT.replace('.png','-suggestions.png')});
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('ArrowUp');
    await input.press('Enter');
    assert.equal(await people.getByRole('checkbox',{name:'past friend',exact:true}).isChecked(),true);
    assert.equal(await people.getByRole('listbox').isVisible(),false);
    await people.getByRole('checkbox',{name:'past friend',exact:true}).click();
    assert.equal(await people.getByRole('checkbox',{name:'past friend',exact:true}).count(),0);
    await input.fill('jo');
    await input.press('Escape');
    assert.equal(await people.getByRole('listbox').isVisible(),false);
    assert.equal(await page.getByRole('dialog',{name:'Photo details',exact:true}).isVisible(),true);
    await input.fill('j');
    const jo=people.getByRole('option',{name:'jo',exact:true});
    if(native)await jo.tap();else await jo.click();
    await input.fill('past n');
    await people.getByRole('option',{name:'past neighbor',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.deepEqual(await page.evaluate(()=>editor.doc[0].tags.people),['sam','jo','past neighbor']);
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex']);
  } finally {await page.close();}
});
test('photo tag management hides history until typing and promotes the chosen suggestion',async()=>{
  const page=await photoPage();
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{
      window.manager=PupMedia.photoTagPicker(fixture.groups.people,[],['past friend'],{},true);
      const d=PupMedia.dialog('Manage people');d.body.append(manager.wrap);
      d.actions.append(PupMedia.button('Save tags',async()=>{manager.values();await PupMedia.savePhotoTagGroups([manager]);d.close();}));
    });
    assert.equal(await page.getByText('past friend',{exact:true}).count(),0);
    await page.getByRole('combobox',{name:'Add people tag'}).fill('past');
    await page.getByRole('option',{name:'past friend',exact:true}).click();
    await page.getByRole('button',{name:'Save tags',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','past friend']);
  } finally {await page.close();}
});
test('permanent mode applies to a photo tag chosen from suggestions',async()=>{
  const page=await photoPage();
  try {
    const people=page.locator('.media-photo-tag-group').filter({has:page.getByRole('heading',{name:'people',exact:true})});
    await people.getByText('permanent',{exact:true}).click();
    await people.getByRole('combobox',{name:'Add people tag'}).fill('past');
    await people.getByRole('option',{name:'past friend',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','past friend']);
    assert.deepEqual(await page.evaluate(()=>editor.doc[0].tags.people),['sam','past friend']);
  } finally {await page.close();}
});
test('web opens a gallery before the device chooser; selecting an existing photo preserves GPS',async()=>{
  const page=await photoPage();
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{window.galleryResult=null;PupMedia.pickPhotos().then(a=>window.galleryResult=a);});
    await page.getByRole('dialog',{name:'Photo gallery',exact:true}).waitFor();
    assert.equal(await page.locator('input[type="file"]').count(),0);
    await page.getByRole('dialog',{name:'Photo gallery',exact:true}).getByRole('button',{name:'Shanghai.jpg',exact:true}).click();
    await page.getByRole('button',{name:'Add 1 photo',exact:true}).click();
    await page.waitForFunction(()=>window.galleryResult!==null);
    assert.deepEqual(await page.evaluate(()=>galleryResult[0].location),{lat:31.208333,lon:121.504167});
  } finally {await page.close();}
});
for(const width of [393,1024])test(`photo details fit ${width}px and actions are shorter`,async()=>{
  const page=await photoPage(false,width);
  try {
    const bounds=await page.getByRole('button',{name:'Save',exact:true}).boundingBox();
    assert.ok(bounds.height<=36.5,JSON.stringify(bounds));
    assert.ok(await page.locator('.media-dialog-body').evaluate(el=>el.scrollWidth<=el.clientWidth));
    assert.match(await page.locator('.media-photo-gps').textContent(),/31\.20833, 121\.50417/);
    if(process.env.PHOTO_UI_SCREENSHOT)await page.screenshot({path:process.env.PHOTO_UI_SCREENSHOT.replace('.png','-'+width+'.png')});
  } finally {await page.close();}
});

test('photo picker shows its selection count and keeps an empty selection visibly inactive', async () => {
  const page = await photoPage(false, 390);
  try {
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    await page.evaluate(() => { window.pickedPhotos = null; PupMedia.pickPhotos().then(photos => window.pickedPhotos = photos); });
    const add = page.getByRole('button', {name: 'Add photos', exact: true});
    await add.waitFor();
    assert.equal(await add.isEnabled(), false);
    assert.ok(Number(await add.evaluate(el => getComputedStyle(el).opacity)) < 1);
    await page.getByRole('dialog',{name:'Photo gallery',exact:true}).getByRole('button', {name: 'Shanghai.jpg', exact: true}).click();
    const selected = page.getByRole('button', {name: 'Add 1 photo', exact: true});
    assert.equal(await selected.isEnabled(), true);
    await page.getByRole('dialog',{name:'Photo gallery',exact:true}).getByRole('button', {name: 'Shanghai.jpg', exact: true}).click();
    assert.equal(await add.isEnabled(), false);
    await page.getByRole('dialog',{name:'Photo gallery',exact:true}).getByRole('button', {name: 'Shanghai.jpg', exact: true}).click();
    await selected.click();
    await page.waitForFunction(() => window.pickedPhotos !== null);
    assert.equal(await page.evaluate(() => pickedPhotos.length), 1);
  } finally { await page.close(); }
});

test('photo details pause edits and dismissal during saving, then retain the draft on failure',async()=>{
  const page=await photoPage();
  try {
    await page.evaluate(()=>{
      const fetch=window.fetch;window.saveAttempt=0;
      window.fetch=async(url,options)=>{
        if(String(url)==='/journal/media/state'&&options?.body){
          window.saveAttempt++;await new Promise(resolve=>window.releaseSave=resolve);
          if(window.saveAttempt===1)return new Response(JSON.stringify({error:'Photo tags could not be saved.'}),{status:503});
        }
        return fetch(url,options);
      };
    });
    const caption=page.getByRole('textbox',{name:'Caption',exact:true});
    await caption.fill('Keep this caption');
    const people=page.locator('.media-photo-tag-group').filter({has:page.getByRole('heading',{name:'people',exact:true})});
    await people.getByRole('combobox',{name:'Add people tag'}).fill('review person');
    await people.getByText('permanent',{exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.saveAttempt===1);
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    assert.equal(await page.getByRole('dialog',{name:'Photo details',exact:true}).getAttribute('aria-busy'),'true');
    assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Photo details',exact:true}).count(),1);
    await page.evaluate(()=>window.releaseSave());
    await page.waitForFunction(()=>document.getElementById('media-status')?.textContent==='Photo tags could not be saved.');
    assert.equal(await caption.inputValue(),'Keep this caption');
    assert.equal(await caption.isEditable(),true);
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),false);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.saveAttempt===2);
    await page.evaluate(()=>window.releaseSave());
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.equal(await page.evaluate(()=>editor.doc[0].caption),'Keep this caption');
    assert.deepEqual(await page.evaluate(()=>fixture.groups.people.tags),['alex','review person']);
  } finally {await page.close();}
});

for(const editable of [false,true])test(`${editable?'editable':'read-only'} photo previews replace failed images with a themed retry`,async()=>{
  const page=await photoPage();let imageRequests=0;
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.route('**/journal/media/file/**',route=>++imageRequests===1?route.fulfill({status:404,body:''}):route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')}));
    await page.evaluate(editable=>{const block={...editor.doc[0],caption:'Preview caption',edited_asset_id:'c'.repeat(64)};PupMedia.viewPhotos([block],editable?{onChange:()=>{}}:{});},editable);
    const preview=page.getByRole('dialog',{name:'Photo',exact:true});
    const retry=preview.getByRole('button',{name:'Retry photo',exact:true});await retry.waitFor();
    assert.equal(await preview.locator('img').count(),0);
    assert.equal(await preview.getByText('Preview caption',{exact:true}).isVisible(),true);
    assert.equal(await preview.getByRole('button',{name:'Close Photo',exact:true}).isEnabled(),true);
    if(editable)assert.equal(await preview.getByRole('button',{name:'Photo details',exact:true}).isEnabled(),true);
    await retry.click();await preview.locator('img').waitFor();
    assert.equal(imageRequests,2);
    assert.equal(await preview.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.ok((await preview.locator('img').getAttribute('src')).includes('c'.repeat(64)));
    assert.equal(await preview.getByRole('button',{name:'Close Photo',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Escape');assert.equal(await preview.count(),0);
  }finally{await page.close();}
});

for(const readOnly of [false,true])test(`${readOnly?'read-only':'editable'} journal photos retain their caption and retry unavailable images in place`,async()=>{
  const page=await photoPage();let imageRequests=0;
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.route('**/journal/media/file/**',route=>++imageRequests===1?route.fulfill({status:404,body:''}):route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')}));
    await page.evaluate(readOnly=>{editor.options.readOnly=readOnly;editor.doc[0].caption='Retained caption';editor.doc[0].edited_asset_id='d'.repeat(64);editor.render();},readOnly);
    const retry=page.getByRole('button',{name:'Photo unavailable · Retry',exact:true});await retry.waitFor();
    assert.equal(await page.locator('.media-block-photo img').count(),0);
    assert.equal(await page.getByText('Retained caption',{exact:true}).isVisible(),true);
    assert.equal(await page.getByRole('button',{name:'Details',exact:true}).count(),readOnly?0:1);
    await retry.click();await page.locator('.media-block-photo img').waitFor();
    assert.equal(imageRequests,2);
    assert.equal(await page.locator('.media-block-photo img').evaluate(image=>image.complete&&image.naturalWidth>0&&document.activeElement===image),true);
    await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'Photo',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.media-block-photo img').evaluate(image=>document.activeElement===image),true);
  }finally{await page.close();}
});
