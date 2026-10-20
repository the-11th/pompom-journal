/* Keyboard and state contracts for the shared web controls. Synthetic data only. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

let browser, basePage, archivePage, sectionPage, entryPage, sectionArchivePage, searchPage, tagsPage;
before(async () => {
  const pages = JSON.parse(execFileSync(path.join(__dirname, '../.venv/bin/python'), ['-c', `
import json, tempfile
from pathlib import Path
from app import app
import todo, journal
with tempfile.TemporaryDirectory(prefix='datapom-web-controls-') as directory:
    root = Path(directory)
    app.config.update(TESTING=True, DATA_FILE=str(root/'tasks.json'), JOURNAL_FILE=str(root/'journal.json'), INTEGRATIONS_FILE=str(root/'integrations.json'))
    tasks = todo._empty()
    todo.add_task(tasks, 'Review task')
    todo.add_subtask(tasks, tasks['active'][0]['id'], 'Review step')
    tasks['archive'] = [
        {'id':'older','title':'Older completion','completed':'2026-09-09T11:02:33.987654'},
        {'id':'newer','title':'Newest completion','completed':'2026-09-10T17:11:22.123456','notes':'Saved archive note','subtasks':[{'text':'Saved archive step','done':True}]},
        {'id':'undated','title':'Undated completion'},
    ]
    tasks['expired'] = [{'id':'missed','title':'Missed review','due':'2026-09-09T17:00:00','notes':'Retain missed notes'}]
    todo.save(app.config['DATA_FILE'], tasks)
    diary = journal._empty()
    journal.add_section(diary, 'people', 'tag', '#e0a955')
    people_id = diary['sections'][0]['id']
    journal.add_section_tag(diary, people_id, 'old friend')
    journal.remove_section_tag(diary, people_id, 'old friend')
    journal.add_section(diary, 'weight', 'numeric', '#e0a955', unit='kg')
    journal.add_section(diary, 'past', 'tag', '#e0a955')
    journal.archive_section(diary, diary['sections'][-1]['id'])
    journal.upsert_entry(diary, '2026-09-15', '2026-09-15', '', mood=4)
    journal.save(app.config['JOURNAL_FILE'], diary)
    with app.test_client() as client:
        pages = {name:client.get(url).get_data(as_text=True) for name,url in [('active','/'),('archive','/archive'),('sections','/journal/sections'),('entry','/journal/2026-09-12'),('section_archive','/journal/sections/archive'),('search','/journal/search')]}
        todo.set_tag_color(tasks, 'work', '#e0a955')
        todo.save(app.config['DATA_FILE'], tasks)
        pages['tags'] = client.get('/tags').get_data(as_text=True)
        print(json.dumps(pages))
`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
  basePage = pages.active; archivePage = pages.archive;
  sectionPage = pages.sections; entryPage = pages.entry;
  sectionArchivePage = pages.section_archive;
  searchPage = pages.search;
  tagsPage = pages.tags;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function openPage(markup) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/static/')) return route.fulfill({ path: path.join(__dirname, '..', pathname) });
    return route.fulfill({ contentType: 'text/html', body: basePage });
  });
  await page.goto('https://datapom.test/');
  if (markup) {
    await page.locator('main').evaluate((main, html) => { main.innerHTML = html; }, markup);
    await page.evaluate(() => document.querySelectorAll('select').forEach(window.enhanceSelect));
  }
  return page;
}

test('journal title has an explicit accessible name', async () => {
  const page = await openPage();
  try {
    await page.route('https://datapom.test/title-review', route => route.fulfill({ contentType: 'text/html', body: entryPage }));
    await page.goto('https://datapom.test/title-review');
    assert.equal(await page.getByRole('textbox', { name: 'Entry title', exact: true }).count(), 1);
  } finally { await page.close(); }
});

async function dictationPage(supported=true){
  const page=await openPage();
  await page.addInitScript(supported=>{
    window.speechSessions=[];
    if(!supported){window.SpeechRecognition=window.webkitSpeechRecognition=undefined;return;}
    window.SpeechRecognition=class {
      constructor(){speechSessions.push(this);}
      start(){this.onstart?.();}
      stop(){this.stopped=true;}
      abort(){this.aborted=true;}
      emit(text){const result=[{transcript:text}];result.isFinal=true;this.onresult?.({resultIndex:0,results:[result]});}
    };
  },supported);
  await page.route('https://datapom.test/journal/media/**',route=>route.fulfill({json:{assets:{},groups:{},places:{},messages:{},samples:[],packs:[]}}));
  await page.route('https://datapom.test/dictation-review',route=>route.fulfill({contentType:'text/html',body:entryPage}));
  await page.goto('https://datapom.test/dictation-review');
  await page.waitForFunction(()=>!!window.PupJournalEditor);
  await page.evaluate(()=>{
    const editor=PupJournalEditor.editor;
    editor.doc=[{id:'first',type:'text',text:'First paragraph',links:[]},{id:'photo',type:'photo',asset_id:'a'.repeat(64),caption:'Keep photo',tags:{}},{id:'second',type:'text',text:'Hello friend',links:[{start:6,end:12,photos:['photo']}]}];editor.render();
  });
  return page;
}

test('website record controls sit equally inset inside each textbox without a writing switch',async()=>{
  const page=await dictationPage();
  try{
    assert.equal(await page.getByRole('button',{name:'Writing / dictation',exact:true}).count(),0);
    assert.equal(await page.locator('.media-block-text .dictation-mic').count(),2);
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:900});
      const group=page.locator('[data-block-id="second"]'),mic=group.getByRole('button',{name:'Record voice',exact:true});
      const input=await group.locator('.media-paragraph-view').boundingBox(),button=await mic.boundingBox();
      assert.equal(button.width,26);assert.equal(button.height,26);
      assert.ok(Math.abs(button.y-input.y-6)<1);
      assert.ok(Math.abs(input.x+input.width-button.x-button.width-6)<1);
    }
  }finally{await page.close();}
});

test('website dictation targets the selected paragraph and preserves inserts and photo links',async()=>{
  const page=await dictationPage();
  try{
    const group=page.locator('[data-block-id="second"]');await group.locator('.media-paragraph-view').click();
    await group.locator('textarea').evaluate(input=>input.setSelectionRange(6,6));
    await group.getByRole('button',{name:'Record voice',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Dictation',exact:true});await dialog.waitFor();
    const styles=await dialog.locator('textarea').evaluate(input=>{const text=getComputedStyle(input),backdrop=getComputedStyle(input.parentElement.querySelector('.dictation-backdrop'));return {font:text.fontFamily,parent:getComputedStyle(input.parentElement).fontFamily,width:input.clientWidth,container:input.parentElement.clientWidth,padding:text.padding,lineHeight:text.lineHeight,backdropPadding:backdrop.padding,backdropLineHeight:backdrop.lineHeight};});
    assert.equal(styles.font,styles.parent);assert.ok(styles.width>=styles.container-2);
    assert.equal(styles.padding,styles.backdropPadding);assert.equal(styles.lineHeight,styles.backdropLineHeight);
    await page.evaluate(()=>speechSessions.at(-1).emit('dear'));
    assert.equal(await dialog.getByRole('textbox',{name:'Dictation text'}).inputValue(),'Hello dear friend');
    assert.equal(await page.evaluate(()=>PupJournalEditor.editor.doc[2].text),'Hello friend');
    await dialog.getByRole('button',{name:'Use text',exact:true}).click();await dialog.waitFor({state:'detached'});
    const doc=await page.evaluate(()=>PupJournalEditor.collect().document);
    assert.equal(doc[0].text,'First paragraph');assert.equal(doc[1].caption,'Keep photo');assert.equal(doc[2].text,'Hello dear friend');
    assert.deepEqual(doc[2].links,[{start:11,end:17,photos:['photo']}]);
    assert.equal(await page.evaluate(()=>speechSessions[0].onresult),null);
  }finally{await page.close();}
});

test('closing website dictation cancels capture and late callbacks cannot change the entry',async()=>{
  const page=await dictationPage();
  try{
    const before=await page.evaluate(()=>PupJournalEditor.collect().document);
    await page.locator('[data-block-id="second"] .dictation-mic').click();
    await page.evaluate(()=>{speechSessions.at(-1).emit('unsaved voice');window.lateResult=speechSessions.at(-1).onresult;window.lateEnd=speechSessions.at(-1).onend;});
    await page.getByRole('dialog',{name:'Dictation'}).getByRole('button',{name:'Cancel',exact:true}).click();
    await page.evaluate(()=>{const result=[{transcript:'late voice'}];result.isFinal=true;lateResult({resultIndex:0,results:[result]});lateEnd();});
    assert.deepEqual(await page.evaluate(()=>PupJournalEditor.collect().document),before);
    assert.equal(await page.evaluate(()=>speechSessions[0].aborted),true);
  }finally{await page.close();}
});

test('website dictation retains its form when the target paragraph changes during capture',async()=>{
  const page=await dictationPage();
  try{
    await page.locator('[data-block-id="second"] .dictation-mic').click();
    const dialog=page.getByRole('dialog',{name:'Dictation'});
    await page.evaluate(()=>{speechSessions.at(-1).emit('new words');PupJournalEditor.editor.doc[2].text='Newer typing';PupJournalEditor.editor.render();});
    await dialog.getByRole('button',{name:'Use text',exact:true}).click();
    assert.equal(await page.evaluate(()=>PupJournalEditor.editor.doc[2].text),'Newer typing');
    assert.ok((await dialog.getByRole('textbox',{name:'Dictation text'}).inputValue()).includes('new words'));
    await dialog.getByRole('status').getByText('This paragraph changed. Copy your dictated text before closing.',{exact:true}).waitFor();
  }finally{await page.close();}
});

test('website dictated tags apply only after the target paragraph passes review',async()=>{
  const page=await dictationPage();
  try{
    await page.evaluate(()=>{const section=document.querySelector('.section[data-section-id]');document.getElementById('tag-voice-catalog').textContent=JSON.stringify([{name:'alex',section_id:section.dataset.sectionId,section_name:'people'}]);});
    await page.locator('[data-block-id="second"] .dictation-mic').click();
    await page.evaluate(()=>{speechSessions.at(-1).emit('a note, tag alex');PupJournalEditor.editor.doc[2].links=[];});
    const dialog=page.getByRole('dialog',{name:'Dictation'});
    assert.equal(await dialog.getByRole('button',{name:'Cancel dictation',exact:true}).count(),0);
    await dialog.getByRole('button',{name:'Use text',exact:true}).click();
    assert.equal(await page.locator('.section input[value="alex"]:checked').count(),0);
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.locator('[data-block-id="second"] .dictation-mic').click();
    await page.evaluate(()=>speechSessions.at(-1).emit('a note, tag alex'));
    await page.getByRole('dialog',{name:'Dictation'}).getByRole('button',{name:'Use text',exact:true}).click();
    assert.equal(await page.locator('.section input[value="alex"]').isChecked(),true);
    assert.ok((await page.evaluate(()=>PupJournalEditor.collect().body)).includes('a note'));
  }finally{await page.close();}
});

test('website voice tag review fits narrow dialogs and keeps a circular record control',async()=>{
  const page=await dictationPage();
  try{
    await page.locator('[data-block-id="second"] .dictation-mic').click();
    const dialog=page.getByRole('dialog',{name:'Dictation'});
    await page.evaluate(()=>speechSessions.at(-1).emit('tag coffee shop'));
    assert.equal(await dialog.locator('.dictation-mic').evaluate(el=>getComputedStyle(el).borderRadius),'50%');
    for(const width of [390,320]){
      await page.setViewportSize({width,height:900});
      const bounds=await dialog.locator('.voice-tag-review').boundingBox();
      for(const control of await dialog.locator('.voice-tag-review .custom-select,.voice-tag-restore,.voice-tag-chip').all()){
        const box=await control.boundingBox();assert.ok(box.x>=bounds.x&&box.x+box.width<=bounds.x+bounds.width+1);
      }
    }
  }finally{await page.close();}
});

test('unsupported speech browsers keep an explained disabled record control in the textbox',async()=>{
  const page=await dictationPage(false);
  try{
    const record=page.locator('[data-block-id="second"] .dictation-mic');
    assert.equal(await record.isVisible(),true);assert.equal(await record.isDisabled(),true);
    assert.match(await record.getAttribute('title'),/not supported|isn't supported/);
  }finally{await page.close();}
});

const selectMarkup = '<label for="frequency">Repeat</label><select id="frequency"><option value="none">No repeat</option><option value="daily" disabled>Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><button id="after">After</button>';

test('custom select arrows skip disabled choices, commit with Enter and restore focus', async () => {
  const page = await openPage(selectMarkup);
  try {
    const trigger = page.locator('.cs-trigger');
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.cs-option:focus').textContent(), 'Weekly');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('select').inputValue(), 'weekly');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
  } finally { await page.close(); }
});

test('custom select reflects external changes, disabled state and the field label', async () => {
  const page = await openPage(selectMarkup);
  try {
    await page.locator('select').evaluate(select => {
      select.value = 'monthly';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.locator('.cs-option.is-selected').textContent(), 'Monthly');
    assert.equal(await page.locator('.cs-option[aria-selected="true"]').textContent(), 'Monthly');
    assert.match(await page.locator('.cs-trigger').getAttribute('aria-label'), /Repeat/);
    await page.locator('select').evaluate(select => { select.disabled = true; });
    await page.waitForFunction(() => document.querySelector('.cs-trigger').disabled);
    assert.equal(await page.locator('.cs-trigger').isDisabled(), true);
  } finally { await page.close(); }
});

test('custom select Escape returns focus; Tab closes without trapping focus', async () => {
  const page = await openPage(selectMarkup);
  try {
    const trigger = page.locator('.cs-trigger');
    await trigger.click();
    await page.keyboard.press('End');
    assert.equal(await page.locator('.cs-option:focus').textContent(), 'Monthly');
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    await trigger.click();
    await page.keyboard.press('Tab');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#after').evaluate(el => document.activeElement === el), true);
  } finally { await page.close(); }
});

test('themed dropdown options stay visible inside a clipped panel and a narrow viewport',async()=>{
  const page=await openPage('<div style="height:90px;overflow:hidden;margin-left:auto;width:190px"><label for="clipped-choice">Section</label><select id="clipped-choice"><option>Short</option><option>A longer section name that needs to wrap</option><option>Last</option></select></div>');
  try {
    await page.setViewportSize({width:320,height:844});await page.locator('.cs-trigger').click();
    await page.keyboard.press('ArrowDown');
    const option=page.getByRole('option',{name:'A longer section name that needs to wrap',exact:true});
    const geometry=await option.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return{left:r.left,right:r.right,visible:!!hit&&(hit===el||el.contains(hit))};});
    assert.ok(geometry.left>=0&&geometry.right<=320&&geometry.visible,JSON.stringify(geometry));
    await page.keyboard.press('Enter');assert.equal(await page.locator('select').inputValue(),'A longer section name that needs to wrap');
    assert.equal(await page.locator('.cs-trigger').evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('confirmation focuses Cancel, contains Tab, and restores the initiating control', async () => {
  const page = await openPage('<button id="launch">Remove</button><button id="other">Other</button>');
  try {
    await page.evaluate(() => {
      document.querySelector('#launch').onclick = async () => {
        window.confirmed = await window.confirmModal('Remove this item?', 'Remove');
      };
    });
    await page.locator('#launch').click();
    assert.equal(await page.locator('.modal-cancel').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.modal-confirm').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.modal-cancel').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.confirmed), false);
    assert.equal(await page.locator('#launch').evaluate(el => document.activeElement === el), true);
  } finally { await page.close(); }
});

for (const kind of ['task', 'missed task', 'tag']) test(`${kind} removal explains consequences, cancels without submission, and restores focus`, async () => {
  const page = await openPage();
  try {
    if (kind === 'tag') {
      await page.route('https://datapom.test/tags', route => route.fulfill({ contentType: 'text/html', body: tagsPage }));
      await page.goto('https://datapom.test/tags');
    }
    const remove = page.getByRole('button', { name: kind === 'task' ? 'Delete Review task' : kind === 'missed task' ? 'Delete Missed review' : 'Delete tag work', exact: true });
    await remove.evaluate(button => {
      window.deletionSubmits = 0;
      button.form.addEventListener('submit', event => { event.preventDefault(); window.deletionSubmits++; });
      button.form.submit = () => { window.deletionSubmits++; };
    });
    await remove.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.deletionSubmits), 0);
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.textContent(), kind === 'tag' ? /all tasks/ : /notes and subtasks/);
    assert.equal(await page.locator('.modal-cancel').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.deletionSubmits), 0);
    assert.equal(await remove.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.locator('.modal-confirm').click();
    assert.equal(await page.evaluate(() => window.deletionSubmits), 1);
  } finally { await page.close(); }
});

test('confirmation keyboard focus uses the web theme color',async()=>{
  const page=await openPage('<button id="theme-confirm">Review</button>');
  try {
    await page.evaluate(()=>document.querySelector('#theme-confirm').onclick=()=>window.confirmModal('Keep this change?','Keep'));
    await page.locator('#theme-confirm').focus();await page.keyboard.press('Enter');
    const colors=await page.locator('.modal-cancel').evaluate(el=>{const sample=document.createElement('span');sample.style.color='var(--accent)';document.body.append(sample);const accent=getComputedStyle(sample).color;sample.remove();return{outline:getComputedStyle(el).outlineColor,accent};});
    assert.equal(colors.outline,colors.accent);
  }finally{await page.close();}
});

for(const kind of ['due','journal'])test(`${kind} calendar stays vertically visible near the viewport bottom`,async()=>{
  const page=await openPage(kind==='due'?'<input type="datetime-local" value="2026-09-12T09:30" aria-label="Due date">':calendarMarkup);
  try {
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    if(kind==='due')await page.evaluate(()=>window.enhanceDatetime(document.querySelector('input')));
    else await page.addScriptTag({path:path.join(__dirname,'../static/journal.js')});
    await page.locator(kind==='due'?'.dt-field':'.cal-field').evaluate(el=>Object.assign(el.style,{position:'fixed',bottom:'20px',left:'16px'}));
    await page.locator(kind==='due'?'.dt-trigger':'.cal-trigger').click();
    const box=await page.getByRole('dialog').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=844,JSON.stringify(box));
    await page.keyboard.press('ArrowRight');await page.keyboard.press('Escape');
    assert.equal(await page.locator(kind==='due'?'.dt-trigger':'.cal-trigger').evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('a populated tag overview keeps its footer reachable with enlarged text',async()=>{
  const page=await openPage(tagMarkup);
  try {
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    const payload=tagPayload('alex');payload.task.timeline=Array.from({length:5},(_,i)=>({date:'2026-09-'+(10+i),title:'A longer review task',status:'completed'}));payload.task.cooccurring=[{name:'work',count:4},{name:'review',count:3}];
    await page.route('https://datapom.test/tag/**',route=>route.fulfill({json:payload}));await page.locator('[data-tagpop="alex"]').click();await page.locator('.tag-pop-name').waitFor();
    const box=await page.getByRole('dialog').boundingBox();assert.ok(box.y>=0&&box.y+box.height<=844,JSON.stringify(box));
    await page.getByRole('button',{name:'Expand →',exact:true}).focus();
    const footer=await page.getByRole('button',{name:'Expand →',exact:true}).boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=844,JSON.stringify(footer));
    await page.keyboard.press('Escape');assert.equal(await page.locator('[data-tagpop="alex"]').evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('mobile Taken at keeps both18px gutters with enlarged text',async()=>{
  const page=await openPage('<input type="datetime-local" value="2026-09-12T09:30" aria-label="Taken at">');
  try {
    await page.setViewportSize({width:360,height:844});await page.evaluate(()=>{document.body.classList.add('media-mobile');document.documentElement.style.fontSize='32px';window.enhanceDatetime(document.querySelector('input'));});
    await page.locator('.dt-trigger').click();const box=await page.getByRole('dialog').boundingBox();
    assert.ok(box.x>=18&&box.x+box.width<=342,JSON.stringify(box));
    const overflow=await page.getByRole('dialog').evaluate(el=>el.scrollWidth-el.clientWidth);assert.ok(overflow<=1,overflow);
  }finally{await page.close();}
});

test('a repeated confirmation request cannot attach two actions to one confirmation', async () => {
  const page = await openPage();
  try {
    await page.evaluate(() => {
      window.firstAnswer = 'pending'; window.secondAnswer = 'pending';
      window.confirmModal('First action?', 'First').then(value => { window.firstAnswer = value; });
      window.confirmModal('Second action?', 'Second').then(value => { window.secondAnswer = value; });
    });
    await page.locator('.modal-confirm').click();
    assert.deepEqual(await page.evaluate(() => [window.firstAnswer, window.secondAnswer]), [false, true]);
  } finally { await page.close(); }
});

test('due date calendar is keyboard reachable and restores focus on Escape', async () => {
  const page = await openPage('<label for="due">Due date</label><input id="due" type="datetime-local" value="2026-09-12T09:30"><button id="after">After</button>');
  try {
    await page.evaluate(() => window.enhanceDatetime(document.querySelector('#due')));
    await page.locator('.dt-trigger').click();
    assert.equal(await page.locator('.cal-day.is-selected:focus').count(), 1);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('aria-label'), 'September 13, 2026');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#due').inputValue(), '2026-09-13T09:30');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.dt-trigger').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.dt-trigger').getAttribute('aria-expanded'), 'false');
  } finally { await page.close(); }
});

test('keyboard users can enter a due-date month reached with the month controls', async () => {
  const page = await openPage('<form><input type="datetime-local" id="due" value="2026-09-12T09:30"></form>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/datetime-picker.js') });
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    await page.locator('.dt-trigger').click();
    await page.getByRole('button', {name: 'Next month'}).click();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date', {timeout: 1000}), '2026-10-01');
  } finally {await page.close();}
});

const calendarMarkup = '<form id="journal-form" data-media-editor="1" data-entry-date="2026-09-12"><div class="cal-field" data-current-date="2026-09-12" data-is-saved="false"><button type="button" class="cal-trigger"><span class="cal-trigger-label">2026-09-12</span></button><input class="cal-input" value="2026-09-12" type="hidden"></div></form><script id="entry-dates-data" type="application/json">[]</script><script id="occupied-dates-data" type="application/json">[]</script>';

test('journal date navigation replaces the document editor instead of relabeling an old autosave target', async () => {
  const page = await openPage(calendarMarkup);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.cal-trigger').click();
    await page.locator('[data-date="2026-09-13"]').click();
    await page.waitForURL('**/journal/2026-09-13');
    assert.equal(new URL(page.url()).pathname, '/journal/2026-09-13');
  } finally { await page.close(); }
});

