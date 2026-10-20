/* Analytics interactions against synthetic data and an isolated browser. */
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({channel: 'chrome', headless: true}); });
after(async () => { await browser?.close(); });
const empty = () => ({sections: [], entries: [], date_range: {min: null, max: null}, tasks: {active: [], archive: [], expired: [], tags: {}}});
async function analyticsPage(respond = async route => route.fulfill({json: empty()}), tagRespond) {
  const page = await browser.newPage({viewport: {width: 1024, height: 768}});
  page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/data') return respond(route);
    if (url.pathname.startsWith('/tag/') && tagRespond) return tagRespond(route);
    if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(__dirname, '..', url.pathname)});
    return route.fulfill({contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/style.css">
      <main><div class="analytics" id="analytics-root" data-endpoint="/data">
      <div class="analytics-cats" role="tablist" aria-label="Analytics categories"></div>
      <div class="analytics-subtabs" role="tablist" aria-label="Sub-sections"></div>
      <div class="analytics-filter">
      <div class="cs-date"><button type="button" class="cs-trigger" data-datepicker="date-from" aria-label="From date"><span class="cs-value">—</span></button><input type="hidden" id="date-from"></div>
      <div class="cs-date"><button type="button" class="cs-trigger" data-datepicker="date-to" aria-label="To date"><span class="cs-value">—</span></button><input type="hidden" id="date-to"></div>
      <button type="button" id="date-reset">reset</button></div>
      <div class="analytics-panels"></div><p id="analytics-loading">Loading…</p></div></main>
      <script src="/static/analytics.js"></script>`});
  });
  await page.goto('https://datapom.test/');
  return page;
}

test('analytics categories and subtabs retain keyboard focus and selected state', async () => {
  const page = await analyticsPage();
  try {
    const overview = page.getByRole('tab', {name: 'Overview', exact: true});
    await overview.waitFor();
    assert.equal(await overview.getAttribute('aria-selected'), 'true');
    await overview.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Memories');
    assert.equal(await page.getByRole('tab', {name: 'Memories', exact: true}).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const mood = page.getByRole('tab', {name: 'Mood', exact: true});
    await mood.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Sleep');
    assert.equal(await page.getByRole('tab', {name: 'Sleep', exact: true}).getAttribute('aria-selected'), 'true');
    assert.equal(await mood.getAttribute('aria-selected'), 'false');
    assert.equal(await mood.getAttribute('tabindex'), '-1');
  } finally { await page.close(); }
});

test('a failed analytics load gives a working retry', async () => {
  let requests = 0;
  const page = await analyticsPage(route => ++requests === 1
    ? route.fulfill({status: 503, json: {error: 'Unavailable'}})
    : route.fulfill({json: empty()}));
  try {
    const retry = page.getByRole('button', {name: 'Retry', exact: true});
    await retry.waitFor();
    assert.match(await page.locator('#analytics-loading').innerText(), /Could not load analytics/);
    await retry.click();
    await page.getByRole('tab', {name: 'Overview', exact: true}).waitFor();
    assert.equal(requests, 2);
    assert.equal(await retry.count(), 0);
  } finally { await page.close(); }
});

test('analytics date picker supports keyboard selection and returns focus', async () => {
  const page = await analyticsPage(route => route.fulfill({json: {...empty(), date_range: {min: '2026-09-01', max: '2026-09-10'}}}));
  try {
    await page.locator('.analytics-cat').first().waitFor();
    const trigger = page.getByRole('button', {name: 'From date', exact: true});
    await trigger.click();
    const selected = page.getByRole('button', {name: '2026-09-01', exact: true});
    await selected.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), '2026-09-01');
    await selected.press('ArrowRight');
    await page.getByRole('button', {name: '2026-09-02', exact: true}).press('Enter');
    assert.equal(await page.locator('#date-from').inputValue(), '2026-09-02');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-datepicker')), 'date-from');
    assert.equal(await page.locator('.cal-popover').count(), 0);
  } finally { await page.close(); }
});

const week = () => ({...empty(), date_range: {min: '2026-09-04', max: '2026-09-10'},
  entries: Array.from({length: 7}, (_, i) => ({id: 'day-' + i, date: '2026-09-' + String(i + 4).padStart(2, '0'),
    body: 'A note', title: 'A day', created: '2026-09-' + String(i + 4).padStart(2, '0') + 'T20:00:00',
    mood: 3 + i % 4, tags: {}, numbers: {}}))});

test('recovered usage with missing events does not chart invented unlocks', async () => {
  const payload = {...empty(), date_range: {min: '2026-10-10', max: '2026-10-10'},
    entries: [{date: '2026-10-10', tags: {}, numbers: {}, usage: {
      screen_min: 130, unlocks: 0, details_available: false, recovered: true, top_apps: [],
    }}]};
  const page = await analyticsPage(route => route.fulfill({json: payload}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click();
    await page.getByRole('tab', {name: 'Phone usage', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-usage-stat-cards .stat-card-value').allTextContents(),
      ['2h 10m', '—', '1']);
    assert.match(await page.locator('#chart-usage-unlocks').innerText(), /No unlock data/);
  } finally { await page.close(); }
});

function sparseHistory(single = false) {
  const dates = single ? ['2026-09-01'] : ['2026-09-01', '2026-09-02', '2026-09-10'];
  return {...empty(), date_range: {min: dates[0], max: dates.at(-1)},
    sections: [{id: 'weight', name: 'Weight', type: 'numeric', color: '#e0a955', unit: 'kg'}],
    entries: dates.map((date, i) => ({id: 'date-' + i, date, body: 'A quiet day', tags: {}, numbers: {weight: 60 + i}, mood: 4 + i,
      sleep: {duration_min: 420 + i * 10, quality: 80 + i, start: date + 'T00:00:00+08:00', end: date + 'T07:00:00+08:00'},
      rescuetime: {pulse: 70 + i, productive_min: 60 + i, neutral_min: 0, distracting_min: 0, total_min: 60 + i,
        top_activities: [{name: 'Writing', min: 60 + i}]},
      music: {minutes: 60 + i, tracks: 10 + i},
      usage: {screen_min: 30 + i, unlocks: 20 + i, top_apps: [{name: 'Reader', package: 'qa.reader', minutes: 30 + i, min: 30 + i}]},
    }))};
}
const datedCharts = [
  ['Patterns', 'Consistency', 'word-count'], ['Health', 'Mood', 'mood-over-time'],
  ['Data', 'Numeric', 'numeric-line'], ['Data', 'Numeric', 'numeric-cumulative'],
  ['Health', 'Sleep', 'sleep-duration'], ['Health', 'Sleep', 'sleep-quality'], ['Health', 'Sleep', 'sleep-consistency'],
  ['Digital', 'Productivity', 'productivity-pulse'], ['Digital', 'Music', 'music-minutes'], ['Digital', 'Phone usage', 'usage-screen-time'],
  ['Digital', 'Productivity', 'productivity-activity-minutes'], ['Digital', 'Phone usage', 'usage-app-minutes'],
];
for (const [category, panel, chart] of datedCharts) test(`${chart} places sparse records on their actual calendar dates`, async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: category, exact: true}).click();
    await page.getByRole('tab', {name: panel, exact: true}).click();
    const ratios = await page.locator('#chart-' + chart + ' svg.chart-svg').first().evaluate(svg => [...svg.querySelectorAll('path[d]')].map(path => {
      const points = [...path.getAttribute('d').matchAll(/[ML]([\d.e+-]+) [\d.e+-]+/g)].map(match => Number(match[1]));
      return points.length === 3 ? (points[1] - points[0]) / (points[2] - points[0]) : null;
    }).filter(ratio => ratio !== null));
    assert.ok(ratios.length > 0);
    assert.ok(ratios.every(ratio => Math.abs(ratio - 1 / 9) < .00001), JSON.stringify(ratios));
  } finally { await page.close(); }
});

test('a single dated record has one centered date label and point', async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory(true)}));
  try {
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const svg = page.locator('#chart-mood-over-time svg.chart-svg');
    const geometry = await svg.evaluate(el => ({dates: [...el.querySelectorAll('text')].filter(t => t.textContent === '2026-09-01').map(t => Number(t.getAttribute('x'))), x: Number(el.querySelector('circle').getAttribute('cx'))}));
    assert.deepEqual(geometry.dates, [geometry.x]);
  } finally { await page.close(); }
});

test('read-only analytics calendars expose full dates and fill a narrow card', async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Patterns', exact: true}).click();
    await page.getByRole('tab', {name: 'Consistency', exact: true}).click();
    const calendar = page.locator('#chart-calendar-heatmap .analytics-cal');
    const widths = await calendar.evaluate(el => ({container: el.clientWidth, month: el.querySelector('.cal-month').getBoundingClientRect().width}));
    assert.ok(widths.month >= widths.container * .95, JSON.stringify(widths));
    assert.equal(await calendar.getByRole('img', {name: '2026-09-01 · entry', exact: true}).count(), 1);
    assert.equal(await calendar.getByRole('img', {name: '2026-09-03 · no entry', exact: true}).count(), 1);
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    const numeric = page.locator('#chart-numeric-calendar');
    assert.equal(await numeric.getByRole('img', {name: '2026-09-01 · 60', exact: true}).count(), 1);
    assert.equal(await numeric.getByRole('img', {name: '2026-09-03 · not recorded', exact: true}).count(), 1);
  } finally { await page.close(); }
});

test('consistency histograms label counts and preserve the recorded local creation hour', async () => {
  const data = sparseHistory();
  data.entries.forEach((entry, i) => { entry.created = entry.date + ['T09:30:00+08:00', 'T09:05:00-07:00', 'T22:00:00Z'][i]; });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Patterns', exact: true}).click();
    await page.getByRole('tab', {name: 'Consistency', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-entry-gaps rect title').allTextContents(), ['1 day · 1 gap', '8 days · 1 gap']);
    const hourTitles = await page.locator('#chart-time-of-day rect title').allTextContents();
    assert.equal(hourTitles.length, 24);
    assert.equal(hourTitles[9], '09:00 · 2 entries');
    assert.equal(hourTitles[22], '22:00 · 1 entry');
    assert.equal(hourTitles[1], '01:00 · 0 entries');
    assert.deepEqual(await page.locator('#chart-word-count circle title').allTextContents(), data.entries.map(e => e.date + ' · 3 words'));
  } finally { await page.close(); }
});

for (const [panel, chart] of [['Productivity', 'productivity-time-breakdown'], ['Phone usage', 'usage-unlocks']]) test(`${chart} retains unrecorded calendar days between bars`, async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click();
    await page.getByRole('tab', {name: panel, exact: true}).click();
    const geometry = await page.locator('#chart-' + chart + ' svg.chart-svg').evaluate(svg => [...svg.querySelectorAll('rect')].map(rect => ({x: Number(rect.getAttribute('x')), width: Number(rect.getAttribute('width')), title: rect.querySelector('title')?.textContent})));
    assert.equal(geometry.length, 3);
    assert.ok(Math.abs((geometry[1].x - geometry[0].x) / (geometry[2].x - geometry[0].x) - 1 / 9) < .00001);
    assert.ok(geometry[1].width < geometry[2].x - geometry[1].x);
    geometry.forEach((bar, i) => assert.ok(bar.title.startsWith(sparseHistory().entries[i].date)));
  } finally { await page.close(); }
});

test('task calendar legend uses the same completion color as its day markers', async () => {
  const data = sparseHistory();
  data.tasks.archive = [{id: 'done', title: 'Done', tags: [], completed: '2026-09-01T12:00:00'}];
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Tasks', exact: true}).click();
    const calendar = page.locator('#chart-task-entry-calendar');
    const marker = calendar.locator('.analytics-cal .cal-dot-alt');
    const legend = calendar.locator('.heat-legend .cal-dot-alt');
    assert.equal(await legend.count(), 1);
    assert.equal(await marker.first().evaluate(el => getComputedStyle(el).backgroundColor), await legend.evaluate(el => getComputedStyle(el).backgroundColor));
    assert.equal(await calendar.getByRole('img', {name: '2026-09-01 · entry · 1 task done', exact: true}).count(), 1);
  } finally { await page.close(); }
});

test('chart labels retain at least ten physical pixels at narrow width', async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    const failures = [];
    for (const [category, panel] of [['Patterns', 'Consistency'], ['Health', 'Mood'], ['Health', 'Sleep'], ['Data', 'Numeric'], ['Digital', 'Productivity'], ['Digital', 'Music'], ['Digital', 'Phone usage']]) {
      await page.getByRole('tab', {name: category, exact: true}).click();
      await page.getByRole('tab', {name: panel, exact: true}).click();
      failures.push(...await page.locator('.chart-svg text').evaluateAll(nodes => nodes.filter(node => node.textContent.trim()).map(node => ({text: node.textContent,
        size: parseFloat(getComputedStyle(node).fontSize) * node.ownerSVGElement.getBoundingClientRect().width / node.ownerSVGElement.viewBox.baseVal.width,
        chart: node.closest('.analytics-panel').id})).filter(item => item.size < 9.99)));
    }
    assert.deepEqual(failures, []);
  } finally { await page.close(); }
});

test('music analytics explain when imported history supplies a day’s totals', async () => {
  const data = sparseHistory(); data.entries[0].music.source = 'history_import';
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click();
    await page.getByRole('tab', {name: 'Music', exact: true}).click();
    const summary = page.locator('#chart-music-stat-cards');
    await summary.getByText('Imported days use history totals. Live sync stays saved separately.', {exact: true}).waitFor();
    assert.match(await summary.innerText(), /1 imported/);
  } finally { await page.close(); }
});

test('analytics remain within320px at200percent text size', async () => {
  const data=sparseHistory(); data.tasks.archive=[{id:'done',title:'Done',tags:[],completed:'2026-09-01T12:00:00'}];
  const page=await analyticsPage(route=>route.fulfill({json:data}));
  try {
    await page.setViewportSize({width:320,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='32px');
    const failures=[];
    for(const [category,panel] of [['Overview',null],['Health','Mood'],['Health','Sleep'],['Data','Numeric'],['Data','Tags'],['Digital','Productivity'],['Digital','Music'],['Digital','Phone usage'],['Tasks','Throughput'],['Patterns','Consistency']]) {
      await page.getByRole('tab',{name:category,exact:true}).click();if(panel)await page.getByRole('tab',{name:panel,exact:true}).click();
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);if(overflow>1)failures.push({panel:panel||category,overflow});
    }
    assert.deepEqual(failures,[]);
  }finally{await page.close();}
});

test('music audio-feature labels and raw values remain readable without overlap', async () => {
  const data=sparseHistory();data.entries.forEach(entry=>Object.assign(entry.music,{valence:.4,energy:.5,danceability:.6,tempo:110}));
  const page=await analyticsPage(route=>route.fulfill({json:data}));
  try {
    await page.setViewportSize({width:320,height:900});await page.getByRole('tab',{name:'Digital',exact:true}).click();await page.getByRole('tab',{name:'Music',exact:true}).click();
    const ranks=page.locator('#chart-music-audio-features .chart-ranks');
    assert.deepEqual(await ranks.locator('.chart-rank-label').allTextContents(),['Valence','Energy','Danceability','Tempo']);
    assert.deepEqual(await ranks.locator('.chart-rank-value').allTextContents(),['0.4','0.5','0.6','110 bpm']);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await page.close();}
});

test('comparison tables scroll inside their cards with keyboard access and row headers', async () => {
  const data = sparseHistory();
  data.sections.push(...Array.from({length: 4}, (_, i) => ({id: 'measure-' + i, name: 'Daily measurement ' + i, type: 'numeric', color: '#e0a955'})));
  data.sections.push({id: 'people', name: 'People', type: 'tag', color: '#e0a955'});
  data.entries.forEach((entry, i) => {
    data.sections.filter(section => section.type === 'numeric').forEach(section => { entry.numbers[section.id] = 10 + i; });
    entry.tags.people = ['Alex from school', 'Long neighborhood walk', 'An afternoon together'];
  });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.setViewportSize({width: 320, height: 900});
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    for (const [panel, name] of [['Numeric', 'Numeric correlations'], ['Tags', 'People co-occurrence']]) {
      await page.getByRole('tab', {name: panel, exact: true}).click();
      const matrix = page.getByRole('region', {name: name + '; scroll for more columns', exact: true});
      await matrix.waitFor();
      assert.equal(await matrix.getAttribute('tabindex'), '0');
      assert.ok(await matrix.locator('th[scope="row"]').count());
      assert.ok(await matrix.locator('th[scope="col"]').count());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await matrix.evaluate(el => el.scrollWidth > el.clientWidth), true, panel + ' retains readable column widths');
      await matrix.focus(); await matrix.press('ArrowRight');
      await page.waitForFunction(label => document.querySelector('[aria-label="' + label + '"]').scrollLeft > 0, name + '; scroll for more columns');
    }
  } finally { await page.close(); }
});

test('switching tabs after resize cancels a redundant redraw of the fresh chart',async()=>{
  const page=await analyticsPage(route=>route.fulfill({json:sparseHistory()}));
  try{
    await page.getByRole('tab',{name:'Data',exact:true}).click();
    await page.clock.install();
    await page.setViewportSize({width:320,height:900});
    await page.getByRole('tab',{name:'Numeric',exact:true}).click();
    await page.locator('#chart-numeric-line').evaluate(el=>el.dataset.fresh='yes');
    await page.clock.runFor(250);
    assert.equal(await page.locator('#chart-numeric-line').getAttribute('data-fresh'),'yes');
  }finally{await page.close();}
});

for (const key of ['imported_plays', 'history', 'streaming_history', 'plays']) test(`music ${key} records retain listening totals and import coverage`, async () => {
  const plays = [60000, 120000].map(ms => ({ms_played: ms, spotify_track_uri: 'spotify:track:qa',
    master_metadata_track_name: 'Slow Light', master_metadata_album_artist_name: 'Juno', master_metadata_album_album_name: 'Sky'}));
  const data = sparseHistory(true);
  data.entries[0].music = {minutes: 0, tracks: 0, distinct: 0, [key]: key === 'plays' ? {first: plays[0], second: plays[1]} : plays};
  if (key === 'plays') data.entries[0].music.source = 'History IMPORT';
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click();
    await page.getByRole('tab', {name: 'Music', exact: true}).click();
    const summary = page.locator('#chart-music-stat-cards');
    assert.deepEqual(await summary.locator('.stat-card-value').allTextContents(), ['3m', '3 min', '2', '1']);
    assert.match(await summary.innerText(), /1 distinct/);
    assert.match(await summary.innerText(), /1 imported/);
    assert.deepEqual(await page.locator('#chart-music-top-tracks .chart-rank-label').allTextContents(), ['Slow Light · Juno']);
    assert.deepEqual(await page.locator('#chart-music-top-tracks .chart-rank-value').allTextContents(), ['2']);
    assert.deepEqual(await page.locator('#chart-music-top-albums .chart-rank-label').allTextContents(), ['Sky · Juno']);
  } finally { await page.close(); }
});

test('music rankings use saved aggregate counts once and distinguish artists', async () => {
  const data = sparseHistory(true);
  data.entries[0].music = {minutes: 30, tracks: 8,
    top_tracks: [{name: 'Slow Light', artists: ['Juno'], count: 5}, {name: 'Slow Light', artists: ['Mira'], count: 3}],
    top_albums: [{name: 'Sky', artists: ['Juno'], count: 5}],
    plays: [{name: 'Slow Light', album: 'Sky', artists: ['Juno'], duration_ms: 180000}]};
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-music-top-tracks .chart-rank-label').allTextContents(), ['Slow Light · Juno', 'Slow Light · Mira']);
    assert.deepEqual(await page.locator('#chart-music-top-tracks .chart-rank-value').allTextContents(), ['5', '3']);
    assert.deepEqual(await page.locator('#chart-music-top-albums .chart-rank-label').allTextContents(), ['Sky · Juno']);
    assert.deepEqual(await page.locator('#chart-music-top-albums .chart-rank-value').allTextContents(), ['5']);
  } finally { await page.close(); }
});

test('Spotify taste failures offer retry without pretending the profile is empty', async () => {
  let attempts = 0;
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  await page.route('**/integrations/spotify/taste', route => ++attempts === 1
    ? route.fulfill({status: 503, json: {error: 'Unavailable'}})
    : route.fulfill({json: {short_term: {artists: [{name: 'Juno'}]}}}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    const taste = page.locator('#chart-music-taste');
    await taste.getByText('Could not load your Spotify taste.', {exact: true}).waitFor();
    assert.equal(await taste.getByText(/No taste data yet/).count(), 0);
    await taste.getByRole('button', {name: 'Retry', exact: true}).click();
    await taste.getByText('Juno', {exact: true}).waitFor();
    assert.equal(attempts, 2);
    assert.equal(await taste.getByRole('button', {name: 'Retry', exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('Spotify taste reuses an in-flight load when tabs change', async () => {
  let release, requested; const request = new Promise(resolve => { requested = resolve; });
  let attempts = 0;
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  await page.route('**/integrations/spotify/taste', async route => {
    attempts++; requested(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({json: {short_term: {artists: [{name: 'Juno'}]}}});
  });
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    await request; await page.getByRole('tab', {name: 'Phone usage', exact: true}).click();
    await page.getByRole('tab', {name: 'Music', exact: true}).click();
    assert.equal(attempts, 1); release();
    await page.locator('#chart-music-taste').getByText('Juno', {exact: true}).waitFor();
    assert.equal(attempts, 1);
  } finally { release?.(); await page.close(); }
});

test('returning to Music refreshes synced taste while retaining the prior profile on failure', async () => {
  let artist = 'Juno', fail = false, reads = 0;
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  await page.route('**/integrations/spotify/taste', route => { reads++; return fail
    ? route.fulfill({status: 503, json: {error: 'Unavailable'}})
    : route.fulfill({json: {short_term: {artists: [{name: artist}]}}}); });
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    const taste = page.locator('#chart-music-taste'); await taste.getByText('Juno', {exact: true}).waitFor();
    await page.clock.install({time: new Date(Date.now() + 20000)}); fail = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await taste.getByText('Could not load your Spotify taste.', {exact: true}).waitFor();
    assert.equal(await taste.getByText('Juno', {exact: true}).count(), 1);
    fail = false; artist = 'Mira'; await taste.getByRole('button', {name: 'Retry', exact: true}).click();
    await taste.getByText('Mira', {exact: true}).waitFor();
    assert.equal(await taste.getByText('Juno', {exact: true}).count(), 0); assert.equal(reads, 3);
  } finally { await page.close(); }
});

test('an older taste response cannot replace a newer synced profile or its cache', async () => {
  let release, started, reads = 0; const pending = new Promise(resolve => { started = resolve; });
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  await page.route('**/integrations/spotify/taste', async route => {
    if (++reads === 1) { started(); await new Promise(resolve => { release = resolve; }); return route.fulfill({json: {short_term: {artists: [{name: 'Old profile'}]}}}); }
    return route.fulfill({json: {short_term: {artists: [{name: 'New profile'}]}}});
  });
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click(); await pending;
    await page.clock.install({time: new Date(Date.now() + 20000)});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const taste = page.locator('#chart-music-taste'); await taste.getByText('New profile', {exact: true}).waitFor();
    release(); await page.waitForTimeout(100);
    assert.equal(await taste.getByText('Old profile', {exact: true}).count(), 0);
    await page.getByRole('tab', {name: 'Phone usage', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    await taste.getByText('New profile', {exact: true}).waitFor(); assert.equal(reads, 2);
  } finally { release?.(); await page.close(); }
});

test('available energy and tempo remain visible when valence is missing', async () => {
  const data = sparseHistory(true); Object.assign(data.entries[0].music, {energy: .7, tempo: 120, valence: null});
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-music-audio-features .chart-rank-label').allTextContents(), ['Energy', 'Tempo']);
    assert.deepEqual(await page.locator('#chart-music-audio-features .chart-rank-value').allTextContents(), ['0.7', '120 bpm']);
    assert.equal(await page.getByText('Audio features unavailable for this Spotify app.', {exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('valid tag and artist names that match JavaScript properties retain their counts', async () => {
  const names = ['__proto__', 'constructor', 'toString'];
  const data = sparseHistory(true);
  data.sections.push({id: 'topics', name: 'Topics', type: 'tag', color: '#e0a955', tags: names});
  data.entries[0].tags.topics = names;
  data.entries[0].music.top_artists = names.map(name => ({name, count: 2}));
  data.tasks.archive = [{id: 'done', title: 'Done', tags: names, completed: '2026-09-01T12:00:00'}];
  const page = await analyticsPage(route => route.fulfill({json: data}));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click(); await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-tag-frequency .chart-rank-label').allTextContents(), names);
    assert.deepEqual(await page.locator('#chart-tag-frequency .chart-rank-value').allTextContents(), ['1', '1', '1']);
    assert.equal(await page.evaluate(() => Object.prototype.constructor === Object), true);
    const search = page.getByRole('combobox', {name: 'tag', exact: true}); await search.fill('constructor');
    assert.equal(await page.getByRole('option').filter({hasText: 'constructor'}).count(), 1);
    await page.getByRole('tab', {name: 'Digital', exact: true}).click(); await page.getByRole('tab', {name: 'Music', exact: true}).click();
    assert.deepEqual(await page.locator('#chart-music-top-artists .chart-rank-label').allTextContents(), names);
    assert.deepEqual(await page.locator('#chart-music-top-artists .chart-rank-value').allTextContents(), ['2', '2', '2']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('scatter charts label their horizontal values and center a constant measurement', async () => {
  const data = sparseHistory();
  data.sections.push({id: 'water', name: 'Water', type: 'numeric', color: '#e0a955', unit: 'cups'});
  data.entries.forEach(entry => {
    entry.numbers = {weight: 60, water: 2}; entry.sleep.duration_min = 420; entry.rescuetime.pulse = 70;
    entry.music = {minutes: 60, tracks: 10, valence: .4}; entry.usage.screen_min = 30;
  });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    const failures = [];
    for (const [category, panel, chart, value] of [['Data', 'Numeric', 'numeric-scatter', '60'], ['Health', 'Mood', 'mood-numeric-scatter', '60'],
      ['Health', 'Sleep', 'sleep-mood-scatter', '7'], ['Digital', 'Productivity', 'productivity-mood-scatter', '70'],
      ['Digital', 'Music', 'music-minutes-mood-scatter', '60'], ['Digital', 'Music', 'music-tracks-mood-scatter', '10'],
      ['Digital', 'Music', 'music-audio-features', '0.4'], ['Digital', 'Phone usage', 'usage-mood-scatter', '30']]) {
      await page.getByRole('tab', {name: category, exact: true}).click(); await page.getByRole('tab', {name: panel, exact: true}).click();
      const geometry = await page.locator('#chart-' + chart + ' svg.chart-svg').first().evaluate(svg => ({
        center: (36 + svg.viewBox.baseVal.width - 10) / 2,
        points: [...svg.querySelectorAll('circle')].map(point => Number(point.getAttribute('cx'))),
        labels: [...svg.querySelectorAll('text[y="216"]')].map(label => ({text: label.textContent, x: Number(label.getAttribute('x'))})),
      }));
      if (!geometry.points.every(x => Math.abs(x - geometry.center) < .01) || geometry.labels.length !== 1 || geometry.labels[0]?.text !== value || geometry.labels[0]?.x !== geometry.center) failures.push({chart, value, geometry});
    }
    assert.deepEqual(failures, []);
  } finally { await page.close(); }
});

test('dense activity grids keep readable labels and cells with dates while scrolling', async () => {
  const data = week();
  data.sections = [{id: 'health', name: 'Health and daily movement', type: 'tag', color: '#e0a955'}];
  data.entries = Array.from({length: 90}, (_, i) => ({...data.entries[0], id: 'day-' + i,
    date: new Date(Date.UTC(2026, 5, 13 + i)).toISOString().slice(0, 10),
    tags: {health: i % 2 ? ['long walk around the neighborhood'] : []}}));
  data.date_range = {min: data.entries[0].date, max: data.entries.at(-1).date};
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const matrix = page.locator('#chart-tag-heatmap .chart-matrix');
    await matrix.waitFor();
    const measure = await matrix.evaluate(el => {
      const label = el.querySelector('.chart-matrix-label');
      const cell = el.querySelector('rect');
      const before = label.getBoundingClientRect().left;
      el.scrollLeft = 500;
      return {overflow: el.scrollWidth > el.clientWidth, before, after: label.getBoundingClientRect().left,
        font: parseFloat(getComputedStyle(label).fontSize), cell: cell.getBoundingClientRect().width,
        tooltip: cell.querySelector('title').textContent,
        dateLabels: [...el.querySelectorAll('text')].map(node => node.textContent),
        pageOverflow: document.documentElement.scrollWidth > innerWidth};
    });
    assert.equal(measure.overflow, true);
    assert.equal(measure.pageOverflow, false);
    assert.equal(measure.before, measure.after);
    assert.ok(measure.font >= 12 && measure.cell >= 14, JSON.stringify(measure));
    assert.match(measure.tooltip, /2026-06-13.*long walk around the neighborhood.*not logged/);
    assert.ok(measure.dateLabels.includes('06-13'));
    await matrix.focus();
    assert.equal(await matrix.getAttribute('role'), 'region');
    await page.getByRole('tab', {name: 'Patterns', exact: true}).click();
    await page.getByRole('tab', {name: 'Coverage', exact: true}).click();
    assert.equal(await page.locator('#chart-section-coverage .chart-matrix rect').count(), 90);
    assert.match(await page.locator('#chart-section-coverage .chart-matrix-label').last().innerText(), /Health and daily movement/);
  } finally { await page.close(); }
});

test('resizing redraws chart geometry without losing an unfinished tag search', async () => {
  const page = await analyticsPage(route => route.fulfill({json: week()}));
  try {
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const before = await page.locator('#chart-mood-over-time svg.chart-svg').getAttribute('viewBox');
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForFunction(previous => document.querySelector('#chart-mood-over-time svg.chart-svg')?.getAttribute('viewBox') !== previous, before);
    const scale = await page.locator('#chart-mood-over-time svg.chart-svg').evaluate(svg => svg.getBoundingClientRect().width / svg.viewBox.baseVal.width);
    assert.ok(scale >= .99, scale);
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.fill('unfinished query');
    await input.evaluate(el => el.setSelectionRange(3, 7));
    await page.setViewportSize({width: 1024, height: 768});
    await page.waitForTimeout(250);
    assert.equal(await input.inputValue(), 'unfinished query');
    assert.deepEqual(await input.evaluate(el => ({focused: el === document.activeElement,
      start: el.selectionStart, end: el.selectionEnd})), {focused: true, start: 3, end: 7});
    assert.equal(new URL(page.url()).hash, '#tab=tags');
  } finally { await page.close(); }
});

test('leading indicator rows wrap clearly and keep keyboard focus when selected', async () => {
  const data = week();
  data.sections = [{id: 'minutes', name: 'Minutes spent walking outdoors', type: 'numeric', color: '#e0a955', unit: 'min'}];
  data.entries.forEach((entry, i) => { entry.numbers.minutes = 20 + i; });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Patterns', exact: true}).click();
    const row = page.locator('.lead-row').filter({hasText: 'Minutes spent walking outdoors'}).first();
    await row.waitFor();
    const layout = await row.evaluate(el => {
      const name = el.querySelector('.driver-name').getBoundingClientRect();
      const effect = el.querySelector('.driver-effect').getBoundingClientRect();
      return {nameWidth: name.width, rowWidth: el.clientWidth, nameBottom: name.bottom, effectTop: effect.top};
    });
    assert.ok(layout.nameWidth > layout.rowWidth * .8 && layout.effectTop >= layout.nameBottom, JSON.stringify(layout));
    await row.press('Enter');
    assert.equal(await row.getAttribute('aria-pressed'), 'true');
    assert.equal(await row.evaluate(el => el === document.activeElement), true);
    const outside = await page.locator('.analytics-panel svg.chart-svg text').evaluateAll(nodes => nodes.filter(node => {
      const box = node.getBoundingClientRect(), panel = node.ownerSVGElement.getBoundingClientRect();
      return box.left < panel.left || box.right > panel.right;
    }).map(node => node.textContent));
    assert.deepEqual(outside, []);
    const lag = page.locator('input[name="lead-lag"][value="1"]');
    await lag.focus(); await lag.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.value), '2');
    assert.equal(await page.locator('input[name="lead-lag"][value="2"]').isChecked(), true);
    assert.match(await page.locator('.driver-effect').first().innerText(), /mood 2 days later/);
  } finally { await page.close(); }
});

test('overview labels the most recent historical run as the latest streak', async () => {
  const page = await analyticsPage(route => route.fulfill({json: sparseHistory()}));
  try {
    await page.getByRole('tab', {name: 'Overview', exact: true}).waitFor();
    const streak = page.locator('#chart-overview-summary .stat-card').filter({has: page.getByText('latest streak', {exact: true})});
    await streak.waitFor();
    assert.equal(await streak.locator('.stat-card-value').innerText(), '1d');
    assert.equal(await page.getByText('current streak', {exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('chart endpoint labels stay inside the SVG and weekday labels line up with bars', async () => {
  const page = await analyticsPage(route => route.fulfill({json: week()}));
  try {
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const ends = await page.locator('#chart-mood-over-time svg text').evaluateAll(nodes => nodes
      .filter(node => /^\d{4}-\d{2}-\d{2}$/.test(node.textContent))
      .map(node => ({text: node.textContent, x: node.getBBox().x,
        right: node.getBBox().x + node.getBBox().width, width: node.ownerSVGElement.viewBox.baseVal.width})));
    assert.equal(ends.length, 2);
    assert.ok(ends.every(label => label.x >= 0 && label.right <= label.width), JSON.stringify(ends));
    const alignment = await page.locator('#chart-mood-dow svg.chart-svg').evaluate(svg => {
      const bars = [...svg.querySelectorAll('rect')];
      const labels = [...svg.querySelectorAll('text')].filter(node => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(node.textContent));
      return labels.map((label, i) => ({label: label.textContent,
        labelCenter: Number(label.getAttribute('x')),
        barCenter: Number(bars[i].getAttribute('x')) + Number(bars[i].getAttribute('width')) / 2}));
    });
    assert.equal(alignment.length, 7);
    assert.ok(alignment.every(pair => Math.abs(pair.labelCenter - pair.barCenter) < 1), JSON.stringify(alignment));
  } finally { await page.close(); }
});

test('numeric section filters preserve keyboard focus and announce their selection', async () => {
  const data = {...empty(), sections: ['water', 'weight'].map(id => ({id, name: id, type: 'numeric', color: '#e0a955', unit: ''}))};
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    const water = page.locator('.section-filter').getByRole('button', {name: 'water', exact: true});
    await water.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'water');
    assert.equal(await water.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.section-filter').getByRole('button', {name: 'weight', exact: true}).getAttribute('aria-pressed'), 'false');
    await page.locator('.section-filter').getByRole('button', {name: 'All', exact: true}).press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'All');
    assert.equal(await water.getAttribute('aria-pressed'), 'true');
  } finally { await page.close(); }
});

test('tag search exposes keyboard suggestions and ArrowUp starts on the last option', async () => {
  const data = empty(); data.tasks.tags = {alpha: '#e0a955', beta: '#e0a955', gamma: '#e0a955'};
  const page = await analyticsPage(route => route.fulfill({json: data}), route => route.fulfill({json: {journal: {}, task: {}}}));
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.focus();
    assert.equal(await input.getAttribute('role'), 'combobox');
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    await input.press('ArrowUp');
    assert.equal((await page.getByRole('option', {selected: true}).innerText()).replace(/\s+/g, ' '), '☑ gamma');
    assert.equal(await input.getAttribute('aria-activedescendant'), await page.getByRole('option', {selected: true}).getAttribute('id'));
    await input.press('Escape');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    assert.equal(await input.getAttribute('aria-activedescendant'), null);
  } finally { await page.close(); }
});

for (const composing of [{isComposing:true}, {keyCode:229}]) test(`tag search preserves Chinese IME keys (${Object.keys(composing)[0]}) and round-trips its URL`, async () => {
  const data = empty(), requests = [], name = '家人 臺灣';
  data.tasks.tags = {[name]:'#e0a955','𠀀家':'#e0a955'};
  const page = await analyticsPage(route => route.fulfill({json:data}), route => {
    requests.push(route.request().url());
    return route.fulfill({json:{journal:{},task:{}}});
  });
  try {
    await page.getByRole('tab',{name:'Data',exact:true}).click();
    await page.getByRole('tab',{name:'Tags',exact:true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.fill('家');
    const initialHash = new URL(page.url()).hash;
    for (const key of ['ArrowDown','ArrowUp','Enter','Escape']) {
      const prevented = await input.evaluate((el,options) => {
        const event = new KeyboardEvent('keydown',{...options,bubbles:true,cancelable:true});
        el.dispatchEvent(event); return event.defaultPrevented;
      },{...composing,key});
      assert.equal(prevented,false,key);
      assert.equal(await input.inputValue(),'家');
      assert.equal(await input.getAttribute('aria-expanded'),'true');
      assert.equal(await input.getAttribute('aria-activedescendant'),null);
      assert.equal(new URL(page.url()).hash,initialHash);
      assert.equal(requests.length,0);
    }
    await input.press('ArrowDown'); await input.press('Enter');
    await page.getByText('No journal entries carry this tag in range.').waitFor();
    assert.equal(await input.inputValue(),name);
    assert.equal(new URL(requests[0]).pathname,'/tag/'+encodeURIComponent(name)+'/overview');
    assert.equal(new URL(page.url()).hash,'#tag='+encodeURIComponent(name));
    await page.reload();
    await page.getByText('No journal entries carry this tag in range.').waitFor();
    assert.equal(await page.getByPlaceholder('search a tag…').inputValue(),name);
    assert.equal(requests.length,2);
    assert.equal(requests[1],requests[0]);
  } finally { await page.close(); }
});

test('a stale failed tag lookup cannot replace the newer result', async () => {
  let rejectOld, oldStarted;
  const oldRequest = new Promise(resolve => { oldStarted = resolve; });
  const page = await analyticsPage(undefined, async route => {
    if (route.request().url().includes('/tag/alpha/')) {
      oldStarted();
      await new Promise(resolve => { rejectOld = resolve; });
      return route.fulfill({status: 503, body: 'Unavailable'});
    }
    return route.fulfill({json: {journal: {entries: 0}, task: {active: 0, completed: 0, expired: 0}}});
  });
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.fill('alpha'); await input.press('Enter'); await oldRequest;
    await input.fill('beta'); await input.press('Enter');
    await page.getByText('No journal entries carry this tag in range.').waitFor();
    const oldDone = page.waitForResponse(response => response.url().includes('/tag/alpha/'));
    rejectOld(); await oldDone;
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByText('Could not load this tag.', {exact: true}).count(), 0);
    assert.equal(await page.getByText('No journal entries carry this tag in range.').count(), 1);
  } finally { rejectOld?.(); await page.close(); }
});

test('failed tag lookups offer a retry without losing the query', async () => {
  let attempts = 0;
  const page = await analyticsPage(undefined, route => ++attempts === 1
    ? route.fulfill({status: 503, json: {error: 'Unavailable'}})
    : route.fulfill({json: {journal: {}, task: {}}}));
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.fill('work'); await input.press('Enter');
    const retry = page.getByRole('button', {name: 'Retry', exact: true});
    await retry.click();
    await page.getByText('No journal entries carry this tag in range.').waitFor();
    assert.equal(await input.inputValue(), 'work');
    assert.equal(attempts, 2);
  } finally { await page.close(); }
});

test('five summary cards share a row on desktop and fit a narrow viewport', async () => {
  const data = week();
  data.sections = [{id: 'water', name: 'water', type: 'numeric', color: '#e0a955', unit: 'cups'}];
  data.entries.forEach((entry, i) => { entry.numbers.water = 4 + i % 4; });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    const cards = page.locator('#chart-numeric-stat-cards .stat-card');
    const rows = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows).size, 1);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await cards.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth)), true);
  } finally { await page.close(); }
});

test('chart collapse controls identify their chart and preserve collapse state across tabs', async () => {
  const page = await analyticsPage(route => route.fulfill({json: week()}));
  try {
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const toggle = page.getByRole('button', {name: 'Collapse Mood over time', exact: true});
    await toggle.press('Enter');
    const expand = page.getByRole('button', {name: 'Expand Mood over time', exact: true});
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    const target = await expand.getAttribute('aria-controls');
    assert.equal(await page.locator('#' + target).isVisible(), false);
    const size = await expand.boundingBox();
    assert.ok(size.width >= 32 && size.height >= 32, JSON.stringify(size));
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    await expand.press('Enter');
    assert.equal(await page.locator('#' + target).isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  } finally { await page.close(); }
});

test('narrow charts keep labels readable and within the panel', async () => {
  const page = await analyticsPage(route => route.fulfill({json: week()}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    const labels = await page.locator('#chart-mood-over-time svg text').evaluateAll(nodes => nodes.map(node => {
      const svg = node.ownerSVGElement, scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      return {text: node.textContent, size: parseFloat(getComputedStyle(node).fontSize) * scale,
        x: node.getBBox().x, right: node.getBBox().x + node.getBBox().width, width: svg.viewBox.baseVal.width};
    }));
    assert.ok(labels.length >= 4);
    assert.ok(labels.every(label => label.size >= 9), JSON.stringify(labels));
    assert.ok(labels.every(label => label.x >= 0 && label.right <= label.width), JSON.stringify(labels));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('live refresh expands the full date range but preserves an explicit range', async () => {
  let end = '2026-09-10';
  const page = await analyticsPage(route => route.fulfill({json: {...empty(), date_range: {min: '2026-09-01', max: end}}}));
  try {
    await page.getByRole('tab', {name: 'Overview', exact: true}).waitFor();
    await page.clock.install({time: new Date(Date.now() + 20000)});
    end = '2026-09-11';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.getElementById('date-to').value === '2026-09-11');
    await page.getByRole('button', {name: 'To date', exact: true}).click();
    await page.getByRole('button', {name: '2026-09-05', exact: true}).click();
    end = '2026-09-12';
    await page.clock.fastForward(11000);
    const response = page.waitForResponse(r => r.url().endsWith('/data'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response;
    assert.equal(await page.locator('#date-to').inputValue(), '2026-09-05');
    await page.getByRole('button', {name: 'reset', exact: true}).click();
    assert.equal(await page.locator('#date-to').inputValue(), '2026-09-12');
  } finally { await page.close(); }
});

for (const panel of ['places','photos']) for (const changed of [false,true]) test(`${panel} refreshes independent metadata while preserving its view with ${changed?'new':'unchanged'} journal data`, async () => {
  const data=week(); const page=await analyticsPage(route=>route.fulfill({json:data}));
  try {
    await page.locator('.analytics-cat').first().waitFor();
    await page.evaluate(panel=>{
      const key=panel==='places'?'_refreshLocations':'_refreshPhotos';
      window.__ANALYTICS_CHARTS__.push({id:panel==='places'?'place-timeline':'photo-gallery',panel,title:'QA retained view',render:host=>{
        host.textContent='Current view';host.dataset.kept='yes';host.dataset.refreshes='0';
        host[key]=()=>host.dataset.refreshes=String(Number(host.dataset.refreshes)+1);
      }});
      document.dispatchEvent(new Event('analytics:charts-ready'));
    },panel);
    await page.getByRole('tab',{name:'Memories',exact:true}).click();
    await page.getByRole('tab',{name:panel==='places'?'Places':'Photos',exact:true}).click();
    const host=page.locator('#chart-body-'+(panel==='places'?'place-timeline':'photo-gallery'));
    await host.evaluate(el=>el.dataset.kept='original');
    if(changed)data.entries[0].body='Updated journal text';
    await page.clock.install({time:new Date(Date.now()+20000)});
    const response=page.waitForResponse('https://datapom.test/data');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await response;
    await page.waitForFunction(id=>document.getElementById(id)?.dataset.refreshes==='1','chart-body-'+(panel==='places'?'place-timeline':'photo-gallery'));
    assert.equal(await host.getAttribute('data-kept'),'original');
  }finally{await page.close();}
});

for (const changed of [false, true]) test(`returning to analytics preserves an unfinished tag query with ${changed ? 'new' : 'unchanged'} data`, async () => {
  let data = sparseHistory(), reads = 0;
  const page = await analyticsPage(route => { reads++; return route.fulfill({json: data}); });
  try {
    await page.getByRole('tab', {name: 'Data', exact: true}).click(); await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const query = page.getByRole('combobox', {name: 'tag', exact: true});
    await query.fill('unfinished query'); await query.evaluate(el => { el.setSelectionRange(2, 8); el.dataset.retained = 'yes'; });
    if (changed) { data = structuredClone(data); data.entries.push({...data.entries[0], date: '2026-09-12'}); data.date_range.max = '2026-09-12'; }
    await page.clock.install({time: new Date(Date.now() + 20000)});
    const response = page.waitForResponse(res => res.url().endsWith('/data'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await response;
    if (changed) await page.waitForFunction(() => document.getElementById('date-to').value === '2026-09-12');
    else await page.waitForTimeout(100);
    assert.equal(reads, 2);
    assert.equal(await query.inputValue(), 'unfinished query');
    assert.deepEqual(await query.evaluate(el => ({focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd})), {focused: true, start: 2, end: 8});
    if (!changed) assert.equal(await query.getAttribute('data-retained'), 'yes');
  } finally { await page.close(); }
});

test('choosing a date beyond the opposite bound keeps a valid range', async () => {
  const page = await analyticsPage(route => route.fulfill({json: {...empty(), date_range: {min: '2026-09-01', max: '2026-09-10'}}}));
  try {
    await page.getByRole('tab', {name: 'Overview', exact: true}).waitFor();
    await page.getByRole('button', {name: 'From date', exact: true}).click();
    await page.getByRole('button', {name: '2026-09-15', exact: true}).click();
    assert.equal(await page.locator('#date-from').inputValue(), '2026-09-15');
    assert.equal(await page.locator('#date-to').inputValue(), '2026-09-15');
    await page.getByRole('button', {name: 'To date', exact: true}).click();
    await page.getByRole('button', {name: '2026-09-05', exact: true}).click();
    assert.equal(await page.locator('#date-from').inputValue(), '2026-09-05');
    assert.equal(await page.locator('#date-to').inputValue(), '2026-09-05');
  } finally { await page.close(); }
});

test('ranking charts keep long labels and totals readable on narrow screens', async () => {
  const data = week(), appName = 'A very long application name for reading and writing';
  data.entries[0].usage = {screen_min: 320, unlocks: 45, top_apps: [
    {name: 'long.app', label: appName, min: 300, opens: 12345}, {name:'short.app',label:'Notes',min:20,opens:10},
  ]};
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Digital', exact: true}).click();
    await page.getByRole('tab', {name: 'Phone usage', exact: true}).click();
    const chart = page.locator('#chart-usage-top-apps');
    const name = chart.getByText(appName, {exact: true});
    const metrics = await name.evaluate(el => {
      const svg = el.ownerSVGElement, box = el.getBoundingClientRect(), panel = el.closest('.analytics-panel').getBoundingClientRect();
      return {size: parseFloat(getComputedStyle(el).fontSize) * (svg ? svg.getBoundingClientRect().width / svg.viewBox.baseVal.width : 1),
        left: box.left, right: box.right, panelLeft: panel.left, panelRight: panel.right};
    });
    assert.ok(metrics.size >= 12, JSON.stringify(metrics));
    assert.ok(metrics.left >= metrics.panelLeft && metrics.right <= metrics.panelRight, JSON.stringify(metrics));
    assert.match(await chart.innerText(), /5h 0m.*12345 opens/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('tag, numeric, productivity and music rankings share readable labels and preserve totals', async () => {
  const data = week();
  data.sections = [
    {id:'water',name:'Water intake',type:'numeric',color:'#e0a955',unit:'cups'},
    {id:'work',name:'work',type:'tag',color:'#e0a955',tags:['careful writing']},
  ];
  data.entries[0].numbers.water = 2; data.entries[0].tags.work = ['careful writing'];
  data.entries[0].rescuetime = {pulse:70,total_min:90,productive_min:90,top_categories:[{name:'Writing and research',min:90}],
    top_activities:[{name:'A writing app with a long name',min:90,category:'Writing and research',productivity:2}]};
  data.entries[0].music = {tracks:3,minutes:90,top_artists:[{name:'An artist with a long name',count:3}]};
  const page = await analyticsPage(route => route.fulfill({json:data}));
  async function readable(chartId, label, total) {
    const chart = page.locator('#chart-' + chartId), node = chart.getByText(label,{exact:true}).first();
    const size = await node.evaluate(el => parseFloat(getComputedStyle(el).fontSize) * (el.ownerSVGElement
      ? el.ownerSVGElement.getBoundingClientRect().width / el.ownerSVGElement.viewBox.baseVal.width : 1));
    assert.ok(size>=12, chartId+': '+size);
    assert.ok((await chart.innerText()).includes(total), await chart.innerText());
  }
  try {
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('tab',{name:'Data',exact:true}).click();
    await readable('numeric-coverage','Water intake','14% (1/7)');
    await page.getByRole('tab',{name:'Tags',exact:true}).click();
    await readable('tag-frequency','careful writing','1');
    await page.getByRole('tab',{name:'Digital',exact:true}).click();
    await readable('productivity-categories','Writing and research','1h 30m');
    await readable('productivity-top-activities','A writing app with a long name','1h 30m');
    await page.getByRole('tab',{name:'Music',exact:true}).click();
    await readable('music-top-artists','An artist with a long name','3');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {await page.close();}
});

test('task throughput shows calendar gaps and averages across the full selected range', async () => {
  const data = week();
  data.tasks.archive = ['2026-09-04','2026-09-10'].map((date,i) => ({id:String(i),title:'Done',completed:date+'T12:00:00',tags:[]}));
  const page = await analyticsPage(route => route.fulfill({json:data}));
  try {
    await page.getByRole('tab',{name:'Tasks',exact:true}).click();
    const panel = page.locator('#chart-task-throughput');
    const mean = panel.locator('.stat').filter({has:page.getByText('mean/day:',{exact:true})});
    assert.equal(await mean.locator('.stat-value').innerText(),'0.29');
    const labels=await panel.locator('svg text').allTextContents();
    assert.ok(labels.includes('2026-09-04') && labels.includes('2026-09-10'));
    const bars=await panel.locator('svg rect').evaluateAll(nodes=>nodes.map(n=>({x:Number(n.getAttribute('x')),width:Number(n.getAttribute('width'))})));
    assert.equal(bars.length,2);
    assert.ok(bars[1].x-bars[0].x>5*bars[0].width,JSON.stringify(bars));
  } finally {await page.close();}
});

test('tag detail and sleep coverage retain readable labels and calendar spacing', async () => {
  const data = week(); data.entries[0].sleep = {duration_min: 450};
  const task = {timeline: ['2026-09-04', '2026-09-10'].map(date => ({date, completed: date + 'T12:00:00', status: 'completed', title: 'Done'}))};
  const page = await analyticsPage(route => route.fulfill({json: data}), route => route.fulfill({json: {
    journal: {entries: 2, dow: [1, 0, 1, 0, 0, 0, 0]}, task,
  }}));
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Health', exact: true}).click();
    await page.getByRole('tab', {name: 'Sleep', exact: true}).click();
    const coverage = page.locator('#chart-sleep-coverage');
    assert.match(await coverage.innerText(), /14% \(1\/7\)/);
    const note = coverage.locator('.chart-rank-value');
    assert.ok(await note.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 12);
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await page.getByRole('tab', {name: 'Tags', exact: true}).click();
    const input = page.getByPlaceholder('search a tag…');
    await input.fill('work'); await input.press('Enter');
    const panel = page.locator('.analytics-panel').filter({has: page.getByRole('heading', {name: 'Completion throughput', exact: true})});
    const mean = panel.locator('.stat').filter({has: page.getByText('mean/day:', {exact: true})});
    assert.equal(await mean.locator('.stat-value').innerText(), '0.29');
    const bars = await panel.locator('svg rect').evaluateAll(nodes => nodes.map(n => ({x: Number(n.getAttribute('x')), width: Number(n.getAttribute('width'))})));
    assert.ok(bars[1].x - bars[0].x > 5 * bars[0].width);
    const labelSizes = await page.locator('.analytics-panel svg text').evaluateAll(nodes => nodes.map(n =>
      parseFloat(getComputedStyle(n).fontSize) * n.ownerSVGElement.getBoundingClientRect().width / n.ownerSVGElement.viewBox.baseVal.width));
    assert.ok(labelSizes.length > 5 && labelSizes.every(size => size >= 9), JSON.stringify(labelSizes));
  } finally { await page.close(); }
});

test('overview includes task-only days and task-only histories', async () => {
  const data = week();
  data.date_range.min = '2026-08-28';
  data.tasks.archive = [{id: 'done', title: 'Done', tags: [], completed: '2026-08-28T12:00:00'}];
  const page = await analyticsPage(route => route.fulfill({json: data}));
  try {
    await page.getByRole('tab', {name: 'Overview', exact: true}).waitFor();
    assert.ok((await page.locator('#chart-overview-summary .cal-month-title').allTextContents()).includes('August 2026'));
    assert.match(await page.locator('#chart-overview-summary [title^="2026-08-28"]').getAttribute('title'), /1 task done/);
    data.entries = [];
    await page.reload();
    const card = page.locator('#chart-overview-summary .stat-card').filter({has: page.getByText('tasks completed', {exact: true})});
    assert.equal(await card.locator('.stat-card-value').innerText(), '1');
    assert.equal((await page.locator('#chart-overview-summary').innerText()).includes('undefined'), false);
    await card.press('Enter');
    assert.equal(await page.getByRole('tab', {name: 'Throughput', exact: true}).getAttribute('aria-selected'), 'true');
  } finally { await page.close(); }
});

test('calendar legends keep their font size on narrow screens', async () => {
  const data = week();
  data.sections = [{id: 'water', name: 'Water', type: 'numeric', color: '#e0a955', unit: 'cups'}];
  data.entries.forEach((entry, i) => { entry.numbers.water = i; });
  const page = await analyticsPage(route => route.fulfill({json: data}));
  async function readable(text) {
    const size = await page.getByText(text, {exact: true}).first().evaluate(node =>
      parseFloat(getComputedStyle(node).fontSize) * (node.ownerSVGElement ? node.ownerSVGElement.getBoundingClientRect().width / node.ownerSVGElement.viewBox.baseVal.width : 1));
    assert.ok(size >= 9, text + ': ' + size);
  }
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Data', exact: true}).click();
    await readable('low'); await readable('high');
    await page.getByRole('tab', {name: 'Tasks', exact: true}).click();
    await readable('journal entry'); await readable('task completed');
  } finally { await page.close(); }
});

test('four task subtabs form balanced rows on narrow screens', async () => {
  const page = await analyticsPage();
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.getByRole('tab', {name: 'Tasks', exact: true}).click();
    const boxes = await page.locator('.analytics-subtab').evaluateAll(nodes => nodes.map(el => {
      const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width};
    }));
    assert.equal(boxes[0].y, boxes[1].y);
    assert.equal(boxes[2].y, boxes[3].y);
    assert.equal(boxes[0].x, boxes[2].x);
    assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 1);
    await page.setViewportSize({width: 1024, height: 768});
    assert.equal(await page.locator('.analytics-subtab').evaluateAll(nodes => new Set(nodes.map(el => el.getBoundingClientRect().y)).size), 1);
  } finally { await page.close(); }
});
