const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('playwright');
const {neighborhood} = require('./map_fixture');
let browser;
before(async () => { browser = await chromium.launch({channel: 'chrome', headless: true}); });
after(async () => { await browser?.close(); });

async function mapPage({fail = false, stale = false, unchanged = false} = {}) {
  const page = await browser.newPage({viewport: {width: 390, height: 844}}); page.setDefaultTimeout(5000);
  const fixture = neighborhood(); let broken = fail, manifests=0; const ranges = [];
  await page.route('https://datapom.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/static/')) return route.fulfill({path: path.join(__dirname, '..', url.pathname)});
    if (url.pathname === '/maps') { manifests++; return route.fulfill({json:{packs:[{id:'qa-map',bounds:fixture.bounds,max_zoom:14,status:'ready',url:'/qa-map',sha256:unchanged?'synthetic':'replacement'}]}}); }
    if (url.pathname === '/qa-map') {
      const match = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range || '');
      assert.ok(match); const from = Number(match[1]), to = Number(match[2]); ranges.push([from, to]);
      if (broken) return route.fulfill({status: 503, body: ''});
      if (stale && url.searchParams.get('v')==='synthetic') return route.fulfill({status:409,json:{error:'map_version_changed'}});
      return route.fulfill({status: 206, headers: {'content-range': `bytes ${from}-${to}/${fixture.bytes.length}`,
        'content-type': 'application/octet-stream'}, body: fixture.bytes.subarray(from, to + 1)});
    }
    return route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/static/style.css"><main><div id="map" class="media-map-host"></div></main><script>window.PupMedia={request:()=>fetch("/maps").then(r=>r.json())};</script><script src="/static/offline-map.js"></script>'});
  });
  await page.goto('https://datapom.test/');
  await page.evaluate(({bounds, center}) => {
    window.qaMap = new TodoPupMap.OfflineMap(document.getElementById('map'), {packs: [{id: 'qa-map', bounds, max_zoom: 14,
      status: 'ready', url: '/qa-map', sha256: 'synthetic'}], ...center, zoom: 14});
    qaMap.fit(bounds);
    // This tiny rendering fixture contains only its zoom14 tile.
    qaMap.setZoom(14);
  }, {bounds: fixture.bounds, center: fixture.center});
  return {page, ranges, manifestReads:()=>manifests, recover() { broken = false; }};
}

test('synthetic PMTiles render themed land, water and roads through bounded range requests', async () => {
  const {page, ranges} = await mapPage();
  try {
    await page.getByText('Offline · regional detail', {exact: true}).waitFor();
    const colors = await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const styles = getComputedStyle(canvas), result = {};
      const sample = document.createElement('canvas'); sample.width = sample.height = 1;
      const sampleContext = sample.getContext('2d');
      for (const variable of ['--map-land', '--map-water', '--map-green']) {
        sampleContext.fillStyle = styles.getPropertyValue(variable).trim();
        sampleContext.fillRect(0, 0, 1, 1);
        const expected = [...sampleContext.getImageData(0, 0, 1, 1).data].slice(0, 3); let found = 0;
        for (let i = 0; i < pixels.length; i += 4) if (expected.every((v, c) => pixels[i + c] === v)) found++;
        result[variable] = found;
      }
      return result;
    });
    assert.ok(Object.values(colors).every(count => count > 100), JSON.stringify(colors));
    assert.ok(ranges.some(([from, to]) => from === 0 && to === 126));
    assert.ok(ranges.every(([from, to]) => to >= from && to - from < 1000));
    const width = await page.locator('canvas').evaluate(el => el.width);
    await page.setViewportSize({width: 1024, height: 844});
    await page.waitForFunction(width => document.querySelector('canvas').width > width, width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});

test('failed map ranges retry on interaction without replacing the canvas', async () => {
  const control = await mapPage({fail: true}), {page} = control;
  try {
    await page.getByText('Map file unavailable · open Downloads', {exact: true}).waitFor();
    await page.locator('canvas').evaluate(el => { el.dataset.retained = 'yes'; });
    control.recover(); await page.getByRole('button', {name: 'Zoom in', exact: true}).click();
    await page.getByText('Offline · regional detail', {exact: true}).waitFor();
    assert.equal(await page.locator('canvas').getAttribute('data-retained'), 'yes');
    assert.ok(control.ranges.filter(([from]) => from === 0).length >= 2);
  } finally { await page.close(); }
});

