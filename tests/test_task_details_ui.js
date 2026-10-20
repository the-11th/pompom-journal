/* Actual task-details handlers against delayed and failed synthetic responses. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });

const markup = `<form><ul><li class="task"><span class="task-title-toggle" role="button" tabindex="0">Test task</span><div class="task-details" data-task-id="review" hidden><textarea class="task-notes">Original note</textarea><ul class="subtask-list"><li class="subtask-row" data-index="0"><span class="subtask-drag">⠇</span><input type="checkbox" class="subtask-check"><input class="subtask-text" value="First step"><button type="button" class="subtask-del">×</button></li></ul><input class="subtask-add"><button type="button" class="subtask-add-btn">add</button></div></li></ul><button id="finish">Refresh</button></form>`;

async function pageWith(handler) {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.route('https://datapom.test/**', route => {
    if (new URL(route.request().url()).pathname.startsWith('/task/')) return handler(route);
    return route.fulfill({ contentType: 'text/html', body: markup });
  });
  await page.goto('https://datapom.test/');
  await page.addScriptTag({ path: path.join(__dirname, '../static/task-details.js') });
  await page.locator('.task-title-toggle').click();
  return page;
}

test('editing a subtask keeps its action labels tied to the saved text',async()=>{
  const page=await pageWith(route=>route.fulfill({json:{subtasks:[{text:route.request().postDataJSON().text,done:false}]}}));
  try {
    await page.locator('.subtask-text').fill('Updated step');await page.locator('.subtask-text').press('Enter');
    await page.locator('.task-save-status').filter({hasText:'Saved'}).waitFor();
    assert.equal(await page.getByRole('checkbox',{name:'Complete Updated step',exact:true}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Delete subtask: Updated step',exact:true}).count(),1);
  }finally{await page.close();}
});

test('notes flush on blur and serialize newer saves behind the pending request', async () => {
  const requests = [], releases = [];
  const page = await pageWith(async route => {
    requests.push(JSON.parse(route.request().postData()));
    await new Promise(resolve => releases.push(resolve));
    await route.fulfill({ json: { notes: JSON.parse(route.request().postData()).text.trim() } });
  });
  try {
    await page.locator('.task-notes').fill('First note');
    await page.locator('.subtask-add').focus();
    await page.waitForFunction(() => document.querySelector('.task-details').getAttribute('aria-busy') === 'true', null, { timeout: 250 });
    await page.locator('.task-notes').fill('Newer note');
    await page.waitForTimeout(550);
    assert.equal(requests.length, 1, 'Do not overlap note writes');
    releases.shift()();
    await page.waitForTimeout(100);
    assert.deepEqual(requests.map(body => body.text), ['First note', 'Newer note']);
    releases.shift()();
    await page.locator('.task-save-status').filter({ hasText: 'Saved' }).waitFor();
  } finally { releases.forEach(release => release()); await page.close(); }
});

test('failed notes remain editable with an explicit retry and success clears the error', async () => {
  let attempts = 0;
  const page = await pageWith(route => route.fulfill(++attempts === 1 ? { status: 503, json: { error: 'offline' } } : { json: { notes: JSON.parse(route.request().postData()).text.trim() } }));
  try {
    await page.locator('.task-notes').fill('Keep this note');
    await page.locator('.subtask-add').focus();
    await page.locator('.task-save-status').filter({ hasText: 'Notes not saved' }).waitFor();
    assert.equal(await page.locator('.task-notes').inputValue(), 'Keep this note');
    await page.getByRole('button', { name: 'Retry notes' }).click();
    await page.locator('.task-save-status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(attempts, 2);
  } finally { await page.close(); }
});

test('a slow subtask add cannot duplicate submission or erase newer typed text', async () => {
  let release, requests = 0;
  const page = await pageWith(async route => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { subtasks: [{ text: 'First step', done: false }, { text: 'Next step', done: false }] } });
  });
  try {
    const input = page.locator('.subtask-add');
    await input.fill('Next step');
    await input.press('Enter');
    await page.waitForTimeout(50);
    await input.press('Enter');
    await input.fill('Another step');
    await page.waitForTimeout(50);
    assert.equal(requests, 1);
    release();
    await page.waitForFunction(() => document.querySelectorAll('.subtask-row').length === 2);
    assert.equal(await input.inputValue(), 'Another step');
  } finally { release?.(); await page.close(); }
});

test('keyboard activation works for subtask buttons without submitting the refresh form', async () => {
  let deleted = false;
  const page = await pageWith(route => { deleted = true; return route.fulfill({ json: { subtasks: [] } }); });
  try {
    await page.locator('.subtask-del').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.subtask-row').length === 0);
    assert.equal(deleted, true);
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.locator('.task-title-toggle').getAttribute('aria-expanded'), 'true');
  } finally { await page.close(); }
});

test('Refresh waits for pending detail saves before archiving checked tasks', async () => {
  const events = [];
  let release;
  const page = await pageWith(async route => {
    events.push('notes');
    await new Promise(resolve => { release = resolve; });
    events.push('notes saved');
    return route.fulfill({ json: { notes: JSON.parse(route.request().postData()).text.trim() } });
  });
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.route('https://datapom.test/', route => {
      if (route.request().method() === 'POST') events.push('refresh');
      return route.fulfill({ contentType: 'text/html', body: markup });
    });
    await page.locator('form').evaluate(form => { form.method = 'post'; });
    await page.locator('.task-notes').fill('Keep before completing');
    await page.locator('#finish').click({ noWaitAfter: true });
    await page.waitForTimeout(100);
    assert.deepEqual(events, ['notes']);
    release();
    await page.waitForTimeout(150);
    assert.deepEqual(events, ['notes', 'notes saved', 'refresh']);
  } finally { release?.(); await page.close(); }
});

test('editing a subtask then checking it saves both actions in order', async () => {
  const requests = [];
  let release;
  const page = await pageWith(async route => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (requests.length === 1) await new Promise(resolve => {release = resolve;});
    return route.fulfill({json: {subtasks: [{text: 'Updated step', done: pathname.endsWith('/toggle')}]}});
  });
  try {
    await page.locator('.subtask-text').fill('Updated step');
    await page.locator('.subtask-check').click();
    await page.waitForTimeout(50);
    assert.deepEqual(requests, ['/task/review/subtasks/0']);
    release();
    await page.waitForTimeout(100);
    assert.deepEqual(requests, ['/task/review/subtasks/0', '/task/review/subtasks/0/toggle']);
    assert.equal(await page.locator('.subtask-check').isChecked(), true);
  } finally {release?.(); await page.close();}
});

test('tabbing away from subtask text preserves the next control during its save', async () => {
  let release;
  const page = await pageWith(async route => {
    await new Promise(resolve => {release = resolve;});
    return route.fulfill({json: {subtasks: [{text: 'Updated step', done: false}]}});
  });
  try {
    await page.locator('.subtask-text').fill('Updated step');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.subtask-del').evaluate(el => document.activeElement === el), true);
    await page.waitForTimeout(50);
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.subtask-del').evaluate(el => document.activeElement === el), true);
  } finally {release?.(); await page.close();}
});

test('notes show the acknowledged normalized value without requiring a reload', async () => {
  const page=await pageWith(route=>route.fulfill({json:{notes:JSON.parse(route.request().postData()).text.trim()}}));
  try {
    await page.locator('.task-notes').fill('  Trimmed note  ');
    await page.locator('.subtask-add').focus();
    await page.locator('.task-save-status').filter({hasText:'Saved'}).waitFor();
    assert.equal(await page.locator('.task-notes').inputValue(),'Trimmed note');
  } finally {await page.close();}
});

test('a malformed note acknowledgement retains the draft and exposes Retry', async () => {
  const page=await pageWith(route=>route.fulfill({json:{}}));
  try {
    await page.locator('.task-notes').fill('Keep this note');
    await page.locator('.subtask-add').focus();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.task-save-status').textContent(),'Notes not saved');
    assert.equal(await page.locator('.task-notes').inputValue(),'Keep this note');
    assert.equal(await page.getByRole('button',{name:'Retry notes'}).isVisible(),true);
  } finally {await page.close();}
});
