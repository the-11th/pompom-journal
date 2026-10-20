const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
let browser;
before(async () => { browser = await chromium.launch({channel: 'chrome', headless: true}); });
after(async () => { await browser?.close(); });

const entries = [
  {date: '2026-09-08', document: [{id: 'old', type: 'photo', asset_id: 'a', caption: 'Old caption', tags: {people: ['sam']}}]},
  {date: '2026-09-10', document: [{id: 'new', type: 'photo', asset_id: 'a', edited_asset_id: 'edit', caption: 'A quiet morning by the river with a long caption that should wrap without shrinking the photo.', tags: {people: ['alex']}}]},
  {date: '2026-09-11', document: [{id: 'text', type: 'text', text: 'A memory', links: [{start: 0, end: 8, photos: ['a', 'b']}]}]},
];
async function photoPage(respond, width = 390) {
  const page = await browser.newPage({viewport: {width, height: 844}}); page.setDefaultTimeout(5000);
  await page.route('https://datapom.test/**', route => {
    const url = new URL(route.request().url()), response = respond?.(route, url); if (response) return response;
    if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(__dirname, '..', url.pathname)});
    if (url.pathname === '/journal/media/state') return route.fulfill({json: {rev: 1, places: {}, messages: {},
      groups: {people: {id: 'people', name: 'people', tags: ['alex', 'sam']}},
      assets: {a: {id: 'a', filename: 'River.jpg'}, b: {id: 'b', filename: 'Memory.jpg'}, edit: {id: 'edit', filename: 'Edited river.png', source_asset_id: 'a'}}}});
    if (url.pathname.startsWith('/journal/media/file/')) return route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#334455"/></svg>'});
    return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><main><section class="analytics-panel" id="photos-root"></section></main><script src="/static/media-ui.js"></script><script src="/static/media-settings.js"></script>'});
  });
  await page.goto('https://datapom.test/'); return page;
}
async function render(page, value = entries) {
  await page.evaluate(value => PupMedia.photos(document.getElementById('photos-root'), value), value);
}

