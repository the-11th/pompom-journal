/* Real photo-editor controls; synthetic pixels and an isolated native bridge. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({channel:'chrome',headless:true}); });
after(async () => { await browser?.close(); });

async function editorPage(scale=1.3) {
  const page = await browser.newPage({viewport:{width:360,height:800},isMobile:true,hasTouch:true});
  page.setDefaultTimeout(5000);
  await page.route('https://todopup.local/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/static/')) return route.fulfill({path:path.join(__dirname,'..',pathname)});
    if (pathname.includes('/file/')) return route.fulfill({path:path.join(__dirname,'../static/img/4-pompom.gif')});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><body class="media-mobile"><script src="/static/custom-color.js"></script><script src="/static/media-ui.js"></script><script src="/static/photo-edit.js"></script></body>'});
  });
  await page.addInitScript(() => {
    const asset = {id:'a'.repeat(64),filename:'QA image',created:'2026-09-09'};
    window.fixture = {assets:{[asset.id]:asset},groups:{},places:{},messages:{}};
    window.changes = []; window.saveCount = 0;
    window.block = {id:'photo',type:'photo',asset_id:asset.id};
    window.TodoPupNative = {request(raw) {
      const call = JSON.parse(raw); let result;
      if (call.path === 'state') {
        for (const change of call.body?.changes || []) {
          window.changes.push(change);
          Object.assign(window.fixture[change.kind][change.id],change.patch);
        }
        result = window.fixture;
      } else if (call.path === 'save-image') {
        const edited = {id:'b'.repeat(64),filename:'QA edit'};
        window.fixture.assets[edited.id] = edited; result = {asset:edited};
      } else throw Error('Unexpected bridge call '+call.path);
      queueMicrotask(() => window.PupMedia.reply(call.id,JSON.parse(JSON.stringify(result))));
    }};
  });
  await page.goto('https://todopup.local/qa');
  await page.evaluate(async scale => {
    document.documentElement.style.fontSize = 16*scale+'px';
    await PupMedia.refresh();
    window.editorResult = PupPhotoEdit.open(window.block,()=>{window.saveCount++;});
  },scale);
  await page.getByRole('dialog',{name:'Edit photo',exact:true}).waitFor();
  return page;
}

test('mobile photo tools group modes and preserve text, undo, redo, and save', async () => {
  const page = await editorPage();
  try {
    const dialog = page.getByRole('dialog',{name:'Edit photo',exact:true});
    await dialog.getByRole('button',{name:'Save',exact:true}).waitFor();
    await page.getByRole('group',{name:'Drawing settings'}).waitFor();
    const drawing=await page.getByRole('group',{name:'Drawing settings'}).evaluate(group=>[...group.querySelectorAll('.media-field')].map(field=>({label:field.querySelector('.label').getBoundingClientRect().top,height:(field.querySelector('.color-trigger')||field.querySelector('input')).getBoundingClientRect().height})));
    assert.ok(Math.abs(drawing[0].label-drawing[1].label)<1,JSON.stringify(drawing));
    assert.ok(drawing.every(field=>field.height>=44),JSON.stringify(drawing));
    await page.getByRole('button',{name:'Move',exact:true}).click();
    assert.equal(await page.getByRole('group',{name:'Drawing settings'}).isVisible(),false);
    await page.getByRole('button',{name:'Text',exact:true}).click();
    const text = page.getByRole('dialog',{name:'Add text',exact:true});
    await text.getByRole('textbox',{name:'Text',exact:true}).fill('QA annotation');
    await text.getByRole('button',{name:'Ink: #e0a955',exact:true}).click();
    await page.getByRole('textbox',{name:'Hex color',exact:true}).fill('#e0524d');
    await page.getByRole('dialog',{name:'Ink',exact:true}).getByRole('button',{name:'Apply',exact:true}).click();
    await text.getByRole('button',{name:'Add',exact:true}).click();
    await page.getByRole('button',{name:'Larger',exact:true}).click();
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    await page.getByRole('button',{name:'Redo',exact:true}).click();
    await page.getByRole('button',{name:'Rotate photo',exact:true}).click();
    await dialog.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(() => window.saveCount === 1);
    const layers = await page.evaluate(() => window.changes.find(c=>c.patch.edit_layers).patch.edit_layers);
    assert.equal(layers[0].text,'QA annotation');
    assert.equal(layers[0].color,'#e0524d');
    assert.equal(layers[1].rotation,90);
  } finally { await page.close(); }
});

test('photo controls remain inside a scrollable dialog with 200% text; cancel discards edits', async () => {
  const page = await editorPage(2);
  try {
    await page.getByRole('button',{name:'Crop',exact:true}).click();
    assert.equal(await page.getByRole('group',{name:'Drawing settings'}).isVisible(),false);
    await page.getByRole('button',{name:'Apply crop',exact:true}).scrollIntoViewIfNeeded();
    const overflow = await page.getByRole('dialog',{name:'Edit photo',exact:true}).evaluate(dialog => {
      const box = dialog.getBoundingClientRect();
      return [...dialog.querySelectorAll('button')].filter(b=>!b.hidden).some(button => {
        const b = button.getBoundingClientRect(); return b.width && (b.left < box.left || b.right > box.right);
      });
    });
    assert.equal(overflow,false);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(() => window.saveCount),0);
    assert.equal(await page.evaluate(() => window.changes.length),0);
  } finally { await page.close(); }
});

test('photo uploads pause canvas tools and retain edits after a failed save',async()=>{
  const page=await editorPage();
  try {
    await page.evaluate(()=>{
      const request=TodoPupNative.request;window.imageAttempts=0;
      TodoPupNative.request=raw=>{
        const call=JSON.parse(raw);
        if(call.path==='save-image'){
          window.imageAttempts++;
          window.releaseImage=()=>window.imageAttempts===1?PupMedia.reply(call.id,null,{message:'Photo could not be saved.'}):request(raw);
        }else request(raw);
      };
    });
    await page.getByRole('button',{name:'Rotate photo',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.imageAttempts===1);
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Edit photo',exact:true}).count(),1);
    await page.evaluate(()=>window.releaseImage());
    await page.waitForFunction(()=>document.getElementById('media-status')?.textContent==='Photo could not be saved.');
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),false);
    assert.equal(await page.getByRole('button',{name:'Undo',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('button',{name:'Redo',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.block.edited_asset_id),undefined);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.imageAttempts===2);
    await page.evaluate(()=>window.releaseImage());
    await page.waitForFunction(()=>window.saveCount===1);
    assert.equal(await page.evaluate(()=>window.changes.find(c=>c.patch.edit_layers).patch.edit_layers.at(-1).rotation),90);
  }finally{await page.close();}
});

test('sticker uploads keep the cutout available after a failed save',async()=>{
  const page=await editorPage();
  try {
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{
      PupMedia.pickPhotos=async()=>[Object.values(fixture.assets)[0]];
      const request=TodoPupNative.request;window.stickerAttempts=0;
      TodoPupNative.request=raw=>{
        const call=JSON.parse(raw);
        if(call.path==='save-image'){
          window.stickerAttempts++;
          window.releaseSticker=()=>window.stickerAttempts===1?PupMedia.reply(call.id,null,{message:'Sticker could not be saved.'}):request(raw);
        }else request(raw);
      };
      window.stickerResult=PupPhotoEdit.stickerMaker();
    });
    const canvas=page.locator('canvas');await canvas.waitFor();
    const box=await canvas.boundingBox();
    await page.mouse.move(box.x+box.width*.15,box.y+box.height*.15);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.85,box.y+box.height*.15,{steps:5});
    await page.mouse.move(box.x+box.width*.85,box.y+box.height*.85,{steps:5});
    await page.mouse.move(box.x+box.width*.15,box.y+box.height*.85,{steps:5});await page.mouse.up();
    await page.getByRole('button',{name:'Cut out',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.stickerAttempts===1);
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'New sticker',exact:true}).count(),1);
    await page.evaluate(()=>window.releaseSticker());
    await page.waitForFunction(()=>document.getElementById('media-status')?.textContent==='Sticker could not be saved.');
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),false);
    await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>window.stickerAttempts===2);
    await page.evaluate(()=>window.releaseSticker());
    await page.waitForFunction(()=>!document.querySelector('.media-overlay'));
    assert.equal(await page.evaluate(async()=>(await window.stickerResult).id),'b'.repeat(64));
    assert.equal(await page.evaluate(()=>window.changes.at(-1).patch.is_sticker),true);
  }finally{await page.close();}
});

test('sticker modes identify selection and enable tools only when they can work',async()=>{
  const page=await editorPage(2);
  try{
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{PupMedia.pickPhotos=async()=>[Object.values(fixture.assets)[0]];window.stickerResult=PupPhotoEdit.stickerMaker();});
    const dialog=page.getByRole('dialog',{name:'New sticker',exact:true});await dialog.waitFor();
    const mode=name=>dialog.getByRole('button',{name,exact:true});
    assert.equal(await mode('Trace').getAttribute('aria-pressed'),'true');
    for(const name of ['Cut out','Keep','Erase','Undo','Save'])assert.equal(await mode(name).isDisabled(),true,name);
    const canvas=dialog.locator('canvas');await canvas.scrollIntoViewIfNeeded();const b=await canvas.boundingBox();
    await page.mouse.move(b.x+b.width*.15,b.y+b.height*.15);await page.mouse.down();
    await page.mouse.move(b.x+b.width*.85,b.y+b.height*.15,{steps:5});
    await page.mouse.move(b.x+b.width*.85,b.y+b.height*.85,{steps:5});
    await page.mouse.move(b.x+b.width*.15,b.y+b.height*.85,{steps:5});await page.mouse.up();
    assert.equal(await mode('Cut out').isEnabled(),true);
    await mode('Cut out').click();
    assert.equal(await mode('Keep').getAttribute('aria-pressed'),'true');
    assert.equal(await mode('Save').isEnabled(),true);
    await mode('Erase').click();assert.equal(await mode('Erase').getAttribute('aria-pressed'),'true');
    assert.equal(await mode('Keep').getAttribute('aria-pressed'),'false');
    await mode('Undo').click();
    assert.equal(await mode('Trace').getAttribute('aria-pressed'),'true');
    for(const name of ['Keep','Erase','Undo','Save'])assert.equal(await mode(name).isDisabled(),true,name);
    await mode('Cancel').click();assert.equal(await page.evaluate(()=>window.changes.length),0);
  }finally{await page.close();}
});