test('journal calendar supports day arrow keys and restores its trigger on Escape', async () => {
  const page = await openPage(calendarMarkup);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.cal-trigger').click();
    assert.equal(await page.locator('.cal-day.is-selected:focus').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date'), '2026-09-19');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'cal-trigger');
  } finally { await page.close(); }
});

test('keyboard users can enter a journal month reached with the month controls', async () => {
  const page = await openPage(calendarMarkup);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.cal-trigger').click();
    await page.getByRole('button', {name: 'Next month'}).click();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date', {timeout: 1000}), '2026-10-01');
  } finally {await page.close();}
});

test('an autosave completing while the journal calendar is open preserves the focused day', async () => {
  const page = await openPage(calendarMarkup);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.cal-trigger').click();
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', { detail: { date: '2026-09-12', hasEntry: true, persisted: true } })));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('.cal-popover').count(), 1);
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date', { timeout: 2000 }), '2026-09-13');
  } finally { await page.close(); }
});

test('canceling dirty journal navigation keeps the calendar and its focused date available', async () => {
  const page = await openPage(calendarMarkup.replace('<form id="journal-form"', '<input name="title"><form id="journal-form"'));
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('input[name="title"]').fill('Unsaved title');
    await page.locator('.cal-trigger').click();
    await page.locator('[data-date="2026-09-13"]').click();
    await page.locator('.modal-cancel').click();
    assert.equal(await page.locator('.cal-popover').count(), 1);
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date', { timeout: 2000 }), '2026-09-13');
    assert.equal(await page.locator('input[name="title"]').inputValue(), 'Unsaved title');
  } finally { await page.close(); }
});

test('canceling navigation after an autosave keeps the replacement calendar day focused', async () => {
  const page = await openPage(calendarMarkup.replace('<form id="journal-form"', '<input name="title"><form id="journal-form"'));
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('input[name="title"]').fill('Unsaved title');
    await page.locator('.cal-trigger').click();
    await page.locator('[data-date="2026-09-13"]').click();
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', { detail: { date: '2026-09-12', hasEntry: true, persisted: true } })));
    await page.locator('.modal-cancel').click();
    assert.equal(await page.locator('.cal-popover').count(), 1);
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date', { timeout: 1000 }), '2026-09-13');
  } finally { await page.close(); }
});

test('entry Move waits for its editor and stays open when saving fails', async () => {
  const page = await openPage(calendarMarkup + '<button class="move-btn">Move</button><form id="move-form"><input class="move-input"></form>');
  try {
    await page.evaluate(() => {
      window.entryActions = []; window.entrySubmits = [];
      window.PupJournalEditor = {prepareEntryAction: action => {window.entryActions.push(action); return new Promise(resolve => {window.actionReady = resolve;});}};
      document.querySelector('#move-form').submit = () => window.entrySubmits.push(document.querySelector('.move-input').value);
    });
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.move-btn').click();
    await page.locator('[data-date="2026-09-13"]').click();
    assert.deepEqual(await page.evaluate(() => window.entryActions), ['move']);
    assert.deepEqual(await page.evaluate(() => window.entrySubmits), []);
    await page.evaluate(() => window.actionReady(false));
    assert.equal(await page.locator('.cal-popover').count(), 1);
    await page.locator('[data-date="2026-09-14"]').click();
    await page.evaluate(() => window.actionReady(true));
    assert.deepEqual(await page.evaluate(() => window.entrySubmits), ['2026-09-14']);
  } finally { await page.close(); }
});

