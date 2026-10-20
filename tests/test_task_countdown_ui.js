const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }); });
after(async () => { await browser?.close(); });
const now = new Date('2026-06-15T12:00:00Z');

async function pageWith(badges) {
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.setContent(`<input id="draft" value="Keep my edit"><input id="done" type="checkbox" checked>${badges}`);
  await page.addScriptTag({ path: path.join(__dirname, '../static/task-countdown.js') });
  return page;
}

test('countdowns match server tiers, including the 48 hour boundary', async () => {
  const cases = [
    [259200, '3 day(s) left'], [172800, '2 day(s) left'],
    [172799, '47 hour(s) left'], [129600, '36 hour(s) left'],
    [86400, '24 hour(s) left'], [3600, '1 hour(s) left'],
    [3599, 'due soon'], [0, 'overdue'], [-1, 'overdue'],
    [-3600, 'overdue by 1 hour(s)'], [-86400, 'overdue by 1 day(s)'],
  ];
  const page = await pageWith(cases.map(([seconds]) =>
    `<span class="badge" data-task-due="${new Date(+now + seconds * 1000).toISOString()}">stale</span>`).join(''));
  try {
    assert.deepEqual(await page.locator('.badge').allTextContents(), cases.map(([, text]) => text));
    assert.deepEqual(await page.locator('.badge').evaluateAll(nodes => nodes.map(node => node.classList.contains('overdue'))), cases.map(([seconds]) => seconds <= 0));
  } finally { await page.close(); }
});

test('visible countdown ticks without reloading or replacing edits and checks', async () => {
  const page = await pageWith('<span class="badge" data-task-due="2026-06-17T12:00:00Z"></span><span class="badge" data-task-due="2026-06-15T12:00:30Z"></span><span class="badge">missed yesterday</span>');
  try {
    await page.locator('#draft').focus();
    await page.clock.runFor(30000);
    assert.deepEqual(await page.locator('.badge').allTextContents(), ['47 hour(s) left', 'overdue', 'missed yesterday']);
    assert.equal(await page.locator('.overdue').count(), 1);
    assert.equal(await page.locator('#draft').inputValue(), 'Keep my edit');
    assert.equal(await page.locator('#done').isChecked(), true);
    assert.equal(await page.locator('#draft').evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

test('returning to a tab immediately catches up after a suspended clock', async () => {
  const page = await pageWith('<span class="badge" data-task-due="2026-06-15T14:00:00Z"></span>');
  try {
    for (const [event, time, expected] of [
      ['focus', '2026-06-15T13:00:00Z', '1 hour(s) left'],
      ['visibilitychange', '2026-06-15T14:00:00Z', 'overdue'],
      ['pageshow', '2026-06-15T16:00:00Z', 'overdue by 2 hour(s)'],
    ]) {
      await page.clock.setSystemTime(new Date(time));
      await page.evaluate(event => (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)), event);
      assert.equal(await page.locator('.badge').textContent(), expected);
    }
  } finally { await page.close(); }
});

test('local timestamps and dates stay local and malformed dates stay empty', async () => {
  const page = await pageWith('<span class="badge" data-task-due="2026-06-16T17:00:00"></span><span class="badge" data-task-due="2026-06-17"></span><span class="badge overdue" data-task-due="invalid"></span><span class="badge" data-task-due=""></span>');
  try {
    assert.deepEqual(await page.locator('.badge').allTextContents(), ['36 hour(s) left', '43 hour(s) left', '', '']);
    assert.equal(await page.locator('.overdue').count(), 0);
  } finally { await page.close(); }
});
