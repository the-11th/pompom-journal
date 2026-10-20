/* Execute the real entry controller with a small DOM/transport test double. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag = 'div') {
    this.tagName = tag; this.value = ''; this.name = ''; this.hidden = false;
    this.dataset = {}; this.children = []; this.listeners = new Map();
    this.classList = { add() {} };
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentElement = this; } }
  prepend(...nodes) { for (const node of nodes.reverse()) { this.children.unshift(node); node.parentElement = this; } }
  addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, 'target', {value:this,configurable:true});
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles) this.parentElement?.dispatchEvent(event);
    return true;
  }
  before(node) { this.parentElement.append(node); }
  after(node) { this.parentElement.append(node); }
  setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
  getAttribute(name) { return this.attributes?.[name] || null; }
  remove() { if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this); }
  focus() {}
  render() {}
  querySelector() { return null; }
}

async function entryHarness({ body = 'Saved text', draft = null, documentValue = null, assets = [], editRevision = null, numberValue = null, moodValue = null, respond } = {}) {
  const form = new Node('form'), source = new Node('textarea'), title = new Node('input');
  const field = new Node(), status = new Node(), buttons = [], calls = [], intervals = [], beacons = [];
  form.dataset = { entryDate: '2026-09-07', entryUpdated: 'version-1' };
  if (editRevision) form.dataset.entryEditRevision = editRevision;
  source.name = 'body'; source.value = body; title.name = 'title'; title.value = 'Saved title';
  form.elements = [source, title]; form.elements.namedItem = name => form.elements.find(el => el.name === name);
  form.append(field, title); field.append(source);
  let number = null, mood = null;
  if(numberValue!==null){number=new Node('input');number.name='num:weight';number.value=numberValue;number.validity={badInput:false};form.elements.push(number);form.append(number);}
  if(moodValue!==null){mood=new Node('input');mood.name='mood';mood.value=moodValue;form.elements.push(mood);form.append(mood);}
  form.querySelector = selector => ({ '[name=body]': source, '[name=title]': title, '.body-field': field, '[name=mood]':mood })[selector] || null;
  const storage = new Map(), key = 'todopup:document:2026-09-07';
  if (draft) storage.set(key, JSON.stringify(draft));
  const document = new Node();
  document.getElementById = id => ({ 'journal-form': form, 'draft-status': status, 'journal-document': {textContent:JSON.stringify(documentValue)} })[id] || null;
  const window = new Node();
  const context = vm.createContext({ window, document, Event, CustomEvent, crypto: require('node:crypto').webcrypto, Date, console });
  vm.runInContext(fs.readFileSync(require.resolve('../static/media-ui.js'), 'utf8'), context);
  const M = window.PupMedia;
  // Keep the real editor's document and mutation behavior; rendering belongs to
  // the independent browser checks and is outside this controller harness.
  M.Editor.prototype.render = function () {};
  Object.assign(M, {
    refresh: async () => ({}),
    element: tag => new Node(tag),
    notice() {},
    pickPhotos: async () => structuredClone(assets),
    dialog() { return {body:new Node(),actions:new Node(),close() {},onClose() {}}; },
    field(label, value = '') { const wrap = new Node('label'), input = new Node('input'); input.value = value; wrap.append(input); return {wrap,input}; },
    button(label, action) { const node = new Node('button'); node.textContent = label; node.action = action; buttons.push(node); return node; },
    request: async (path, payload) => {
      calls.push({ path, payload: structuredClone(payload) });
      if (respond) return respond(path, payload, calls.length);
      return { entry: { ...payload, updated: 'version-2' } };
    },
  });
  window.PupMedia = M; window.confirmModal = async () => true;
  const localStorage = { getItem: name => storage.get(name) || null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) };
  Object.assign(context, { localStorage, setInterval: callback => intervals.push(callback), Blob, navigator: {sendBeacon: (...args) => {beacons.push(args); return true;}} });
  await vm.runInContext(fs.readFileSync(require.resolve('../static/media-entry.js'), 'utf8'), context);
  return { source, form, title, field, status, buttons, calls, storage, controller: window.PupJournalEditor, intervals, window, document, beacons, number, mood };
}

test('incomplete numbers keep the last valid value, prose and mood through draft recovery', async () => {
  const view=await entryHarness({numberValue:'3.25',moodValue:'6'});
  view.source.value='Keep this full paragraph';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  view.number.value='1';view.number.dispatchEvent(new Event('input',{bubbles:true}));
  view.number.value='';view.number.validity.badInput=true;view.number.dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(await view.controller.save(),false);
  view.window.dispatchEvent(new Event('pagehide'));
  assert.equal(view.beacons.length,0);
  const draft=JSON.parse(view.storage.get('todopup:document:2026-09-07'));
  assert.equal(draft.numbers.weight,'1');assert.deepEqual(draft.invalid_numbers,['weight']);
  assert.equal(draft.body,'Keep this full paragraph');assert.equal(draft.mood,'6');
  const restored=await entryHarness({numberValue:'3.25',moodValue:'4',draft});
  assert.equal(restored.number.value,'1');assert.equal(restored.mood.value,'6');
  assert.equal(await restored.controller.save(),false);
  restored.number.value='100';restored.number.dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(await restored.controller.save(),true);
  assert.equal(restored.calls.at(-1).payload.numbers.weight,'100');
  assert.equal(restored.calls.at(-1).payload.body,'Keep this full paragraph');
  assert.equal(restored.calls.at(-1).payload.mood,'6');
  assert.equal(restored.calls.at(-1).payload.sleep,undefined);
});

test('validation failures show their message and wait for a correction before retrying', async () => {
  const view=await entryHarness({respond:async(path,payload,count)=>{if(count===1)throw Object.assign(Error('Choose a valid tag name.'),{status:400});return {entry:{...payload,updated:'v2'}};}});
  view.source.value='Preserved draft';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(await view.controller.save(),false);
  assert.equal(view.status.textContent,'Choose a valid tag name.');
  assert.equal(await view.controller.save(),false);view.window.dispatchEvent(new Event('pagehide'));
  assert.equal(view.calls.length,1);assert.equal(view.beacons.length,0);
  view.source.value='Corrected draft';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(await view.controller.save(),true);assert.equal(view.calls.length,2);
});

test('a validation response for an older draft does not block newer corrected input', async () => {
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const view=await entryHarness({respond:async(path,payload,count)=>{if(count===1){await pending;throw Object.assign(Error('Choose a valid tag name.'),{status:400});}return {entry:{...payload,updated:'v2'}};}});
  view.source.value='First version';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  const saving=view.controller.save();
  view.source.value='Corrected while saving';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  release();assert.equal(await saving,false);
  assert.equal(await view.controller.save(),true);
  assert.equal(view.calls.at(-1).payload.body,'Corrected while saving');
});

test('a save acknowledgement cannot clear a newer incomplete numeric draft with the same last valid value', async () => {
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const view=await entryHarness({numberValue:'1',respond:async(path,payload)=>{await pending;return {entry:{...payload,updated:'v2'}};}});
  view.source.value='A saved paragraph';view.source.dispatchEvent(new Event('input',{bubbles:true}));
  const saving=view.controller.save();
  view.number.value='';view.number.validity.badInput=true;view.number.dispatchEvent(new Event('input',{bubbles:true}));
  release();await saving;
  const draft=JSON.parse(view.storage.get('todopup:document:2026-09-07') || 'null');
  assert.ok(draft);assert.equal(draft.numbers.weight,'1');assert.deepEqual(draft.invalid_numbers,['weight']);
  assert.equal(await view.controller.save(),false);
});

test('moving an entry waits for pending saves and flushes newer text before leaving', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const view = await entryHarness({respond: async (path, payload, number) => {
    if (number === 1) await pending;
    return {entry: {...payload, updated: 'version-' + (number + 1)}};
  }});
  view.source.value = 'First thought';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  const saving = view.controller.save();
  view.source.value = 'First thought with the ending';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  let ready = false;
  const moving = view.controller.prepareEntryAction('move').then(value => {ready = value;});
  await Promise.resolve();
  assert.equal(ready, false);
  release(); await saving; await moving;
  assert.equal(ready, true);
  assert.equal(view.calls.length, 2);
  assert.equal(view.calls.at(-1).payload.body, 'First thought with the ending');
  view.window.dispatchEvent(new Event('pagehide'));
  assert.equal(view.beacons.length, 0);
});

test('a failed move preparation keeps its draft and allows saving again', async () => {
  const view = await entryHarness({respond: async (path, payload, number) => {
    if (number === 1) throw Error('Offline');
    return {entry: {...payload, updated: 'version-2'}};
  }});
  view.source.value = 'A draft to move';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  assert.equal(await view.controller.prepareEntryAction('move'), false);
  assert.equal(view.form.inert, false);
  assert.equal(JSON.parse(view.storage.get('todopup:document:2026-09-07')).body, 'A draft to move');
  assert.equal(await view.controller.save(), true);
});

test('deleting an entry waits for its pending save and suppresses every later autosave trigger', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const view = await entryHarness({respond: async (path, payload) => {
    await pending;
    return {entry: {...payload, updated: 'version-2'}};
  }});
  view.source.value = 'Draft about to be deleted';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  const saving = view.controller.save();
  let ready = false;
  const deleting = view.controller.prepareEntryAction('delete').then(value => {ready = value;});
  await Promise.resolve();
  assert.equal(ready, false);
  release(); await saving; await deleting;
  assert.equal(ready, true);
  view.controller.changed(true);
  view.document.hidden = true;
  view.document.dispatchEvent(new Event('visibilitychange'));
  view.window.dispatchEvent(new Event('pagehide'));
  view.intervals.forEach(callback => callback());
  assert.equal(await view.controller.save(true), false);
  assert.equal(view.calls.length, 1);
  assert.equal(view.beacons.length, 0);
  assert.equal(view.storage.has('todopup:document:2026-09-07'), false);
});

test('restored draft remains editable without the retired Writing / dictation switch', async () => {
  const view = await entryHarness({ draft: {
    base_updated: 'version-1', title: 'Draft title', body: 'Draft text',
    document: [{ id: 'paragraph', type: 'text', text: 'Draft text', links: [] }],
    tags: {}, numbers: {}, mood: null,
  } });
  assert.equal(view.controller.collect().body, 'Draft text');
  assert.equal(view.buttons.some(button => button.textContent === 'Writing / dictation'),false);
  view.source.value += '!';
  view.source.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(view.controller.collect().body, 'Draft text!');
  await view.controller.save();
  assert.equal(view.calls.at(-1).payload.body, 'Draft text!');
});

test('photo details opened during a commit keep editing the live photo block', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const view = await entryHarness({ documentValue: [
    {id:'paragraph',type:'text',text:'Saved text',links:[]},
    {id:'photo',type:'photo',asset_id:'asset',caption:'Old caption',tags:{}},
  ], respond: async (path, payload, number) => {
    if (number === 1) await delayed;
    return { entry: { ...structuredClone(payload), updated: 'version-' + (number + 1) } };
  } });
  const saving = view.controller.save(true);
  const openedPhoto = view.controller.editor.doc.find(block => block.id === 'photo');
  release(); await saving;
  openedPhoto.caption = 'Caption edited after the response';
  view.controller.editor.changed();
  await view.controller.save();
  assert.equal(view.calls.at(-1).payload.document.find(block => block.id === 'photo').caption, 'Caption edited after the response');
});

test('a failed autosave retains the draft and a successful retry clears it', async () => {
  const view = await entryHarness({ respond: async (path, payload, number) => {
    if (number === 1) throw Error('Connection interrupted');
    return { entry: { ...payload, updated: 'version-2' } };
  } });
  view.source.value = 'A note worth keeping';
  view.source.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(await view.controller.save(), false);
  assert.equal(JSON.parse(view.storage.get('todopup:document:2026-09-07')).body, 'A note worth keeping');
  assert.equal(await view.controller.save(), true);
  assert.equal(view.calls.at(-1).payload.body, 'A note worth keeping');
  assert.equal(view.storage.has('todopup:document:2026-09-07'), false);
});

test('typing during an autosave keeps newer text and uses the returned revision on retry', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const view = await entryHarness({ respond: async (path, payload, number) => {
    if (number === 1) await delayed;
    return { entry: { ...payload, updated: 'version-' + (number + 1) } };
  } });
  view.source.value = 'First thought';
  view.source.dispatchEvent(new Event('input', { bubbles: true }));
  const saving = view.controller.save();
  view.source.value = 'First thought and a second';
  view.source.dispatchEvent(new Event('input', { bubbles: true }));
  release(); await saving;
  const draft = JSON.parse(view.storage.get('todopup:document:2026-09-07'));
  assert.equal(draft.body, 'First thought and a second');
  assert.equal(draft.base_updated, 'version-2');
  await view.controller.save();
  assert.equal(view.calls.at(-1).payload.body, 'First thought and a second');
  assert.equal(view.calls.at(-1).payload.base_updated, 'version-2');
});

test('autosave retains the editable-content baseline until acknowledgement, including newer typing', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const view = await entryHarness({editRevision: 'content-1', respond: async (path, payload, number) => {
    if (number === 1) await delayed;
    return {entry: {...payload, updated: 'version-' + (number + 1), edit_revision: 'content-' + (number + 1)}};
  }});
  view.source.value = 'First thought';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  const saving = view.controller.save();
  assert.equal(view.calls[0].payload.base_edit_revision, 'content-1');
  view.source.value = 'First thought plus newer text';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  assert.equal(view.controller.collect().base_edit_revision, 'content-1');
  release(); await saving;
  const draft = JSON.parse(view.storage.get('todopup:document:2026-09-07'));
  assert.equal(draft.base_edit_revision, 'content-2');
  assert.equal(draft.body, 'First thought plus newer text');
  await view.controller.save();
  assert.equal(view.calls.at(-1).payload.base_edit_revision, 'content-2');
  assert.equal(view.form.dataset.entryEditRevision, 'content-3');
});

test('failed saves preserve their original editable-content baseline for retry', async () => {
  const view = await entryHarness({editRevision: 'content-1', respond: async () => {throw Error('Connection interrupted');}});
  view.source.value = 'Keep this note';
  view.source.dispatchEvent(new Event('input', {bubbles: true}));
  assert.equal(await view.controller.save(), false);
  assert.equal(JSON.parse(view.storage.get('todopup:document:2026-09-07')).base_edit_revision, 'content-1');
});

test('a recovered draft can save after a provider-only timestamp change', async () => {
  const view = await entryHarness({editRevision: 'same-content', draft: {
    base_updated: 'older-provider-version', base_edit_revision: 'same-content',
    title: 'A local draft', body: 'Still editable', document: [{id:'paragraph',type:'text',text:'Still editable'}],
    tags: {}, numbers: {}, mood: null,
  }});
  assert.equal(await view.controller.save(), true);
  assert.equal(view.calls.at(-1).payload.body, 'Still editable');
  assert.equal(view.calls.at(-1).payload.base_edit_revision, 'same-content');
});

for (const uncertainResponse of [false, true]) test('capture-date retry does not duplicate photos after ' + (uncertainResponse ? 'a lost save response' : 'a later day fails'), async () => {
  const saved = new Map(); let interrupted = false;
  const view = await entryHarness({ assets: [
    {id:'photo-a',captured_at:'2026-09-05T10:00:00'},
    {id:'photo-b',captured_at:'2026-09-06T10:00:00'},
  ], respond: async (path, payload) => {
    const day = path.match(/\d{4}-\d{2}-\d{2}/)[0];
    if (!payload) return {entry:structuredClone(saved.get(day) || null)};
    if (!uncertainResponse && day === '2026-09-06' && !interrupted) { interrupted = true; throw Error('Entry changed elsewhere'); }
    const entry = {...structuredClone(payload),updated:'saved-' + day}; saved.set(day,entry);
    if (uncertainResponse && day === '2026-09-05' && !interrupted) { interrupted = true; throw Error('Response interrupted'); }
    return {entry};
  } });
  await view.buttons.find(button => button.textContent === '＋ Photos').action();
  const useDates = view.buttons.find(button => button.textContent === 'Use capture dates');
  await assert.rejects(() => useDates.action(), /interrupted|elsewhere/);
  await useDates.action();
  for (const day of ['2026-09-05','2026-09-06']) {
    assert.equal(saved.get(day).document.filter(block => block.type === 'photo').length, 1);
    assert.equal(view.calls.filter(call => call.path === '/journal/' + day + '/autosave').length, day === '2026-09-06' && !uncertainResponse ? 2 : 1);
  }
});

test('after a partial capture-date import, adding here inserts only the remaining photos', async () => {
  const view = await entryHarness({ assets: [
    {id:'photo-a',captured_at:'2026-09-05T10:00:00'},
    {id:'photo-b',captured_at:'2026-09-06T10:00:00'},
  ], respond: async (path, payload) => {
    if (!payload) return {entry:null};
    if (path === '/journal/2026-09-06/autosave') throw Error('Entry changed elsewhere');
    return {entry:{...payload,updated:'version-2'}};
  } });
  await view.buttons.find(button => button.textContent === '＋ Photos').action();
  await assert.rejects(() => view.buttons.find(button => button.textContent === 'Use capture dates').action(), /elsewhere/);
  await view.buttons.find(button => button.textContent === 'Add remaining to 2026-09-07').action();
  await view.controller.save();
  const photos = view.controller.collect().document.filter(block => block.type === 'photo');
  assert.equal(photos.length,1);
  assert.equal(photos[0].asset_id,'photo-b');
});

for (const lookupFails of [false, true]) test('adding here reconciles a lost capture-date response' + (lookupFails ? ' and keeps the dialog when lookup fails' : ''), async () => {
  const saved = new Map(); let interrupted = false;
  const view = await entryHarness({ assets: [
    {id:'photo-a',captured_at:'2026-09-05T10:00:00'},
    {id:'photo-b',captured_at:'2026-09-06T10:00:00'},
  ], respond: async (path, payload) => {
    const day = path.match(/\d{4}-\d{2}-\d{2}/)[0];
    if (!payload) {
      if (lookupFails && interrupted) throw Error('Lookup unavailable');
      return {entry:structuredClone(saved.get(day) || null)};
    }
    const entry = {...structuredClone(payload),updated:'saved-' + day}; saved.set(day,entry);
    if (day === '2026-09-05' && !interrupted) { interrupted = true; throw Error('Response interrupted'); }
    return {entry};
  } });
  await view.buttons.find(button => button.textContent === '＋ Photos').action();
  await assert.rejects(() => view.buttons.find(button => button.textContent === 'Use capture dates').action(), /interrupted/);
  const keepHere = view.buttons.find(button => button.textContent === 'Add to 2026-09-07');
  if (lookupFails) await assert.rejects(() => keepHere.action(), /unavailable/);
  else await keepHere.action();
  await view.controller.save();
  const photos = view.controller.collect().document.filter(block => block.type === 'photo');
  assert.deepEqual(Array.from(photos, photo => photo.asset_id), lookupFails ? [] : ['photo-b']);
  assert.equal(saved.get('2026-09-05').document.filter(block => block.type === 'photo').length, 1);
  assert.equal(keepHere.disabled, false);
});

test('capture-date and current-day import choices cannot run concurrently', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const view = await entryHarness({ assets: [{id:'photo-a',captured_at:'2026-09-05T10:00:00'}], respond: async (path, payload) => {
    if (!payload) return {entry:null};
    await pending;
    return {entry:{...payload,updated:'saved'}};
  } });
  await view.buttons.find(button => button.textContent === '＋ Photos').action();
  const useDates = view.buttons.find(button => button.textContent === 'Use capture dates');
  const keepHere = view.buttons.find(button => button.textContent === 'Add to 2026-09-07');
  const importing = useDates.action();
  await Promise.resolve();
  assert.equal(keepHere.disabled, true);
  await keepHere.action();
  assert.equal(view.controller.collect().document.filter(block => block.type === 'photo').length, 0);
  release(); await importing;
  assert.equal(view.calls.filter(call => call.payload).length, 1);
});

for (const reason of ['task-rewrite','version']) test('409 ' + reason + ' keeps the correct recovery choices and local reason', async () => {
  const view = await entryHarness({ respond: async () => {
    throw Object.assign(Error('Saved task links need review'), {
      status:409, ...(reason === 'task-rewrite' ? {reason} : {}),
      current:{updated:'saved-2',body:'[task:abc123] walk',document:[{id:'text',type:'text',text:'[task:abc123] walk',links:[]}]},
    });
  } });
  view.source.value = '[] walk and a newer thought';
  view.source.dispatchEvent(new Event('input',{bubbles:true}));
  assert.equal(await view.controller.save(),false);
  const recovery = JSON.parse(view.storage.get('todopup:document:2026-09-07'));
  assert.equal(recovery.recovery_reason,reason);
  assert.equal(recovery.body,'[] walk and a newer thought');
  assert.equal(view.buttons.some(button => button.textContent === 'Keep my draft'),reason !== 'task-rewrite');
  assert.equal(view.buttons.some(button => button.textContent === 'Use saved version'),true);
  assert.equal(await view.controller.save(),false);
  assert.equal(view.calls.length,1);
});

test('successful autosaves publish calendar content separately from an occupied date', async () => {
  const view=await entryHarness({respond:async(_path,payload)=>({entry:{...payload,id:'saved-review',updated:'saved'},calendar_entry:!!payload.body.trim()})});
  const events=[];view.form.addEventListener('journal:saved',event=>events.push(event.detail));
  await view.controller.save(true);
  assert.equal(events.at(-1).date,'2026-09-07');assert.equal(events.at(-1).hasEntry,true);assert.equal(events.at(-1).persisted,true);
  assert.equal(events.at(-1).entryId,'saved-review');
  view.source.value='';view.source.dispatchEvent(new Event('input',{bubbles:true}));await view.controller.save();
  assert.equal(events.at(-1).hasEntry,false);assert.equal(events.at(-1).persisted,true);
});

for(const body of ['', 'Saved in another tab'])test(`restoring a ${body?'text':'placeholder'} conflict publishes the saved entry identity`,async()=>{
  const current={id:'other-tab-entry',date:'2026-09-07',title:'2026-09-07',body,updated:'other-tab-v2',mood:4,document:[{id:'text',type:'text',text:body,links:[]}]};
  const view=await entryHarness({respond:async()=>{throw Object.assign(Error('Entry changed'),{status:409,current});}});
  const events=[];view.form.addEventListener('journal:saved',event=>events.push(event.detail));
  await view.controller.save(true);await view.buttons.find(button=>button.textContent==='Use saved version').action();
  assert.equal(events.at(-1)?.entryId,'other-tab-entry');
  assert.equal(events.at(-1).date,'2026-09-07');assert.equal(events.at(-1).persisted,true);assert.equal(events.at(-1).hasEntry,!!body);
  assert.equal(view.source.value,body);assert.equal(view.storage.has('todopup:document:2026-09-07'),false);
});

test('task references are adopted before rendering a committed document',async()=>{
  const taskIndex={abc123:{status:'active',done:false,title:'Review task'}};
  const view=await entryHarness({body:'[] Review task',respond:async(_path,payload)=>({entry:{...payload,body:'[task:abc123] Review task',document:[{id:'text',type:'text',text:'[task:abc123] Review task'}],updated:'v2'},task_ref_index:taskIndex})});
  const order=[];view.window.journalSetTaskIndex=index=>order.push(['tasks',JSON.parse(JSON.stringify(index))]);view.controller.editor.refreshTaskLinks=()=>order.push(['refresh']);view.controller.editor.render=()=>order.push(['render']);
  assert.equal(await view.controller.save(true),true);
  assert.deepEqual(order,[['tasks',taskIndex],['refresh'],['render']]);
});
