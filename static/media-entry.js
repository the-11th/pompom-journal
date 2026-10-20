/* Ten-second changed-only saves around the existing journal form. */
window.PupJournalEditorReady = (async function () {
  'use strict';
  const M = window.PupMedia, form = document.getElementById('journal-form');
  const native = !!window.TodoPupNative;
  if (!M || !form) return;
  const date = form.dataset.entryDate, source = form.querySelector('[name=body]'), title = form.querySelector('[name=title]');
  const initial = JSON.parse(document.getElementById('journal-document')?.textContent || 'null');
  const field = form.querySelector('.body-field'), host = M.element('div'), toolbar = M.element('div', 'media-toolbar');
  field.after(host); field.before(toolbar); field.hidden = true;
  const status = document.getElementById('draft-status'), key = 'todopup:document:' + date;
  let base = form.dataset.entryUpdated || null, dirty = false, saving = false, changedAt = 0, blocked = false, changingSource = false;
  let baseEditRevision = form.dataset.entryEditRevision || null;
  let documentValue = initial, savePromise = Promise.resolve(), conflictDialog = null, recoveryReason = null;
  let preparingEntryAction = false, leavingEntry = false;
  let reviewButton = null, reviewCurrent = null, reviewOrigin = 'Saved', statusEpoch = 0, nativePolling = false;
  let nativeSnapshot = native ? JSON.parse(form.dataset.entrySnapshot || 'null') || {updated:base,server_version:JSON.parse(form.dataset.serverVersion || 'null')} : null;
  let nativeSections = native ? JSON.parse(form.dataset.entrySections || '[]') : [];
  try { await M.refresh(); } catch (e) { M.notice('Media library unavailable · your draft stays here'); }
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { /* Ignore an unreadable draft. */ }
  if (restored && M.draftRecovery(restored,base,baseEditRevision).sameVersion) { documentValue=restored.document; const recovery=M.draftRecovery(restored,base,baseEditRevision); blocked=recovery.blocked; recoveryReason=recovery.reason; }
  else if (restored && await window.confirmModal('This entry changed elsewhere. Restore your local draft for review?', 'Restore draft')) { documentValue = restored.document; blocked = true; recoveryReason=M.draftRecovery(restored,base,baseEditRevision).reason || 'version'; }
  else if (restored) restored = null;
  const numericValues = new Map(), numericRecovery = new Set(Array.isArray(restored?.invalid_numbers) ? restored.invalid_numbers : []);
  let validationRejected = null, validationMessage = '';
  function numericFields() { return [...form.elements].filter(el => el.name?.startsWith('num:')); }
  function badNumber(el) { return !!el.validity?.badInput || (!!el.value.trim() && !Number.isFinite(Number(el.value))); }
  function numericError() {
    const el = numericFields().find(el => badNumber(el) || numericRecovery.has(el.name.slice(4)));
    if (!el) return null;
    const name = el.getAttribute?.('aria-label') || el.name.slice(4);
    return {field:el,message:name + (badNumber(el) ? ': enter a valid number.' : ': check the restored number, then save.')};
  }
  function badTag(el) { return el.name?.startsWith('newtag-name:') && el.value.trim() && !/^[\p{L}\p{N} ._-]+$/u.test(el.value.trim().toLowerCase()); }
  function fieldError() {
    const numeric = numericError(); if (numeric) return numeric;
    const longTag = [...form.elements].find(el => el.name?.startsWith('newtag-name:') && [...el.value.trim()].length > 200);
    if (longTag) return {field:longTag,message:(longTag.getAttribute?.('aria-label') || 'New tag') + ': use at most 200 characters.'};
    const el = [...form.elements].find(badTag);
    return el ? {field:el,message:(el.getAttribute?.('aria-label') || 'New tag') + ': use letters, numbers, spaces, . _ or -.'} : null;
  }
  numericFields().forEach(el => numericValues.set(el, el.value));
  function collect() {
    const tags = {}, numbers = {}, new_tags = [];
    for (const el of form.elements) {
      if (el.name?.startsWith('tag:') && el.checked) (tags[el.name.slice(4)] ||= []).push(el.value);
      if (el.name?.startsWith('newtag-name:') && el.value.trim()) { const sid=el.name.slice(12); (tags[sid] ||= []).push(el.value.trim()); new_tags.push({section_id:sid,name:el.value.trim(),kind:form.elements.namedItem('newtag-kind:'+sid)?.value || 'temporary'}); }
      if (el.name?.startsWith('num:')) {
        if (!badNumber(el)) numericValues.set(el, el.value);
        const value = numericValues.get(el) || '';
        if (value.trim()) numbers[el.name.slice(4)] = value;
      }
    }
    return { title: title.value, body: M.documentBody(editor.doc), document: editor.doc, tags, numbers, new_tags, ...(native ? {audio_transcript:form.querySelector('[name=audio_transcript]')?.value||''} : {}), mood: form.querySelector('[name=mood]')?.value || null, base_updated: base, base_edit_revision: baseEditRevision };
  }
  function acceptBase(entry) {
    statusEpoch++; if(native && entry)nativeSnapshot=entry;
    base = entry?.updated || null;
    baseEditRevision = entry?.edit_revision || null;
    form.dataset.entryUpdated = base || '';
    form.dataset.entryEditRevision = baseEditRevision || '';
  }
  function publishSaved(entry, hasEntry) {
    // Mirror journal.has_calendar_content for restored snapshots without the
    // save endpoint's calendar_entry flag. Mood/numbers still occupy the date.
    if (typeof hasEntry !== 'boolean') {
      const text = value => typeof value === 'string' && value.trim();
      hasEntry = !!entry && !!((text(entry.title) && entry.title.trim() !== (entry.date || date)) ||
        text(entry.body) || text(entry.audio_transcript) ||
        Object.values(entry.tags || {}).some(names => names.some(text)) ||
        (entry.document || []).some(block => block.type === 'photo' || block.type === 'message'));
    }
    form.dispatchEvent(new CustomEvent('journal:saved', {bubbles:true,detail:{date,entryId:entry?.id || null,hasEntry,persisted:!!entry}}));
  }
  function preserve() { try { localStorage.setItem(key, JSON.stringify({...collect(),recovery_reason:recoveryReason,invalid_numbers:numericFields().filter(el=>badNumber(el)||numericRecovery.has(el.name.slice(4))).map(el=>el.name.slice(4))})); } catch (e) { if (status) status.textContent = 'Draft storage is full · keep this page open'; } }
  function changed(immediate = false) { if (leavingEntry) return; statusEpoch++; if (!dirty) changedAt = Date.now(); dirty = true; preserve(); if (status) status.textContent = fieldError()?.message || 'Unsaved changes'; if (immediate && !preparingEntryAction) void save(); }
  const editor = new M.Editor(host, documentValue, restored?.body || source.value, (doc, immediate) => { changingSource = true; source.value = M.documentBody(doc); source.dispatchEvent(new Event('input', { bubbles: true })); changingSource = false; changed(immediate); }, native ? {record: () => M.request('dictation', {action:'start'})} : {
    record: openWebDictation,
    recordUnavailable: !(window.SpeechRecognition || window.webkitSpeechRecognition) ? "Voice dictation isn't supported in this browser (try Chrome)." : null,
  });
  function openWebDictation({block,input}) {
    const snapshot={id:block.id,text:block.text || '',links:JSON.stringify(block.links || []),start:input.selectionStart,end:input.selectionEnd};
    const d=M.dialog('Dictation'),box=M.element('div','body-field media-dictation-field'),draft=M.element('textarea','body-input');
    draft.value=snapshot.text;draft.setAttribute('aria-label','Dictation text');
    const backdrop=M.element('div','dictation-backdrop');backdrop.setAttribute('aria-hidden','true');
    const mic=M.button('',()=>{},'dictation-mic');mic.setAttribute('aria-label','Record voice');mic.setAttribute('aria-pressed','false');mic.title='Record voice';
    const dot=M.element('span','dictation-mic-dot');dot.setAttribute('aria-hidden','true');mic.append(dot);
    box.append(backdrop,draft,mic);d.body.append(box);
    const use=M.button('Use text',()=>{},'save');d.actions.append(M.button('Cancel',d.close),use);
    let applied=null;
    const controller=window.mountJournalDictation(box,{
      confirmButton:use,externalCancel:true,showInput:()=>draft.focus(),
      beforeConfirm:()=>{
        const current=editor.doc.find(b=>b.id===snapshot.id&&b.type==='text');
        return !current || current.text!==snapshot.text || JSON.stringify(current.links || [])!==snapshot.links ? 'This paragraph changed. Copy your dictated text before closing.' : null;
      },
      onConfirm:value=>{
        const current=editor.doc.find(b=>b.id===snapshot.id);
        current.links=M.rebaseLinks(current.text || '',value.text,current.links);current.text=value.text;
        applied=value;editor.render();editor.changed();d.close();
      },
    });
    d.onClose(()=>{
      controller?.destroy();
      queueMicrotask(()=>{
        if(document.querySelector('.media-overlay'))return;
        const wrap=[...host.children].find(el=>el.dataset.blockId===snapshot.id),target=wrap?.querySelector('textarea');
        if(applied&&target){target.hidden=false;wrap.querySelector('.media-paragraph-view').hidden=true;target.focus();target.setSelectionRange(applied.start,applied.end);}
        else wrap?.querySelector('.dictation-mic')?.focus();
      });
    });
    draft.focus();draft.setSelectionRange(snapshot.start,snapshot.end);controller?.start();
  }
  source.value = M.documentBody(editor.doc);
  if (restored && documentValue === restored.document) { title.value = restored.title || ''; dirty = true; changedAt = Date.now(); }
  async function save(commit = false) {
    if (leavingEntry) return false;
    if (saving) { await savePromise; if (commit || dirty) return save(commit); return !blocked; }
    if (blocked) return false;
    if (!dirty && !commit) return true;
    if (commit && !numericFields().some(badNumber)) { numericRecovery.clear(); numericFields().forEach(el=>el.removeAttribute?.('aria-invalid')); }
    const invalid = fieldError();
    if (invalid) { preserve(); if(status)status.textContent=invalid.message; invalid.field.setAttribute?.('aria-invalid','true'); if(commit)invalid.field.focus(); return false; }
    if (validationRejected === JSON.stringify(collect())) { if(status)status.textContent=validationMessage; return false; }
    savePromise = performSave(commit); return savePromise;
  }
  async function prepareEntryAction(action) {
    if (preparingEntryAction || leavingEntry || !['move', 'delete'].includes(action)) return false;
    preparingEntryAction = true; form.inert = true;
    try {
      if (action === 'move') {
        do { if (!await save()) return false; } while (dirty);
      } else {
        // A request already sent must settle before deleting its destination.
        while (saving) await savePromise;
      }
      leavingEntry = true;
      if (action === 'delete') { dirty = false; localStorage.removeItem(key); }
      return true;
    } finally {
      preparingEntryAction = false;
      if (!leavingEntry) form.inert = false;
    }
  }
  async function prepareNavigation(){
    do{
      if(!await save()){
        const invalid=fieldError();
        if(invalid){if(status)status.textContent=invalid.message;invalid.field.focus();invalid.field.scrollIntoView?.({block:'center',behavior:'smooth'});}
        else if(blocked)await openReview();
        else status?.scrollIntoView?.({block:'center',behavior:'smooth'});
        return false;
      }
    }while(dirty);
    return true;
  }
  async function performSave(commit) {
    const payload = JSON.parse(JSON.stringify(collect())), fingerprint = JSON.stringify(payload); saving = true;
    if (status) status.textContent = 'Saving…';
    try {
      const result = await M.request('/journal/' + date + (commit ? '/commit' : '/autosave'), payload);
      if (result.task_ref_index) { window.journalSetTaskIndex?.(result.task_ref_index); editor.refreshTaskLinks?.(); }
      validationRejected = null; validationMessage = '';
      const unchanged = JSON.stringify(collect()) === fingerprint && !fieldError();
      acceptBase(result.entry);
      if(native&&commit&&result.entry)for(const tag of payload.new_tags || []){
        const input=form.elements.namedItem('newtag-name:'+tag.section_id),kind=form.elements.namedItem('newtag-kind:'+tag.section_id)?.value || 'temporary';
        if(input?.value.trim()===tag.name&&kind===tag.kind&&result.entry.tags?.[tag.section_id]?.includes(tag.name.trim().toLowerCase()))input.value='';
      }
      if (unchanged) {
        if (commit && result.entry) { editor.doc = result.entry.document || editor.doc; source.value = result.entry.body; restoreFields(result.entry,result.sections); editor.render(); }
        dirty = false; localStorage.removeItem(key);
      } else {
        if (native && commit && result.entry) {
          // A completed addition becomes a chip even when the next tag is already
          // being typed. Never replace newer text, kind choices, or checkbox edits.
          const added = {};
          for (const tag of payload.new_tags || []) {
            const name=tag.name.trim().toLowerCase();
            if(result.entry.tags?.[tag.section_id]?.includes(name))(added[tag.section_id] ||= []).push(name);
          }
          restoreNativeTags({tags:added},result.sections,true);
        }
        if (commit && result.entry?.document) {
          const merged=M.mergeCommittedDocument(payload.document,result.entry.document,editor.doc);
          if (!merged) { blocked=true; recoveryReason='task-rewrite'; localStorage.setItem(key+':before-task-rewrite',JSON.stringify(collect())); preserve(); if(status)status.textContent='Saved task links need review · draft kept'; reviewConflict(result.entry,{taskRewrite:true}); return false; }
          editor.doc=merged; source.value=M.documentBody(merged); editor.render();
        }
        preserve();
      }
      if (status) status.textContent = window.TodoPupNative ? 'Saved on phone · ready for USB sync' : 'Entry saved';
      if (dirty) { if (status) status.textContent = fieldError()?.message || 'New changes waiting to save'; } else publishSaved(result.entry,result.calendar_entry);
      return true;
    } catch (e) {
      if (e.status === 409) {
        blocked = true; recoveryReason=e.reason==='task-rewrite'?'task-rewrite':'version';
        if(native)nativeSnapshot=e.local || (e.current?.sync_state ? e.current : nativeSnapshot);
        setReview(nativeSnapshot?.server_version || e.current,nativeSnapshot?.server_version ? 'Mac' : 'Saved');
        if (status) status.textContent = recoveryReason==='task-rewrite'?'Saved task links need review · draft kept':'Changed elsewhere · draft kept here';
        reviewConflict(reviewCurrent);
      }
      else if (e.status === 400) { validationRejected = fingerprint; validationMessage = e.message || 'Check this entry before saving.'; if(status)status.textContent=JSON.stringify(collect())===fingerprint ? validationMessage : 'New changes waiting to save'; }
      else if (status) status.textContent = 'Draft kept locally · retrying';
      preserve(); return false;
    } finally { saving = false; }
  }
  function setReview(current, origin = 'Saved') {
    reviewCurrent=current;reviewOrigin=origin;
    if(!reviewButton){reviewButton=M.button('',openReview);toolbar.append(reviewButton);}
    reviewButton.textContent=native&&origin==='Mac'?'Review Mac changes':'Review saved version';
  }
  async function openReview(){
    if(!reviewCurrent){
      try{const result=await M.request(native?'entry/'+date:'/journal/media/entry/'+date);if(native)nativeSnapshot=result.entry;setReview(result.entry?.server_version || result.entry,result.entry?.server_version?'Mac':'Saved');}
      catch(error){M.notice(error.message || 'The saved version could not be read.');return;}
    }
    reviewConflict(reviewCurrent);
  }
  function clearReview() { statusEpoch++; reviewButton?.remove();reviewButton=null;reviewCurrent=null;reviewOrigin='Saved'; }
  function sectionLabel(sid, type) {
    const input=[...form.elements].find(el=>el.name===(type==='tag'?'newtag-name:':'num:')+sid);
    const group=input?.closest?.('.media-entry-section,.section');
    return nativeSections.find(section=>section.id===sid)?.name || group?.querySelector('.label')?.textContent?.trim() ||
      (type==='numeric'?input?.getAttribute?.('aria-label'):null) || (type==='tag'?'Other tags':'Other numbers');
  }
  function comparisonDraft() {
    const draft=collect();
    if(native){for(const [kind,prefix] of [['tags','newtag-name:'],['numbers','num:']]){
      const visible=new Set([...form.elements].filter(el=>el.name?.startsWith(prefix)).map(el=>el.name.slice(prefix.length)));
      draft[kind]={...Object.fromEntries(Object.entries(nativeSnapshot?.[kind] || {}).filter(([sid])=>!visible.has(sid))),...draft[kind]};
    }}
    return draft;
  }
  function appendComparison(body, draft, saved, savedName) {
    const versions=M.element('div','media-conflict-values'),columns=[];
    for(const name of [native?'Phone':'Your draft',savedName]){
      const column=M.element('section','media-conflict-version media-entry-version');column.setAttribute('role','region');column.setAttribute('aria-label',name);
      column.append(M.element('h4','',name));const values=M.element('dl','media-entry-diff');column.append(values);columns.push({column,values});versions.append(column);
    }
    let fields=0;
    const line=(label,a,b)=>{if(String(a??'')===String(b??''))return;fields++;
      [a,b].forEach((value,index)=>columns[index].values.append(M.element('dt','',label),M.element('dd','',String(value??'') || '—')));
    };
    line('Title',draft.title,saved?.title);line('Mood',draft.mood,saved?.mood);
    for(const sid of new Set([...Object.keys(draft.tags || {}),...Object.keys(saved?.tags || {})]))line(sectionLabel(sid,'tag'),[...(draft.tags?.[sid] || [])].sort().join(', '),[...(saved?.tags?.[sid] || [])].sort().join(', '));
    for(const sid of new Set([...Object.keys(draft.numbers || {}),...Object.keys(saved?.numbers || {})]))line(sectionLabel(sid,'numeric'),draft.numbers?.[sid],saved?.numbers?.[sid]);
    line('Transcript',draft.audio_transcript,saved?.audio_transcript);
    if(JSON.stringify(draft.document)!==JSON.stringify(saved?.document) || draft.body!==(saved?.body || '')){
      fields++;[draft,saved].forEach((value,index)=>{
        const preview=M.element('div');columns[index].column.append(preview);
        if(value)new M.Editor(preview,value.document,value.body || '',()=>{},{readOnly:true});else preview.append(M.element('p','muted','Entry deleted'));
      });
    }
    if(!fields)columns.forEach(({column})=>column.append(M.element('p','muted','Entry content matches.')));
    body.append(versions);
  }
  function reviewConflict(current, options = {taskRewrite:recoveryReason==='task-rewrite'}) {
    if (conflictDialog) return;
    const d=M.dialog('Review entry',true),draft=JSON.parse(JSON.stringify(comparisonDraft())),snapshot=nativeSnapshot?JSON.parse(JSON.stringify(nativeSnapshot)):null,savedName=native&&reviewOrigin==='Mac'?'Mac':'Saved';
    conflictDialog=d;d.onClose(()=>{conflictDialog=null;});
    d.body.append(M.element('p','muted','Your draft is kept.'));
    appendComparison(d.body,draft,current,savedName);
    if(options.taskRewrite){const newer=M.field('Your newer text · copy anything you want to keep',M.documentBody(editor.doc),'textarea');newer.input.readOnly=true;d.body.prepend(M.element('p','muted','Tasks were created while you edited. Restore their saved links, then reapply your text.'),newer.wrap);}
    async function resolve(choice){
      if(!native)return current;
      try {
        const result=await M.request('journal-conflicts/resolve',{date,choice,...(choice==='local'?{draft:comparisonDraft()}:{}),expected_updated:snapshot?.updated || null,expected_server_version:snapshot?.server_version || null});
        if(Array.isArray(result.sections))nativeSections=result.sections;
        return result.entry;
      } catch(error){
        if(error.status===409&&error.current){nativeSnapshot=error.current;setReview(error.current.server_version || error.current,error.current.server_version?'Mac':'Saved');if(status)status.textContent='Entry changed again · review versions';preserve();d.close();reviewConflict(reviewCurrent);return null;}
        throw error;
      }
    }
    if(!options.taskRewrite)d.actions.append(M.button(native&&savedName==='Mac'?'Keep phone':'Keep my draft',async()=>{
      const fingerprint=JSON.stringify(collect());
      const resolved=await resolve('local');if(native&&!resolved)return;
      const unchanged=JSON.stringify(collect())===fingerprint&&!fieldError();
      acceptBase(resolved);blocked=false;recoveryReason=null;dirty=!native||!unchanged;clearReview();d.close();
      if(native&&unchanged){restoreFields(resolved);editor.render();dirty=false;}
      if(dirty){preserve();await save();}
      else{localStorage.removeItem(key);if(status)status.textContent='Phone version queued for Mac';publishSaved(resolved);}
    }));
    d.actions.append(M.button(native&&savedName==='Mac'?'Use Mac':'Use saved version',async()=>{
      const resolved=await resolve('remote');if(native&&!resolved)return;current=resolved;
      acceptBase(current);editor.doc=current?.document || [{id:crypto.randomUUID().replaceAll('-',''),type:'text',text:current?.body || ''}];
      title.value=current?.title || '';restoreFields(current || {});source.value=M.documentBody(editor.doc);editor.render();
      blocked=false;recoveryReason=null;dirty=false;clearReview();localStorage.removeItem(key);if(status)status.textContent='Saved version restored';publishSaved(current);d.close();
    }));
  }
  async function refreshNativeStatus(){
    if(!native || nativePolling || saving || preparingEntryAction || leavingEntry || document.hidden)return;
    nativePolling=true;const epoch=statusEpoch;
    try {
      const result=await M.request('entry/'+date),entry=result.entry;
      if(epoch!==statusEpoch || saving || !entry)return;
      if(result.task_ref_index){window.journalSetTaskIndex?.(result.task_ref_index);editor.refreshTaskLinks?.();}
      nativeSnapshot=entry;
      if(entry.sync_state==='CONFLICT'&&entry.server_version){blocked=true;recoveryReason='version';setReview(entry.server_version,'Mac');preserve();if(status)status.textContent='Mac changes need review · phone draft kept';}
      else if(entry.updated!==base){blocked=true;recoveryReason='version';setReview(entry,'Saved');preserve();if(status)status.textContent='Saved version changed · review your draft';}
      else if(!dirty&&!blocked&&status){status.textContent=entry.sync_state==='SYNCED'?'Synced with Mac':entry.sync_state==='PERMANENT_FAILURE'?(entry.sync_message || 'Sync needs attention'):'Queued for Mac';}
    } catch(error){/* The visible draft remains intact if a status read fails. */}
    finally{nativePolling=false;}
  }
  function restoreNativeTags(value, sections, preserveChecks=false) {
    if(Array.isArray(sections))nativeSections=sections;
    const indexNode=document.getElementById('mention-index');
    const mentions=Object.assign(Object.create(null),JSON.parse(indexNode?.textContent || '{}'));
    for(const field of [...form.elements].filter(el=>el.name?.startsWith('newtag-name:'))){
      const sid=field.name.slice(12),group=field.closest('.media-entry-section'),chips=group?.querySelector('.media-tag-chips');
      if(!chips)continue;
      const section=nativeSections.find(section=>section.id===sid),permanent=new Set(section?.tags || []),archived=new Set(section?.archived_tags || []),selected=new Set(value.tags?.[sid] || []);
      for(const name of new Set([...permanent,...selected])){
        if(![...chips.querySelectorAll('input')].some(input=>input.value===name)){
          const chip=M.toggle(name,selected.has(name),()=>{}),input=chip.querySelector('input');
          input.name='tag:'+sid;input.value=name;chips.append(chip);
        }
        if(section)mentions[name] ||= {section_id:sid,section_name:section.name,color:section.color};
      }
      for(const input of chips.querySelectorAll('input')){
        input.closest('label').classList.toggle('temp',!permanent.has(input.value));
        input.closest('label').hidden=archived.has(input.value);
        if(!preserveChecks)input.checked=selected.has(input.value);
      }
    }
    if(indexNode)indexNode.textContent=JSON.stringify(mentions);
  }
  function restoreFields(value, sections, restoreInputs=false) {
    if(native)restoreNativeTags(value,sections);
    else for (const [sid,names] of Object.entries(value.tags || {})) { const field=form.querySelector('[name="newtag-name:'+sid+'"]'); if(!field)continue; for (const name of names) { if (![...form.elements].some(el=>el.name==='tag:'+sid && el.value===name)) { const chip=M.toggle(name,true,()=>{}); const input=chip.querySelector('input'); input.name='tag:'+sid; input.value=name; const webSection=field.closest('.section'); if(webSection)chip.className='chip tag-toggle'+((sections || []).find(s=>s.id===sid)?.tags?.includes(name)?'':' temp'); const target=webSection?.querySelector('.chips') || field.parentElement; target.append(chip); } } }
    for (const el of form.elements) {
      if (el.name?.startsWith('tag:')) el.checked = (value.tags?.[el.name.slice(4)] || []).includes(el.value);
      if (el.name?.startsWith('newtag-name:')) el.value='';
      if (el.name?.startsWith('newtag-kind:')) el.checked=native?el.value==='temporary':el.defaultChecked;
      if (el.name?.startsWith('num:')) el.value = value.numbers?.[el.name.slice(4)] ?? '';
    }
    if(restoreInputs)for (const tag of value.new_tags || []) { const input=form.elements.namedItem('newtag-name:'+tag.section_id); if(input) input.value=tag.name; const kind=form.elements.namedItem('newtag-kind:'+tag.section_id); if(kind) kind.value=tag.kind; }
    const transcript=form.querySelector('[name=audio_transcript]');if(transcript)transcript.value=value.audio_transcript || '';
    const mood = form.querySelector('[name=mood]'); if (mood) { mood.value = value.mood || ''; mood.dispatchEvent(new Event('change')); }
  }
  if (restored && documentValue === restored.document) { restoreFields(restored,undefined,true); if(status && fieldError())status.textContent=fieldError().message; }
  if (blocked) setReview(null);
  async function addPhotos() {
    const assets = await M.pickPhotos(date); if (!assets.length) return;
    const otherDates = [...new Set(assets.map(a => a.captured_at?.slice(0,10)).filter(d => d && d !== date))];
    if (!otherDates.length) { editor.insertAssets(assets); return; }
    const d = M.dialog('Add photos'); d.body.append(M.element('p', '', 'Some photos were taken on other days. Keep them here or place them in their original dates.'));
    const grouped = {}, completed = new Set(), uncertain = new Set(), confirmed = new Set(); assets.forEach(a => (grouped[a.captured_at?.slice(0,10) || date] ||= []).push(a));
    // Keep block IDs stable so a retry can recognize a save whose reply was lost.
    const plan = Object.entries(grouped).map(([day, photos]) => { photos = [...photos].sort((a,b) => (a.captured_at || a.created || '').localeCompare(b.captured_at || b.created || '')); return {day, photos, blocks:photos.map(a => M.photoBlock(a))}; });
    let importing = false;
    async function importOnce(action) {
      if (importing) return;
      importing = true; keepHere.disabled = useDates.disabled = true;
      try { await action(); } finally { importing = false; keepHere.disabled = useDates.disabled = false; }
    }
    const keepHere = M.button('Add to ' + date, () => importOnce(async () => {
      // A failed reply may follow a successful save. Check only those attempted
      // destinations before moving the remaining photos into the current entry.
      for (const part of plan.filter(part => uncertain.has(part.day))) {
        const {entry} = await M.request('/journal/media/entry/' + part.day);
        const existing = new Set((entry?.document || []).map(block => block.id));
        for (const block of part.blocks) if (existing.has(block.id)) confirmed.add(block.id);
        uncertain.delete(part.day);
      }
      editor.insertAssets(plan.filter(part => !completed.has(part.day)).flatMap(part => part.photos.filter((photo, index) => !confirmed.has(part.blocks[index].id)))); d.close();
    }), 'save');
    const useDates = M.button('Use capture dates', () => importOnce(async () => {
      for (const {day, blocks} of plan) {
        if (completed.has(day)) continue;
        if (day === date) editor.insertPhotoBlocks(blocks);
        else {
          const entry = await M.request('/journal/media/entry/' + day);
          const doc = entry.entry?.document || [{ id: crypto.randomUUID().replaceAll('-', ''), type: 'text', text: entry.entry?.body || '' }];
          const existing = new Set(doc.map(block => block.id)), missing = blocks.filter(block => !existing.has(block.id));
          if (missing.length) {
            doc.push(...missing);
            uncertain.add(day);
            await M.request('/journal/' + day + '/autosave', { ...(entry.entry || {}), document: doc, base_updated: entry.entry?.updated || null, base_edit_revision: entry.entry?.edit_revision || null });
          }
          uncertain.delete(day);
        }
        completed.add(day); keepHere.textContent = 'Add remaining to ' + date;
      }
      d.close(); M.notice('Photos added to their capture dates');
    }));
    d.actions.append(keepHere, useDates);
  }
  toolbar.append(M.button('＋ Photos', addPhotos), M.button('＋ Message', async () => {
    await M.refresh(); const d = M.dialog('Discord inbox'); const rows = Object.values(M.getState().messages);
    if (!rows.length) d.body.append(M.element('p', 'muted', 'No messages yet.'));
    rows.sort((a,b)=>(b.timestamp||'').localeCompare(a.timestamp||'')).forEach(m => {
      const row=M.element('div','media-inbox-row'), info=M.element('div','media-settings-copy'); info.append(M.element('strong','',m.author_name || 'Discord'),M.element('p','muted',m.timestamp ? new Date(m.timestamp).toLocaleString() : 'Timestamp unavailable'),M.element('p','',m.content || '(attachment)'));
      const add = async day => {
        const block={id:crypto.randomUUID().replaceAll('-',''),type:'message',message_id:m.id,caption:'',caption_visible:true,tags:{}};
        if(day===date){editor.doc.push(block);editor.render();changed(true);}
        else {const {entry}=await M.request('/journal/media/entry/'+day);const doc=entry?.document || [{id:crypto.randomUUID().replaceAll('-',''),type:'text',text:entry?.body||''}];doc.push(block);await M.request('/journal/'+day+'/autosave',{...(entry||{}),document:doc,base_updated:entry?.updated||null,base_edit_revision:entry?.edit_revision||null});}
        d.close();M.notice('Message added to '+day);
      };
      const original=m.timestamp ? new Date(m.timestamp) : null, day=original&&!Number.isNaN(original.valueOf()) ? [original.getFullYear(),String(original.getMonth()+1).padStart(2,'0'),String(original.getDate()).padStart(2,'0')].join('-') : date;
      const actions=M.element('div','media-toolbar'); actions.append(M.button('Add to '+day,()=>add(day),'save')); if(day!==date)actions.append(M.button('Use this entry',()=>add(date)));row.append(info,actions);d.body.append(row);
    });
  }));
  const docInput = M.element('input'); docInput.type = 'hidden'; docInput.name = 'document'; form.append(docInput);
  function patchBody(next) {
    const before = M.documentBody(editor.doc); let s = 0, end = before.length, ne = next.length;
    while (s < end && s < ne && before[s] === next[s]) s++;
    while (end > s && ne > s && before[end - 1] === next[ne - 1]) { end--; ne--; }
    let offset = 0, inserted = false;
    for (const b of editor.doc.filter(b => b.type === 'text')) { const old = b.text || '', last = offset + old.length;
      if (s <= last && end >= offset) { let value = old.slice(0, Math.max(0,s-offset)); if (!inserted) { value += next.slice(s,ne); inserted = true; } value += old.slice(Math.max(0,end-offset)); b.links = M.rebaseLinks(old,value,b.links); b.text = value; }
      offset = last + 1;
    }
    if (!inserted && next.slice(s,ne)) editor.doc.push({ id: crypto.randomUUID().replaceAll('-', ''), type: 'text', text: next.slice(s,ne), links: [] });
  }
  source.addEventListener('input', () => { if (!changingSource) { patchBody(source.value); editor.render(); } });
  function formChanged(event) {
    const field = event.target;
    if(native&&field.name?.startsWith('tag:')&&!field.checked){
      const input=form.elements.namedItem('newtag-name:'+field.name.slice(4));
      if(input?.value.trim().toLowerCase()===field.value)input.value='';
    }
    if(native)for(const input of form.querySelectorAll('.media-tag-chips input[name^="tag:"]')){
      input.closest('label').hidden=(nativeSections.find(section=>section.id===input.name.slice(4))?.archived_tags || []).includes(input.value);
    }
    if (field?.name?.startsWith('num:')) { numericRecovery.delete(field.name.slice(4)); if(!badNumber(field))field.removeAttribute?.('aria-invalid'); }
    if (field?.name?.startsWith('newtag-name:') && !badTag(field)) field.removeAttribute?.('aria-invalid');
    changed();
  }
  form.addEventListener('input', formChanged); form.addEventListener('change', formChanged);
  if(native){
    form.addEventListener('keydown',event=>{
      const input=event.target;
      if(!input.name?.startsWith('newtag-name:')||event.key!=='Enter'||event.isComposing||event.keyCode===229)return;
      event.preventDefault();event.stopPropagation();
      const name=input.value.trim().toLowerCase();if(!name)return;
      if(!badTag(input)&&[...name].length<=200){
        const sid=input.name.slice(12),chips=input.closest('.media-entry-section')?.querySelector('.media-tag-chips');
        let choice=[...chips?.querySelectorAll('input')||[]].find(choice=>choice.value===name);
        if(!choice&&chips){const chip=M.toggle(name,true,()=>{});choice=chip.querySelector('input');choice.name='tag:'+sid;choice.value=name;chips.append(chip);}
        if(choice){
          choice.checked=true;
          const section=nativeSections.find(section=>section.id===sid),kind=form.elements.namedItem('newtag-kind:'+sid)?.value;
          choice.closest('label').classList.toggle('temp',!(section?.tags || []).includes(name)&&kind!=='permanent');
        }
        changed();
      }
      void save(true);
    });
    let holdTimer=null,held=null,suppressed=null,suppressUntil=0,releaseGuard=null;
    // The finger that opens a menu may lift over one of its new buttons.
    // Consume that gesture's click, even after a very long hold; a fresh tap works.
    document.addEventListener('pointerdown',event=>{if(releaseGuard&&(releaseGuard.released||event.isPrimary))releaseGuard=null;},true);
    document.addEventListener('keydown',()=>{if(releaseGuard?.released)releaseGuard=null;},true);
    for(const type of ['pointerup','pointercancel'])document.addEventListener(type,event=>{if(releaseGuard?.pointerId===event.pointerId)releaseGuard.released=true;},true);
    document.addEventListener('click',event=>{if(releaseGuard){event.preventDefault();event.stopImmediatePropagation();if(releaseGuard.released)releaseGuard=null;}},true);
    function cancelHold(){clearTimeout(holdTimer);holdTimer=null;held=null;}
    function tagAt(target){
      const label=target.closest?.('.media-tag-chips label'),input=label?.querySelector('input[name^="tag:"]');
      return input&&!label.hidden?input:null;
    }
    async function tagOptions(input,pointerId=null){
      cancelHold();if(!input.isConnected)return;
      if(pointerId!==null)releaseGuard={pointerId,released:false};
      const sid=input.name.slice(4),name=input.value;
      suppressed=sid+':'+name;suppressUntil=Date.now()+800;
      const d=M.dialog('Tag options'),error=M.element('p','media-form-error');error.hidden=true;error.setAttribute('role','status');
      d.body.append(M.element('strong','',name),M.element('p','muted','Hide from tag choices. Past entries keep this tag.'),error);
      d.onClose(()=>queueMicrotask(()=>{if(form.isConnected&&!document.querySelector('.media-overlay'))form.elements.namedItem('newtag-name:'+sid)?.focus({preventScroll:true});}));
      d.actions.append(M.button('Cancel',d.close),M.button('Archive tag',async()=>{
        d.setBusy(true);error.hidden=true;
        try{
          const result=await M.request('journal-tags/archive',{section_id:sid,name});
          if(!Array.isArray(result.sections))throw Error('Could not confirm tag archive. Try again.');
          const tags={};
          for(const field of form.elements)if(field.name?.startsWith('tag:')&&field.checked)(tags[field.name.slice(4)] ||= []).push(field.value);
          restoreNativeTags({tags},result.sections,true);
          d.setBusy(false);d.close();
        }catch(failure){error.textContent=failure.message||'Could not archive. Try again.';error.hidden=false;}
        finally{d.setBusy(false);}
      }));
    }
    form.addEventListener('pointerdown',event=>{
      cancelHold();const input=tagAt(event.target);if(!input||event.button!==0)return;
      held={input,x:event.clientX,y:event.clientY,pointerId:event.pointerId};holdTimer=setTimeout(()=>void tagOptions(input,event.pointerId),500);
    });
    form.addEventListener('pointermove',event=>{if(held&&Math.hypot(event.clientX-held.x,event.clientY-held.y)>8)cancelHold();});
    for(const type of ['pointerup','pointercancel','pointerleave'])form.addEventListener(type,cancelHold);
    form.addEventListener('click',event=>{const input=tagAt(event.target);if(input&&suppressed===input.name.slice(4)+':'+input.value&&Date.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
    form.addEventListener('contextmenu',event=>{const input=tagAt(event.target);if(!input)return;event.preventDefault();if(!releaseGuard&&Date.now()>=suppressUntil)void tagOptions(input,held?.pointerId??null);});
    form.addEventListener('keydown',event=>{const input=tagAt(event.target);if(input&&(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))){event.preventDefault();void tagOptions(input);}});
  }
  form.addEventListener('submit', async e => {
    e.preventDefault(); docInput.value = JSON.stringify(editor.doc);
    if (blocked) { await openReview(); return; }
    await save(true);
  });
  setInterval(() => { if (!preparingEntryAction && !leavingEntry && dirty && Date.now()-changedAt >= 10000) void save(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!preparingEntryAction && !leavingEntry && document.hidden && dirty) { preserve(); void save(); } });
  window.addEventListener('pagehide', () => { if (leavingEntry || !dirty) return; preserve(); if (!preparingEntryAction && !native && !blocked && !saving && !fieldError() && validationRejected !== JSON.stringify(collect())) navigator.sendBeacon('/journal/' + date + '/autosave', new Blob([JSON.stringify(collect())], { type: 'application/json' })); });
  form.addEventListener('drop', async e => { if (e.dataTransfer.files.length) { e.preventDefault(); await importFiles([...e.dataTransfer.files]); } });
  form.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  form.addEventListener('paste', async e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); await importFiles(files); } });
  async function importFiles(files) { const assets=[]; try { for (const file of files) if(file.type.startsWith('image/')) assets.push(await M.upload(file)); } catch(e) { M.notice(e.message); } if(assets.length)editor.insertAssets(assets); }
  document.addEventListener('media:location-changed', e => { const {assetId,label}=e.detail; for(const b of editor.doc)if(b.type==='photo'&&b.asset_id===assetId){b.tags ||= {}; if(label)b.tags.locations=[label.toLowerCase()];else delete b.tags.locations;} editor.render(); changed(true); });
  function acceptPhotoEntry(entry){
    if(entry.date!==date||dirty||saving||blocked)return false;
    statusEpoch++;acceptBase(entry);nativeSnapshot=entry;
    title.value=entry.title||'';restoreFields(entry);editor.doc=entry.document||[];
    source.value=M.documentBody(editor.doc);editor.render();localStorage.removeItem(key);
    if(status)status.textContent='Saved on phone · ready for USB sync';
    return true;
  }
  window.PupJournalEditor = { date, editor, save, changed, collect, reviewConflict, prepareEntryAction, prepareNavigation, refreshNativeStatus, acceptPhotoEntry };
  if (window.PupLocationDayView) {
    const dayHost=M.element('section');dayHost.id='journal-location-day';dayHost.hidden=form.hidden;form.after(dayHost);
    window.PupJournalEditor.locationDay=window.PupLocationDayView.mount(dayHost,date,{getDocument:()=>editor.doc});
  }
  if (native && form.dataset.syncState === 'CONFLICT') { blocked=true; recoveryReason ||= 'version'; setReview(nativeSnapshot.server_version,'Mac'); if(status)status.textContent='Mac changes need review · phone draft kept'; }
  if(native)setInterval(refreshNativeStatus,2500);
})();