test('entry Delete confirms removal of its draft and waits for editor preparation', async () => {
  const page = await openPage(calendarMarkup + '<button class="delete-entry-btn">Delete</button><form id="delete-form"></form>');
  try {
    await page.evaluate(() => {
      window.entryActions = []; window.entrySubmits = 0;
      window.PupJournalEditor = {prepareEntryAction: action => {window.entryActions.push(action); return new Promise(resolve => {window.actionReady = resolve;});}};
      document.querySelector('#delete-form').submit = () => {window.entrySubmits++;};
    });
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    await page.locator('.delete-entry-btn').click();
    assert.match(await page.locator('.modal-msg').textContent(), /draft/);
    await page.locator('.modal-confirm').click();
    assert.deepEqual(await page.evaluate(() => window.entryActions), ['delete']);
    assert.equal(await page.evaluate(() => window.entrySubmits), 0);
    await page.evaluate(() => window.actionReady(true));
    assert.equal(await page.evaluate(() => window.entrySubmits), 1);
  } finally { await page.close(); }
});

test('saving a new numeric-only entry reveals actions for its returned ID without reloading', async () => {
  const actions = '<button class="move-btn" hidden>Move</button><button class="delete-entry-btn" hidden>Delete</button><form id="move-form" data-action-template="/journal/entry/__ENTRY_ID__/move"><input class="move-input"></form><form id="delete-form" data-action-template="/journal/entry/__ENTRY_ID__/delete"></form>';
  const page = await openPage(calendarMarkup + actions);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal.js') });
    assert.equal(await page.locator('.move-btn').isVisible(), false);
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', {detail: {date:'2026-09-12',entryId:'saved-review',hasEntry:false,persisted:true}})));
    assert.equal(await page.locator('.move-btn').isVisible(), true);
    assert.equal(await page.locator('.delete-entry-btn').isVisible(), true);
    assert.equal(await page.locator('#move-form').getAttribute('action'), '/journal/entry/saved-review/move');
    assert.equal(await page.locator('#delete-form').getAttribute('action'), '/journal/entry/saved-review/delete');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', {detail: {date:'2026-09-13',entryId:'another-entry',hasEntry:true,persisted:true}})));
    assert.equal(await page.locator('#move-form').getAttribute('action'), '/journal/entry/saved-review/move');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', {detail: {date:'2026-09-12',entryId:null,hasEntry:false,persisted:false}})));
    assert.equal(await page.locator('.delete-entry-btn').isVisible(), false);
  } finally {await page.close();}
});

const tagMarkup = '<span role="button" tabindex="0" class="tag-pop-trigger" data-tagpop="alex">alex</span><span role="button" tabindex="0" class="tag-pop-trigger" data-tagpop="sam">sam</span>';
const tagPayload = name => ({ name, task: { active: 1, completed: 0, expired: 0 }, journal: { entries: 1, sections: [] } });

test('tag popovers open by keyboard, receive focus and return it on Escape', async () => {
  const page = await openPage(tagMarkup);
  try {
    await page.route('https://datapom.test/tag/**', route => route.fulfill({ json: tagPayload('alex') }));
    await page.locator('[data-tagpop="alex"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('.tag-pop-name').waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.tag-pop-close').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-tagpop="alex"]').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.tag-pop').count(), 0);
  } finally { await page.close(); }
});

test('an older tag request failure cannot close a newer tag popover', async () => {
  const page = await openPage(tagMarkup);
  let release;
  try {
    await page.route('https://datapom.test/tag/**', async route => {
      if (route.request().url().includes('/alex/')) {
        await new Promise(resolve => { release = resolve; });
        return route.fulfill({ status: 500, body: 'Error' });
      }
      return route.fulfill({ json: tagPayload('sam') });
    });
    await page.locator('[data-tagpop="alex"]').click();
    await page.locator('[data-tagpop="sam"]').click();
    await page.locator('.tag-pop-name').filter({ hasText: 'sam' }).waitFor();
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.tag-pop-name').textContent({ timeout: 2000 }), 'sam');
  } finally { release?.(); await page.close(); }
});

const configureMarkup = '<button class="configure-btn" data-section="people" data-name="people">Configure</button><script id="section-chart-opts-data" type="application/json">{"people":[{"id":"tag-frequency","label":"Tag frequency","enabled":true}]}</script>';

test('section configuration contains keyboard focus and closes from its backdrop', async () => {
  const page = await openPage(configureMarkup);
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/section-config.js') });
    await page.locator('.configure-btn').click();
    assert.equal(await page.locator('.suggest-popup').getAttribute('role'), 'dialog');
    assert.equal(await page.locator('.suggest-popup-close').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.modal-confirm').evaluate(el => document.activeElement === el), true);
    await page.locator('.suggest-popup-overlay').click({ position: { x: 4, y: 4 } });
    assert.equal(await page.locator('.suggest-popup-overlay').count(), 0);
    assert.equal(await page.locator('.configure-btn').evaluate(el => document.activeElement === el), true);
  } finally { await page.close(); }
});

test('section configuration keeps choices and shows an HTTP save failure', async () => {
  const page = await openPage(configureMarkup);
  try {
    await page.route('https://datapom.test/journal/sections/people/chart-opts', route => route.fulfill({ status: 500, body: 'Unavailable' }));
    await page.addScriptTag({ path: path.join(__dirname, '../static/section-config.js') });
    await page.locator('.configure-btn').click();
    await page.locator('.chartcfg-row input').uncheck();
    await page.locator('.modal-confirm').click();
    await page.locator('.suggest-popup').getByRole('status').filter({ hasText: 'Could not save' }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.chartcfg-row input').isChecked(), false);
    assert.equal(await page.locator('.modal-confirm').isEnabled(), true);
  } finally { await page.close(); }
});

test('pending section configuration retains submitted choices and blocks dismissal until retry',async()=>{
  const page=await openPage(configureMarkup);let release;
  try {
    await page.route('https://datapom.test/journal/sections/people/chart-opts',route=>new Promise(resolve=>{release=()=>resolve(route.fulfill({status:503,body:'Unavailable'}));}));
    await page.addScriptTag({path:path.join(__dirname,'../static/section-config.js')});
    await page.locator('.configure-btn').click();await page.locator('.chartcfg-row input').uncheck();
    await page.locator('.modal-confirm').click();
    assert.equal(await page.locator('.chartcfg-row input').isDisabled(),true);
    await page.keyboard.press('Escape');await page.keyboard.press('Tab');
    await page.locator('.suggest-popup-overlay').click({position:{x:4,y:4}});
    assert.equal(await page.getByRole('dialog',{name:'Configure people',exact:true}).count(),1);
    assert.equal(await page.locator('.chartcfg-row input').isChecked(),false);
    release();release=null;await page.getByRole('status').filter({hasText:'Could not save'}).waitFor();
    assert.equal(await page.locator('.chartcfg-row input').isEnabled(),true);
    assert.equal(await page.locator('.modal-confirm').evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('.configure-btn').evaluate(el=>document.activeElement===el),true);
  }finally{release?.();await page.close();}
});

test('tag suggestions name their dialog, preserve failed choices and dismiss the backdrop', async () => {
  const page = await openPage('<div id="suggest-root"></div><script id="suggest-data" type="application/json">{"suggestions":[{"word":"orchard","days":3}]}</script>');
  try {
    await page.route('https://datapom.test/journal/suggestions/orchard', route => route.fulfill({ json: { sections: [{ id: 'people', name: 'people' }], occurrences: [{ date: '2026-09-10', snippet: 'An **orchard** walk' }] } }));
    await page.route('https://datapom.test/journal/suggestions/orchard/apply', route => route.fulfill({ status: 503, json: { ok: false } }));
    await page.addScriptTag({ path: path.join(__dirname, '../static/tag-suggest.js') });
    await page.locator('.suggest-chip-body').click();
    await page.locator('.suggest-day-row').waitFor();
    assert.equal(await page.locator('.suggest-popup').getAttribute('role'), 'dialog');
    await page.locator('.modal-confirm').click();
    await page.locator('.suggest-popup').getByRole('status').filter({ hasText: 'Could not apply' }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('.suggest-day-row input').isChecked(), true);
    await page.locator('.suggest-popup-overlay').click({ position: { x: 4, y: 4 } });
    assert.equal(await page.locator('.suggest-popup-overlay').count(), 0);
    assert.equal(await page.locator('.suggest-chip-body').evaluate(el => document.activeElement === el), true);
  } finally { await page.close(); }
});

test('pending tag application locks its kind, section, dates, and dismissal until retry',async()=>{
  const page=await openPage('<div id="suggest-root"></div><script id="suggest-data" type="application/json">{"suggestions":[{"word":"orchard","days":3}]}</script>');let release;
  try {
    await page.route('https://datapom.test/journal/suggestions/orchard',route=>route.fulfill({json:{sections:[{id:'people',name:'people'},{id:'places',name:'places'}],occurrences:[{date:'2026-09-10',snippet:'An **orchard** walk'}]}}));
    await page.route('https://datapom.test/journal/suggestions/orchard/apply',route=>new Promise(resolve=>{release=()=>resolve(route.fulfill({status:503,json:{ok:false}}));}));
    await page.addScriptTag({path:path.join(__dirname,'../static/tag-suggest.js')});
    await page.locator('.suggest-chip-body').click();await page.getByRole('button',{name:'Temporary',exact:true}).click();
    await page.locator('.modal-confirm').click();
    assert.equal(await page.locator('.suggest-day-row input').isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Temporary',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('.cs-trigger').isDisabled(),true);
    await page.keyboard.press('Escape');await page.locator('.suggest-popup-overlay').click({position:{x:4,y:4}});
    assert.equal(await page.getByRole('dialog',{name:'Tag orchard',exact:true}).count(),1);
    release();release=null;await page.getByRole('status').filter({hasText:'Could not apply'}).waitFor();
    assert.equal(await page.locator('.suggest-day-row input').isChecked(),true);
    assert.equal(await page.getByRole('button',{name:'Temporary',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.cs-trigger').isEnabled(),true);
    assert.equal(await page.locator('.modal-confirm').evaluate(el=>document.activeElement===el),true);
  }finally{release?.();await page.close();}
});

test('failed tag suggestion loads retry in place and preserve keyboard focus',async()=>{
  const page=await openPage('<div id="suggest-root"></div><script id="suggest-data" type="application/json">{"suggestions":[{"word":"orchard","days":3}]}</script>');let attempts=0;
  try {
    await page.route('https://datapom.test/journal/suggestions/orchard',route=>++attempts===1?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{sections:[{id:'people',name:'people'}],occurrences:[{date:'2026-09-10',snippet:'An **orchard** walk'}]}}));
    await page.addScriptTag({path:path.join(__dirname,'../static/tag-suggest.js')});await page.locator('.suggest-chip-body').click();
    await page.getByText('Could not load suggestion.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Retry suggestion',exact:true}).count(),1);
    await page.keyboard.press('Tab');assert.equal(await page.getByRole('button',{name:'Retry suggestion',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Enter');await page.locator('.suggest-day-row').waitFor();
    assert.equal(attempts,2);assert.equal(await page.getByRole('button',{name:'Permanent',exact:true}).evaluate(el=>document.activeElement===el),true);
    assert.equal(await page.getByRole('button',{name:'Retry suggestion',exact:true}).count(),0);
  }finally{await page.close();}
});

test('search tag filters keep independent choices and return focus when closed', async () => {
  const page = await openPage('<input id="q"><div class="tag-dropdown"><button class="tag-dropdown-btn">Tags</button><div class="tag-dropdown-panel" hidden><label><input type="checkbox" data-tag="alex">alex</label><label><input type="checkbox" data-tag="sam">sam</label></div></div><p class="result-count"></p><script id="entries-data" type="application/json">[]</script><script id="bounds-data" type="application/json">{}</script>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-search.js') });
    await page.locator('.tag-dropdown-btn').click();
    assert.equal(await page.locator('[data-tag="alex"]').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.tag-dropdown-btn').evaluate(el => document.activeElement === el), true);
    await page.locator('.tag-dropdown-btn').click();
    assert.equal(await page.locator('[data-tag="alex"]').isChecked(), true);
    assert.equal(await page.locator('[data-tag="sam"]').isChecked(), true);
  } finally { await page.close(); }
});

test('section tag drags cannot silently promote a tag into a different section', async () => {
  const page = await openPage('<div class="tag-zone" data-zone="temporary" data-section="people"><span id="drag-tag" class="perm-chip" draggable="true" data-origin="temporary" data-tag="alex">alex</span></div><div id="people-zone" class="tag-zone" data-zone="permanent" data-section="people" data-promote-url="/people/__TAG__/promote"></div><div id="places-zone" class="tag-zone" data-zone="permanent" data-section="places" data-promote-url="/places/__TAG__/promote"></div>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-sections.js') });
    await page.locator('#drag-tag').dispatchEvent('dragstart');
    await page.locator('#places-zone').dispatchEvent('dragover');
    assert.equal(await page.locator('#places-zone').evaluate(el => el.classList.contains('drag-over')), false);
    await page.locator('#people-zone').dispatchEvent('dragover');
    assert.equal(await page.locator('#people-zone').evaluate(el => el.classList.contains('drag-over')), true);
    await page.locator('#drag-tag').dispatchEvent('dragend');
    assert.equal(await page.locator('.drag-over').count(), 0);
  } finally { await page.close(); }
});