test('photo gallery includes linked-only photos, latest display details and merged tag filters', async () => {
  const page = await photoPage();
  try {
    await render(page);
    await page.getByText('2 unique photos', {exact: true}).waitFor();
    assert.equal(await page.locator('.media-gallery-card').count(), 2);
    await page.getByRole('button', {name: 'people: sam · 1', exact: true}).click();
    assert.equal(await page.locator('.media-gallery-card').count(), 1);
    assert.ok((await page.locator('.media-gallery-card img').getAttribute('src')).includes('/edit/'));
    assert.match(await page.locator('.media-gallery-card').innerText(), /2026-09-10/);
    await page.getByRole('button', {name: 'All photos', exact: true}).click();
    await page.getByRole('button', {name: 'Memory.jpg · 2026-09-11', exact: true}).click();
    await page.getByRole('dialog', {name: 'Photo', exact: true}).waitFor();
    assert.ok((await page.locator('.media-full-image').getAttribute('src')).includes('/b/'));
    await page.getByRole('button', {name: 'Close Photo', exact: true}).click();
    assert.equal(await page.getByRole('button', {name: 'Memory.jpg · 2026-09-11', exact: true}).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('photo tag filters count valid names that match object properties', async () => {
  const page = await photoPage();
  try {
    await render(page, [{date: '2026-09-10', document: [{id: 'photo', type: 'photo', asset_id: 'a', tags: {people: ['constructor', '__proto__']}}]}]);
    for (const name of ['constructor', '__proto__']) {
      await page.getByRole('button', {name: 'people: ' + name + ' · 1', exact: true}).click();
      assert.equal(await page.locator('.media-gallery-card').count(), 1);
    }
  } finally { await page.close(); }
});

test('photo refresh keeps the selected filter and keyboard focus while updating metadata', async () => {
  let fail = false;
  const page = await photoPage((route, url) => {
    if (url.pathname === '/journal/media/state' && fail) return route.fulfill({status: 503, json: {error: 'Temporary outage'}});
  });
  try {
    await render(page);
    await page.getByRole('button', {name: 'people: sam · 1', exact: true}).click();
    fail = true;
    await page.evaluate(() => document.getElementById('photos-root')._refreshPhotos());
    assert.equal(await page.locator('.media-gallery-card').count(), 1);
    await page.getByText('Could not refresh photos. Previous view kept.', {exact: true}).waitFor();
    fail = false;
    await page.evaluate(() => document.getElementById('photos-root')._refreshPhotos());
    const filter = page.getByRole('button', {name: 'people: sam · 1', exact: true});
    assert.equal(await filter.getAttribute('aria-pressed'), 'true');
    assert.equal(await filter.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.media-gallery-card').count(), 1);
    assert.equal(await page.getByText('Could not refresh photos. Previous view kept.', {exact: true}).count(), 0);
  } finally { await page.close(); }
});

test('photo gallery recovers from a failed load and failed thumbnails without browser chrome', async () => {
  let fail = true;
  const page = await photoPage((route, url) => {
    if (url.pathname === '/journal/media/state' && fail) return route.fulfill({status: 503, json: {error: 'Temporary outage'}});
    if (url.pathname.startsWith('/journal/media/file/')) return route.fulfill({status: 404, body: ''});
  });
  try {
    await render(page).catch(() => {});
    await page.getByText('Could not load photos.', {exact: true}).waitFor();
    fail = false; await page.getByRole('button', {name: 'Retry photos', exact: true}).click();
    await page.getByText('2 unique photos', {exact: true}).waitFor();
    await page.locator('.media-image-unavailable').first().waitFor();
    assert.equal(await page.locator('.media-gallery-card img:visible').count(), 0);
    assert.equal(await page.locator('.media-image-unavailable:visible').count(), 2);
  } finally { await page.close(); }
});

for (const failed of [false, true]) test(`an older ${failed ? 'failed' : 'successful'} photo load cannot replace a newer date selection`, async () => {
  let reads = 0, release, started;
  const pending = new Promise(resolve => { started = resolve; });
  const page = await photoPage((route, url) => {
    if (url.pathname === '/journal/media/state' && ++reads === 1) {
      started(); return new Promise(resolve => { release = () => { release = null; resolve(route.fulfill(failed ? {status: 503, json: {error: 'Old failure'}} : {json: {rev: 0, assets: {}, groups: {}, places: {}, messages: {}}})); }; });
    }
  });
  try {
    await page.evaluate(value => { window.oldPhotos = PupMedia.photos(document.getElementById('photos-root'), value).catch(() => {}); }, entries);
    await pending; await render(page, []); await page.getByText('0 unique photos', {exact: true}).waitFor();
    release(); await page.evaluate(() => window.oldPhotos);
    assert.equal(await page.getByText('0 unique photos', {exact: true}).count(), 1);
    assert.equal(await page.getByRole('button', {name: 'Retry photos', exact: true}).count(), 0);
  } finally { release?.(); await page.close(); }
});

test('photo picker keeps filenames and selection controls when thumbnails fail', async () => {
  const page = await photoPage((route, url) => {
    if (url.pathname.startsWith('/journal/media/file/')) return route.fulfill({status: 404, body: ''});
  });
  try {
    await page.evaluate(() => { window.picked = PupMedia.pickPhotos(); });
    const dialog = page.getByRole('dialog', {name: 'Photo gallery', exact: true});
    await dialog.locator('.media-image-unavailable').first().waitFor();
    assert.equal(await dialog.locator('img:visible').count(), 0);
    const river = dialog.getByRole('button', {name: 'River.jpg', exact: true});
    const memory = dialog.getByRole('button', {name: 'Memory.jpg', exact: true});
    assert.match(await river.innerText(), /River.jpg/);
    assert.match(await memory.innerText(), /Memory.jpg/);
    await river.click(); await memory.click();
    await dialog.getByRole('button', {name: 'Add 2 photos', exact: true}).click();
    assert.deepEqual(await page.evaluate(async () => (await window.picked).map(asset => asset.id)), ['a', 'b']);
  } finally { await page.close(); }
});

test('closing a photo after background refresh retains gallery focus', async () => {
 const page=await photoPage();
 try {
  await render(page);
  await page.getByRole('button',{name:'Memory.jpg · 2026-09-11',exact:true}).click();
  await page.getByRole('dialog',{name:'Photo',exact:true}).waitFor();
  await page.evaluate(()=>document.getElementById('photos-root')._refreshPhotos());
  await page.getByRole('button',{name:'Close Photo',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.asset),'b');
 } finally {await page.close();}
});