test('zoom controls overzoom local vectors to22 while retaining bounded cached tiles',async()=>{
  const {page}=await mapPage();
  try{
    await page.getByText('Offline · regional detail',{exact:true}).waitFor();
    await page.evaluate(()=>{
      window.tileZooms=[];const fetchTile=qaMap.fetchTile.bind(qaMap);
      qaMap.fetchTile=(pack,z,x,y)=>{tileZooms.push(z);return fetchTile(pack,z,x,y);};qaMap.setZoom(18);
      document.querySelector('canvas').dataset.retained='yes';
    });
    for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    assert.equal(await page.evaluate(()=>qaMap.zoom),22);
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    assert.equal(await page.evaluate(()=>qaMap.zoom),22);
    await page.getByRole('button',{name:'Zoom out',exact:true}).click();
    assert.equal(await page.evaluate(()=>qaMap.zoom),21);
    const zooms=await page.evaluate(()=>tileZooms);assert.ok(zooms.length>0);assert.ok(zooms.every(z=>z===14),JSON.stringify(zooms));
    assert.equal(await page.locator('canvas').getAttribute('data-retained'),'yes');
    await page.getByText('Offline · regional detail',{exact:true}).waitFor();
  }finally{await page.close();}
});

for(const scale of [1,2])test(`web map scale, status and attribution stay separate at320px with${scale*100}percent text`,async()=>{
  const {page}=await mapPage({fail:true});
  try{
    await page.setViewportSize({width:320,height:844});
    await page.evaluate(scale=>document.documentElement.style.fontSize=(16*scale)+'px',scale);
    await page.getByText('Map file unavailable · open Downloads',{exact:true}).waitFor();
    const boxes=await page.locator('.map-scale,.map-note,.map-credit').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {name:node.className,top:b.top,bottom:b.bottom,left:b.left,right:b.right};}));
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert.ok(boxes[i].bottom<=boxes[j].top+.5||boxes[j].bottom<=boxes[i].top+.5,JSON.stringify(boxes));
    assert.ok(boxes.every(box=>box.left>=0&&box.right<=320),JSON.stringify(boxes));
    const canvas=await page.locator('canvas').boundingBox();
    assert.ok(canvas.y+canvas.height<=Math.min(...boxes.map(box=>box.top))+.5,'Route canvas must end before the footer');
  }finally{await page.close();}
});

for(const unchanged of [false,true])test(`a stale map version refreshes its manifest once${unchanged?' even if the manifest remains stale':''}`,async()=>{
  const control=await mapPage({stale:true,unchanged}),{page}=control;
  try{
    if(!unchanged)await page.getByText('Offline · regional detail',{exact:true}).waitFor();
    else{
      await page.getByText('Map file unavailable · open Downloads',{exact:true}).waitFor();
      await page.getByRole('button',{name:'Zoom in',exact:true}).click();
      await page.waitForTimeout(100);
    }
    assert.equal(control.manifestReads(),1);
    assert.equal(await page.locator('canvas').count(),1);
    if(!unchanged)assert.match(await page.evaluate(()=>qaMap.versions.get('qa-map')),/replacement/);
  }finally{await page.close();}
});

test('fitting a wide route leaves room for markers beside map controls',async()=>{
  const {page}=await mapPage();
  try{
    await page.setViewportSize({width:320,height:844});
    const geometry=await page.evaluate(()=>{
      const bounds=[121.46,31.229,121.48,31.231];qaMap.fit(bounds);
      return {right:qaMap.pixel(bounds[2],bounds[3]).x+22,controls:document.querySelector('.map-controls').offsetLeft};
    });
    assert.ok(geometry.right<geometry.controls,JSON.stringify(geometry));
  }finally{await page.close();}
});
