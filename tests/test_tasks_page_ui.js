/* Real task templates with disposable data: dropdown, forms and responsive UI. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
let browser, pages;
before(async () => {
  pages = JSON.parse(execFileSync(path.join(__dirname, '../.venv/bin/python'), ['-c', `
import json, tempfile
from pathlib import Path
from datetime import datetime
from datapom.web.app import app
from datapom.domain import todo, journal
with tempfile.TemporaryDirectory(prefix='datapom-task-ui-') as directory:
    root = Path(directory)
    app.config.update(TESTING=True, DATA_FILE=str(root/'tasks.json'), JOURNAL_FILE=str(root/'journal.json'), INTEGRATIONS_FILE=str(root/'integrations.json'))
    data = todo._empty()
    todo.set_tag_color(data, 'home', '#e0a955')
    todo.add_task(data, 'Water the plants', tags=['home'], now=datetime(2026,10,18))
    todo.set_task_notes(data, data['active'][0]['id'], 'Keep the soil moist.')
    todo.add_subtask(data, data['active'][0]['id'], 'Check the fern')
    todo.refresh(data, [data['active'][0]['id']], now=datetime(2026,10,18,18))
    todo.add_task(data, 'Plan the weekend and choose a walking route', tags=['home'], recurrence='every:3', now=datetime(2026,10,19))
    active = data['active'][0]
    todo.add_subtask(data, active['id'], 'Check the forecast')
    todo.save(app.config['DATA_FILE'], data)
    journal.save(app.config['JOURNAL_FILE'], journal._empty())
    with app.test_client() as client:
        print(json.dumps({name:client.get(url).get_data(as_text=True) for name,url in [
            ('active','/?tags=home'), ('archive','/archive'), ('edit','/edit/'+active['id']), ('journal','/journal')]}))
`], {cwd: path.join(__dirname, '..'), encoding:'utf8'}));
  browser = await chromium.launch({channel:'chrome', headless:true});
});
after(async () => { await browser?.close(); });

async function openPage(name='active', options={}) {
  const page = await browser.newPage({viewport:{width:1100,height:1000}, ...options});
  page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/static/')) return route.fulfill({path:path.join(__dirname,'..',pathname)});
    return route.fulfill({contentType:'text/html',body:pages[name]});
  });
  await page.goto('https://datapom.test/');
  return page;
}

test('completed tasks start folded and keyboard toggling preserves the draft and makes no writes', async () => {
  const page = await openPage();
  const writes = [];
  page.on('request', request => { if (request.method()==='POST') writes.push(request.url()); });
  try {
    const history = page.locator('#completed-tasks'), summary = history.locator('summary');
    assert.equal(await history.getAttribute('open'), null);
    await page.getByRole('textbox',{name:'Task title',exact:true}).fill('Keep my unfinished idea');
    await summary.focus(); await page.keyboard.press('Enter');
    assert.equal(await history.locator('.task').isVisible(), true);
    await history.locator('.task-title-toggle').click();
    assert.equal(await history.getByText('Keep the soil moist.',{exact:true}).isVisible(),true);
    assert.equal(await history.locator('.subtask-check').isDisabled(),true);
    assert.equal(await page.getByRole('textbox',{name:'Task title',exact:true}).inputValue(),'Keep my unfinished idea');
    assert.deepEqual(writes,[]);
    await page.waitForFunction(()=>sessionStorage.getItem('datapom.completed-tasks.open')==='1');
    await page.reload();
    assert.notEqual(await history.getAttribute('open'),null);
    await summary.focus(); await page.keyboard.press('Space');
    assert.equal(await history.getAttribute('open'),null);
    await page.waitForFunction(()=>sessionStorage.getItem('datapom.completed-tasks.open')==='0');
    await page.reload();
    assert.equal(await history.getAttribute('open'),null);
    await page.goto('https://datapom.test/#completed-tasks');
    assert.notEqual(await history.getAttribute('open'),null);
  } finally { await page.close(); }
});

test('completion submits only active checkboxes with their difficulty and current filter', async () => {
  const page=await openPage();
  try {
    await page.locator('#active-tasks input.task-check').check();
    await page.locator('#active-tasks input[value="hard"]').check();
    await page.locator('#completed-tasks summary').click();
    assert.equal(await page.locator('#active-tasks form').count(),0,'No completed forms may nest inside the active form');
    const request=page.waitForRequest(r=>r.method()==='POST'&&new URL(r.url()).pathname==='/refresh');
    await page.getByRole('button',{name:'Save completed',exact:true}).click();
    const body=new URLSearchParams((await request).postData());
    assert.equal(body.getAll('completed').length,1);
    assert.equal(body.get('difficulty:'+body.get('completed')),'hard');
    assert.equal(body.get('tags'),'home');
    assert.equal(body.has('return_to'),false);
  } finally {await page.close();}
});

test('task form keeps the themed calendar and custom recurrence editor',async()=>{
  const page=await openPage('edit');
  try {
    assert.equal(await page.getByRole('spinbutton',{name:'Repeat every N days'}).inputValue(),'3');
    await page.getByRole('button',{name:'Repeat: Custom',exact:true}).click();
    await page.getByRole('option',{name:'Weekly',exact:true}).click();
    assert.equal(await page.getByRole('spinbutton',{name:'Repeat every N days'}).isVisible(),false);
    await page.getByRole('button',{name:/^Due date:/}).click();
    assert.equal(await page.locator('.cal-popover').isVisible(),true);
  } finally {await page.close();}
});

test('task controls match the journal palette and fit narrow or enlarged layouts',async()=>{
  const page=await openPage();
  try {
    for(const [width,fontSize] of [[1100,16],[390,16],[320,32]]) {
      await page.setViewportSize({width,height:1000});
      await page.evaluate(size=>{document.documentElement.style.fontSize=size+'px';},fontSize);
      await page.locator('#completed-tasks').evaluate(el=>{el.open=true;});
      const geometry=await page.evaluate(()=>({
        width:document.documentElement.scrollWidth, viewport:innerWidth,
        clipped:[...document.querySelectorAll('.tasks-page input:not(.cs-native),.tasks-page button,.tasks-page summary')]
          .filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).map(el=>el.outerHTML.slice(0,100)),
        overflow:[...document.querySelectorAll('body *')]
          .filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1)
          .map(el=>({tag:el.tagName,class:el.className,right:el.getBoundingClientRect().right})),
      }));
      assert.ok(geometry.width<=geometry.viewport+1,JSON.stringify(geometry));
      assert.deepEqual(geometry.clipped,[]);
    }
    await page.locator('#active-tasks input.task-check').check();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('#active-tasks input.task-check')).backgroundColor==='rgb(224, 169, 85)');
    const styles=await page.locator('#active-tasks input.task-check').evaluate(input=>{
      const style=getComputedStyle(input),root=getComputedStyle(document.documentElement);
      return {radius:style.borderRadius,appearance:style.appearance,color:style.backgroundColor,accent:root.getPropertyValue('--accent').trim()};
    });
    assert.equal(styles.radius,'50%');assert.equal(styles.appearance,'none');
    assert.equal(styles.color,'rgb(224, 169, 85)');
    assert.equal(await page.locator('select:not([data-enhanced])').count(),0);
  }finally{await page.close();}
});
