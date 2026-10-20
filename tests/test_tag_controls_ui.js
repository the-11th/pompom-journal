/* Actual Flask templates and stylesheet, backed only by temporary fixture data. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
let browser, pages;
before(async () => {
  pages = JSON.parse(execFileSync(path.join(__dirname, '../.venv/bin/python'), ['-c', `
import json, tempfile
from pathlib import Path
from datetime import datetime, timedelta
from app import app
import journal, todo, integrations
with tempfile.TemporaryDirectory(prefix='datapom-tag-controls-') as directory:
    root = Path(directory)
    app.config.update(TESTING=True, DATA_FILE=str(root/'tasks.json'), JOURNAL_FILE=str(root/'journal.json'), INTEGRATIONS_FILE=str(root/'integrations.json'))
    tasks = todo._empty()
    tasks['tags'] = {'alex': '#e0a955', 'sam': '#e0524d'}
    todo.add_task(tasks, 'Test task', tags=['alex'])
    task = tasks['active'][0]
    todo.save(app.config['DATA_FILE'], tasks)
    data = journal._empty()
    section = journal.add_section(data, 'people', 'tag', '#e0a955')
    section['tags'] = ['alex', 'sam']
    today = datetime.now()
    for days in range(3):
        journal.upsert_entry(data, (today-timedelta(days=days)).date().isoformat(), 'A day', 'orchard', tags={section['id']: ['alex']})
    journal.save(app.config['JOURNAL_FILE'], data)
    integrations.save(app.config['INTEGRATIONS_FILE'], integrations._empty())
    urls = ['/', '/edit/' + task['id'], '/archive', '/journal', '/journal/search', '/journal/sections', '/journal/suggestions/orchard']
    with app.test_client() as client:
        print(json.dumps({url: client.get(url).get_data(as_text=True) for url in urls}))
`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }));
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); });

async function openPage(url) {
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
  await page.route('https://datapom.test/**', route => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/static/')) return route.fulfill({ path: path.join(__dirname, '..', pathname) });
    return route.fulfill({ contentType: pathname.startsWith('/journal/suggestions/') ? 'application/json' : 'text/html', body: pages[pathname] || '{}' });
  });
  await page.goto('https://datapom.test' + url);
  return page;
}

async function assertCircles(controls) {
  assert.ok(await controls.count(), 'The route must render tag controls');
  const styles = await controls.evaluateAll(inputs => inputs.map(input => {
    const style = getComputedStyle(input), box = input.getBoundingClientRect();
    return { radius: style.borderRadius, appearance: style.appearance, width: box.width, height: box.height };
  }));
  for (const style of styles) {
    assert.equal(style.radius, '50%');
    assert.equal(style.appearance, 'none');
    assert.equal(style.width, style.height);
    assert.ok(style.width > 0);
  }
}

test('task add/edit/filter, entry, and search tag controls are circles and remain multi-select', async () => {
  for (const url of ['/', Object.keys(pages).find(url => url.startsWith('/edit/')), '/archive', '/journal', '/journal/search']) {
    const page = await openPage(url);
    try {
      if (url === '/journal/search') await page.locator('.tag-dropdown-btn').click();
      await assertCircles(page.locator('.tag-toggle input[type="checkbox"], .tag-check'));
      const boxes = page.locator('.tag-toggle input[type="checkbox"]');
      if (await boxes.count() >= 2) {
        await boxes.nth(0).check(); await boxes.nth(1).check();
        assert.equal(await boxes.nth(0).isChecked(), true);
        assert.equal(await boxes.nth(1).isChecked(), true);
        await boxes.nth(0).focus();
        await page.keyboard.press('Space');
        assert.equal(await boxes.nth(0).isChecked(), false);
        assert.equal(await boxes.nth(1).isChecked(), true);
        assert.equal(await boxes.nth(0).evaluate(input => getComputedStyle(input).outlineStyle), 'solid');
      }
    } finally { await page.close(); }
  }
});

test('tag suggestion day choices are circular independent checkboxes', async () => {
  const page = await openPage('/journal/sections');
  try {
    await page.locator('.suggest-chip-v2').filter({ hasText: 'orchard' }).locator('.suggest-chip-body').click();
    const choices = page.locator('.suggest-day-row input[type="checkbox"]');
    await choices.first().waitFor();
    await assertCircles(choices);
    await choices.nth(0).uncheck();
    assert.equal(await choices.nth(1).isChecked(), true);
    assert.equal(await page.getByRole('button', { name: 'Confirm', exact: true }).isEnabled(), true);
  } finally { await page.close(); }
});