test('mood-only edits notify autosave and restored values update the visible picker', async () => {
  const page = await openPage('<form id="journal-form"><div class="mood-picker"><button type="button" class="mood-opt" data-mood="2"><img src="/static/img/2-pompom.gif" alt="Mood 2"></button><button type="button" class="mood-opt" data-mood="6"><img src="/static/img/6-pompom.gif" alt="Mood 6"></button></div><input type="hidden" class="mood-input" name="mood" value=""></form>');
  try {
    await page.evaluate(() => { window.moodEdits = 0; document.querySelector('form').addEventListener('change', () => { window.moodEdits++; }); });
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-mood.js') });
    await page.locator('[data-mood="6"]').click();
    assert.equal(await page.evaluate(() => window.moodEdits), 1);
    assert.equal(await page.locator('[data-mood="6"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-mood="6"]').click();
    assert.equal(await page.locator('.mood-input').inputValue(), '');
    assert.equal(await page.evaluate(() => window.moodEdits), 2);
    await page.locator('.mood-input').evaluate(input => { input.value = '2'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(await page.locator('.mood-opt.selected').getAttribute('data-mood'), '2');
    assert.equal(await page.locator('[data-mood="6"]').getAttribute('aria-pressed'), 'false');
  } finally { await page.close(); }
});

test('manual integration sync prevents duplicates and retains a visible failure', async () => {
  const page = await openPage('<section class="integration-card"><button type="button" id="rescuetime-sync-now">Sync now</button></section>');
  let release, requested;
  try {
    await page.route('https://datapom.test/integrations/rescuetime/sync?**', async route => {
      requested = new URL(route.request().url());
      await new Promise(resolve => { release = resolve; });
      return route.fulfill({ status: 503, json: { ok: false } });
    });
    await page.addScriptTag({ path: path.join(__dirname, '../static/integrations-sync.js') });
    await page.locator('#rescuetime-sync-now').click();
    assert.equal(await page.locator('#rescuetime-sync-now').isDisabled(), true);
    await page.waitForTimeout(50);
    assert.equal(requested.searchParams.get('force'), '1');
    release();
    await page.getByRole('status').filter({ hasText: 'Sync failed' }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('#rescuetime-sync-now').isEnabled(), true);
  } finally { release?.(); await page.close(); }
});

test('integration data renders missing metrics cleanly and reports partial sync errors', async () => {
  const page = await openPage('<div id="sleep-panel" data-date="2026-09-10" data-connected="1" data-last-sync="invalid">Old sleep data</div>');
  try {
    await page.route('https://datapom.test/integrations/google/sync?**', route => route.fulfill({ json: { ok: true, connected: true, errors: ['Another day failed'], sleep: { '2026-09-10': { start: '23:10', end: '07:20', duration_min: 490, quality: null } } } }));
    await page.addScriptTag({ path: path.join(__dirname, '../static/integrations-sync.js') });
    await page.locator('#sleep-panel').getByText('8h 10m', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await page.locator('#sleep-panel .sleep-qual').count(), 0);
    await page.getByRole('status').filter({ hasText: 'Some days could not sync' }).waitFor({ timeout: 2000 });
  } finally { await page.close(); }
});

for (const source of ['history_import','spotify']) test(`Spotify ${source} rows retain the displayed source after sync`,async()=>{
  const page=await openPage('<div id="spotify-panel" data-date="2026-09-10" data-connected="1" data-last-sync="invalid">Old listening data</div>');
  try {
    await page.route('https://datapom.test/integrations/spotify/sync?**',route=>route.fulfill({json:{ok:true,connected:true,errors:[],music:{'2026-09-10':{minutes:42,tracks:7,top_artists:[{name:'Review artist'}],source,source_label:source==='history_import'?'Imported history':null}}}}));
    await page.addScriptTag({path:path.join(__dirname,'../static/integrations-sync.js')});
    await page.locator('#spotify-panel .music-min').waitFor();
    assert.equal(await page.locator('#spotify-panel').getByText('Imported history',{exact:true}).count(),source==='history_import'?1:0);
    assert.equal(await page.locator('#spotify-panel').getByText('42 min',{exact:true}).count(),1);
  }finally{await page.close();}
});

test('rich text reflects dotted mentions and numeric changes into autosave fields', async () => {
  const page = await openPage('<form><div class="body-field"><textarea class="body-input">Met @dr.lee. #weight 68.5</textarea><div class="body-rendered" hidden></div></div><div class="section" data-section-id="people"><div class="chips"></div></div><input name="num:weight" value=""><script id="mention-index" type="application/json">{"dr":{"section_id":"people","color":"#e0a955"},"dr.lee":{"section_id":"people","color":"#e0a955"}}</script><script id="numeric-index" type="application/json">{"weight":{"section_id":"weight","color":"#e0a955","unit":"kg"}}</script></form>');
  try {
    await page.evaluate(() => { window.reflectedEdits = []; document.querySelector('form').addEventListener('change', event => window.reflectedEdits.push(event.target.name)); });
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-richtext.js') });
    assert.deepEqual(await page.locator('.chips input').evaluateAll(inputs => inputs.map(input => input.value)), ['dr.lee']);
    assert.equal(await page.locator('[name="num:weight"]').inputValue(), '68.5');
    assert.deepEqual(await page.evaluate(() => window.reflectedEdits), ['tag:people', 'num:weight']);
  } finally { await page.close(); }
});

for(const known of [false,true])test(`rich text treats prototype-like names as ${known?'registered fields':'unknown text'}`,async()=>{
  const names=['constructor','__proto__'];
  const mentions=known?Object.fromEntries(names.map(name=>[name,{section_id:'people',color:'#e0a955'}])):{};
  const numbers=known?Object.fromEntries(names.map((name,i)=>[name,{section_id:'number'+i,color:'#e0a955',unit:'pts'}])):{};
  const page=await openPage('<form><div class="body-field"><textarea class="body-input">@constructor @__proto__ #constructor 4 #__proto__ 5</textarea><div class="body-rendered" hidden></div></div><div class="section" data-section-id="people"><div class="chips"></div></div><input name="num:number0"><input name="num:number1"><script id="mention-index" type="application/json">'+JSON.stringify(mentions)+'</script><script id="numeric-index" type="application/json">'+JSON.stringify(numbers)+'</script></form>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.equal(await page.locator('.mention-highlight').count(),known?2:0);
    assert.equal(await page.locator('.numeric-highlight').count(),known?2:0);
    assert.deepEqual(await page.locator('.chips input').evaluateAll(inputs=>inputs.map(input=>input.value)),known?names:[]);
    assert.equal(await page.locator('[name="num:number0"]').inputValue(),known?'4':'');
    assert.equal(await page.locator('[name="num:number1"]').inputValue(),known?'5':'');
  }finally{await page.close();}
});

test('mention tokens retain surrounding formatting, literal names and escaped text',async()=>{
  const page=await openPage('<div class="body-field"><textarea class="body-input">**Met @__proto__** and __underlined__ &lt;img src=x onerror=alert(1)&gt; #constructor 5.25</textarea><div class="body-rendered" hidden></div></div><script id="mention-index" type="application/json">{"__proto__":{"section_id":"people","color":"#e0a955"}}</script><script id="numeric-index" type="application/json">{"constructor":{"section_id":"number","color":"#e0a955","unit":"pts"}}</script>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.equal(await page.locator('.body-rendered strong .mention-highlight').textContent(),'__proto__');
    assert.equal(await page.locator('.body-rendered u').textContent(),'underlined');
    assert.equal(await page.locator('.body-rendered .numeric-highlight').textContent(),'constructor 5.25 pts');
    assert.equal(await page.locator('.body-rendered img').count(),0);
    assert.ok((await page.locator('.body-rendered').textContent()).includes('<img src=x onerror=alert(1)>'));
  }finally{await page.close();}
});

test('underlined mentions and numeric captures keep their semantic highlights',async()=>{
  const page=await openPage('<div class="body-field"><textarea class="body-input">__@alex__ and __#weight 5__</textarea><div class="body-rendered" hidden></div></div><div class="section" data-section-id="people"><div class="chips"></div></div><input name="num:number"><script id="mention-index" type="application/json">{"alex":{"section_id":"people","color":"#e0a955"}}</script><script id="numeric-index" type="application/json">{"weight":{"section_id":"number","color":"#e0a955","unit":"kg"}}</script>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.equal(await page.locator('.body-rendered u .mention-highlight').textContent(),'alex');
    assert.equal(await page.locator('.body-rendered u .numeric-highlight').textContent(),'weight 5 kg');
    assert.equal(await page.locator('.chips input[value="alex"]').isChecked(),true);
    assert.equal(await page.locator('[name="num:number"]').inputValue(),'5');
  }finally{await page.close();}
});

test('inline captures respect Unicode word and email boundaries',async()=>{
  const page=await openPage('<div class="body-field"><textarea class="body-input">é@alex 文字#weight 5 a@alex a#weight 3</textarea><div class="body-rendered" hidden></div></div><div class="section" data-section-id="people"><div class="chips"></div></div><input name="num:number"><script id="mention-index" type="application/json">{"alex":{"section_id":"people","color":"#e0a955"}}</script><script id="numeric-index" type="application/json">{"weight":{"section_id":"number","color":"#e0a955","unit":"kg"}}</script>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.equal(await page.locator('.mention-highlight,.numeric-highlight,.chips input').count(),0);
    assert.equal(await page.locator('[name="num:number"]').inputValue(),'');
  }finally{await page.close();}
});

test('newly acknowledged task references become active links without reloading the editor',async()=>{
  const page=await openPage('<div class="body-field"><textarea class="body-input">[task:abc123] Review task</textarea><div class="body-rendered" hidden></div></div><script id="task-ref-index" type="application/json">{}</script>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.equal(await page.locator('.task-check.missing').count(),1);
    assert.equal(await page.locator('.task-check.missing').getAttribute('data-task-id'),'abc123');
    await page.evaluate(()=>{window.journalSetTaskIndex({abc123:{status:'active',done:false,title:'Review task'}});document.querySelector('.body-rendered').innerHTML=window.journalRender('[task:abc123] Review task',{});});
    assert.equal(await page.locator('.task-check.missing').count(),0);assert.equal(await page.locator('.task-check').getAttribute('href'),'/');
    assert.equal(await page.getByRole('link',{name:'Open task: Review task',exact:true}).getAttribute('data-task-id'),'abc123');
    await page.evaluate(()=>{window.journalSetTaskIndex({abc123:{status:'done',done:true,title:'Review task'}});document.querySelector('.body-rendered').innerHTML=window.journalRender('[task:abc123] Review task',{});});
    assert.equal(await page.locator('.task-check.done').getAttribute('href'),'/archive');
  }finally{await page.close();}
});

test('formatted journal text remains keyboard editable after blur', async () => {
  const page = await openPage('<div class="body-field"><textarea class="body-input">A paragraph</textarea><div class="body-rendered" hidden></div></div>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-richtext.js') });
    assert.equal(await page.locator('.body-rendered').getAttribute('tabindex'), '0');
    await page.locator('.body-rendered').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.body-input').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.body-input').isVisible(), true);
  } finally { await page.close(); }
});

test('optional task difficulty can be selected and cleared with the keyboard', async () => {
  const page = await openPage();
  try {
    await page.locator('.task-check').check();
    const medium = page.locator('.difficulty-check[value="medium"]');
    await medium.focus();
    await page.keyboard.press('Space');
    assert.equal(await medium.isChecked(), true);
    await page.keyboard.press('Space');
    assert.equal(await medium.isChecked(), false);
  } finally { await page.close(); }
});

