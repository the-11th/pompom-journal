const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({channel: 'chrome', headless: true}); });
after(async () => { await browser?.close(); });

const activities = Array.from({length: 12}, (_, i) => ({name: `app-${i}`, min: 12 - i, category: 'Work', productivity: 2}));
const payload = {sections: [], entries: [{date: '2026-09-18', tags: {}, numbers: {}, rescuetime: {
  pulse: 80, total_min: 78, productive_min: 78, activity_version: 2, top_activities: activities,
}}], date_range: {min: '2026-09-18', max: '2026-09-18'}, tasks: {active: [], archive: [], expired: [], tags: {}}};
const detail = () => ({ok: true, connected: true, date: '2026-09-18', reports: {
  activities: {status: 'ok', fetched: '2026-09-19T14:00:00', rows: activities},
  hourly: {status: 'ok', fetched: '2026-09-19T14:00:00', rows: [
    {hour: 9, name: 'app-0', min: 20, productivity: 2},
    {hour: 9, name: 'unknown', min: 5, productivity: null},
  ]},
  documents: {status: 'ok', fetched: '2026-09-19T14:00:00', rows: [
    {name: 'example.com', title: '<img src=x onerror=alert(1)>', min: 0.25, productivity: 1},
  ]},
}});

async function pageFor(respond = route => route.fulfill({json: detail()}), initial = payload) {
  const page = await browser.newPage({viewport: {width: 1000, height: 850}});
  page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/data') return route.fulfill({json: initial});
    if (url.pathname === '/integrations/rescuetime/detail') return respond(route, url);
    if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(__dirname, '..', url.pathname)});
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
      <link rel="stylesheet" href="/static/style.css"><div id="analytics-root" data-endpoint="/data">
      <div class="analytics-cats"></div><div class="analytics-subtabs"></div>
      <input id="date-from" type="hidden"><input id="date-to" type="hidden"><button id="date-reset">reset</button>
      <div class="analytics-panels"></div><p id="analytics-loading">Loading…</p></div>
      <script src="/static/custom-select.js"></script><script src="/static/analytics.js"></script>`});
  });
  await page.goto('https://datapom.test/');
  await page.getByRole('tab', {name: 'Digital', exact: true}).click();
  return page;
}

test('all imported activities are searchable beyond the top eight', async () => {
  const page = await pageFor();
  try {
    const panel = page.locator('#chart-productivity-top-activities');
    await panel.getByRole('searchbox', {name: 'Search apps and websites'}).fill('app-11');
    assert.match(await panel.innerText(), /app-11/);
    assert.doesNotMatch(await panel.innerText(), /app-0/);
  } finally { await page.close(); }
});

test('connected accounts can explore a day before the first import', async () => {
  const page = await pageFor(undefined, {...payload, entries: [], rescuetime_connected: true});
  try {
    const panel = page.locator('#chart-productivity-day-detail');
    await panel.getByRole('button', {name: 'Load day', exact: true}).click();
    await panel.getByText('<img src=x onerror=alert(1)>', {exact: true}).waitFor();
  } finally { await page.close(); }
});

test('day explorer shows hourly totals and treats reported titles as text', async () => {
  const page = await pageFor();
  try {
    const panel = page.locator('#chart-productivity-day-detail');
    await panel.getByRole('button', {name: 'Load day', exact: true}).click();
    await panel.getByText('<img src=x onerror=alert(1)>', {exact: true}).waitFor();
    assert.equal(await panel.locator('img').count(), 0);
    assert.match(await panel.innerText(), /15s/);
    assert.match(await panel.locator('svg title').allTextContents().then(v => v.join(' ')), /09:00.*25m/);
    await page.setViewportSize({width: 390, height: 850});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('unavailable document reports keep other reports and show an explanation', async () => {
  const page = await pageFor(route => {
    const data = detail();
    data.reports.documents = {status: 'unavailable', rows: [], message: 'Page details are unavailable for this account.'};
    return route.fulfill({json: data});
  });
  try {
    const panel = page.locator('#chart-productivity-day-detail');
    await panel.getByRole('button', {name: 'Load day', exact: true}).click();
    await panel.getByText('Page details are unavailable for this account.', {exact: true}).waitFor();
    assert.match(await panel.innerText(), /app-0/);
    assert.ok(await panel.locator('svg').count());
  } finally { await page.close(); }
});

test('failed requests can retry and the calendar changes the requested day', async () => {
  const requested = [];
  const page = await pageFor((route, url) => {
    requested.push(url.searchParams.get('date'));
    return requested.length === 1 ? route.fulfill({status: 503, json: {}})
      : route.fulfill({json: {...detail(), date: url.searchParams.get('date')}});
  });
  try {
    const panel = page.locator('#chart-productivity-day-detail');
    await panel.getByRole('button', {name: 'Load day', exact: true}).click();
    await panel.getByText('Could not load this day. Try again.', {exact: true}).waitFor();
    await panel.getByRole('button', {name: 'Activity date', exact: true}).click();
    await page.getByRole('button', {name: '2026-09-17', exact: true}).click();
    await panel.getByRole('button', {name: 'Load day', exact: true}).click();
    await panel.getByText('<img src=x onerror=alert(1)>', {exact: true}).waitFor();
    assert.deepEqual(requested, ['2026-09-18', '2026-09-17']);
  } finally { await page.close(); }
});
