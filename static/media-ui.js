/* Shared offline-friendly journal photos, places, and message controls. */
(function (global) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = () => crypto.randomUUID().replaceAll('-', '');
  const documentBody = doc => doc.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  function selectedPassage(text, from, to) {
    const start=Math.max(0,Math.min(text.length,from)),end=Math.max(start,Math.min(text.length,to));
    const selection=text.slice(start,end);
    return selection.trim()?{start:[...text.slice(0,start)].length,end:[...text.slice(0,end)].length,text:selection}:null;
  }
  function setPassagePhotos(block, passage, photos) {
    if (block.text !== passage.text) throw Error('Text changed while this window was open. Close it and select the passage again.');
    const {start,end}=passage;
    block.links=(block.links||[]).filter(link=>link.end<=start||link.start>=end);
    if(photos.length)block.links.push({start,end,photos:[...new Set(photos)]});
  }
  function rebaseLinks(before, after, links) {
    const a = [...before], b = [...after];
    let start = 0, end = a.length, newEnd = b.length;
    while (start < end && start < newEnd && a[start] === b[start]) start++;
    while (end > start && newEnd > start && a[end - 1] === b[newEnd - 1]) { end--; newEnd--; }
    const delta = newEnd - end;
    return (links || []).flatMap(link => {
      if (end <= link.start) return [{ ...link, start: link.start + delta, end: link.end + delta }];
      if (start >= link.end) return [link];
      if (start <= link.start && end >= link.end) return [];
      return [{ ...link, start: Math.min(link.start, start), end: Math.max(newEnd, link.end + delta) }];
    });
  }
  function splitText(text, caret, links) {
    const offset = [...text.slice(0, caret)].length;
    const before = [], after = [];
    for (const link of links || []) {
      if (link.start < offset) before.push({...link, end:Math.min(offset,link.end)});
      if (link.end > offset) after.push({...link, start:Math.max(0,link.start-offset), end:link.end-offset});
    }
    return {before:{text:text.slice(0,caret),links:before},after:{text:text.slice(caret),links:after}};
  }
  function photoBlock(asset, identity) {
    return {id:identity||id(),type:'photo',asset_id:asset.id,caption:'',caption_visible:true,location_visible:!!asset.location,location_label:asset.location_label||'',tags:asset.location_label?{locations:[asset.location_label.toLowerCase()]}:{},width:'full'};
  }
  function locationName(value) {
    return String(value || '').trim().replace(/^(?:(?:locations?\s*:\s*)|(?:near(?:\s*:\s*|\s+)))+/i, '').trim();
  }
  function mergePhotoTagFields(previous,fields) {
    const result=clone(previous||{});
    for(const [gid,value] of fields){const names=[...new Set(value.split(',').map(n=>n.trim().toLowerCase()).filter(Boolean))];if(names.length)result[gid]=names;else delete result[gid];}
    return result;
  }
  function photoTagChoices(group, selected = [], history = [], mentions = {}) {
    const clean = names => [...new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean))];
    const permanent = clean(group.tags || []);
    const known = Object.entries(mentions).filter(([,s]) => String(s.section_name || '').toLowerCase() === group.name.toLowerCase()).map(([name]) => name);
    return clean([...permanent, ...selected, ...history, ...known])
      .map(name => ({name, permanent: permanent.includes(name)}))
      .sort((a,b) => Number(b.permanent) - Number(a.permanent) || a.name.localeCompare(b.name));
  }
  function captionTagNames(caption,tags,groups,mentions) {
    const result=clone(tags||{}), index=Object.create(null);
    Object.entries(result).forEach(([gid,names])=>names.forEach(n=>index[n.toLowerCase()]=gid));
    Object.entries(mentions||{}).forEach(([name,section])=>{const group=groups.find(g=>g.name.toLowerCase()===String(section.section_name||'').toLowerCase());if(group)index[name.toLowerCase()]=group.id;});
    for(const match of (caption||'').matchAll(/(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/gu)){const direct=match[1].toLowerCase(),name=index[direct]?direct:direct.replaceAll('_',' '),gid=index[name];if(gid)result[gid]=[...new Set([...(result[gid]||[]),name])];}
    return result;
  }
  function mergeCommittedDocument(submitted,committed,current) {
    const result=clone(current);
    for(const before of submitted.filter(b=>b.type==='text')){
      const after=committed.find(b=>b.id===before.id), target=result.find(b=>b.id===before.id);
      if(!after||!target||after.text===before.text)continue;
      const old=before.text||'',authoritative=after.text||'',now=target.text||'';
      const oldLines=old.split('\n'),newLines=authoritative.split('\n'),edits=[];if(oldLines.length!==newLines.length)return null;
      let offset=0;
      for(let i=0;i<oldLines.length;i++){
        if(oldLines[i]!==newLines[i]){
          const a=/^([ \t]*(?:-[ \t]+)?)\[[ ]?\]([ \t]+.+)$/.exec(oldLines[i]),b=/^([ \t]*(?:-[ \t]+)?)\[task:([0-9a-f]+)\]([ \t]+.+)$/.exec(newLines[i]);
          if(!a||!b||a[1]!==b[1]||a[2]!==b[3])return null;
          edits.push({start:offset+a[1].length,end:offset+oldLines[i].length-a[2].length,text:'[task:'+b[2]+']'});
        }offset+=oldLines[i].length+1;
      }
      let start=0,end=old.length,newEnd=now.length;
      while(start<end&&start<newEnd&&old[start]===now[start])start++;
      while(end>start&&newEnd>start&&old[end-1]===now[newEnd-1]){end--;newEnd--;}
      for(const edit of edits.reverse()){
        if(edit.end<=start){}else if(edit.start>=end){edit.start+=newEnd-end;edit.end+=newEnd-end;}else return null;
        const next=target.text.slice(0,edit.start)+edit.text+target.text.slice(edit.end);target.links=rebaseLinks(target.text,next,target.links);target.text=next;
      }
    }
    return result;
  }
  function draftRecovery(draft, base, editRevision) {
    const sameVersion=(draft.base_updated||null)===(base||null)||!!(editRevision&&draft.base_edit_revision===editRevision), reason=['task-rewrite','version'].includes(draft.recovery_reason)?draft.recovery_reason:!sameVersion?'version':null;
    return {sameVersion,blocked:!!reason,reason};
  }
  function reconcileDocument(current, next) {
    const existing = new Map((current || []).map(block => [block.id, block]));
    return clone(next).map(value => {
      const block = existing.get(value.id);
      if (!block || block.type !== value.type) return value;
      // Open photo and passage dialogs retain these objects while saves finish.
      for (const key of Object.keys(block)) delete block[key];
      Object.assign(block, value);
      return block;
    });
  }
  function photoReferences(documentValue) {
    const blocks = documentValue || [];
    const photos = blocks.filter(block => block.type === 'photo' && typeof block.asset_id === 'string');
    const byBlockId = new Map(photos.map(photo => [photo.id, photo.asset_id]));
    const seen = new Set(photos.map(photo => photo.asset_id));
    for (const block of blocks.filter(block => block.type === 'text')) {
      for (const link of block.links || []) for (const identity of link.photos || []) {
        const assetId = byBlockId.get(identity) || identity;
        if (typeof assetId !== 'string' || !assetId || seen.has(assetId)) continue;
        seen.add(assetId); photos.push({type: 'photo', asset_id: assetId, linked_only: true});
      }
    }
    return photos;
  }
  function photoStats(entries) {
    const found = new Map(), direct = new Set(), tagCounts = new Map(), series = {};
    [...entries].sort((a,b) => b.date.localeCompare(a.date)).forEach(e => photoReferences(e.document).forEach(b => {
      const prior = found.get(b.asset_id), merged = clone(prior?.tags || {});
      Object.entries(b.tags || {}).forEach(([gid, names]) => { merged[gid] = [...new Set([...(merged[gid] || []), ...names])].sort(); });
      if (!prior) series[e.date] = (series[e.date] || 0) + 1;
      if (!prior || (!direct.has(b.asset_id) && !b.linked_only)) {
        const photo = {...clone(b), date: prior?.date || e.date, details_date: e.date}; delete photo.linked_only;
        found.set(b.asset_id, photo);
      }
      found.get(b.asset_id).tags = merged;
      if (!b.linked_only) direct.add(b.asset_id);
    }));
    found.forEach(p => Object.entries(p.tags || {}).forEach(([gid, names]) => {
      if (!tagCounts.has(gid)) tagCounts.set(gid, new Map());
      const counts = tagCounts.get(gid);
      [...new Set(names)].forEach(name => { counts.set(name, (counts.get(name) || 0) + 1); });
    }));
    const tags = Object.fromEntries([...tagCounts].map(([gid, counts]) => [gid, Object.fromEntries(counts)]));
    return { photos: found.size, gallery: [...found.values()].sort((a,b) => b.date.localeCompare(a.date)), tags, series };
  }
  function photoDate(photo, assets) {
    return (assets[photo.asset_id]?.captured_at || photo.date || '').slice(0,10);
  }
  function photosInRange(photos, assets, from, to) {
    return photos.filter(photo => { const day=photoDate(photo,assets); return (!from || day>=from) && (!to || day<=to); });
  }
  const API = { rebaseLinks, splitText, documentBody, photoReferences, photoStats, photoDate, photosInRange, photoBlock, locationName, captionTagNames, mergeCommittedDocument, draftRecovery, reconcileDocument, mergePhotoTagFields, selectedPassage, setPassagePhotos, photoTagChoices };
  if (typeof module !== 'undefined') module.exports = API;
  if (typeof document === 'undefined') return;
  let state = { assets: {}, groups: {}, places: {}, messages: {} }, pending = new Map();
  const dialogClosers = new WeakMap();
  function closeTopDialog() {
    const escape = new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true});
    (document.activeElement || document).dispatchEvent(escape);
    if(escape.defaultPrevented)return true;
    const overlay = [...document.querySelectorAll('.media-overlay')].at(-1);
    const close = overlay && dialogClosers.get(overlay);
    if (!close) return false;
    close();
    return true;
  }
  const native = !!global.TodoPupNative;
  function element(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }
  function button(text, action, cls) { const b = element('button', 'media-action' + (cls ? ' ' + cls : ''), text); b.type = 'button'; b.onclick = async () => { if (b.dataset.busy) return; b.dataset.busy = '1'; try { await action(); } catch (e) { notice(e.message); } finally { delete b.dataset.busy; } }; return b; }
  function notice(text) { let host = document.getElementById('media-status'); if (!host) { host = element('div', 'media-toast'); host.id = 'media-status'; host.setAttribute('role', 'status'); document.body.append(host); } host.textContent = text; clearTimeout(host.timer); host.timer = setTimeout(() => host.remove(), 6000); }
  function reply(identity, value, error) { let call = pending.get(identity); if (!call) return; pending.delete(identity); if (error) { const e = Error(error.message || error); e.status = error.status; e.current = error.current; e.local = error.local; e.reason = error.reason; e.task_ref_index = error.task_ref_index; call.reject(e); } else call.resolve(value); }
  async function request(path, body) {
    if (native) return new Promise((resolve, reject) => { const identity = id(); pending.set(identity, { resolve, reject }); global.TodoPupNative.request(JSON.stringify({ id: identity, path, body: body ?? null })); });
    const response = await fetch(path.startsWith('/') ? path : '/journal/media/' + path, body == null ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) { const error = Error(typeof value.error === 'string' ? value.error : value.error?.message || 'Could not save'); error.status = response.status; error.current = value.current; throw error; }
    return value;
  }
  function acceptState(incoming) {
    // Native snapshots have their own persisted clock. Optimistic record
    // revisions can decrease when several offline edits receive one Mac ACK.
    if (native && Number.isSafeInteger(incoming.local_revision)) {
      if (!Number.isSafeInteger(state.local_revision) || incoming.local_revision > state.local_revision) {
        state = incoming; return state;
      }
      if (incoming.local_revision < state.local_revision) return state;
      // A separate import response may already have added an asset while this
      // equal-clock snapshot was in flight. Merge those records below.
    }
    // Web records are archived by revision, never removed by omission. Imports
    // and seeded groups can appear without advancing the global store revision.
    // Per-record merging also supports older native builds without a clock.
    const next = {...(Number(incoming.rev) < Number(state.rev) ? state : incoming)};
    for (const kind of ['assets','groups','places','messages']) {
      next[kind] = {...state[kind]};
      for (const [identity, record] of Object.entries(incoming[kind] || {})) {
        const current = next[kind][identity];
        if (!current || Number(record.rev || 0) >= Number(current.rev || 0)) next[kind][identity] = record;
      }
    }
    state = next;
    return state;
  }
  async function refresh() { return acceptState(await request('state')); }
  const mutationAttempts = new Map();
  async function mutate(kind, identity, patch) {
    const old = state[kind][identity], base = old?.rev ?? null;
    const key = kind + ':' + identity, signature = JSON.stringify([base, patch]);
    let attempt = mutationAttempts.get(key);
    if (!attempt || attempt.signature !== signature) {
      attempt = {signature, change: {op_id: id(), kind, id: identity, base_rev: base, patch: clone(patch)}};
      mutationAttempts.set(key, attempt);
    }
    // A failed response may still have committed. Replay the same operation
    // until an acknowledgement arrives, so its receipt makes retry harmless.
    const result = await request('state', {changes: [attempt.change]});
    if (mutationAttempts.get(key) === attempt) mutationAttempts.delete(key);
    if (result.conflicts?.length) throw Error('This item changed elsewhere. Reload to review it.');
    acceptState(result);
    return state[kind][identity];
  }
  function fileURL(assetId, variant = 'preview.webp') { return '/journal/media/file/' + assetId + '/' + variant; }
  function photoThumbnail(assetId, name = 'Photo') {
    const image = element('img'); image.alt = ''; image.loading = 'lazy';
    image.onerror = () => {
      if (!image.isConnected) return;
      const missing = element('div', 'media-image-unavailable');
      missing.append(element('strong', '', name), element('span', '', 'Preview unavailable'));
      image.replaceWith(missing);
    };
    image.src = fileURL(assetId, 'thumb.webp'); return image;
  }
  function dialog(title, wide = false) {
    const previous = document.activeElement, overlay = element('div', 'media-overlay'), box = element('section', 'media-dialog' + (wide ? ' media-dialog-wide' : ''));
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.tabIndex = -1; const heading = element('h3', '', title); heading.id = 'dialog-' + id(); box.setAttribute('aria-labelledby', heading.id);
    const top = element('div', 'media-dialog-title'), body = element('div', 'media-dialog-body'), actions = element('div', 'media-dialog-actions');
    const returnTargets = [previous, ...(previous?.closest('.media-overlay')?.mediaReturnTargets || [])];
    overlay.mediaReturnTargets = returnTargets;
    let closed = false, busy = false, busyFocus = null, disabledControls = []; const callbacks = [];
    const available = node => node?.isConnected && !node.matches(':disabled') && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
    const focusable = root => [...root.querySelectorAll('a[href],button,input,textarea,select,summary,[tabindex],[contenteditable="true"]')].filter(node => available(node) && (node.tabIndex >= 0 || (node.isContentEditable && !node.hasAttribute('tabindex'))));
    const topOverlay = () => [...document.querySelectorAll('.media-overlay')].at(-1);
    const setBusy = value => {
      value = !!value;
      if (busy === value || closed) return;
      busy = value; body.inert = value;
      if (value) {
        box.setAttribute('aria-busy', 'true'); busyFocus = document.activeElement;
        disabledControls = [...box.querySelectorAll('button,input,textarea,select,fieldset')].map(node => ({node, disabled: node.disabled}));
        disabledControls.forEach(({node}) => { node.disabled = true; });
        if (box.contains(busyFocus)) box.focus();
      } else {
        box.removeAttribute('aria-busy');
        disabledControls.forEach(({node, disabled}) => { node.disabled = disabled; }); disabledControls = [];
        if (available(busyFocus) && document.activeElement === box) busyFocus.focus();
        busyFocus = null;
      }
    };
    const close = () => {
      if (closed || busy) return;
      closed = true;
      try { callbacks.forEach(fn => fn()); }
      finally {
        overlay.remove(); document.removeEventListener('keydown', key);
        global.dispatchEvent(new CustomEvent('media:dialog-state',{detail:{open:!!document.querySelector('.media-overlay')}}));
        const remaining = topOverlay();
        if (!remaining) { document.body.style.overflow = document.body.dataset.mediaOverflow || ''; delete document.body.dataset.mediaOverflow; }
        // A parent may finish saving while its child remains open. Keep that
        // child's focus and retain the original page opener for its later close.
        if (!remaining?.contains(document.activeElement)) {
          const target = returnTargets.find(node => available(node) && (!remaining || remaining.contains(node)));
          (target || (remaining && (focusable(remaining)[0] || remaining.querySelector('.media-dialog'))))?.focus();
        }
      }
    };
    dialogClosers.set(overlay, close);
    const key = e => {
      if (topOverlay() !== overlay || e.defaultPrevented) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const list = focusable(box), active = document.activeElement;
      if (!list.length) { e.preventDefault(); box.focus(); return; }
      const boundary = e.shiftKey ? list[0] : list.at(-1);
      const direction = e.shiftKey ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
      const beyond = !list.includes(active) && !list.some(node => active.compareDocumentPosition(node) & direction);
      if (!box.contains(active) || active === boundary || beyond) {
        e.preventDefault(); (e.shiftKey ? list.at(-1) : list[0]).focus();
      }
    };
    const closeButton = button('×', close, 'media-close'); closeButton.setAttribute('aria-label','Close ' + title); top.append(heading, closeButton); box.append(top, body, actions); overlay.append(box); if (!document.querySelector('.media-overlay')) { document.body.dataset.mediaOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; } overlay.onclick = e => { if (e.target === overlay) close(); }; document.body.append(overlay); document.addEventListener('keydown', key); top.querySelector('button').focus(); global.dispatchEvent(new CustomEvent('media:dialog-state',{detail:{open:true}})); return { overlay, box, body, actions, close, setBusy, onClose: fn => callbacks.push(fn) };
  }
  function field(label, value = '', type = 'text') { const wrap = element('label', 'media-field'); wrap.append(element('span', 'label', label)); const input = element(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') input.type = type; input.value = value ?? ''; wrap.append(input); if (type === 'color') queueMicrotask(() => global.enhanceColor?.(input)); return { wrap, input }; }
  function toggle(label, checked, action) { const wrap = element('label', 'media-toggle'); const input = element('input'); input.type = 'checkbox'; input.checked = checked; input.onchange = () => action(input.checked); wrap.append(input, element('span', '', label)); return wrap; }
  function select(label, options, value) { const f = field(label); const input = element('select'); options.forEach(([v, t]) => { const option = element('option', '', t); option.value = v; input.append(option); }); input.value = value; f.input.replaceWith(input); queueMicrotask(() => global.enhanceSelect?.(input)); return { wrap: f.wrap, input }; }
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  function rich(text) { return global.journalRender ? global.journalRender(text, JSON.parse(document.getElementById('mention-index')?.textContent || '{}')) : escape(text).replaceAll('\n', '<br>'); }
  function captionTags(block) {
    const mentions=JSON.parse(document.getElementById('mention-index')?.textContent||'{}');
    block.tags=captionTagNames(block.caption,block.tags,Object.values(state.groups),mentions);
  }
  function photoTagPicker(group, selected = [], history = [], mentions = {}, manage = false) {
    const staged = clone(group), chosen = new Set(selected.map(n => n.trim().toLowerCase())), extra = [...history, ...selected];
    staged.tags ||= [];
    const wrap = element('section', 'media-photo-tag-group'), chips = element('div', 'media-tag-chips');
    wrap.append(element('h4', '', group.name), chips);
    const add = field('Add ' + group.name + ' tag'); add.input.maxLength = 100;
    add.input.setAttribute('aria-label', 'Add ' + group.name + ' tag'); add.input.placeholder = 'New tag';
    add.wrap.querySelector('.label').hidden = true;
    const newRow = element('div', 'media-photo-tag-add'), kinds = element('div', 'kind-toggle');
    const entry = element('div', 'media-photo-tag-input'), suggestions = element('div', 'media-photo-tag-suggest');
    suggestions.id = 'photo-tag-suggest-' + id(); suggestions.hidden = true;
    suggestions.setAttribute('role', 'listbox'); suggestions.setAttribute('aria-label', group.name + ' tag suggestions');
    add.input.setAttribute('role', 'combobox'); add.input.setAttribute('aria-autocomplete', 'list');
    add.input.setAttribute('aria-controls', suggestions.id); add.input.setAttribute('aria-expanded', 'false'); add.input.autocomplete = 'off';
    let matches = [], active = -1;
    const hideSuggestions = () => { suggestions.hidden = true; add.input.setAttribute('aria-expanded', 'false'); add.input.removeAttribute('aria-activedescendant'); active = -1; };
    const chooseSuggestion = name => {
      chosen.add(name); extra.push(name);
      if (manage || kinds.querySelector('input:checked').value === 'permanent') staged.tags = [...new Set([...staged.tags, name])];
      add.input.value = ''; hideSuggestions(); paint(); add.input.focus();
    };
    const showSuggestions = () => {
      const query = add.input.value.trim().toLowerCase();
      hideSuggestions(); suggestions.replaceChildren();
      matches = query ? photoTagChoices(staged, [], extra, mentions).filter(c => !chosen.has(c.name) && (!manage || !c.permanent) && c.name.includes(query)).slice(0, 8) : [];
      for (const [i, choice] of matches.entries()) {
        const option = button(choice.name, () => chooseSuggestion(choice.name));
        option.id = suggestions.id + '-' + i; option.tabIndex = -1;
        option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
        option.onpointerdown = e => e.preventDefault(); suggestions.append(option);
      }
      suggestions.hidden = !matches.length; add.input.setAttribute('aria-expanded', String(!!matches.length));
    };
    const radioName = 'photo-tag-kind-' + id();
    for (const kind of ['permanent','temporary']) {
      const label = element('label', 'kind-opt'), input = element('input');
      input.type = 'radio'; input.name = radioName; input.value = kind; input.checked = kind === 'temporary';
      label.append(input, element('span', '', kind)); kinds.append(label);
    }
    const paint = () => {
      chips.replaceChildren();
      const choices = photoTagChoices(staged, [...chosen], extra, mentions);
      for (const choice of choices.filter(c => c.permanent || (!manage && chosen.has(c.name)))) {
        const permanent = choice.permanent;
        const item = element('div', 'media-photo-tag-item' + (permanent ? '' : ' temp'));
        const chip = toggle(choice.name, chosen.has(choice.name), checked => {
          if (checked) chosen.add(choice.name);
          else { chosen.delete(choice.name); if (!permanent) { item.remove(); add.input.focus(); } }
        });
        const input = chip.querySelector('input'); input.value = choice.name; input.dataset.photoTag = group.id;
        if (manage) input.remove();
        const move = button(permanent ? '↓' : '↑', () => {
          extra.push(choice.name);
          staged.tags = permanent ? staged.tags.filter(n => n !== choice.name) : [...new Set([...staged.tags, choice.name])];
          paint(); add.input.focus();
        }, 'media-photo-tag-move');
        move.title = move.ariaLabel = 'Make ' + choice.name + (permanent ? ' temporary' : ' permanent');
        item.append(chip, move); chips.append(item);
      }
    };
    const flush = () => {
      const name = add.input.value.trim().toLowerCase();
      if (!name) return;
      if (name.length > 100 || /[\u0000-\u001f]/.test(name)) throw Error('Use a tag of 1–100 characters.');
      chosen.add(name); extra.push(name);
      if (manage || kinds.querySelector('input:checked').value === 'permanent') staged.tags = [...new Set([...staged.tags, name])];
      add.input.value = ''; hideSuggestions(); paint();
    };
    const addButton = button('Add tag', flush);
    add.input.oninput = showSuggestions; add.input.onfocus = showSuggestions; add.input.onblur = hideSuggestions;
    add.input.onkeydown = e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && !suggestions.hidden) { e.preventDefault(); e.stopPropagation(); hideSuggestions(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (suggestions.hidden) showSuggestions();
        if (!matches.length) return;
        e.preventDefault();
        active = e.key === 'ArrowDown' ? (active + 1) % matches.length : (active < 0 ? matches.length - 1 : (active - 1 + matches.length) % matches.length);
        [...suggestions.children].forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
        const option = suggestions.children[active]; add.input.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({block:'nearest'});
      } else if (e.key === 'Enter') {
        e.preventDefault(); if (!suggestions.hidden && active >= 0) chooseSuggestion(matches[active].name); else addButton.click();
      }
    };
    entry.append(add.wrap, suggestions); newRow.append(entry); if (!manage) newRow.append(kinds); newRow.append(addButton); wrap.append(newRow); paint();
    return {wrap, group: staged, values: () => { flush(); return [...chosen]; },
      add: name => { if (name) { name = name.trim().toLowerCase(); chosen.add(name); extra.push(name); paint(); } }};
  }
  async function savePhotoTagGroups(pickers) {
    const attempts = pickers.filter(p => JSON.stringify(p.group.tags) !== JSON.stringify(state.groups[p.group.id]?.tags || []) || (p.shareEntryEdited && !!p.group.share_entry !== !!state.groups[p.group.id]?.share_entry))
      .map(p => {
        const key = 'groups:' + p.group.id, base = p.group.rev ?? null, patch = {tags:p.group.tags};
        if(p.shareEntryEdited&&!!p.group.share_entry!==!!state.groups[p.group.id]?.share_entry)patch.share_entry=!!p.group.share_entry;
        const signature = JSON.stringify([base, patch]);
        let attempt = mutationAttempts.get(key);
        if (!attempt || attempt.signature !== signature) {
          attempt = {signature, change:{op_id:id(),kind:'groups',id:p.group.id,base_rev:base,patch:clone(patch)}};
          mutationAttempts.set(key, attempt);
        }
        return {key, attempt};
      });
    if (!attempts.length) return;
    const result = await request('state', {changes:attempts.map(item => item.attempt.change)});
    for (const {key, attempt} of attempts) if (mutationAttempts.get(key) === attempt) mutationAttempts.delete(key);
    if (result.conflicts?.length) { await refresh(); throw Error('Photo tags changed elsewhere. Reopen details to review them.'); }
    acceptState(result);
  }
  async function upload(file) {
    const form = new FormData(); form.append('file', file);
    const response = await fetch('/journal/media/upload', { method: 'POST', body: form }); const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Could not add photo'); state.assets[result.asset.id] = result.asset; return await locateAsset(result.asset);
  }
  async function locateAsset(asset) {
    if (!asset.location || asset.location_label || !global.TodoPupMap) return asset;
    try {
      const saved = global.TodoPupMap.nearestPlace(asset.location, Object.values(state.places));
      const found = saved || await global.TodoPupMap.lookup(asset.location, (await request('maps')).packs);
      if (found) {
        asset = await mutate('assets', asset.id, {location_label:found.name});
        if (!saved) await mutate('places', id(), {name:found.name,lat:asset.location.lat,lon:asset.location.lon,radius_m:100,city:'',is_city:false});
      }
    } catch(e) { /* Missing regional detail leaves coordinates available for manual naming. */ }
    return asset;
  }
  async function choosePhotoFiles() {
    return new Promise(resolve => {
      const input = element('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.hidden = true;
      const finish = assets => { input.remove(); resolve(assets); };
      input.onchange = async () => { const assets = []; try { for (const file of input.files) { notice('Adding ' + file.name + '…'); assets.push(await upload(file)); } } catch (e) { notice(e.message); } finish(assets); };
      input.oncancel = () => finish([]);
      document.body.append(input); input.click();
    });
  }
  async function pickPhotos(date) {
    if (native) { const result = await request('pick-photos',date?{date}:null); result.assets.forEach(a => { state.assets[a.id] = a; }); return await Promise.all(result.assets.map(locateAsset)); }
    await refresh();
    return new Promise(resolve => {
      const d = dialog('Photo gallery', true), grid = element('div', 'media-gallery media-picker-grid'), selected = new Map();
      let finished = false;
      const done = assets => { finished = true; d.close(); resolve(assets); };
      d.onClose(() => { if (!finished) resolve([]); });
      const confirm = button('Add photos', () => done([...selected.values()]), 'save'); confirm.disabled = true;
      const paint = () => {
        grid.replaceChildren();
        const assets = Object.values(state.assets).filter(a => !a.is_sticker && !a.source_asset_id).sort((a,b) => (b.captured_at || b.created || '').localeCompare(a.captured_at || a.created || ''));
        for (const asset of assets) {
          const card = button('', () => {
            if (selected.has(asset.id)) selected.delete(asset.id); else selected.set(asset.id, asset);
            card.setAttribute('aria-pressed', String(selected.has(asset.id))); confirm.disabled = !selected.size;
            confirm.textContent = selected.size ? 'Add ' + selected.size + (selected.size === 1 ? ' photo' : ' photos') : 'Add photos';
          }, 'media-gallery-card media-picker-card');
          card.setAttribute('aria-label', asset.filename || 'Photo'); card.setAttribute('aria-pressed', String(selected.has(asset.id)));
          const img = photoThumbnail(asset.id, asset.filename || 'Photo');
          card.append(img, element('span', '', (asset.captured_at || asset.created || '').slice(0,10))); grid.append(card);
        }
        if (!assets.length) grid.append(element('p', 'muted', 'No photos yet.'));
      };
      d.body.append(button('Add photos from device', async () => {
          const assets = await choosePhotoFiles();
          if (assets.length && d.overlay.isConnected) done(assets);
        }), grid);
      d.actions.append(button('Cancel', d.close), confirm); paint();
    });
  }
  function photoLocation(block) {
    const asset=state.assets[block.asset_id]||{},point=asset.location;
    return locationName(block.location_label||asset.location_label)||(point?`${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`:'');
  }
  function previewLocation(name, points) {
    const valid=points.filter(p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon));
    if(!valid.length){notice('No location saved.');return;}
    const d=dialog(locationName(name)||'Location');d.box.classList.add('media-location-preview');
    const host=element('div','media-map-host'),status=element('p','media-map-status','Loading map…');status.setAttribute('role','status');
    const retry=button('Retry map',load);retry.hidden=true;d.body.append(host,status,retry);
    const map=new global.TodoPupMap.OfflineMap(host,{packs:[],lat:valid[0].lat,lon:valid[0].lon,zoom:17});map.setMarkers(valid);
    if(valid.length>1)map.fit([Math.min(...valid.map(p=>p.lon))-.0001,Math.min(...valid.map(p=>p.lat))-.0001,Math.max(...valid.map(p=>p.lon))+.0001,Math.max(...valid.map(p=>p.lat))+.0001]);
    d.onClose(()=>map.destroy());
    async function load(){
      retry.hidden=true;status.hidden=false;status.textContent='Loading map…';
      try{const result=await request('maps');if(d.overlay.isConnected){map.setPacks(result.packs||[]);status.hidden=true;}}
      catch(_){if(d.overlay.isConnected){status.textContent='Map unavailable.';retry.hidden=false;}}
    }
    load();return d;
  }
  function locationPreviewTrigger(control,name,points) {
    let timer=null,start=null,suppressUntil=0;
    const cancel=()=>{clearTimeout(timer);timer=null;};
    const open=()=>{cancel();if(!control.isConnected)return;control.focus({preventScroll:true});suppressUntil=Date.now()+700;previewLocation(typeof name==='function'?name():name,typeof points==='function'?points():points);};
    control.title='Hold for map preview';
    control.addEventListener('pointerdown',e=>{if(e.button!==0)return;start={x:e.clientX,y:e.clientY};cancel();timer=setTimeout(open,500);});
    control.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>8)cancel();});
    for(const event of ['pointerup','pointercancel','pointerleave'])control.addEventListener(event,cancel);
    control.addEventListener('click',e=>{if(Date.now()<suppressUntil){e.preventDefault();e.stopImmediatePropagation();}},true);
    control.addEventListener('contextmenu',e=>{e.preventDefault();if(Date.now()>=suppressUntil)open();});
    control.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();open();}});
    return control;
  }
  function viewPhotos(blocks, options = {}) {
    const d = dialog(blocks.length > 1 ? 'Photos' : 'Photo', true);
    d.box.classList.add('media-photo-viewer');
    const paintPhoto = (b, previous) => {
        if(blocks.length===1){d.actions.replaceChildren();d.actions.hidden=false;}
        const figure=element('figure','media-preview-photo'), asset=state.assets[b.asset_id]||{};
        const feedback=element('div','media-preview-actions'), status=element('p','media-map-status','Loading photo…');
        status.setAttribute('role','status');status.tabIndex=-1;
        const retry=button('Retry photo',loadImage);retry.hidden=true;feedback.append(status,retry);figure.append(feedback);
        let loading=false;
        function loadImage(){
          if(loading||!d.overlay.isConnected)return;
          loading=true;const restoreFocus=document.activeElement===retry;
          status.textContent='Loading photo…';retry.hidden=true;if(restoreFocus)status.focus();
          const image=element('img','media-full-image');image.alt=b.caption||asset.filename||'Journal photo';
          image.onload=()=>{
            if(!figure.isConnected)return;
            loading=false;const hadFocus=feedback.contains(document.activeElement);feedback.remove();figure.prepend(image);
            if(hadFocus)d.box.querySelector('.media-close').focus();
          };
          image.onerror=()=>{
            if(!figure.isConnected)return;
            loading=false;status.textContent='Photo unavailable.';retry.hidden=false;
            if(document.activeElement===status)retry.focus();
          };
          image.src=fileURL(b.edited_asset_id||b.asset_id);
        }
        const editable=!!(options.onChange||options.saveDetails);let detailActions;
        if(editable){
          const summary=element('div','media-photo-summary'),fields=element('div','media-photo-inline');fields.hidden=true;
          const captionButton=button(b.caption||'Add caption',()=>edit('caption'),'media-inline-caption');if(b.caption)captionButton.innerHTML=rich(b.caption);captionButton.setAttribute('aria-label','Edit caption');summary.append(captionButton);
          const locationButton=button(photoLocation(b)||'Add location name',()=>edit('location'),'media-location-label');locationButton.setAttribute('aria-label','Edit location name');
          locationPreviewTrigger(locationButton,()=>photoLocation(b),()=>[asset.location]);summary.append(locationButton);
          const caption=field('Caption',b.caption||'','textarea'),location=field('Location name',b.location_label||'');location.input.placeholder=photoLocation(b)||'Location name';location.input.maxLength=300;
          const status=element('p','media-form-error');status.hidden=true;status.setAttribute('role','status');
          const actions=element('div','media-preview-actions');
          function edit(which){summary.hidden=true;fields.hidden=false;if(detailActions)detailActions.hidden=true;(which==='caption'?caption.input:location.input).focus();}
          actions.append(button('Cancel',()=>{caption.input.value=b.caption||'';location.input.value=b.location_label||'';fields.hidden=true;summary.hidden=false;if(detailActions)detailActions.hidden=false;captionButton.focus();}),button('Save',async()=>{
            const patch={caption:caption.input.value,location_label:location.input.value};d.setBusy(true);status.hidden=true;
            try{
              if(options.saveDetails)Object.assign(b,await options.saveDetails(b,patch));
              else{Object.assign(b,patch);captionTags(b);await options.onChange(b);}
            }catch(error){status.textContent=error.message||'Could not save.';status.hidden=false;return;}
            finally{d.setBusy(false);}
            const updated=paintPhoto(b,figure);updated.querySelector('[aria-label="Edit caption"]')?.focus();
          },'save'));
          fields.append(caption.wrap,location.wrap,status,actions);figure.append(summary,fields);
        }else{
          if(b.caption){const caption=element('figcaption','media-caption');caption.innerHTML=rich(b.caption);figure.append(caption);}
          if(photoLocation(b)){const location=button(photoLocation(b),()=>previewLocation(photoLocation(b),[asset.location]),'media-location-label');locationPreviewTrigger(location,()=>photoLocation(b),()=>[asset.location]);figure.append(location);}
        }
        if(options.onChange){
          const actions=blocks.length===1?d.actions:element('div','media-preview-actions');
          detailActions=actions;
          const changed=async()=>{await options.onChange(b);if(d.overlay.isConnected)paintPhoto(b,figure);};
          actions.append(button('Edit photo',async()=>{if(global.PupPhotoEdit)await global.PupPhotoEdit.open(b,changed);}),button('Photo details',()=>editBlock(b,changed)));
          if(blocks.length>1)figure.append(actions);
        }
        if(previous)previous.replaceWith(figure);else d.body.append(figure);
        loadImage();return figure;
    };
    blocks.forEach(b=>paintPhoto(b));return d;
  }
  async function openEntryPhoto(date, summary, onSaved=()=>{}, isCurrent=()=>true) {
    if(!isCurrent())return null;
    if(!native)return viewPhotos([summary]);
    if(global.PupJournalEditor?.date===date){
      await global.PupJournalEditor.refreshNativeStatus();
      if(!isCurrent())return null;
      if(await global.PupJournalEditor.prepareNavigation()===false){notice('Review the journal changes first.');return null;}
    }
    if(!isCurrent())return null;
    const result=await request('entry/'+date),entry=result.entry;
    if(!isCurrent())return null;
    if(!entry)throw Error('This entry is no longer available.');
    const matches=(entry.document||[]).filter(b=>b.type==='photo'&&b.asset_id===summary.asset_id);
    const direct=matches.find(b=>b.id===summary.id)||(!summary.id&&matches.length===1?matches[0]:null);
    if(!direct&&matches.length)throw Error('This photo changed. Reopen it from the entry.');
    const block=direct?clone(direct):{id:id(),type:'photo',asset_id:summary.asset_id,caption:'',location_label:'',hidden:true};
    return viewPhotos([block],{saveDetails:async(current,patch)=>{
      const reply=await request('journal/'+date+'/photo-details',{asset_id:current.asset_id,block_id:current.id,base_caption:current.caption||'',base_location_label:current.location_label||'',...patch});
      const saved=reply.entry,updated=saved?.document?.find(b=>b.id===current.id)||saved?.document?.find(b=>b.type==='photo'&&b.asset_id===current.asset_id);
      if(!updated)throw Error('Photo save could not be confirmed.');
      global.PupJournalEditor?.acceptPhotoEntry?.(saved);
      await onSaved(saved);
      document.dispatchEvent(new CustomEvent('journal:saved',{detail:{date,entry:saved}}));
      return updated;
    }});
  }
  async function editBlock(block, onChange) {
    const draft = clone(block), d = dialog(block.type === 'photo' ? 'Photo details' : 'Message details');
    const caption = field('Caption', draft.caption, 'textarea'); d.body.append(caption.wrap);
    d.body.append(toggle('Show caption', draft.caption_visible !== false, v => draft.caption_visible = v));
    if (block.type === 'photo') d.body.append(toggle('Show only from linked text', !!draft.hidden, v => draft.hidden = v));
    const groupFields = []; let saveDetails;
    if (block.type === 'photo') {
      const history = await request('analytics').catch(() => ({tags:{}}));
      if (!d.overlay.isConnected) return;
      const mentions = JSON.parse(document.getElementById('mention-index')?.textContent || '{}');
      Object.values(state.groups).filter(g => !g.archived).sort((a,b)=>Number(b.id==='people')-Number(a.id==='people')||a.name.localeCompare(b.name)).forEach(g => {
        const picker = photoTagPicker(g, draft.tags?.[g.id] || [], Object.keys(history.tags?.[g.id] || {}), mentions);
        groupFields.push(picker); d.body.append(picker.wrap);
      });
    }
    const label = field('Location display name', draft.location_label || state.assets[draft.asset_id]?.location_label || ''), color = field('Location label color', draft.location_color || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), 'color');
    if (block.type === 'photo') {
      const location = state.assets[draft.asset_id]?.location;
      d.body.append(element('p', 'media-photo-gps', location ? 'Photo location · ' + location.lat.toFixed(5) + ', ' + location.lon.toFixed(5) : 'No location stored in this photo.'), toggle('Show location below this photo', !!draft.location_visible, v => draft.location_visible = v), label.wrap, color.wrap);
      d.body.append(button('Correct location on map…', () => editPhotoLocation(draft.asset_id, () => { draft.location_label = ''; label.input.value = state.assets[draft.asset_id]?.location_label || ''; groupFields.find(p=>p.group.id==='locations')?.add(label.input.value);onChange(); })));
      const captured = field('Taken at · saves separately', state.assets[draft.asset_id]?.captured_at?.slice(0,16) || '', 'datetime-local');
      captured.input.dataset.emptyLabel='Time unknown';
      const status = element('p', 'media-map-status'); status.hidden = true; status.tabIndex = -1; status.setAttribute('role', 'status');
      const retryTime = button('Retry time', saveTime); retryTime.hidden = true;
      d.body.append(captured.wrap, status, retryTime); global.enhanceDatetime?.(captured.input);
      let timePending = false, acceptingTime = false;
      async function saveTime() {
        if (timePending) return;
        timePending = true; const value = captured.input.value || null, hadFocus = captured.wrap.contains(document.activeElement);
        captured.input.disabled = true; saveDetails.disabled = true; retryTime.hidden = true;
        status.hidden = false; status.classList.remove('media-form-error'); status.textContent = 'Saving time…';
        if (hadFocus) queueMicrotask(() => { if (d.overlay.isConnected) status.focus(); });
        let failed = false;
        try {
          const asset = await mutate('assets', draft.asset_id, {captured_at: value});
          captured.input.value = asset.captured_at?.slice(0,16) || '';
          acceptingTime = true; captured.input.dispatchEvent(new Event('change', {bubbles:true})); acceptingTime = false;
          status.textContent = 'Time saved';
        } catch (error) {
          failed = true; status.textContent = error.message || 'Could not save time.'; status.classList.add('media-form-error'); retryTime.hidden = false;
        } finally {
          timePending = false; captured.input.disabled = false; saveDetails.disabled = failed;
          if (d.overlay.isConnected && document.activeElement === status) {
            if (failed) retryTime.focus();
            else queueMicrotask(() => captured.wrap.querySelector('.dt-trigger')?.focus());
          }
        }
      }
      captured.input.onchange = () => { if (!acceptingTime) saveTime(); };
    }
    const width = select('Photo width', [['full', 'Full width'], ['medium', 'Medium'], ['small', 'Small']], draft.width || 'full'); if (block.type === 'photo') d.body.append(width.wrap);
    saveDetails = button('Save', async () => {
      draft.caption = caption.input.value; draft.tags ||= {};
      for (const picker of groupFields) { const names = picker.values(); if (names.length) draft.tags[picker.group.id] = names; else delete draft.tags[picker.group.id]; }
      draft.location_label = label.input.value; draft.location_color = color.input.value; draft.width = width.input.value;
      d.setBusy(true);
      try {
        await savePhotoTagGroups(groupFields);
        captionTags(draft); Object.assign(block, draft); await onChange();
      } finally { d.setBusy(false); }
      d.close();
    }, 'save');
    d.actions.append(button('Cancel', d.close), saveDetails);
    return d;
  }
  class Editor {
    constructor(host, documentValue, body, onChange, options = {}) { this.options = options; this.host = host; this.doc = documentValue || [{ id: id(), type: 'text', text: body || '', links: [] }]; this.onChange = onChange; this.active = null; this.host.classList.add('media-document'); this.render(); }
    get doc() { return this._doc; }
    set doc(value) { this._doc = reconcileDocument(this._doc, value); }
    changed(immediate = false) { this.onChange(this.doc, immediate); }
    preview(blocks) {
      const origin=document.activeElement,returnId=origin?.closest('[data-block-id]')?.dataset.blockId||blocks[0]?.id,returnText=origin?.classList.contains('media-text-link')?origin.textContent:null;
      const d=viewPhotos(blocks,this.options.readOnly?{}:{onChange:()=>{this.render();this.changed(true);}});
      d.onClose(()=>queueMicrotask(()=>{if(document.querySelector('.media-overlay'))return;const wrap=[...this.host.children].find(el=>el.dataset.blockId===returnId);const target=returnText?[...wrap?.querySelectorAll('.media-text-link')||[]].find(el=>el.textContent===returnText):wrap?.querySelector('.media-photo,.media-hidden-photo');target?.focus();}));
      return d;
    }
    destroy() { this.selectionEvents?.abort(); }
    refreshTaskLinks() {
      for(const current of this.host.querySelectorAll('.task-check[data-task-id]')){
        const parsed=element('span');parsed.innerHTML=rich('[task:'+current.dataset.taskId+'] task');
        const next=parsed.querySelector('.task-check');if(!next||next.outerHTML===current.outerHTML)continue;
        const focused=document.activeElement===current,paragraph=current.closest('.media-paragraph-view');
        current.replaceWith(next);
        if(focused)(next.tagName==='A'?next:paragraph)?.focus({preventScroll:true});
      }
    }
    async details(block) {
      const d=await editBlock(block,()=>{this.render();this.changed(true);});
      d?.onClose(()=>queueMicrotask(()=>{
        if(document.querySelector('.media-overlay'))return;
        const wrap=[...this.host.children].find(el=>el.dataset.blockId===block.id);
        [...wrap?.querySelectorAll('.media-block-controls button')||[]].find(button=>button.textContent==='Details')?.focus();
      }));
    }
    insertAssets(assets) {
      const sorted = [...assets].sort((a,b) => (a.captured_at || a.created || '').localeCompare(b.captured_at || b.created || ''));
      this.insertPhotoBlocks(sorted.map(a => photoBlock(a)));
    }
    insertPhotoBlocks(values) {
      const blocks=clone(values); if(!blocks.length)return;
      let at = this.doc.length, tail = null;
      if (this.active) { const b = this.doc.find(b => b.id === this.active.block.id), textarea = this.active.input; if (b) { at = this.doc.indexOf(b) + 1; let caret = textarea.selectionEnd; const lineStart = b.text.lastIndexOf('\n',caret-1)+1, nextLine = b.text.indexOf('\n',caret); if (/^\s*\[(?:\]|task:)/.test(b.text.slice(lineStart))) caret = nextLine < 0 ? b.text.length : nextLine; const split = splitText(b.text,caret,b.links); tail = { id:id(),type:'text',...split.after }; Object.assign(b,split.before); } }
      this.doc.splice(at, 0, ...blocks, tail || { id: id(), type: 'text', text: '', links: [] }); this.active = null; this.render(); this.changed(true); const input = this.host.querySelector('[data-block-id="' + (tail?.id || this.doc[at + blocks.length].id) + '"] textarea'); input?.focus();
    }
    move(identity, direction) {
      const at = this.doc.findIndex(b => b.id === identity), target = at + direction;
      if (at < 0 || target < 0 || target >= this.doc.length) return;
      const origin=document.activeElement,action=origin?.closest('[data-block-id]')?.dataset.blockId===identity?origin.getAttribute('aria-label'):null;
      this.doc.splice(target, 0, this.doc.splice(at, 1)[0]); this.render(); this.changed(true);
      if(action){const wrap=[...this.host.children].find(el=>el.dataset.blockId===identity),buttons=[...wrap?.querySelectorAll('.media-block-controls button')||[]];
        (buttons.find(b=>!b.disabled&&b.getAttribute('aria-label')===action)||buttons.find(b=>!b.disabled&&/^Move insert /.test(b.getAttribute('aria-label')||'')))?.focus();}
    }
    remove(identity) {
      const at=this.doc.findIndex(b=>b.id===identity),restore=document.activeElement?.closest('[data-block-id]')?.dataset.blockId===identity;
      this.doc = this.doc.filter(b => b.id !== identity); this.doc.forEach(b => { if (b.links) b.links = b.links.map(l => ({ ...l, photos: l.photos.filter(p => p !== identity) })).filter(l => l.photos.length); }); if (!this.doc.length) this.doc.push({ id: id(), type: 'text', text: '', links: [] }); this.render(); this.changed(true);
      if(restore){const wrap=this.host.children[Math.min(at,this.doc.length-1)];(wrap?.querySelector('.media-paragraph-view:not([hidden]),textarea:not([hidden]),.media-photo,.media-hidden-photo')||wrap?.querySelector('button:not(:disabled)'))?.focus();}
    }
    async linkSelection() {
      const current = this.active, passage=current&&selectedPassage(current.input.value,current.input.selectionStart,current.input.selectionEnd);
      if (!passage) return;
      const {start,end}=passage, snapshot={start,end,text:current.block.text};
      const existing = (current.block.links || []).find(l => l.start === start && l.end === end); const d = dialog('Photos for this passage'), picked = new Set(existing?.photos || []); if (!this.doc.some(b=>b.type==='photo')) d.body.append(element('p','muted','No photos in this entry.'));
      const saveLinks=photos=>{if(!this.doc.includes(current.block))throw Error('This paragraph changed. Close this window and select the passage again.');setPassagePhotos(current.block,snapshot,photos);this.render();this.changed(true);d.close();};
      const apply=button('Link photos',()=>{if(picked.size)saveLinks([...picked]);},'save');apply.disabled=!picked.size;
      this.doc.filter(b => b.type === 'photo').forEach(b => { const row = toggle(b.caption || state.assets[b.asset_id]?.filename || 'Photo', picked.has(b.id), yes => {if(yes)picked.add(b.id);else picked.delete(b.id);apply.disabled=!picked.size;}); const image = element('img', 'media-link-thumb'); image.src = fileURL(b.edited_asset_id||b.asset_id, 'thumb.webp'); row.prepend(image); d.body.append(row); });
      d.actions.append(button('Cancel', d.close));
      if(existing)d.actions.append(button('Remove link',()=>saveLinks([])));
      d.actions.append(apply);
    }
    render() {
      this.selectionEvents?.abort();this.selectionEvents=new AbortController();
      this.active = null;
      this.host.replaceChildren();
      for (const block of this.doc) {
        const wrap = element('div', 'media-block media-block-' + block.type); wrap.dataset.blockId = block.id;
        wrap.ondragover = e => { if (e.dataTransfer.types.includes('application/x-todopup-block')) { e.preventDefault(); wrap.classList.add('drop-target'); } };
        wrap.ondragleave = () => wrap.classList.remove('drop-target');
        wrap.ondrop = e => { const identity = e.dataTransfer.getData('application/x-todopup-block'); if (!identity) return; e.preventDefault(); const source = this.doc.findIndex(b => b.id === identity), target = this.doc.indexOf(block); if (source >= 0 && target >= 0) { this.doc.splice(target, 0, this.doc.splice(source, 1)[0]); this.render(); this.changed(true); } };
        if (block.type === 'text') {
          const input = element('textarea', 'media-paragraph-input'), rendered = element('div', 'media-paragraph-view'); input.value = block.text || ''; input.placeholder = "the day's events…"; input.setAttribute('aria-label', 'Journal paragraph');
          const resize = () => { input.style.height = 'auto'; input.style.height = Math.max(72, input.scrollHeight) + 'px'; };
          const paint = () => { rendered.replaceChildren(); let pos = 0, chars = [...(block.text || '')]; const links = [...(block.links || [])].sort((a,b) => a.start - b.start); for (const link of links) { if (link.start < pos) continue; const span = element('span'); span.innerHTML = rich(chars.slice(pos, link.start).join('')); rendered.append(span); const anchor = button(chars.slice(link.start, link.end).join(''), () => this.preview(this.doc.filter(b => link.photos.includes(b.id))), 'media-text-link'); rendered.append(anchor); pos = link.end; } const span = element('span'); span.innerHTML = rich(chars.slice(pos).join('')); rendered.append(span); };
          paint(); rendered.hidden = !block.text; input.hidden = !!block.text;
          const edit = () => { input.hidden = false; rendered.hidden = true; resize(); input.focus(); this.active = { block, input }; };
          rendered.onclick = e => { if (!e.target.closest('button,a')) edit(); }; rendered.tabIndex = 0; rendered.onkeydown = e => { if (e.key === 'Enter' && e.target === rendered) { e.preventDefault(); edit(); } };
          input.onfocus = () => { this.active = { block, input }; resize(); };
          if (!this.options.readOnly && this.options.record) {
            const record = button('', () => {
              if (this.active?.block.id !== block.id && input.hidden) input.setSelectionRange(input.value.length, input.value.length);
              this.active = {block, input}; return this.options.record({block,input,wrap,record});
            }, 'dictation-mic');
            record.setAttribute('aria-label', 'Record voice'); record.title = 'Record voice';
            if(this.options.recordUnavailable){record.disabled=true;record.title=this.options.recordUnavailable;}
            const dot = element('span', 'dictation-mic-dot'); dot.setAttribute('aria-hidden', 'true'); record.append(dot);
            // Keep the paragraph caret when opening Android's recording dialog.
            record.onpointerdown = e => e.preventDefault();
            wrap.append(record);
          }
          const selectionActions=element('div','media-selection-actions');selectionActions.hidden=true;
          const linkPhoto=button('Link photo',()=>this.linkSelection());linkPhoto.onpointerdown=e=>e.preventDefault();selectionActions.append(linkPhoto);
          const selectionChanged=()=>{selectionActions.hidden=this.options.readOnly||!(document.activeElement===input||selectionActions.contains(document.activeElement))||!selectedPassage(input.value,input.selectionStart,input.selectionEnd);};
          input.onselect=selectionChanged;input.onkeyup=selectionChanged;input.onpointerup=selectionChanged;
          if(!this.options.readOnly)document.addEventListener('selectionchange',selectionChanged,{signal:this.selectionEvents.signal});
          selectionActions.onfocusout=e=>{if(e.relatedTarget===input||selectionActions.contains(e.relatedTarget))return;selectionActions.hidden=true;paint();if(block.text){input.hidden=true;rendered.hidden=false;}};
          input.oninput = () => { block.links = rebaseLinks(block.text || '', input.value, block.links); block.text = input.value; resize(); selectionChanged();this.changed(); };
          input.onblur = e => { const source = document.querySelector('[name=body]'); source?.dispatchEvent(new Event('blur')); if(selectionActions.contains(e.relatedTarget))return;selectionActions.hidden=true;paint(); if (block.text) { if (this.options.record) rendered.style.minHeight = input.getBoundingClientRect().height + 'px'; input.hidden = true; rendered.hidden = false; } };
          if (this.options.readOnly) { input.hidden = true; rendered.hidden = false; rendered.onclick = null; rendered.onkeydown = null; rendered.removeAttribute('tabindex'); } wrap.append(input, rendered,selectionActions);
        } else {
          const controls = element('div', 'media-block-controls'), grip = button('⠿', () => {}, 'media-grip'); grip.draggable = true; grip.title = 'Drag to move'; grip.setAttribute('aria-label','Drag insert to move'); grip.ondragstart = e => { e.dataTransfer.setData('application/x-todopup-block', block.id); e.dataTransfer.effectAllowed = 'move'; };
          const insertName=block.type==='photo'?'Photo':'Message',context=block.caption||(block.type==='photo'?state.assets[block.asset_id]?.filename:state.messages[block.message_id]?.author_name);
          controls.setAttribute('role','group');controls.setAttribute('aria-label',insertName+' insert'+(context?': '+context:''));
          const remove=button('×',async()=>{if(await global.confirmModal('Remove this insert? The original stays in your library.','Remove'))this.remove(block.id);});remove.setAttribute('aria-label','Remove '+insertName.toLowerCase());
          const up = button('↑', () => this.move(block.id, -1)), down = button('↓', () => this.move(block.id, 1)); up.setAttribute('aria-label','Move insert up'); down.setAttribute('aria-label','Move insert down'); up.disabled = this.doc.indexOf(block) === 0; down.disabled = this.doc.indexOf(block) === this.doc.length-1; controls.append(grip, up, down, button('Details', () => this.details(block)), remove);
          if (block.type === 'photo') {
            if (block.hidden) wrap.append(button('▧ Photo linked to text', () => this.preview([block]), 'media-hidden-photo'));
            else {
              const image = element('img', 'media-photo media-photo-' + (block.width || 'full'));
              let retrying = false;
              const retry = button('Photo unavailable · Retry', () => {
                if (retrying) return;
                retrying = true; retry.setAttribute('aria-disabled', 'true'); retry.textContent = 'Retrying photo…'; image.loading = 'eager'; image.src = fileURL(block.edited_asset_id || block.asset_id);
              }, 'media-hidden-photo');
              image.onerror = () => {
                if (!wrap.isConnected) return;
                const focused = document.activeElement === image || document.activeElement === retry;
                if (image.isConnected) image.replaceWith(retry);
                retrying = false; retry.removeAttribute('aria-disabled'); retry.textContent = 'Photo unavailable · Retry'; if (focused) retry.focus();
              };
              image.onload = () => {
                if (!retry.isConnected) return;
                retrying = false; retry.removeAttribute('aria-disabled');
                const focused = document.activeElement === retry; retry.replaceWith(image); if (focused) image.focus();
              };
              image.loading = 'lazy'; image.src = fileURL(block.edited_asset_id || block.asset_id);
              image.alt = block.caption || state.assets[block.asset_id]?.filename || 'Journal photo';
              image.onclick = () => this.preview([block]); image.tabIndex = 0; image.setAttribute('role','button');
              image.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.preview([block]); } };
              wrap.append(image);
            }
          }
          else { const m = state.messages[block.message_id] || {}, quote = element('div', 'discord-insert'); const avatar = element('div', 'discord-avatar', (m.author_name || '?')[0]); const content = element('div', 'discord-content'), header = element('div', 'discord-heading'); header.append(element('strong', '', m.author_name || 'Discord message'), element('time', '', m.timestamp ? new Date(m.timestamp).toLocaleString() : '')); const text = element('div'); text.innerHTML = rich(m.content || 'Message unavailable until sync completes.'); content.append(header, text); for(const attachment of m.attachments||[]) content.append(element('p','muted','▧ '+(attachment.filename||'Attachment'))); if (m.source_url) { const a = element('a', 'muted', 'Open in Discord ↗'); a.href = m.source_url; a.target = '_blank'; a.rel = 'noopener'; content.append(a); } quote.append(avatar, content); wrap.append(quote); }
          if (block.type === 'message' && block.caption && block.caption_visible === false) wrap.append(button('Show caption', () => { const d=dialog('Message caption'); const caption=element('div','media-caption'); caption.innerHTML=rich(block.caption); d.body.append(caption); },'media-hidden-caption'));
          if (block.caption && block.caption_visible !== false) { const caption = element('div', 'media-caption'); caption.innerHTML = rich(block.caption); wrap.append(caption); }
          const locationLabel=block.location_visible?photoLocation(block):'';
          if (locationLabel) { const asset = state.assets[block.asset_id] || {};const location = button(locationLabel, () => this.options.readOnly ? viewPhotos([block]) : editPhotoLocation(block.asset_id), 'media-location-label');locationPreviewTrigger(location,()=>photoLocation(block),()=>[asset.location]);if (block.location_color) location.style.color = block.location_color;wrap.append(location); }
          const chips = element('div', 'media-tag-chips'); Object.entries(block.tags || {}).forEach(([gid, names]) => names.forEach(n => {if(gid==='locations'&&locationLabel&&[locationLabel,locationName(state.assets[block.asset_id]?.location_label)].some(label=>locationName(n).toLowerCase()===label.toLowerCase()))return;chips.append(element('span', 'entry-tag-chip', gid==='locations'?locationName(n):n));})); wrap.append(chips); if (!this.options.readOnly) wrap.append(controls);
        }
        this.host.append(wrap);
      }
    }
  }
  async function editPhotoLocation(assetId, onChange = () => {}) {
    const asset = state.assets[assetId]; if (!asset) return;
    const d = dialog('Photo location', true), label = field('Place name', asset.location_label || '');
    d.body.append(label.wrap, element('p', 'muted', 'Tap the map to place the pin.'));
    let point = asset.location;
    const status = element('p', 'media-map-status'); status.setAttribute('role', 'status');
    const retryMaps = button('Retry maps', loadMaps); retryMaps.hidden = true;
    const host = element('div', 'media-map-host'); d.body.append(status, retryMaps, host);
    const map = new global.TodoPupMap.OfflineMap(host, {packs: [], lon: point?.lon ?? 121.47, lat: point?.lat ?? 31.23, zoom: 13, onPick: p => { point = p; map.setMarkers([p]); }});
    d.onClose(() => map.destroy()); if (point) map.setMarkers([point]);
    async function loadMaps() {
      status.hidden = false; status.textContent = 'Loading maps…'; retryMaps.hidden = true;
      try {
        const packs = (await request('maps')).packs || [];
        if (!d.overlay.isConnected) return;
        map.setPacks(packs); status.hidden = true;
      } catch (_) {
        if (!d.overlay.isConnected) return;
        status.textContent = 'Could not load maps.'; retryMaps.hidden = false;
      }
    }
    const save = button('Save location', async () => {
      const patch = {location: point, location_label: label.input.value}; d.setBusy(true); save.textContent = 'Saving…';
      try {
        await mutate('assets', assetId, patch);
        document.dispatchEvent(new CustomEvent('media:location-changed',{detail:{assetId,label:patch.location_label}}));
        await onChange();
      } finally { d.setBusy(false); save.textContent = 'Save location'; }
      d.close(); notice('Photo location saved');
    }, 'save');
    d.actions.append(button('Cancel', d.close), save); loadMaps();
  }
  Object.assign(API, { element, button, field, toggle, select, dialog, closeTopDialog, notice, request, reply, refresh, mutate, fileURL, photoThumbnail, upload, pickPhotos, choosePhotoFiles, photoTagPicker, savePhotoTagGroups, photoLocation, previewLocation, locationPreviewTrigger, viewPhotos, openEntryPhoto, Editor, getState: () => state });
  global.PupMedia = API;
  if (!global.confirmModal) global.confirmModal = (message, label = 'Confirm') => new Promise(resolve => { const d = dialog('Datapom'); let decided = false; d.onClose(() => { if (!decided) resolve(false); }); d.body.append(element('p', '', message)); d.actions.append(button('Cancel', () => { d.close(); resolve(false); }), button(label, () => { decided = true; resolve(true); d.close(); }, 'save')); });
})(typeof window !== 'undefined' ? window : globalThis);