test('task controls expose the task and field they act on', async () => {
  const page = await openPage();
  try {
    assert.equal(await page.getByRole('checkbox', {name: 'Complete Review task', exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Delete Review task', exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Due date: no due date', exact: true}).count(), 1);
    await page.getByRole('button', {name: /^Review task/}).click();
    assert.equal(await page.getByRole('checkbox', {name: 'Complete Review step', exact: true}).count(), 1);
    assert.equal(await page.getByRole('textbox', {name: 'Subtask text', exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Delete subtask: Review step', exact: true}).count(), 1);
  } finally {await page.close();}
});

test('archive lists recent completions first and displays a compact timestamp', async () => {
  const page = await openPage();
  try {
    await page.route('https://datapom.test/archive', route => route.fulfill({contentType: 'text/html', body: archivePage}));
    await page.goto('https://datapom.test/archive');
    assert.deepEqual(await page.locator('.task > .title').evaluateAll(toggles=>toggles.map(toggle=>toggle.firstChild.textContent)), ['Newest completion', 'Older completion', 'Undated completion']);
    const date = page.locator('time[datetime="2026-09-10T17:11:22.123456"]');
    assert.equal(await date.textContent(), '2026-09-10 17:11');
  } finally {await page.close();}
});

test('archive titles are keyboard disclosures only when saved details exist',async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/archive-details-review',route=>route.fulfill({contentType:'text/html',body:archivePage}));await page.goto('https://datapom.test/archive-details-review');
    assert.equal(await page.getByRole('button',{name:'Older completion',exact:true}).count(),0);
    assert.equal(await page.locator('.task-title-toggle').count(),1);
    const title=page.locator('.task-title-toggle');await title.focus();await page.keyboard.press('Enter');
    assert.equal(await page.getByText('Saved archive note',{exact:true}).isVisible(),true);
  }finally{await page.close();}
});

test('journal fields and management actions retain their section context', async () => {
  const page = await openPage();
  try {
    const showMain = html => page.locator('main').evaluate((main, source) => {
      main.innerHTML = new DOMParser().parseFromString(source, 'text/html').querySelector('main').innerHTML;
    }, html);
    await showMain(sectionPage);
    const people = page.getByRole('region', {name: 'people section', exact: true});
    assert.equal(await people.getByRole('textbox', {name: 'Section name', exact: true}).count(), 1);
    assert.equal(await people.getByRole('button', {name: 'Save people section', exact: true}).count(), 1);
    assert.equal(await people.getByRole('textbox', {name: 'Add permanent tag to people', exact: true}).count(), 1);
    await showMain(entryPage);
    assert.equal(await page.getByRole('textbox', {name: 'New people tag', exact: true}).count(), 1);
    assert.equal(await page.getByRole('spinbutton', {name: 'weight (kg)', exact: true}).count(), 1);
    await showMain(sectionArchivePage);
    assert.equal(await page.getByRole('button', {name: 'Restore past section', exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Restore old friend to people', exact: true}).count(), 1);
  } finally {await page.close();}
});

test('subtask dragging starts from the grip without hijacking checkbox interaction', async () => {
  const page = await openPage();
  try {
    await page.getByRole('button', {name: /^Review task/}).click();
    assert.equal(await page.locator('#active-tasks .subtask-row').evaluate(el => el.draggable), false);
    assert.equal(await page.locator('.subtask-drag').evaluate(el => el.draggable), true);
    await page.locator('#active-tasks .subtask-check').dispatchEvent('dragstart');
    assert.equal(await page.locator('.subtask-row.dragging').count(), 0);
    await page.locator('.subtask-drag').dispatchEvent('dragstart');
    assert.equal(await page.locator('.subtask-row.dragging').count(), 1);
    await page.locator('.subtask-drag').dispatchEvent('dragend');
    assert.equal(await page.locator('.subtask-row.dragging').count(), 0);
  } finally {await page.close();}
});

test('journal text search matches punctuation and accented words without matching word fragments', async () => {
  const entries = [
    {id:'code',title:'A coding day',body:'Practiced C++ today.',tags:[],numbers:{}},
    {id:'accent',title:'A café visit',body:'Élan after a café break.',tags:[],numbers:{}},
    {id:'fragment',title:'Fragments',body:'A mélange and caféine.',tags:[],numbers:{}},
  ];
  const rows = entries.map(entry => '<li class="entry-row" data-id="' + entry.id + '"><span>' + entry.title + '</span><div class="entry-snippet" hidden></div></li>').join('');
  const page = await openPage('<input id="q"><p class="result-count"></p><ul id="entry-list">' + rows + '</ul><script id="entries-data" type="application/json">' + JSON.stringify(entries) + '</script>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-search.js') });
    await page.locator('#q').fill('C++');
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
    assert.equal(await page.locator('.entry-row:visible').getAttribute('data-id'), 'code');
    assert.equal(await page.locator('.entry-row:visible .suggest-hl').textContent(), 'C++');
    await page.locator('#q').fill('élan café');
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
    assert.equal(await page.locator('.entry-row:visible').getAttribute('data-id'), 'accent');
    assert.deepEqual(await page.locator('.entry-row:visible .suggest-hl').allTextContents(), ['Élan', 'café']);
    await page.locator('#q').fill('café');
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
    await page.locator('#q').fill('e\u0301lan cafe\u0301');
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
  } finally {await page.close();}
});

test('populated search tag filters retain readable choices within a narrow enlarged viewport',async()=>{
  const names=Array.from({length:12},(_,i)=>i===0?'review_'+ 'a'.repeat(100):'review tag '+i);
  const labels=names.map(name=>'<label class="chip tag-toggle"><input type="checkbox" data-tag="'+name+'">'+name+'</label>').join('');
  const page=await openPage('<div class="search-controls"><input id="q"><div class="tag-dropdown"><button class="tag-dropdown-btn">Tags</button><div class="tag-dropdown-panel" hidden><div class="tag-dropdown-chips">'+labels+'</div></div></div></div><p class="result-count"></p><script id="entries-data" type="application/json">[]</script>');
  try {
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-search.js')});await page.getByRole('button',{name:'Tags',exact:true}).click();
    const geometry=await page.locator('.tag-dropdown-panel').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,width:el.scrollWidth,client:el.clientWidth}));
    assert.ok(geometry.left>=16&&geometry.right<=304&&geometry.top>=16&&geometry.bottom<=828&&geometry.width<=geometry.client,JSON.stringify(geometry));
    const boxes=page.locator('.tag-dropdown-panel input');
    for(let i=1;i<names.length;i++)await page.keyboard.press('Tab');
    assert.equal(await boxes.last().evaluate(el=>document.activeElement===el),true);
    const hit=await boxes.last().evaluate(el=>{const r=el.getBoundingClientRect();return el===document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);});assert.equal(hit,true);
    await page.keyboard.press('Space');await page.keyboard.press('Escape');
    assert.equal(await boxes.last().isChecked(),true);assert.equal(await page.locator('.tag-dropdown-btn').evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('search combines whole-word AND, tag OR, and numeric ranges while escaping punctuation', async () => {
  const entries = [
    {id:'low',title:'C++ café',body:'Literal <mark> and $5.00 [draft]',tags:['work'],numbers:{score:1}},
    {id:'high',title:'C++ café',body:'Other',tags:['home'],numbers:{score:3}},
    {id:'missing_word',title:'C++',body:'Other',tags:['home'],numbers:{score:3}},
    {id:'missing_number',title:'C++ café',body:'Other',tags:['work'],numbers:{}},
  ];
  const rows = entries.map(entry => '<li class="entry-row" data-id="' + entry.id + '"><div class="entry-snippet" hidden></div></li>').join('');
  const filters = '<div class="tag-dropdown"><button class="tag-dropdown-btn">Tags</button><div class="tag-dropdown-panel"><label><input type="checkbox" data-tag="work">work</label><label><input type="checkbox" data-tag="home">home</label></div></div><div class="num-filter"><input type="range" min="1" max="3" step="any" value="1" data-role="min" data-section="score"><input type="range" min="1" max="3" step="any" value="3" data-role="max" data-section="score"><input type="number" data-role="min-num"><input type="number" data-role="max-num"></div>';
  const page = await openPage('<input id="q"><p class="result-count"></p>' + filters + '<ul id="entry-list">' + rows + '</ul><script id="entries-data" type="application/json">' + JSON.stringify(entries) + '</script><script id="bounds-data" type="application/json">{"score":[1,3]}</script>');
  try {
    await page.addScriptTag({ path: path.join(__dirname, '../static/journal-search.js') });
    await page.locator('#q').fill('<mark> $5.00 [draft]');
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
    assert.deepEqual(await page.locator('.entry-row[data-id="low"] .suggest-hl').allTextContents(), ['<mark>', '$5.00', '[draft]']);
    assert.equal(await page.locator('.entry-snippet mark').count(), 0);
    await page.locator('#q').fill('C++ café');
    assert.equal(await page.locator('.result-count').textContent(), '3 entries');
    await page.getByRole('checkbox', {name:'work',exact:true}).check();
    assert.equal(await page.locator('.result-count').textContent(), '2 entries');
    await page.locator('[data-role="min-num"]').fill('2');
    assert.equal(await page.locator('.result-count').textContent(), '0 entries');
    await page.getByRole('button', {name:'Tags',exact:true}).click();
    await page.getByRole('checkbox', {name:'home',exact:true}).check();
    assert.equal(await page.locator('.result-count').textContent(), '1 entry');
    assert.equal(await page.locator('.entry-row').evaluateAll(rows => rows.find(row=>row.style.display!=='none')?.dataset.id), 'high');
  } finally {await page.close();}
});

test('long search previews keep the matched words visible in concise escaped context',async()=>{
  const body='Opening line without the query.\n'+ 'Earlier notes 🐶 '.repeat(80)+'Café <marker> '+ 'Later notes 🐶 '.repeat(80);
  const page=await openPage('<input id="q"><p class="result-count"></p><ul id="entry-list"><li class="entry-row" data-id="review"><span>Review day</span><div class="entry-snippet" hidden></div></li></ul><script id="entries-data" type="application/json">'+JSON.stringify([{id:'review',title:'Review day',body,tags:[],numbers:{}}])+'</script>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-search.js')});await page.locator('#q').fill('Café <marker>');
    const snippet=await page.locator('.entry-snippet').textContent();
    assert.ok(snippet.length<=244,snippet.length);assert.ok(snippet.startsWith('… '));assert.ok(snippet.endsWith(' …'));assert.ok(!snippet.includes('\uFFFD'));
    assert.match(snippet,/^… (?:Earlier |notes |🐶 )/u);assert.match(snippet,/(?:Later|notes|🐶) …$/u);
    assert.deepEqual(await page.locator('.suggest-hl').allTextContents(),['Café','<marker>']);assert.equal(await page.locator('.entry-snippet marker').count(),0);
    await page.locator('#q').fill('unmatched');assert.equal(await page.locator('.result-count').textContent(),'0 entries');
    await page.locator('#q').fill('Review');assert.equal(await page.locator('.result-count').textContent(),'1 entry');assert.equal(await page.locator('.entry-snippet').isVisible(),false);
  }finally{await page.close();}
});

test('search entries display a fallback date title only once', async () => {
  const page = await openPage();
  try {
    await page.route('https://datapom.test/journal/search', route => route.fulfill({contentType:'text/html',body:searchPage}));
    await page.goto('https://datapom.test/journal/search');
    assert.equal(await page.getByRole('link', {name:'2026-09-15',exact:true}).count(), 1);
  } finally {await page.close();}
});

test('required task feedback is themed, preserves values, and clears after correction', async () => {
  const page = await openPage();
  try {
    await page.locator('[name="new_tag"]').fill('review');
    await page.getByRole('button', {name:'Add task',exact:true}).click();
    assert.equal(await page.getByRole('alert').textContent(), 'Task title is required.');
    assert.equal(await page.getByRole('textbox', {name:'Task title'}).evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('[name="new_tag"]').inputValue(), 'review');
    assert.equal(await page.getByRole('textbox', {name:'Task title'}).getAttribute('aria-invalid'), 'true');
    await page.getByRole('textbox', {name:'Task title'}).fill('Keep my draft');
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('textbox', {name:'Task title'}).getAttribute('aria-invalid'), null);
  } finally {await page.close();}
});

test('range validation focuses the first invalid field and retains existing descriptions', async () => {
  const page = await openPage('<form><p id="hint">Daily target</p><input type="number" min="1" value="0" aria-label="Days" aria-describedby="hint"><input required aria-label="Title"><button>Save</button></form>');
  try {
    await page.getByRole('button', {name:'Save',exact:true}).click();
    assert.equal(await page.getByRole('alert').textContent(), 'Days: use 1 or more.');
    assert.equal(await page.getByRole('spinbutton', {name:'Days'}).evaluate(el => document.activeElement === el), true);
    assert.match(await page.getByRole('spinbutton', {name:'Days'}).getAttribute('aria-describedby'), /^hint /);
    await page.getByRole('spinbutton', {name:'Days'}).fill('3');
    assert.equal(await page.getByRole('spinbutton', {name:'Days'}).getAttribute('aria-describedby'), 'hint');
    await page.getByRole('button', {name:'Save',exact:true}).click();
    assert.equal(await page.getByRole('alert').textContent(), 'Title is required.');
  } finally {await page.close();}
});

test('required custom selects focus their themed trigger without native validation chrome', async () => {
  const page = await openPage('<form><label for="kind">Kind</label><select id="kind" required><option value="">Choose</option><option value="task">Task</option></select><button>Save</button></form>');
  try {
    await page.getByRole('button', {name:'Save',exact:true}).click();
    assert.equal(await page.getByRole('alert').textContent(), 'Kind is required.');
    assert.equal(await page.locator('.cs-trigger').evaluate(el => document.activeElement === el), true);
    assert.equal(await page.locator('.cs-trigger').getAttribute('aria-invalid'), 'true');
    await page.locator('.cs-trigger').click();
    await page.getByRole('option', {name:'Task',exact:true}).click();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.locator('.cs-trigger').getAttribute('aria-invalid'), null);
  } finally {await page.close();}
});

test('required due dates focus their themed trigger and recover after choosing a day',async()=>{
  const page=await openPage('<form><input type="datetime-local" name="due" required aria-label="Due date"><button>Save task</button></form>');const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.evaluate(()=>window.enhanceDatetime(document.querySelector('[name="due"]')));
    await page.getByRole('button',{name:'Save task',exact:true}).click();
    assert.equal(await page.locator('.dt-trigger').evaluate(el=>document.activeElement===el),true);
    assert.deepEqual(errors,[]);
    assert.equal(await page.locator('.dt-trigger').getAttribute('aria-invalid'),'true');
    await page.keyboard.press('Enter');await page.keyboard.press('Enter');
    assert.equal(await page.locator('.form-validation:visible').count(),0);
    assert.equal(await page.locator('.dt-trigger').getAttribute('aria-invalid'),null);
  }finally{await page.close();}
});

