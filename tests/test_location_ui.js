/* Location controls with synthetic routes, actual shared scripts, and no network. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({channel: 'chrome', headless: true}); });
after(async () => { await browser?.close(); });

function oneDay() {
  return {days: [{date: '2026-09-10', summary: {sample_count: 10, distance_m: 900, moving_seconds: 1800,
    recorded_seconds: 2700, stay_count: 1}, visits: []}],
    summary: {days_tracked: 1, distance_m: 900, moving_seconds: 1800, recorded_seconds: 2700,
      stationary_seconds: 900, stay_count: 1, avg_moving_speed_mps: .5, max_speed_mps: 2,
      transport: [{mode: 'walking', duration_seconds: 1800, distance_m: 900}]},
    place_totals: [], hourly: [{hour: 10, moving_seconds: 1800}], dow: [{day: 3, distance_m: 900, days_tracked: 1}]};
}
async function locationPage(data = oneDay(), width = 390, respond) {
  const page = await browser.newPage({viewport: {width, height: 844}});
  page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const url = new URL(route.request().url());
    const response = respond?.(route, url); if (response) return response;
    if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(__dirname, '..', url.pathname)});
    if (url.pathname === '/journal/media/state') return route.fulfill({json: {assets: {}, groups: {}, places: {}, messages: {}}});
    if (url.pathname === '/journal/media/tracking') return route.fulfill({json: url.searchParams.has('summary') ? data : {
      samples: Array.from({length: 5}, (_, i) => ({id: 'fix-' + i, at: '2026-09-10T10:' + String(i * 5).padStart(2, '0') + ':00+08:00',
        lat: 31.2 + i * .001, lon: 121.5 + i * .001, accuracy_m: 8, session: 'qa', source_device: 'phone'})),
    }});
    if (url.pathname === '/journal/media/maps') return route.fulfill({json: {packs: []}});
    if (url.pathname === '/journal/media/discord/status') return route.fulfill({json: {connected: false}});
    if (url.pathname.startsWith('/journal/media/entry/')) return route.fulfill({json: {date: '2026-09-10', document: []}});
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <link rel="stylesheet" href="/static/style.css"><main><section class="analytics-panel" id="location-root"></section></main>
      ${['custom-select', 'custom-color', 'media-ui', 'offline-map', 'location-day', 'location-day-view', 'location-analytics', 'media-settings'].map(name => '<script src="/static/' + name + '.js"></script>').join('')}
      <script>PupLocationAnalytics.render(document.getElementById('location-root')).catch(error => document.body.dataset.error=error.message);</script>`});
  });
  await page.goto('https://datapom.test/');
  await page.getByRole('heading', {name: 'Travel over time', exact: true}).waitFor();
  return page;
}

test('location charts remain readable, center a single day, and resize without closing the map', async () => {
  const page = await locationPage();
  try {
    assert.equal(await page.locator('#location-root > .media-toolbar p').innerText(), '2026-09-10 · 1 day tracked');
    const svg = page.getByRole('img', {name: 'Daily recorded travel distance', exact: true});
    const geometry = await svg.evaluate(el => ({width: el.viewBox.baseVal.width,
      pointX: Number(el.querySelector('circle').getAttribute('cx')),
      labels: [...el.querySelectorAll('text')].map(node => ({text: node.textContent,
        size: parseFloat(getComputedStyle(node).fontSize) * el.getBoundingClientRect().width / el.viewBox.baseVal.width}))}));
    assert.ok(geometry.labels.every(label => label.size >= 10), JSON.stringify(geometry));
    assert.equal(geometry.labels.filter(label => label.text === '09-10').length, 1);
    assert.equal(geometry.pointX, geometry.width / 2);
    await page.getByRole('button', {name: 'Open daily map', exact: true}).click();
    const canvas = page.locator('.location-selected-day canvas'); await canvas.waitFor();
    await canvas.evaluate(el => { el.dataset.retained = 'yes'; });
    await page.setViewportSize({width: 1024, height: 844});
    await page.waitForFunction(() => document.querySelector('.location-trend').viewBox.baseVal.width > 500);
    assert.equal(await canvas.getAttribute('data-retained'), 'yes');
    assert.equal(await page.getByRole('button', {name: 'Close daily map', exact: true}).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('location totals remain readable within320px at200percent text size', async () => {
  const data = oneDay();
  Object.assign(data.summary, {days_tracked: 90, distance_m: 987654, moving_seconds: 1234567, recorded_seconds: 2345678});
  const page = await locationPage(data, 320);
  try {
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('#location-root *')].filter(el => {
      const box = el.getBoundingClientRect(); return box.width && box.height && box.right > innerWidth + 1;
    }).map(el => ({tag: el.tagName, class: el.className, text: el.textContent})).filter(el => el.tag !== 'svg'));
    assert.deepEqual(overflow, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      JSON.stringify(await page.locator('#location-root *').evaluateAll(nodes => nodes.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => ({class: el.className, text: el.textContent, scroll: el.scrollWidth, width: el.clientWidth})))));
  } finally { await page.close(); }
});

test('location summary refresh retains an open daily map and its controls through failure and new totals', async () => {
  const data = oneDay(); let fail = false;
  const page = await locationPage(data, 390, (route, url) => {
    if (fail && url.pathname === '/journal/media/tracking' && url.searchParams.has('summary')) return route.fulfill({status: 503, json: {error: 'Unavailable'}});
  });
  try {
    await page.getByRole('button', {name: 'Open daily map', exact: true}).click();
    const canvas = page.locator('.location-selected-day canvas'); await canvas.evaluate(el => { el.dataset.retained = 'yes'; });
    const slider = page.getByRole('slider', {name: 'Time of day for recorded location', exact: true}); await slider.press('ArrowLeft'); const minute = await slider.inputValue();
    fail = true; await page.evaluate(() => document.getElementById('location-root')._refreshLocations());
    await page.getByText('Could not refresh location history. Previous view kept.', {exact: true}).waitFor();
    assert.equal(await canvas.getAttribute('data-retained'), 'yes'); assert.equal(await slider.inputValue(), minute);
    fail = false; data.summary.distance_m = 1800;
    await slider.focus(); await page.evaluate(() => document.getElementById('location-root')._refreshLocations());
    await page.locator('.location-stat-cards').first().getByText('1.8 km', {exact: true}).waitFor();
    assert.equal(await canvas.getAttribute('data-retained'), 'yes'); assert.equal(await slider.inputValue(), minute);
    assert.equal(await slider.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.getByRole('button', {name: 'Close daily map', exact: true}).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByText('Could not refresh location history. Previous view kept.', {exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('daily map device filters preserve keyboard focus and replay time', async () => {
  const page = await locationPage();
  try {
    await page.getByRole('button', {name: 'Open daily map', exact: true}).click();
    const slider = page.getByRole('slider', {name: 'Time of day for recorded location', exact: true});
    await slider.waitFor();
    await slider.press('ArrowLeft');
    const minute = await slider.inputValue();
    assert.equal(await page.getByRole('button', {name: 'Follow dot', exact: true}).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', {name: 'Follow dot', exact: true}).click();
    const laptop = page.getByRole('button', {name: 'Laptop', exact: true});
    await laptop.press('Enter');
    assert.equal(await laptop.getAttribute('aria-pressed'), 'true');
    assert.equal(await laptop.evaluate(el => el === document.activeElement), true);
    await page.getByText('No laptop recordings for this day yet.', {exact: true}).waitFor();
    const phone = page.getByRole('button', {name: 'Phone', exact: true});
    await phone.press('Enter');
    assert.equal(await phone.evaluate(el => el === document.activeElement), true);
    assert.equal(await slider.inputValue(), minute);
    assert.equal(await page.getByRole('button', {name: 'Follow dot', exact: true}).getAttribute('aria-pressed'), 'false');
  } finally { await page.close(); }
});

for(const control of ['toggle','picker'])test(`location refresh retains the selected day label and focus on the ${control}`, async () => {
  const data = oneDay(); data.days.unshift({...data.days[0], date: '2026-09-09'});
  const page = await locationPage(data);
  try {
    await page.getByRole('button', {name: 'Open daily map', exact: true}).click();
    await page.locator('select[aria-label="Choose a recorded day"]').selectOption('2026-09-09', {force: true});
    const focus=control==='toggle'?page.getByRole('button', {name: 'Close daily map', exact: true}):page.locator('.location-selected-day .cs-trigger').first();
    await focus.focus();
    data.days[0].summary.distance_m=1800;
    await page.evaluate(() => document.getElementById('location-root')._refreshLocations());
    assert.equal(await page.locator('select[aria-label="Choose a recorded day"]').inputValue(), '2026-09-09');
    assert.match(await page.locator('.location-selected-day .cs-trigger').first().innerText(), /2026-09-09/);
    assert.equal(await focus.evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

for (const kind of ['places', 'groups']) test(`retrying ${kind} after a lost acknowledgement creates one record`, async () => {
  const store = {assets: {}, groups: {}, places: {}, messages: {}}, receipts = new Set(), attempts = [];
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/state') return;
    if (route.request().method() === 'GET') return route.fulfill({json: store});
    const change = route.request().postDataJSON().changes[0]; attempts.push(change);
    if (!receipts.has(change.op_id)) {
      const current = store[change.kind][change.id];
      if ((current?.rev ?? null) !== change.base_rev) return route.fulfill({json: {...store, conflicts: [{current}]}});
      store[change.kind][change.id] = {...current, ...change.patch, id: change.id, rev: (current?.rev ?? 0) + 1};
      receipts.add(change.op_id);
    }
    return attempts.length === 1 ? route.abort('failed') : route.fulfill({json: store});
  });
  try {
    if (kind === 'places') await page.evaluate(() => PupMedia.editPlace({}, {lat: 31.2, lon: 121.5}));
    else {
      await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
      await page.getByRole('button', {name: '＋ Photo-tag group', exact: true}).click();
    }
    await page.getByRole('textbox', {name: kind === 'places' ? 'Name' : 'Group name', exact: true}).fill('Quiet cafe');
    const save = page.getByRole('button', {name: kind === 'places' ? 'Save place' : 'Add group', exact: true});
    await save.click();
    await page.getByText('Failed to fetch', {exact: true}).waitFor();
    await save.click();
    await page.getByRole('dialog', {name: kind === 'places' ? 'Save a place' : 'New photo-tag group', exact: true}).waitFor({state: 'hidden'});
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].id, attempts[1].id);
    assert.equal(attempts[0].op_id, attempts[1].op_id);
    assert.equal(Object.keys(store[kind]).length, 1);
    assert.equal(Object.values(store[kind])[0].rev, 1);
  } finally { await page.close(); }
});

test('place validation keeps values, focuses the field and accepts fractional radii', async () => {
  let posted = null;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/state' || route.request().method() !== 'POST') return;
    posted = route.request().postDataJSON().changes[0];
    return route.fulfill({json: {assets: {}, messages: {}, groups: {}, places: {[posted.id]: {...posted.patch, id: posted.id, rev: 1}}}});
  });
  try {
    await page.evaluate(() => PupMedia.editPlace({}, {lat: 31.2, lon: 121.5}));
    const name = page.getByRole('textbox', {name: 'Name', exact: true});
    const radius = page.getByRole('spinbutton', {name: 'Arrival radius (m)', exact: true});
    const city = page.getByRole('textbox', {name: 'City / nickname', exact: true});
    const save = page.getByRole('button', {name: 'Save place', exact: true});
    const fields = await page.locator('.media-place-fields > .media-field').evaluateAll(nodes => nodes.map(el => {
      const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width};
    }));
    assert.equal(fields[2].y, fields[3].y);
    assert.ok(fields[0].width > fields[2].width);
    await city.fill('A familiar neighborhood');
    await name.fill('   '); await save.click();
    assert.equal(posted, null);
    await page.getByRole('alert').filter({hasText: 'A name is required.'}).waitFor();
    assert.equal(await name.evaluate(el => el === document.activeElement), true);
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    assert.equal(await city.inputValue(), 'A familiar neighborhood');
    await name.fill('Quiet cafe');
    for (const value of ['', '0', '500001']) {
      await radius.fill(value); await save.click();
      assert.equal(posted, null);
      assert.equal(await radius.evaluate(el => el === document.activeElement), true);
      await page.getByRole('alert').filter({hasText: 'Radius must be between 10 and 500,000 m.'}).waitFor();
    }
    await radius.fill('10.5'); await save.click();
    await page.getByRole('dialog', {name: 'Save a place', exact: true}).waitFor({state: 'hidden'});
    assert.equal(posted.patch.radius_m, 10.5);
    assert.equal(posted.patch.name, 'Quiet cafe');
  } finally { await page.close(); }
});

test('failed place map loading offers retry without dropping the form', async () => {
  let mapRequests = 0;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/maps') return;
    return ++mapRequests === 1 ? route.fulfill({status: 503, json: {error: 'Maps unavailable'}})
      : route.fulfill({json: {packs: []}});
  });
  try {
    await page.evaluate(() => { PupMedia.editPlace({}, {lat: 31.2, lon: 121.5}).catch(() => {}); });
    const name = page.getByRole('textbox', {name: 'Name', exact: true});
    await name.fill('A place to keep');
    const retry = page.getByRole('button', {name: 'Retry maps', exact: true});
    await retry.click();
    await retry.waitFor({state: 'hidden'});
    assert.equal(mapRequests, 2);
    assert.equal(await name.inputValue(), 'A place to keep');
    assert.equal(await page.getByRole('button', {name: 'Save place', exact: true}).isEnabled(), true);
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
  } finally { await page.close(); }
});

test('photo-tag group validation stays in the dialog and accepts Unicode names', async () => {
  let posted = null;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/state' || route.request().method() !== 'POST') return;
    posted = route.request().postDataJSON().changes[0];
    return route.fulfill({json: {assets: {}, messages: {}, places: {}, groups: {[posted.id]: {...posted.patch, id: posted.id, tags: [], rev: 1}}}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    await page.getByRole('button', {name: '＋ Photo-tag group', exact: true}).click();
    const name = page.getByRole('textbox', {name: 'Group name', exact: true});
    await name.fill('  '); await page.getByRole('button', {name: 'Add group', exact: true}).click();
    assert.equal(posted, null);
    await page.getByRole('alert').filter({hasText: 'A name is required.'}).waitFor();
    assert.equal(await name.evaluate(el => el === document.activeElement), true);
    await name.fill('散步'); await page.getByRole('button', {name: 'Add group', exact: true}).click();
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    assert.equal(posted.patch.name, '散步');
  } finally { await page.close(); }
});

test('a slow old settings render cannot duplicate or replace the current view', async () => {
  let requests = 0, release, started;
  const oldStarted = new Promise(resolve => { started = resolve; });
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/maps') return;
    if (++requests === 1) {
      started();
      return new Promise(resolve => { release = () => { release = null; resolve(route.fulfill({json: {packs: []}})); }; });
    }
    return route.fulfill({json: {packs: []}});
  });
  try {
    await page.evaluate(() => { window.oldSettings = PupMedia.settings(document.getElementById('location-root')); });
    await oldStarted;
    await page.evaluate(() => { window.newSettings = PupMedia.settings(document.getElementById('location-root')); });
    await page.locator('#discord-inbox').waitFor();
    release();
    await page.evaluate(() => Promise.all([window.oldSettings, window.newSettings]));
    for (const id of ['photo-tags', 'saved-places', 'tracking', 'map-downloads', 'discord-inbox']) {
      assert.equal(await page.locator('#' + id).count(), 1, id);
    }
    assert.equal(await page.locator('#location-root canvas').count(), 2);
    await page.evaluate(() => document.getElementById('location-root')._mediaCleanup());
    assert.equal(await page.locator('#location-root canvas').count(), 0);
  } finally { release?.(); await page.close(); }
});

test('settings can retry unavailable metadata without leaving a dead page', async () => {
  let fail = false;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/state' && fail) return route.fulfill({status: 503, json: {error: 'Temporary outage'}});
  });
  try {
    fail = true;
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')).catch(() => {}));
    await page.getByText('Could not load settings.', {exact: true}).waitFor();
    fail = false;
    await page.getByRole('button', {name: 'Retry settings', exact: true}).click();
    await page.locator('#discord-inbox').waitFor();
    assert.equal(await page.locator('#saved-places canvas').count(), 1);
  } finally { await page.close(); }
});

test('unavailable maps leave the settings usable and can be retried in place', async () => {
  let fail = true;
  const pack = {id: 'world', name: 'World overview', bounds: [-180, -85, 180, 85], status: 'ready', bytes: 420000,
    url: '/journal/media/maps/world.pmtiles', max_zoom: 0};
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/maps') return fail ? route.fulfill({status: 503, json: {error: 'Temporary outage'}})
      : route.fulfill({json: {packs: [pack]}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')).catch(() => {}));
    await page.locator('#discord-inbox').waitFor();
    assert.equal(await page.getByRole('button', {name: '＋ Place / city', exact: true}).isEnabled(), true);
    await page.getByRole('button', {name: '＋ Photo-tag group', exact: true}).click();
    await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    fail = false;
    await page.getByRole('button', {name: 'Retry map status', exact: true}).click();
    await page.getByText('420 KB downloaded', {exact: true}).waitFor();
    assert.equal(await page.locator('#location-root canvas').count(), 2);
    assert.equal(await page.getByRole('button', {name: 'Retry map status', exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('a failed connection lookup does not claim Discord is disconnected', async () => {
  let fail = true;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/discord/status') return fail ? route.fulfill({status: 503, json: {error: 'Temporary outage'}})
      : route.fulfill({json: {connected: true, receiver_url: 'https://receiver.test', application_id: '12345'}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    const discord = page.locator('#discord-inbox');
    await discord.getByText('Could not check connection.', {exact: true}).waitFor();
    assert.equal(await discord.getByText('Not connected', {exact: true}).count(), 0);
    assert.equal(await discord.getByRole('button', {name: 'Save receiver', exact: true}).count(), 0);
    fail = false;
    await discord.getByRole('button', {name: 'Retry connection', exact: true}).click();
    await discord.getByText('Connected', {exact: true}).waitFor();
    await discord.getByText('Receiver settings', {exact: true}).click();
    assert.equal(await discord.getByRole('textbox', {name: 'Receiver URL', exact: true}).inputValue(), 'https://receiver.test');
  } finally { await page.close(); }
});

test('narrow map download rows give names a full readable line', async () => {
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/maps') return route.fulfill({json: {packs: [
      {id: 'world', name: 'World overview', bounds: [-180, -85, 180, 85], status: 'missing'},
      {id: 'bay-area', name: 'San Francisco Bay Area · all nine counties', bounds: [-123, 37, -121, 39], status: 'missing',
        counties: ['Alameda', 'Contra Costa', 'Marin', 'Napa', 'San Francisco', 'San Mateo', 'Santa Clara', 'Solano', 'Sonoma']},
    ]}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    const rows = await page.locator('#map-downloads .media-settings-row').evaluateAll(nodes => nodes.map(row => {
      const copy = row.querySelector('.media-settings-copy').getBoundingClientRect();
      const actions = row.querySelector('.media-download-actions').getBoundingClientRect();
      return {width: row.clientWidth, copyWidth: copy.width, copyBottom: copy.bottom, actionsTop: actions.top};
    }));
    assert.ok(rows.every(row => row.copyWidth >= row.width * .95 && row.actionsTop >= row.copyBottom), JSON.stringify(rows));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('map download progress retains the focused coverage action and map canvas', async () => {
  let reads = 0;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/maps') {
      reads++;
      return route.fulfill({json: {packs: [{id: 'area', name: 'Neighborhood', bounds: [121, 31, 122, 32], status: 'missing',
        download_status: 'downloading', downloaded_bytes: reads * 10000}]}});
    }
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    const canvas = page.locator('#map-downloads canvas'); await canvas.evaluate(el => { el.dataset.retained = 'yes'; });
    const coverage = page.getByRole('group', {name: 'Neighborhood', exact: true}).getByRole('button', {name: 'Coverage', exact: true});
    await coverage.focus(); const before = reads;
    await page.waitForFunction(expected => document.querySelector('#map-downloads .media-settings-copy p').textContent.includes(expected + ' KB'), (before + 1) * 10);
    assert.equal(await coverage.evaluate(el => el === document.activeElement), true);
    assert.equal(await canvas.getAttribute('data-retained'), 'yes');
  } finally { await page.close(); }
});

test('adding a map area validates in place and retains its identity after an uncertain response', async () => {
  const attempts = [];
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname !== '/journal/media/maps' || route.request().method() !== 'POST') return;
    attempts.push(route.request().postDataJSON());
    return attempts.length === 1 ? route.abort('failed') : route.fulfill({json: {packs: []}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    await page.getByRole('button', {name: '＋ Map area', exact: true}).click();
    const dialog = page.getByRole('dialog'), name = dialog.getByRole('textbox', {name: 'Area name', exact: true});
    const add = dialog.getByRole('button', {name: 'Add area', exact: true});
    await add.click();
    assert.equal(attempts.length, 0);
    await dialog.getByRole('alert').filter({hasText: 'A name is required.'}).waitFor();
    assert.equal(await name.evaluate(el => el === document.activeElement), true);
    await name.fill('A'.repeat(201)); await add.click();
    assert.equal(attempts.length, 0);
    await dialog.getByRole('alert').filter({hasText: 'Use a name of 200 characters or fewer.'}).waitFor();
    await name.fill('Neighborhood walks'); await add.click();
    await dialog.getByRole('alert').filter({hasText: 'Failed to fetch'}).waitFor();
    assert.equal(await name.inputValue(), 'Neighborhood walks');
    await add.click(); await dialog.waitFor({state: 'hidden'});
    assert.equal(attempts.length, 2);
    assert.match(attempts[0].id, /^[0-9a-f]{32}$/);
    assert.deepEqual(attempts[0], attempts[1]);
  } finally { await page.close(); }
});

test('keyboard map selection opens the existing centered place', async () => {
  const place = {id: 'cafe', name: 'Quiet cafe', lat: 31.2, lon: 121.5, radius_m: 100, color: '#78b8d8', rev: 1};
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/state') return route.fulfill({json: {assets: {}, groups: {}, messages: {}, places: {cafe: place}}});
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    await page.locator('#saved-places canvas').press('Enter');
    const edit = page.getByRole('dialog', {name: 'Edit place', exact: true}); await edit.waitFor();
    assert.equal(await edit.getByRole('textbox', {name: 'Name', exact: true}).inputValue(), 'Quiet cafe');
    await edit.getByRole('button', {name: 'Cancel', exact: true}).click();
    assert.equal(await page.locator('#saved-places canvas').evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

async function mountDay(page) {
  await page.evaluate(async () => {
    const root = document.getElementById('location-root'); root._mediaCleanup?.(); root.replaceChildren();
    window.qaDay = PupLocationDayView.mount(root, '2026-09-10', {document: []}); await qaDay.ready;
  });
}

test('background day refresh retains map framing, replay time and keyboard focus', async () => {
  let reads = 0;
  const page = await locationPage(oneDay(), 390, (_route, url) => {
    if (url.pathname === '/journal/media/tracking' && !url.searchParams.has('summary')) reads++;
  });
  try {
    await mountDay(page);
    const canvas = page.locator('.location-day-map canvas');
    await canvas.press('+'); await canvas.press('ArrowLeft');
    const slider = page.getByRole('slider', {name: 'Time of day for recorded location', exact: true});
    await slider.press('ArrowLeft'); const minute = await slider.inputValue();
    await canvas.press('ArrowLeft');await slider.focus();
    const framing = await page.evaluate(() => ({center: qaDay.map.center, zoom: qaDay.map.zoom}));
    await page.evaluate(() => qaDay.refresh());
    assert.equal(await slider.inputValue(), minute);
    assert.equal(await slider.evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => ({center: qaDay.map.center, zoom: qaDay.map.zoom})), framing);
    const before = reads;
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('journal:saved', {detail: {date: '2026-09-09'}})));
    await page.waitForTimeout(50);
    assert.equal(reads, before);
  } finally { await page.close(); }
});

test('stop details stay open through a refresh and return focus when closed', async () => {
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/tracking' && !url.searchParams.has('summary')) return route.fulfill({json: {
      samples: Array.from({length: 4}, (_, i) => ({id: 'stop-' + i, at: '2026-09-10T10:' + String(i * 5).padStart(2, '0') + ':00+08:00',
        lat: 31.2, lon: 121.5, accuracy_m: 8, speed_mps: 0, session: 'qa', source_device: 'phone'})),
    }});
  });
  try {
    await mountDay(page);
    const stop = page.locator('.location-day-stop').first(); await stop.press('Enter');
    const detail = page.locator('.location-day-detail');
    assert.equal(await detail.evaluate(el => el === document.activeElement), true);
    const close = page.getByRole('button', {name: 'Close stop details', exact: true}); await close.focus();
    const scroll = await page.evaluate(() => scrollY);
    await page.evaluate(() => qaDay.refresh());
    assert.equal(await detail.isVisible(), true);
    assert.equal(await close.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal(await close.evaluate(el => {const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight;}), true);
    await close.press('Enter');
    assert.equal(await detail.isVisible(), false);
    assert.equal(await stop.evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

test('receiver validation and failed saves preserve the entered configuration', async () => {
  const posts = [];
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/discord/config') {
      posts.push(route.request().postDataJSON());
      return route.fulfill({status: 503, json: {error: 'Could not save receiver settings.'}});
    }
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    const area = page.locator('#discord-inbox'), url = area.getByRole('textbox', {name: 'Receiver URL', exact: true});
    const token = area.getByRole('textbox', {name: 'Receiver token', exact: true});
    const application = area.getByRole('textbox', {name: 'Discord application ID', exact: true});
    const save = area.getByRole('button', {name: 'Save receiver', exact: true});
    for (const value of ['', 'http://receiver.test', 'https://receiver.test?token=oops']) {
      await url.fill(value); await save.click(); assert.equal(posts.length, 0);
      await area.getByRole('alert').filter({hasText: 'Use the HTTPS address of your private receiver.'}).waitFor();
      assert.equal(await url.evaluate(el => el === document.activeElement), true);
    }
    await url.fill('https://receiver.test'); await save.click();
    assert.equal(posts.length, 0); assert.equal(await token.evaluate(el => el === document.activeElement), true);
    await token.fill('synthetic-test-token'); await application.fill('abc'); await save.click();
    assert.equal(posts.length, 0); assert.equal(await application.evaluate(el => el === document.activeElement), true);
    await application.fill('123456'); await save.click();
    await area.getByRole('alert').filter({hasText: 'Could not save receiver settings.'}).waitFor();
    assert.equal(posts.length, 1);
    assert.equal(await url.inputValue(), 'https://receiver.test');
    assert.equal(await token.inputValue(), 'synthetic-test-token');
    assert.equal(await application.inputValue(), '123456');
    assert.equal(await save.isEnabled(), true);
  } finally { await page.close(); }
});

for (const kind of ['place', 'photo group', 'map area']) test(`${kind} fields pause during save and become editable after failure`, async () => {
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (route.request().method() !== 'POST' || !['/journal/media/state', '/journal/media/maps'].includes(url.pathname)) return;
    started(); return new Promise(resolve => { release = () => { release = null; resolve(route.fulfill({status: 503, json: {error: 'Please retry.'}})); }; });
  });
  try {
    if (kind === 'place') await page.evaluate(() => PupMedia.editPlace({}, {lat: 31.2, lon: 121.5}));
    else {
      await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
      await page.getByRole('button', {name: kind === 'photo group' ? '＋ Photo-tag group' : '＋ Map area', exact: true}).click();
    }
    const dialog = page.getByRole('dialog'), name = dialog.getByRole('textbox', {name: kind === 'place' ? 'Name' : kind === 'photo group' ? 'Group name' : 'Area name', exact: true});
    await name.fill('Original name');
    await dialog.getByRole('button', {name: kind === 'place' ? 'Save place' : kind === 'photo group' ? 'Add group' : 'Add area', exact: true}).click();
    await pending;
    await name.focus(); await page.keyboard.type(' accidental change');
    assert.equal(await name.inputValue(), 'Original name');
    release(); await dialog.getByRole('alert').filter({hasText: 'Please retry.'}).waitFor();
    await name.fill('A corrected name'); assert.equal(await name.inputValue(), 'A corrected name');
  } finally { release?.(); await page.close(); }
});

test('media conflict choices refer to the displayed copies and refresh stale comparisons', async () => {
  const conflict = revision => ({kind: 'groups', id: 'people', revision,
    local: {id: 'people', name: 'people', tags: ['alex'], share_entry: true, rev: 3},
    current: {id: 'people', name: 'people', tags: [revision === 'copy-1' ? 'sam' : 'maya'], share_entry: true, rev: 4}});
  let current = conflict('copy-1'); const posts = [];
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/media-conflicts') return route.fulfill({json: {conflicts: current ? [current] : []}});
    if (url.pathname === '/journal/media/media-conflicts/resolve') {
      posts.push(route.request().postDataJSON());
      if (posts.length === 1) { current = conflict('copy-2'); return route.fulfill({status: 409, json: {error: 'Copies changed.', current}}); }
      current = null; return route.fulfill({json: {ok: true}});
    }
    if (url.pathname === '/journal/media/tracking-status') return route.fulfill({json: {enabled: false, message: 'Tracking paused.'}});
    if (url.pathname === '/journal/media/current-location') return route.fulfill({json: {status: 'unavailable'}});
  });
  try {
    await page.evaluate(() => { window.TodoPupNative = {}; return PupMedia.settings(document.getElementById('location-root')); });
    await page.getByRole('button', {name: 'Keep phone', exact: true}).click();
    await page.getByText('Copies changed. Review them again.', {exact: true}).waitFor();
    assert.equal(posts[0].expected_revision, 'copy-1');
    assert.equal(posts[0].choice, 'local');
    assert.match(await page.locator('.media-conflict-version').first().innerText(), /Tags: alex/);
    assert.match(await page.locator('.media-conflict-version').last().innerText(), /Tags: maya/);
    assert.equal(await page.getByRole('button', {name: 'Keep phone', exact: true}).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', {name: 'Use Mac', exact: true}).click();
    await page.getByRole('heading', {name: 'Changes to review', exact: true}).waitFor({state: 'hidden'});
    assert.equal(posts.length, 2); assert.equal(posts[1].expected_revision, 'copy-2'); assert.equal(posts[1].choice, 'remote');
    assert.equal(await page.getByRole('heading', {name: 'Photo tags', exact: true}).evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

for (const endpoint of ['state', 'tracking']) test(`location history retries a failed ${endpoint} load in place`, async () => {
  let fail = false;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (fail && url.pathname === '/journal/media/' + endpoint) return route.fulfill({status: 503, json: {error: 'Unavailable'}});
  });
  try {
    fail = true;
    await page.evaluate(() => PupLocationAnalytics.render(document.getElementById('location-root')).catch(() => {}));
    const retry = page.getByRole('button', {name: 'Retry locations', exact: true});
    await retry.waitFor();
    await page.getByText('Could not load location history.', {exact: true}).waitFor();
    assert.equal(await page.locator('#location-root').count(), 1);
    fail = false; await retry.click();
    await page.getByRole('heading', {name: 'Travel over time', exact: true}).waitFor();
    assert.equal(await retry.count(), 0);
  } finally { await page.close(); }
});

test('an old failed location load cannot replace a newer range or escape to the caller', async () => {
  let delay = false, release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (delay && url.pathname === '/journal/media/tracking' && url.searchParams.has('summary')) {
      delay = false; started();
      return new Promise(resolve => { release = () => { release = null; resolve(route.fulfill({status: 503, json: {error: 'Old failure'}})); }; });
    }
  });
  try {
    delay = true;
    await page.evaluate(() => { window.oldLoad = PupLocationAnalytics.render(document.getElementById('location-root'), {from: '2026-09-01'}).catch(error => { document.body.dataset.error = error.message; }); });
    await pending;
    await page.evaluate(() => PupLocationAnalytics.render(document.getElementById('location-root'), {from: '2026-09-10'}));
    release(); await page.evaluate(() => oldLoad);
    assert.equal(await page.locator('body').getAttribute('data-error'), null);
    assert.equal(await page.getByRole('heading', {name: 'Travel over time', exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Retry locations', exact: true}).count(), 0);
  } finally { release?.(); await page.close(); }
});

for (const [endpoint, label] of [['media-conflicts', 'Retry review'], ['tracking-status', 'Retry tracking']]) test(`a failed native ${endpoint} read keeps the other settings available`, async () => {
  let fail = true;
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/' + endpoint && fail) return route.fulfill({status: 503, json: {error: 'Unavailable'}});
    if (url.pathname === '/journal/media/media-conflicts') return route.fulfill({json: {conflicts: []}});
    if (url.pathname === '/journal/media/tracking-status') return route.fulfill({json: {enabled: false, message: 'Tracking paused.'}});
    if (url.pathname === '/journal/media/current-location') return route.fulfill({json: {status: 'unavailable'}});
  });
  try {
    await page.evaluate(() => { window.TodoPupNative = {}; return PupMedia.settings(document.getElementById('location-root')).catch(() => {}); });
    assert.equal(await page.getByRole('heading', {name: 'Photo tags', exact: true}).count(), 1);
    assert.equal(await page.getByRole('heading', {name: 'Offline map downloads', exact: true}).count(), 1);
    const retry = page.getByRole('button', {name: label, exact: true}); await retry.waitFor();
    fail = false; await retry.click();
    await page.getByRole('button', {name: 'Enable tracking', exact: true}).waitFor();
    await retry.waitFor({state: 'hidden'});
    assert.equal(await retry.count(), 0);
  } finally { await page.close(); }
});

test('tag sharing is managed with tags and failed saves retain the chosen value', async () => {
  const store = {assets: {}, groups: {people: {id: 'people', name: 'People', rev: 1, tags: [], share_entry: false}}, places: {}, messages: {}};
  let release, started, posts = 0;
  const pending = new Promise(resolve => { started = resolve; });
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/analytics') return route.fulfill({json:{tags:{}}});
    if (url.pathname !== '/journal/media/state') return;
    if (route.request().method() === 'GET') return route.fulfill({json: structuredClone(store)});
    posts++;
    if (posts > 1) return route.fulfill({status: 503, json: {error: 'Please retry sharing.'}});
    started(); return new Promise(resolve => { release = () => {
      release = null; store.groups.people = {...store.groups.people, share_entry: true, rev: 2}; resolve(route.fulfill({json: structuredClone(store)}));
    }; });
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    const row = page.getByRole('group', {name: 'People', exact: true});
    assert.equal(await row.getByRole('checkbox').count(),0);
    await row.getByRole('button',{name:'Manage tags',exact:true}).click();
    let dialog=page.getByRole('dialog',{name:'People photo tags',exact:true});
    let checkbox=dialog.getByRole('checkbox',{name:'Also tag entries',exact:true});
    await checkbox.check();assert.equal(posts,0);
    await dialog.getByRole('button',{name:'Save tags',exact:true}).click();await pending;
    assert.equal(await dialog.locator('.media-dialog-body').evaluate(el=>el.inert),true);
    release();await dialog.waitFor({state:'hidden'});
    await page.getByRole('group',{name:'People',exact:true}).getByRole('button',{name:'Manage tags',exact:true}).click();
    dialog=page.getByRole('dialog',{name:'People photo tags',exact:true});checkbox=dialog.getByRole('checkbox',{name:'Also tag entries',exact:true});
    assert.equal(await checkbox.isChecked(),true);
    await checkbox.uncheck();await dialog.getByRole('button',{name:'Save tags',exact:true}).click();await page.getByText('Please retry sharing.',{exact:true}).waitFor();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await checkbox.isEnabled(), true);
    assert.equal(posts, 2);
  } finally { release?.(); await page.close(); }
});

test('native settings reveal new conflicts in place and retain focus when copies change', async () => {
  let current = [], reads = 0;
  const conflict = tag => ({kind: 'groups', id: 'people', revision: tag,
    local: {id: 'people', name: 'People', tags: ['phone tag'], rev: 2}, current: {id: 'people', name: 'People', tags: [tag], rev: 3}});
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/media-conflicts') { reads++; return route.fulfill({json: {conflicts: current}}); }
    if (url.pathname === '/journal/media/tracking-status') return route.fulfill({json: {enabled: false, message: 'Tracking paused.'}});
    if (url.pathname === '/journal/media/current-location') return route.fulfill({json: {status: 'unavailable'}});
  });
  try {
    await page.evaluate(() => { window.TodoPupNative = {}; return PupMedia.settings(document.getElementById('location-root')); });
    const canvas = page.locator('#saved-places canvas'); await canvas.evaluate(el => { el.dataset.retained = 'yes'; });
    current = [conflict('first mac tag')];
    const keep = page.getByRole('button', {name: 'Keep phone', exact: true}); await keep.waitFor(); await keep.focus();
    await page.getByRole('status').filter({hasText: 'New changes to review.'}).waitFor();
    current = [conflict('newer mac tag')];
    await page.locator('.media-conflict-version').filter({hasText: 'newer mac tag'}).waitFor();
    assert.equal(await keep.evaluate(el => el === document.activeElement), true);
    assert.equal(await canvas.getAttribute('data-retained'), 'yes');
    await page.evaluate(() => document.getElementById('location-root')._mediaCleanup());
    const stoppedAt = reads; await page.waitForTimeout(2700); assert.equal(reads, stoppedAt);
  } finally { await page.close(); }
});

test('a settings refresh does not undo a section jump made while it was loading', async () => {
  let hold = false, release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (hold && url.pathname === '/journal/media/discord/status') {
      hold = false; started(); return new Promise(resolve => { release = () => { release = null; resolve(route.fulfill({json: {connected: false}})); }; });
    }
  });
  try {
    await page.evaluate(() => PupMedia.settings(document.getElementById('location-root')));
    await page.getByRole('link', {name: 'Places', exact: true}).click();
    hold = true;
    await page.evaluate(() => { window.settingsRefresh = PupMedia.settings(document.getElementById('location-root')); });
    await pending;
    await page.getByRole('link', {name: 'Maps', exact: true}).click();
    const downloads = page.locator('#map-downloads');
    const before = await downloads.evaluate(el => el.getBoundingClientRect().top);
    release(); await page.evaluate(() => settingsRefresh);
    const after = await downloads.evaluate(el => el.getBoundingClientRect().top);
    assert.ok(Math.abs(after - before) < 2, JSON.stringify({before, after}));
  } finally { release?.(); await page.close(); }
});

test('daily photo strips retain filenames and open photos when a thumbnail is unavailable', async () => {
  const page = await locationPage(oneDay(), 390, (route, url) => {
    if (url.pathname === '/journal/media/state') return route.fulfill({json: {assets: {harbor: {id: 'harbor', filename: 'Harbor.jpg',
      captured_at: '2026-09-10T10:10:00+08:00', location: {lat: 31.2, lon: 121.5}}}, places: {}, groups: {}, messages: {}}});
    if (url.pathname === '/journal/media/entry/2026-09-10') return route.fulfill({json: {entry: {date: '2026-09-10', document: [{id: 'photo', type: 'photo', asset_id: 'harbor'}]}}});
    if (url.pathname.endsWith('/thumb.webp')) return route.fulfill({status: 404, body: ''});
    if (url.pathname.endsWith('/preview.webp')) return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#334455"/></svg>'});
  });
  try {
    await page.getByRole('button', {name: 'Open daily map', exact: true}).click();
    const photo = page.getByRole('button', {name: 'Harbor.jpg · 10:10', exact: true}); await photo.scrollIntoViewIfNeeded();
    await photo.getByText('Preview unavailable', {exact: true}).waitFor();
    assert.equal(await photo.locator('img').count(), 0);
    assert.equal(await photo.getByText('Harbor.jpg', {exact: true}).count(), 1);
    await photo.click(); await page.getByRole('dialog', {name: 'Photo', exact: true}).waitFor();
    await page.waitForFunction(() => document.querySelector('.media-full-image')?.naturalWidth > 0);
    await page.getByRole('button', {name: 'Close Photo', exact: true}).click();
    assert.equal(await photo.evaluate(el => el === document.activeElement), true);
  } finally { await page.close(); }
});

test('location refresh retains an expanded place and focused visit', async () => {
 const data=oneDay();
 data.place_totals=[{place_id:'park',name:'Park',lat:31.2,lon:121.5,duration_seconds:1200,visits:1}];
 data.days[0].visits=[{place_id:'park',name:'Park',lat:31.2,lon:121.5,arrival:'2026-09-10T10:00:00+08:00',departure_after:'2026-09-10T10:20:00+08:00',duration_seconds:1200}];
 const page=await locationPage(data);
 try {
  await page.getByRole('button',{name:'Park',exact:true}).click();
  const visit=page.getByRole('button',{name:'2026-09-10 · 10:00–10:20 · 20 min',exact:true});
  await visit.focus();
  data.days[0].visits[0].departure_after='2026-09-10T10:30:00+08:00';data.days[0].visits[0].duration_seconds=1800;
  await page.evaluate(()=>document.getElementById('location-root')._refreshLocations());
  const updated=page.getByRole('button',{name:'2026-09-10 · 10:00–10:30 · 30 min',exact:true});
  assert.equal(await updated.count(),1);
  assert.equal(await updated.evaluate(el=>el===document.activeElement),true);
 } finally {await page.close();}
});