test('Spotify history file selection uses the web theme and blocks an empty import',async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/history-controls',route=>route.fulfill({contentType:'text/html',body:sectionPage}));await page.goto('https://datapom.test/history-controls');
    const file=page.locator('[name="history"]');
    const style=await file.evaluate(el=>{const button=getComputedStyle(el,'::file-selector-button'),input=getComputedStyle(el);return{font:button.fontFamily,inputFont:input.fontFamily,background:button.backgroundColor,panel:input.backgroundColor};});
    assert.equal(style.font,style.inputFont);assert.equal(style.background,style.panel);
    await page.getByRole('button',{name:'Import history',exact:true}).click();
    assert.equal(new URL(page.url()).pathname,'/history-controls');
    assert.match(await page.getByRole('alert').textContent(),/History JSON is required/);
    assert.equal(await file.evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('themed colors preserve the native value and preview events while rejecting invalid hex', async () => {
  const page = await openPage();
  try {
    const trigger = page.getByRole('button', {name:'New tag color: #e0a955',exact:true});
    await trigger.click({timeout:1000});
    const popup = page.getByRole('dialog', {name:'New tag color',exact:true});
    await popup.getByRole('textbox', {name:'Hex color',exact:true}).fill('oops');
    await popup.getByRole('button', {name:'Apply',exact:true}).click();
    assert.equal(await popup.getByRole('alert').textContent(), 'Use a hex color, like #e0a955.');
    assert.equal(await page.locator('[name="new_tag_color"]').inputValue(), '#e0a955');
    await popup.getByRole('textbox', {name:'Hex color',exact:true}).fill('#abc');
    await popup.getByRole('textbox', {name:'Hex color',exact:true}).press('Enter');
    assert.equal(await page.locator('[name="new_tag_color"]').inputValue(), '#aabbcc');
    assert.equal(await page.locator('.tag-preview').evaluate(el=>el.style.getPropertyValue('--tag-bg')), '#aabbcc');
    assert.equal(await page.getByRole('dialog', {name:'New tag color',exact:true}).count(), 0);
    assert.equal(await page.getByRole('button', {name:'New tag color: #aabbcc'}).evaluate(el=>document.activeElement===el), true);
  } finally {await page.close();}
});

test('themed colors cancel drafts, accept palette choices, and follow external changes and reset', async () => {
  const page = await openPage();
  try {
    let trigger = page.getByRole('button', {name:/^New tag color:/});
    await trigger.click({timeout:1000});
    await page.getByRole('textbox', {name:'Hex color',exact:true}).fill('#123456');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[name="new_tag_color"]').inputValue(), '#e0a955');
    await trigger.click();
    await page.getByRole('button', {name:'Use #e0524d',exact:true}).click();
    assert.equal(await page.locator('[name="new_tag_color"]').inputValue(), '#e0524d');
    await page.locator('[name="new_tag_color"]').evaluate(input=>{input.value='#78b8d8';input.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await trigger.getAttribute('aria-label'), 'New tag color: #78b8d8');
    await page.locator('form.add-form').evaluate(form=>form.reset());
    await page.waitForFunction(()=>document.querySelector('.color-trigger').getAttribute('aria-label').endsWith('#e0a955'));
    assert.equal(await page.locator('.tag-preview').evaluate(el=>el.style.getPropertyValue('--tag-bg')), '#e0a955');
    await page.locator('[name="new_tag_color"]').evaluate(input=>{input.disabled=true;});
    await page.waitForFunction(()=>document.querySelector('.color-trigger').disabled);
    assert.equal(await trigger.isDisabled(), true);
  } finally {await page.close();}
});

test('dynamic media colors stay inside their modal, fit narrow screens, and close before the modal', async () => {
  const page = await openPage();
  try {
    await page.setViewportSize({width:360,height:640});
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{const d=window.PupMedia.dialog('Ink review');d.body.append(window.PupMedia.field('Ink','#e0a955','color').wrap);});
    await page.getByRole('button',{name:'Ink: #e0a955',exact:true}).click({timeout:1000});
    const box=await page.getByRole('dialog',{name:'Ink',exact:true}).boundingBox();
    assert.ok(box.x>=8 && box.x+box.width<=352,JSON.stringify(box));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Ink',exact:true}).count(),0);
    assert.equal(await page.getByRole('dialog',{name:'Ink review',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Ink: #e0a955',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('custom recurrence requires an interval while preserving the task draft', async () => {
  const page = await openPage();
  try {
    await page.getByRole('textbox',{name:'Task title'}).fill('Keep this task');
    await page.getByRole('button',{name:'Repeat: No repeat'}).click();
    await page.getByRole('option',{name:'Custom',exact:true}).click();
    await page.getByRole('button',{name:'Add task',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Task title'}).inputValue(),'Keep this task');
    assert.equal(await page.getByRole('alert').textContent(),'Repeat every N days is required.');
    await page.getByRole('button',{name:'Repeat: Custom'}).click();
    await page.getByRole('option',{name:'Daily',exact:true}).click();
    assert.equal(await page.locator('[name="custom_n"]').evaluate(el=>el.willValidate),false);
    assert.equal(await page.getByRole('alert').count(),0);
  } finally {await page.close();}
});

test('Chinese tag and section names pass themed web form validation',async()=>{
  const page=await openPage();
  try{
    const taskTag=page.locator('[name="new_tag"]');
    for(const name of ['朋友','臺灣家人','Work 工作2','𠀀家']){
      await taskTag.fill(name);assert.equal(await taskTag.evaluate(el=>el.checkValidity()),true,name);
    }
    await page.route('https://datapom.test/journal/sections',route=>route.fulfill({contentType:'text/html',body:sectionPage}));
    await page.goto('https://datapom.test/journal/sections');
    const names=page.locator('input[pattern][name="name"],input[pattern][name="tag"]');
    assert.ok(await names.count()>=3);
    for(const el of await names.all()){
      await el.fill('朋友 臺灣𠀀2');assert.equal(await el.evaluate(input=>input.checkValidity()),true);
      await el.fill('朋友<script>');assert.equal(await el.evaluate(input=>input.checkValidity()),false);
    }
  }finally{await page.close();}
});

test('Chinese rich text preserves tag tokens, underscores and numeric captures',async()=>{
  const page=await openPage('<form><div class="body-field"><textarea class="body-input">**@朋友** @家人_臺灣 @李.明。 @𠀀家 @work朋友 #體重 68.5</textarea><div class="body-rendered" hidden></div></div><div class="section" data-section-id="people"><div class="chips"></div></div><input name="num:weight"><script id="mention-index" type="application/json">'+JSON.stringify(Object.fromEntries(['朋友','家人 臺灣','李.明','𠀀家','work'].map(name=>[name,{section_id:'people',color:'#e0a955'}])))+'</script><script id="numeric-index" type="application/json">{"體重":{"section_id":"weight","color":"#e0a955","unit":"kg"}}</script></form>');
  try{
    await page.addScriptTag({path:path.join(__dirname,'../static/journal-richtext.js')});
    assert.deepEqual(await page.locator('.mention-highlight').allTextContents(),['朋友','家人 臺灣','李.明','𠀀家']);
    assert.equal(await page.locator('.body-rendered strong .mention-highlight').textContent(),'朋友');
    assert.equal(await page.locator('.numeric-highlight').textContent(),'體重 68.5 kg');
    await page.locator('.body-input').focus();await page.locator('.body-input').blur();
    assert.equal(await page.locator('[name="num:weight"]').inputValue(),'68.5');
    assert.deepEqual(await page.locator('.chips input:checked').evaluateAll(els=>els.map(el=>el.value)),['朋友','家人 臺灣','李.明','𠀀家']);
  }finally{await page.close();}
});

test('invalid task tags and whitespace titles are caught before drafts leave the page', async () => {
  const page = await openPage();
  try {
    await page.getByRole('textbox',{name:'Task title'}).fill('Keep this task');
    await page.locator('[name="new_tag"]').fill('work&play');
    await page.getByRole('button',{name:'Add task',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Task title'}).inputValue(),'Keep this task');
    assert.equal(await page.getByRole('alert').textContent(),'New tag: use letters, numbers, spaces, . _ or -.');
    await page.locator('[name="new_tag"]').fill('Work.play_2-3');
    assert.equal(await page.getByRole('alert').count(),0);
    await page.getByRole('textbox',{name:'Task title'}).fill('   ');
    await page.getByRole('button',{name:'Add task',exact:true}).click();
    assert.equal(await page.getByRole('alert').textContent(),'Task title is required.');
  } finally {await page.close();}
});

test('invalid section names retain their type, unit, and color choices', async () => {
  const page = await openPage();
  try {
    await page.route('https://datapom.test/journal/sections',route=>route.fulfill({contentType:'text/html',body:sectionPage}));
    await page.goto('https://datapom.test/journal/sections');
    const form = page.locator('form[action="/journal/sections/add"]');
    await form.locator('[name="name"]').fill('energy%');
    await form.getByRole('button',{name:'type: tag'}).click();
    await form.getByRole('option',{name:'numeric',exact:true}).click();
    await form.locator('[name="unit"]').fill('pts');
    await form.getByRole('button',{name:'+ add section',exact:true}).click();
    assert.equal(await form.locator('[name="name"]').inputValue(),'energy%');
    assert.equal(await form.locator('[name="unit"]').inputValue(),'pts');
    assert.equal(await form.locator('select').inputValue(),'numeric');
    assert.equal(await page.getByRole('alert').textContent(),'Section name: use letters, numbers, spaces, . _ or -.');
  } finally {await page.close();}
});

test('legacy short hex colors keep their actual color through enhancement and form reset', async () => {
  const page = await openPage('<form><input type="color" name="color" aria-label="Tag color" value="#abc"><button type="reset">Reset</button></form>');
  try {
    await page.locator('input[type="color"]').evaluate(input=>window.enhanceColor(input));
    assert.equal(await page.locator('[name="color"]').inputValue(),'#aabbcc');
    await page.getByRole('button',{name:'Tag color: #aabbcc',exact:true}).click();
    await page.getByRole('button',{name:'Use #e0524d',exact:true}).click();
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    assert.equal(await page.locator('[name="color"]').inputValue(),'#aabbcc');
    await page.waitForFunction(()=>document.querySelector('.color-trigger').getAttribute('aria-label')==='Tag color: #aabbcc');
  } finally {await page.close();}
});

test('mobile colors open on a palette choice without raising the text keyboard and keep dialog gutters', async () => {
  const page = await openPage();
  try {
    await page.setViewportSize({width:360,height:640});
    await page.evaluate(()=>document.body.classList.add('media-mobile'));
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{const d=PupMedia.dialog('Ink review');d.body.append(PupMedia.field('Ink','#e0a955','color').wrap);});
    await page.getByRole('button',{name:'Ink: #e0a955',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Use #e0a955',exact:true}).evaluate(el=>document.activeElement===el),true);
    const box=await page.getByRole('dialog',{name:'Ink',exact:true}).boundingBox();
    assert.ok(box.x>=18 && box.x+box.width<=342,JSON.stringify(box));
  } finally {await page.close();}
});

test('an incomplete journal number cannot be autosaved as a cleared field', async () => {
  const page = await openPage('<form id="journal-form" data-entry-date="2026-09-12"><input name="title" value="Saved title"><div class="body-field"><textarea name="body">Saved text</textarea></div><input type="number" step="any" name="num:weight" aria-label="Weight" value="3.25"><p id="draft-status"></p></form>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{window.entryCalls=[];PupMedia.refresh=async()=>({});PupMedia.request=async(path,payload)=>{window.entryCalls.push(payload);return {entry:{...payload,updated:'v2'}};};});
    await page.addScriptTag({path:path.join(__dirname,'../static/media-entry.js')});
    await page.evaluate(()=>window.PupJournalEditorReady);
    await page.getByRole('spinbutton',{name:'Weight',exact:true}).fill('');
    await page.getByRole('spinbutton',{name:'Weight',exact:true}).pressSequentially('1e');
    assert.equal(await page.getByRole('spinbutton',{name:'Weight',exact:true}).evaluate(el=>el.validity.badInput),true);
    assert.equal(await page.evaluate(()=>PupJournalEditor.save()),false);
    assert.equal(await page.evaluate(()=>window.entryCalls.length),0);
    assert.match(await page.locator('#draft-status').textContent(),/Weight.*valid number/);
    await page.getByRole('spinbutton',{name:'Weight',exact:true}).fill('1e2');
    assert.equal(await page.evaluate(()=>PupJournalEditor.save()),true);
    assert.equal(await page.evaluate(()=>window.entryCalls.at(-1).numbers.weight),'1e2');
  } finally {await page.close();}
});

test('invalid new journal tags remain editable instead of disappearing on autosave', async () => {
  const page = await openPage('<form id="journal-form" data-entry-date="2026-09-12"><input name="title" value="Saved title"><div class="body-field"><textarea name="body">Saved text</textarea></div><input name="newtag-name:people" aria-label="New people tag"><p id="draft-status"></p></form>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{window.entryCalls=[];PupMedia.refresh=async()=>({});PupMedia.request=async(path,payload)=>{window.entryCalls.push(payload);return {entry:{...payload,updated:'v2'}};};});
    await page.addScriptTag({path:path.join(__dirname,'../static/media-entry.js')});
    await page.evaluate(()=>window.PupJournalEditorReady);
    await page.getByRole('textbox',{name:'New people tag',exact:true}).fill('Alex & Sam');
    assert.equal(await page.evaluate(()=>PupJournalEditor.save()),false);
    assert.equal(await page.evaluate(()=>window.entryCalls.length),0);
    assert.match(await page.locator('#draft-status').textContent(),/New people tag: use letters/);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('todopup:document:2026-09-12')).new_tags[0].name),'Alex & Sam');
    await page.getByRole('textbox',{name:'New people tag',exact:true}).fill('Alex_Sam');
    assert.equal(await page.evaluate(()=>PupJournalEditor.save()),true);
    assert.equal(await page.evaluate(()=>window.entryCalls.at(-1).new_tags[0].name),'Alex_Sam');
  } finally {await page.close();}
});

test('entry save feedback remains readable at narrow widths', async () => {
  const page=await openPage();
  try {
    await page.setViewportSize({width:390,height:844});
    await page.locator('main').evaluate((main,html)=>{main.innerHTML=new DOMParser().parseFromString(html,'text/html').querySelector('main').innerHTML;},entryPage);
    await page.locator('#draft-status').evaluate(el=>{el.textContent='Review energy (pts): check the restored number, then save.';});
    const size=await page.locator('#draft-status').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));
    assert.ok(size.scroll<=size.width+1,JSON.stringify(size));
  } finally {await page.close();}
});

test('duplicate section names retain the form and identify the correction before submitting', async () => {
  const page=await openPage();
  try {
    await page.route('https://datapom.test/journal/sections',route=>route.fulfill({contentType:'text/html',body:sectionPage}));
    await page.route('https://datapom.test/journal/sections/add',route=>route.fulfill({status:303,headers:{location:'/journal/sections'}}));
    await page.goto('https://datapom.test/journal/sections');
    const form=page.locator('form[action="/journal/sections/add"]');
    await form.locator('[name="name"]').fill(' PEOPLE ');
    await form.getByRole('button',{name:'type: tag',exact:true}).click();
    await form.getByRole('option',{name:'numeric',exact:true}).click();
    await form.locator('[name="unit"]').fill('pts');
    await form.getByRole('button',{name:'+ add section',exact:true}).click();
    assert.equal(await form.locator('[name="name"]').inputValue(),' PEOPLE ');
    assert.equal(await form.locator('[name="unit"]').inputValue(),'pts');
    assert.equal(await page.getByRole('alert').textContent(),'Section name already exists.');
    await form.locator('[name="name"]').fill('New section');
    assert.equal(await page.getByRole('alert').count(),0);
    const people=page.getByRole('region',{name:'people section',exact:true}).getByRole('textbox',{name:'Section name',exact:true});
    await people.fill('People');
    assert.equal(await people.evaluate(el=>el.validity.valid),true);
    await people.fill('weight');
    assert.equal(await people.evaluate(el=>el.validity.valid),false);
  } finally {await page.close();}
});

test('media dialog Tab reaches links and wraps around only focusable controls', async () => {
  const page=await openPage();
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{const d=PupMedia.dialog('Keyboard review');const link=document.createElement('a');link.href='#help';link.textContent='Help';d.body.append(link);});
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('link',{name:'Help',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Close Keyboard review',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('media dialog reverse Tab skips hidden native fields, disabled fieldsets, and negative tabindex', async () => {
  const page=await openPage();
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{const d=PupMedia.dialog('Keyboard review');d.body.append(PupMedia.button('Done',()=>{}));const hidden=document.createElement('select');hidden.setAttribute('aria-hidden','true');hidden.tabIndex=-1;hidden.className='cs-native';d.body.append(hidden);const disabled=document.createElement('fieldset');disabled.disabled=true;disabled.append(document.createElement('input'));d.body.append(disabled);const ignored=PupMedia.button('Programmatic focus only',()=>{});ignored.tabIndex=-1;d.body.append(ignored);});
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button',{name:'Done',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('closing a parent media dialog preserves its child focus and eventual original opener', async () => {
  const page=await openPage('<button id="launch">Launch</button>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{document.querySelector('#launch').onclick=()=>{window.parentDialog=PupMedia.dialog('Parent');parentDialog.body.append(PupMedia.button('Open child',()=>{window.childDialog=PupMedia.dialog('Child');}));};});
    await page.getByRole('button',{name:'Launch',exact:true}).click();
    await page.getByRole('button',{name:'Open child',exact:true}).click();
    await page.evaluate(()=>window.parentDialog.close());
    assert.equal(await page.getByRole('button',{name:'Close Child',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button',{name:'Launch',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('themed selects close before their media dialog and retain the nested opener', async () => {
  const page=await openPage('<button id="launch">Launch</button>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{document.querySelector('#launch').onclick=()=>{const d=PupMedia.dialog('Picker review');d.body.append(PupMedia.select('Kind',[['one','One'],['two','Two']],'one').wrap);};});
    await page.getByRole('button',{name:'Launch',exact:true}).click();
    await page.getByRole('button',{name:'Kind: One',exact:true}).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Picker review',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Kind: One',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Picker review',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Launch',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('dynamic date pickers keep their field label and keyboard flow inside a media dialog', async () => {
  const page=await openPage();
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{const d=PupMedia.dialog('Photo time');const field=PupMedia.field('Taken at','2026-09-12T09:30','datetime-local');d.body.append(field.wrap);window.enhanceDatetime(field.input);});
    await page.getByRole('button',{name:'Taken at: 2026-09-12 09:30',exact:true}).click({timeout:1000});
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('spinbutton',{name:'Hour',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog',{name:'Photo time',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Taken at: 2026-09-12 09:30',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('Enter in a due-time field accepts the time without submitting its task form', async () => {
  const page=await openPage('<form><input name="title" value="Task"><input type="datetime-local" name="due" value="2026-09-12T09:30" aria-label="Due date"><button>Save task</button></form>');
  try {
    await page.evaluate(()=>{window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;};window.enhanceDatetime(document.querySelector('[name="due"]'));});
    await page.locator('.dt-trigger').click();
    await page.getByRole('spinbutton',{name:'Hour',exact:true}).fill('10');
    await page.getByRole('spinbutton',{name:'Hour',exact:true}).press('Enter');
    assert.equal(await page.evaluate(()=>window.submits),0);
    assert.equal(await page.locator('[name="due"]').inputValue(),'2026-09-12T10:30');
    assert.equal(await page.locator('.dt-trigger').evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

for(const [label,value] of [['Hour','1e'],['Hour','24'],['Minute','60'],['Minute','2.5']])test(`invalid ${label} ${value} keeps the saved timestamp until corrected`,async()=>{
  const page=await openPage('<input type="datetime-local" name="due" value="2026-09-12T09:30" aria-label="Taken at">');
  try {
    await page.evaluate(()=>{window.timeChanges=[];const input=document.querySelector('[name="due"]');input.addEventListener('change',()=>timeChanges.push(input.value));window.enhanceDatetime(input);});
    await page.locator('.dt-trigger').click();const field=page.getByRole('spinbutton',{name:label,exact:true});
    await field.fill('');await field.pressSequentially(value);await field.press('Enter');
    assert.equal(await page.locator('[name="due"]').inputValue(),'2026-09-12T09:30');
    assert.deepEqual(await page.evaluate(()=>timeChanges),[]);
    assert.equal(await page.getByRole('dialog',{name:'Taken at',exact:true}).count(),1);
    assert.equal(await field.getAttribute('aria-invalid'),'true');
    assert.equal(await field.evaluate(el=>document.activeElement===el),true);
    await page.getByRole('button',{name:'Next month',exact:true}).click();
    assert.equal(await page.locator('.cal-month-title').textContent(),'September 2026');
    await page.getByRole('button',{name:'September 13, 2026',exact:true}).click();
    assert.equal(await page.locator('[name="due"]').inputValue(),'2026-09-12T09:30');
    await page.getByRole('button',{name:'September 12, 2026',exact:true}).focus();await page.keyboard.press('ArrowRight');
    assert.equal(await field.getAttribute('aria-invalid'),'true');
    assert.equal(await field.evaluate(el=>document.activeElement===el),true);
    await field.fill(label==='Hour'?'10':'45');await field.press('Enter');
    assert.equal(await page.locator('[name="due"]').inputValue(),label==='Hour'?'2026-09-12T10:30':'2026-09-12T09:45');
    assert.equal(await page.getByRole('dialog',{name:'Taken at',exact:true}).count(),0);
  }finally{await page.close();}
});

test('invalid enlarged time feedback fits the picker and Escape preserves its saved value',async()=>{
  const page=await openPage('<input type="datetime-local" name="due" value="2026-09-12T09:30" aria-label="Taken at">');
  try {
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize='32px';window.enhanceDatetime(document.querySelector('[name="due"]'));});
    await page.locator('.dt-trigger').click();const hour=page.getByRole('spinbutton',{name:'Hour',exact:true});await hour.fill('24');await hour.press('Enter');
    const geometry=await page.locator('.dt-popover').evaluate(el=>({width:el.scrollWidth,client:el.clientWidth,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom}));
    assert.ok(geometry.width<=geometry.client&&geometry.top>=16&&geometry.bottom<=828,JSON.stringify(geometry));
    const fields=await page.locator('.dt-time').evaluateAll(inputs=>inputs.map(input=>{const style=getComputedStyle(input),ctx=document.createElement('canvas').getContext('2d');ctx.font=style.font;return{inner:input.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),text:ctx.measureText('00').width};}));
    assert.ok(fields.every(field=>field.inner>=field.text+2),JSON.stringify(fields));
    assert.equal(await page.getByRole('status').textContent(),'Hour must be 0–23.');
    await hour.press('Escape');assert.equal(await page.locator('.dt-popover').count(),0);
    assert.equal(await page.locator('[name="due"]').inputValue(),'2026-09-12T09:30');
    assert.equal(await page.locator('.dt-trigger').evaluate(el=>document.activeElement===el),true);
  }finally{await page.close();}
});

test('due-date controls follow form reset and dynamic disabled state', async () => {
  const page=await openPage('<form><input type="datetime-local" name="due" value="2026-09-12T09:30" aria-label="Due date"></form>');
  try {
    await page.evaluate(()=>window.enhanceDatetime(document.querySelector('[name="due"]')));
    await page.locator('[name="due"]').evaluate(input=>{input.value='2026-09-13T10:00';input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.locator('form').evaluate(form=>form.reset());
    await page.waitForTimeout(25);
    assert.equal(await page.locator('.dt-trigger').getAttribute('aria-label'),'Due date: 2026-09-12 09:30');
    await page.locator('[name="due"]').evaluate(input=>{input.disabled=true;});
    await page.waitForTimeout(25);
    assert.equal(await page.locator('.dt-trigger').isDisabled(),true);
  } finally {await page.close();}
});

test('due-date arrow navigation moves the single day tab stop in both directions', async () => {
  const page=await openPage('<input type="datetime-local" name="due" value="2026-09-12T09:30" aria-label="Due date">');
  try {
    await page.evaluate(()=>window.enhanceDatetime(document.querySelector('[name="due"]')));
    await page.locator('.dt-trigger').click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('spinbutton',{name:'Hour',exact:true}).evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date'),'2026-09-11');
  } finally {await page.close();}
});

test('journal calendar Tab leaves the day grid after navigating backward', async () => {
  const page=await openPage(calendarMarkup+'<button id="after-calendar">After calendar</button>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/journal.js')});
    await page.locator('.cal-trigger').click();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#after-calendar').evaluate(el=>document.activeElement===el),true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.cal-day:focus').getAttribute('data-date'),'2026-09-11');
  } finally {await page.close();}
});

test('busy media dialogs block dismissal and restore each control state after failure',async()=>{
  const page=await openPage('<button id="launch">Launch</button>');
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{
      document.querySelector('#launch').onclick=()=>{
        const d=window.busyDialog=PupMedia.dialog('Pending changes');
        d.body.append(PupMedia.field('Caption','Draft').wrap);
        const unavailable=PupMedia.button('Unavailable',()=>{});unavailable.disabled=true;d.actions.append(unavailable);
        d.actions.append(PupMedia.button('Save',()=>d.setBusy(true)));
      };
    });
    await page.getByRole('button',{name:'Launch',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();
    assert.equal(await page.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    await page.keyboard.press('Escape');
    await page.locator('.media-overlay').click({position:{x:1,y:1}});
    assert.equal(await page.getByRole('dialog',{name:'Pending changes',exact:true}).count(),1);
    await page.evaluate(()=>window.busyDialog.setBusy(false));
    assert.equal(await page.getByRole('textbox',{name:'Caption',exact:true}).isEditable(),true);
    assert.equal(await page.getByRole('button',{name:'Unavailable',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isEnabled(),true);
    await page.evaluate(()=>window.busyDialog.close());
    assert.equal(await page.getByRole('button',{name:'Launch',exact:true}).evaluate(el=>document.activeElement===el),true);
  } finally {await page.close();}
});

test('app navigation shortcuts respect an open modal and resume after it closes',async()=>{
  const page=await openPage();
  try {
    await page.addScriptTag({path:path.join(__dirname,'../static/media-ui.js')});
    await page.evaluate(()=>{window.shortcutDialog=PupMedia.dialog('Pending save');shortcutDialog.body.append(PupMedia.field('Caption','Keep my draft').wrap);shortcutDialog.setBusy(true);});
    await page.keyboard.press('Meta+k');await page.waitForTimeout(30);
    assert.equal(new URL(page.url()).pathname,'/');
    await page.keyboard.press('Meta+j');await page.waitForTimeout(30);
    assert.equal(new URL(page.url()).pathname,'/');
    assert.equal(await page.getByRole('dialog',{name:'Pending save',exact:true}).count(),1);
    await page.evaluate(()=>{shortcutDialog.setBusy(false);shortcutDialog.close();});
    await page.keyboard.press('Meta+k');await page.waitForURL('**/journal/search#focus-search');
  }finally{await page.close();}
});

test('integration callback URLs wrap within the narrow Manage page',async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/journal/sections',route=>route.fulfill({contentType:'text/html',body:sectionPage}));
    await page.setViewportSize({width:390,height:844});await page.goto('https://datapom.test/journal/sections');
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,clipped:[...document.querySelectorAll('body *')].filter(el=>{const b=el.getBoundingClientRect();return b.width&&b.right>innerWidth+.5&&!el.closest('[hidden]');}).map(el=>({tag:el.tagName,class:typeof el.className==='string'?el.className:'',text:el.textContent.slice(0,60),right:el.getBoundingClientRect().right}))}));
    assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
  }finally{await page.close();}
});

test('a slow task Add cannot submit twice before its redirect',{timeout:6000},async()=>{
  const page=await openPage();const releases=[];let attempts=0;
  try {
    await page.route('https://datapom.test/add',route=>{
      attempts++;return new Promise(resolve=>releases.push(()=>resolve(route.fulfill({status:303,headers:{location:'/'}}))));
    });
    await page.getByRole('textbox',{name:'Task title',exact:true}).fill('One task');
    await page.evaluate(()=>setTimeout(()=>{const form=document.querySelector('.add-form');form.requestSubmit();setTimeout(()=>form.requestSubmit(),50);},0));
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(attempts,1);
  }finally{releases.forEach(release=>release());await page.close();}
});

test('POST form guards preserve named submitter data',async()=>{
  const page=await openPage('<form method="post" action="/save-review"><input name="title" value="Keep title"><button name="action" value="save">Save review</button></form>');let submitted;
  try {
    await page.route('https://datapom.test/save-review',route=>{submitted=new URLSearchParams(route.request().postData());return route.fulfill({status:303,headers:{location:'/review-saved'}});});
    await page.getByRole('button',{name:'Save review',exact:true}).click();await page.waitForURL('**/review-saved');
    assert.equal(submitted.get('title'),'Keep title');assert.equal(submitted.get('action'),'save');
  }finally{await page.close();}
});

test('POST form guards restore history controls and skip background submissions',async()=>{
  const page=await openPage('<form method="post" aria-busy="false"><input name="title" value="Draft"><button id="send">Send</button><button disabled>Unavailable</button></form>');
  try {
    await page.evaluate(()=>{const form=document.querySelector('form');form.dispatchEvent(new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:document.querySelector('#send')}));});
    assert.equal(await page.locator('form').evaluate(form=>form.inert),true);
    assert.equal(await page.locator('#send').isDisabled(),true);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    assert.equal(await page.locator('form').evaluate(form=>form.inert),false);
    assert.equal(await page.locator('form').getAttribute('aria-busy'),'false');
    assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isEnabled(),true);
    assert.equal(await page.getByRole('button',{name:'Unavailable',exact:true}).isDisabled(),true);
    await page.evaluate(()=>{const form=document.querySelector('form');form.onsubmit=event=>event.preventDefault();form.requestSubmit(document.querySelector('#send'));});
    assert.equal(await page.locator('form').evaluate(form=>form.inert),false);
    assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isEnabled(),true);
  }finally{await page.close();}
});

for(const [name,markup] of [['tasks',()=>basePage],['journal',()=>entryPage],['search',()=>searchPage],['manage',()=>sectionPage],['section archive',()=>sectionArchivePage]])test(`${name} retains its controls at320px with200% text`,async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/text-review',route=>route.fulfill({contentType:'text/html',body:markup()}));
    await page.setViewportSize({width:320,height:844});await page.goto('https://datapom.test/text-review');
    await page.evaluate(name=>{
      document.documentElement.style.fontSize='32px';
      if(name==='journal')document.querySelectorAll('.move-btn,.delete-entry-btn').forEach(button=>button.hidden=false);
      if(name==='search'){
        const title=document.createElement('span');title.className='entry-title';title.textContent='A review entry with a longer title';document.querySelector('.entry-link').append(title);
        const tags=document.createElement('span');tags.className='entry-tags';tags.innerHTML='<span class="entry-tag-chip">old friend</span><span class="entry-tag-chip">review tag</span>';document.querySelector('.entry-row-main').append(tags);
      }
    },name);
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,clipped:[...document.querySelectorAll('body *')].filter(el=>{const b=el.getBoundingClientRect();return b.width&&b.right>innerWidth+.5&&!el.closest('[hidden]');}).map(el=>({tag:el.tagName,class:typeof el.className==='string'?el.className:'',text:el.textContent.slice(0,60),right:el.getBoundingClientRect().right}))}));
    assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
  }finally{await page.close();}
});

test('large-text journal leaves room to read the title and edit above its actions',async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/header-review',route=>route.fulfill({contentType:'text/html',body:entryPage}));
    await page.setViewportSize({width:320,height:844});await page.goto('https://datapom.test/header-review');
    await page.evaluate(()=>{document.documentElement.style.fontSize='32px';document.querySelectorAll('.move-btn,.delete-entry-btn').forEach(button=>button.hidden=false);});
    const geometry=await page.evaluate(()=>({title:document.querySelector('[name="title"]').getBoundingClientRect().width,actions:document.querySelector('.entry-actions').getBoundingClientRect().height}));
    assert.ok(geometry.title>=200,JSON.stringify(geometry));
    assert.ok(geometry.actions<200,JSON.stringify(geometry));
  }finally{await page.close();}
});

for(const [name,markup] of [['active',()=>basePage],['archive',()=>archivePage]])test(`${name} task titles wrap long pasted tokens without hiding their controls`,async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/long-title-review',route=>route.fulfill({contentType:'text/html',body:markup()}));await page.setViewportSize({width:320,height:844});await page.goto('https://datapom.test/long-title-review');
    await page.locator('.task-title-toggle').first().evaluate(el=>el.firstChild.textContent='https://example.test/'+ 'a'.repeat(100));
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
    const first=page.locator('.task').first();await first.locator('.task-title-toggle').focus();await page.keyboard.press('Enter');
    assert.equal(await first.locator('.task-details').isVisible(),true);
  }finally{await page.close();}
});

for(const [name,markup] of [['active',()=>basePage],['archive',()=>archivePage]])for(const size of [16,32])test(`${name} expanded task details fit320px at${size}px text`,async()=>{
  const page=await openPage();
  try {
    await page.route('https://datapom.test/expanded-review',route=>route.fulfill({contentType:'text/html',body:markup()}));await page.setViewportSize({width:320,height:844});await page.goto('https://datapom.test/expanded-review');
    await page.evaluate(size=>{document.documentElement.style.fontSize=size+'px';document.querySelectorAll('.task-notes-readonly,.subtask-text-readonly').forEach(el=>el.textContent='https://example.test/'+ 'a'.repeat(100));},size);
    await page.locator('.task-title-toggle').first().click();
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,clipped:[...document.querySelectorAll('.task-details input,.task-details button')].filter(el=>el.getBoundingClientRect().right>innerWidth).map(el=>el.className)}));
    assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
    assert.deepEqual(geometry.clipped,[]);
    assert.equal(await page.locator('.subtask-row').first().evaluate(row=>getComputedStyle(row).cursor),'default');
    if(name==='active'){const input=page.getByRole('textbox',{name:'Subtask text',exact:true});await input.focus();assert.equal(await input.evaluate(el=>document.activeElement===el),true);}
  }finally{await page.close();}
});

for(const [kind,markup] of [
  ['task tag','<div class="tag-section"><label class="tag-chip tag-toggle"><input type="checkbox">LONG</label></div>'],
  ['entry tag','<div class="section"><div class="chips"><label class="chip tag-toggle"><input type="checkbox">LONG</label></div></div>'],
  ['managed tag','<div class="manage-section"><div class="tag-zone"><div class="zone-chips"><span class="perm-chip">LONG<button class="x" aria-label="Archive tag">×</button></span></div></div></div>'],
  ['tag color','<form class="tag-manage-form tag-preview-group"><span class="tag-chip tag-preview title-highlight">LONG</span><input type="color" value="#e0a955"><button>Save</button></form>'],
])test(`${kind} keeps its full long name and action within320px`,async()=>{
  const name='review_'+ 'a'.repeat(100),page=await openPage(markup.replace('LONG',name));
  try {
    await page.setViewportSize({width:320,height:844});
    const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(geometry.width<=geometry.viewport,JSON.stringify(geometry));
    assert.ok((await page.locator('main').textContent()).includes(name));
    if(kind==='task tag'||kind==='entry tag'){await page.getByRole('checkbox').focus();await page.keyboard.press('Space');assert.equal(await page.getByRole('checkbox').isChecked(),true);}
    if(kind==='managed tag'){await page.getByRole('button',{name:'Archive tag',exact:true}).focus();assert.equal(await page.getByRole('button',{name:'Archive tag',exact:true}).evaluate(button=>document.activeElement===button),true);}
  }finally{await page.close();}
});

for(const kind of ['confirmation','due date','journal date','color','configuration','tag suggestion','tag overview'])test(`${kind} dialog keeps actions within320px at200% text`,async()=>{
  const markup=kind==='configuration'?configureMarkup:kind==='journal date'?calendarMarkup:kind==='tag overview'?tagMarkup:kind==='tag suggestion'?'<div id="suggest-root"></div><script id="suggest-data" type="application/json">{"suggestions":[{"word":"orchard","days":3}]}</script>':kind==='due date'?'<input type="datetime-local" aria-label="Due date" value="2026-09-12T09:30">':kind==='color'?'<input type="color" aria-label="Ink" value="#e0a955">':'<button id="confirm-review">Archive section</button>';
  const page=await openPage(markup);
  try {
    await page.setViewportSize({width:320,height:844});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    if(kind==='configuration'){await page.addScriptTag({path:path.join(__dirname,'../static/section-config.js')});await page.locator('.configure-btn').click();}
    if(kind==='journal date'){await page.addScriptTag({path:path.join(__dirname,'../static/journal.js')});await page.locator('.cal-trigger').click();}
    if(kind==='due date'){await page.evaluate(()=>window.enhanceDatetime(document.querySelector('input')));await page.locator('.dt-trigger').click();}
    if(kind==='color'){await page.evaluate(()=>window.enhanceColor(document.querySelector('input')));await page.locator('.color-trigger').click();}
    if(kind==='confirmation'){await page.evaluate(()=>document.querySelector('#confirm-review').onclick=()=>window.confirmModal('Archive this section? Existing entries keep their data.','Archive'));await page.locator('#confirm-review').click();}
    if(kind==='tag overview'){await page.route('https://datapom.test/tag/**',route=>route.fulfill({json:tagPayload('alex')}));await page.locator('[data-tagpop="alex"]').click();await page.locator('.tag-pop-name').waitFor();}
    if(kind==='tag suggestion'){
      await page.route('https://datapom.test/journal/suggestions/orchard',route=>route.fulfill({json:{sections:[{id:'people',name:'people'}],occurrences:[{date:'2026-09-10',snippet:'An **orchard** walk'}]}}));
      await page.addScriptTag({path:path.join(__dirname,'../static/tag-suggest.js')});await page.locator('.suggest-chip-body').click();await page.locator('.suggest-day-row').waitFor();
    }
    const geometry=await page.getByRole('dialog').evaluateAll(dialogs=>dialogs.map(dialog=>({width:dialog.scrollWidth,client:dialog.clientWidth,left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,clipped:[...dialog.querySelectorAll('button,input:not([aria-hidden="true"]),a[href]')].filter(el=>{const r=el.getBoundingClientRect();return r.width&&(r.left<-.5||r.right>innerWidth+.5);}).map(el=>({label:el.getAttribute('aria-label')||el.textContent||el.name,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))})));
    assert.ok(geometry.length>0);
    assert.ok(geometry.every(dialog=>dialog.width<=dialog.client+1&&dialog.left>=0&&dialog.right<=320&&dialog.clipped.length===0),JSON.stringify(geometry));
  }finally{await page.close();}
});
