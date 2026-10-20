/* Bundled journal surface: all requests resolve to private Android files. */
(async function () {
  'use strict';
  const M = window.PupMedia, root = document.getElementById('mobile-root');
  window.addEventListener('media:dialog-state',event=>{void M.request('dialog-state',{open:!!event.detail.open}).catch(()=>{});});
  const query=new URLSearchParams(location.search),data = await M.request('bootstrap'), date = data.entry.date, settingsPage=query.get('settings')==='1';
  let activeName='Entry',viewGeneration=0;
  const top = M.element('div', 'media-mobile-nav');top.setAttribute('role','navigation');top.setAttribute('aria-label','Journal views');
  function activeView(name){activeName=name;document.title=(settingsPage?'Photos & places':name==='Entry'?'Journal':name)+' · Datapom';for(const button of top.querySelectorAll('button')){const selected=button.textContent===name;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',selected);}const day=document.getElementById('journal-location-day');if(day)day.hidden=name!=='Entry';heading.hidden=settingsPage||name==='Photos';}
  async function showView(name){
    const generation=++viewGeneration;
    if(name!=='Entry'&&await window.PupJournalEditor?.prepareNavigation()===false)return;
    if(generation!==viewGeneration)return;
    extra._mediaCleanup?.();extra._mediaCleanup=null;extra.replaceChildren();form.hidden=name!=='Entry';extra.hidden=name==='Entry';activeView(name);
    if(name==='Entry')return;
    // A separate pane keeps late responses from replacing a newer view.
    const pane=M.element('section',name==='Places'?'location-mobile-day':'');extra.append(pane);
    try {
      if(name==='Places'){
        await M.refresh();if(generation!==viewGeneration)return;
        const day=window.PupLocationDayView.mount(pane,date,{getDocument:()=>window.PupJournalEditor.editor.doc,showHeading:false,showAnalytics:true});
        extra._mediaCleanup=()=>day.destroy();await day.ready;
      } else {
        extra._mediaCleanup=()=>pane._mediaCleanup?.();
        const entries=(await M.request('entries')).entries;
        if(generation===viewGeneration)await M.photos(pane,entries);
      }
    } catch(error){if(generation===viewGeneration)pane.replaceChildren(M.element('p','muted',error.message||'This view could not load.'),M.button('Try again',()=>showView(name)));}
  }
  for(const name of ['Entry','Photos','Places']){const button=M.button(name,()=>showView(name));button.disabled=true;top.append(button);}
  top.hidden=settingsPage;root.replaceChildren(top);
  const form = M.element('form', 'journal-form'); form.id = 'journal-form'; form.dataset.mediaEditor = '1'; form.dataset.entryDate = date; form.dataset.entryUpdated = data.entry.updated || ''; form.dataset.entryEditRevision=data.entry.edit_revision || ''; form.dataset.syncState=data.entry.sync_state || ''; form.dataset.serverVersion=JSON.stringify(data.entry.server_version || null);
  form.noValidate=true;form.dataset.entrySnapshot=JSON.stringify(data.entry);form.dataset.entrySections=JSON.stringify(data.sections);
  const extra = M.element('div'); extra.hidden = true; root.append(form, extra);
  const heading = M.element('div', 'media-mobile-heading'), dateTrigger=M.button(date+' ▾',async()=>{if(await window.PupJournalEditor?.prepareNavigation()===false)return;const day=await M.request('choose-date',{date});if(day.date!==date){const next=new URLSearchParams({date:day.date});if(activeName==='Places')next.set('view','places');location.href='/static/mobile-journal.html?'+next;}},'media-date-trigger');dateTrigger.setAttribute('aria-label','Choose journal date · '+date);dateTrigger.disabled=true;heading.append(dateTrigger);root.insertBefore(heading,form);activeView('Entry');
  const title = M.field('Title', data.entry.title || ''); title.input.name = 'title'; form.append(title.wrap);
  const moods = M.element('div', 'media-moods'), mood = M.element('input'); mood.type = 'hidden'; mood.name = 'mood'; mood.value = data.entry.mood || ''; form.append(moods, mood);
  function moodPaint() { moods.querySelectorAll('button').forEach(b => { b.classList.toggle('selected', b.dataset.mood === mood.value); b.setAttribute('aria-pressed', b.dataset.mood === mood.value); }); }
  for (let i = 1; i <= 7; i++) { const b = M.button('', () => { mood.value = mood.value === String(i) ? '' : String(i); moodPaint(); form.dispatchEvent(new Event('change', {bubbles:true})); }); b.dataset.mood = i; b.setAttribute('aria-label', 'Mood ' + i + ' of 7'); const image = M.element('img'); image.src = '/static/img/' + i + '-pompom.gif'; image.alt = ''; b.append(image); moods.append(b); } moodPaint(); mood.onchange = moodPaint;
  const body = M.field('What happened today', data.entry.body || '', 'textarea'); body.wrap.className = 'body-field'; body.input.name = 'body'; body.input.id = 'body-input'; body.input.className = 'body-input'; body.wrap.append(M.element('div', 'body-rendered')); form.append(body.wrap);
  const numeric = Object.create(null), mentions = Object.create(null);
  data.sections.forEach(s => {
    if(s.managed || s.archived)return;
    const group = M.element('div', 'media-entry-section'); group.dataset.sectionId = s.id;
    if (s.type === 'tag') {
      group.append(M.element('span', 'label', s.name));
      const selected = data.entry.tags?.[s.id] || [];
      // Mention history recognizes old tags without offering them on every day.
      [...(s.tags || []), ...(s.mention_tags || []), ...selected].forEach(n => {
        mentions[n] ||= {section_id:s.id, section_name:s.name, color:s.color};
      });
      const chips = M.element('div', 'media-tag-chips');
      [...new Set([...(s.tags || []), ...selected])].forEach(n => {
        const chip = M.toggle(n, selected.includes(n), () => {});
        chip.classList.toggle('temp', !(s.tags || []).includes(n));
        chip.hidden=(s.archived_tags || []).includes(n);
        const input = chip.querySelector('input'); input.name = 'tag:' + s.id; input.value = n;
        chips.append(chip);
      });
      group.append(chips);
      const add = M.field('Add ' + s.name + ' tag'); add.input.name = 'newtag-name:' + s.id;
      add.input.setAttribute('aria-label', 'Add ' + s.name + ' tag'); add.input.placeholder = 'New tag';
      add.input.setAttribute('enterkeyhint','done');
      add.wrap.querySelector('.label').hidden = true; group.append(add.wrap);
      const kinds=M.element('div','kind-toggle'); for(const kind of ['permanent','temporary']){const label=M.element('label','kind-opt'),input=M.element('input'); input.type='radio';input.name='newtag-kind:'+s.id;input.value=kind;input.checked=kind==='temporary';label.append(input,M.element('span','',kind));kinds.append(label);}group.append(kinds);
    } else { const label=s.name + (s.unit ? ' · ' + s.unit : ''),f = M.field(label, data.entry.numbers?.[s.id] ?? '', 'number'); f.input.name = 'num:' + s.id; f.input.setAttribute('aria-label',label); f.input.step = 'any'; group.append(f.wrap); numeric[s.name] = {section_id:s.id, color:s.color}; }
    form.append(group);
  });
  for (const [id, value] of Object.entries({'journal-document': data.entry.document || null, 'mention-index': mentions, 'numeric-index': numeric, 'task-ref-index':data.task_ref_index||{}})) { const node = M.element('script'); node.type = 'application/json'; node.id = id; node.textContent = JSON.stringify(value); form.append(node); }
  let openingTask=false;
  root.addEventListener('click',async event=>{
    const link=event.target.closest?.('a.task-check[data-task-id]');if(!link)return;
    event.preventDefault();if(openingTask)return;openingTask=true;link.setAttribute('aria-disabled','true');
    try{
      if(await window.PupJournalEditor?.prepareNavigation()===false)return;
      await M.request('open-task',{id:link.dataset.taskId});
    }catch(error){
      if(error.task_ref_index){window.journalSetTaskIndex?.(error.task_ref_index);window.PupJournalEditor?.editor.refreshTaskLinks();}
      M.notice(error.message||'Task could not open.');
    }finally{openingTask=false;link.removeAttribute('aria-disabled');}
  });
  const actions = M.element('div', 'media-toolbar media-entry-actions'), save = M.element('button', 'media-action save', 'Save entry'); save.type = 'submit'; const status = M.element('span', 'muted', data.message || 'Saved on this phone'); status.id = 'draft-status'; status.setAttribute('role','status'); actions.append(save, status); form.append(actions);
  const transcript=M.element('input'); transcript.type='hidden';transcript.name='audio_transcript';transcript.value=data.entry.audio_transcript || '';form.append(transcript);
  window.PupDictationCapture = capture => { transcript.value=[transcript.value,capture.audio_transcript||''].filter(Boolean).join('\n'); for(const [sid,names] of Object.entries(capture.tags||{}))for(const name of names){let input=[...form.elements].find(el=>el.name==='tag:'+sid&&el.value===name);if(!input){const chip=M.toggle(name,true,()=>{});chip.classList.add('temp');input=chip.querySelector('input');input.name='tag:'+sid;input.value=name;const group=form.querySelector('[name="newtag-name:'+sid+'"]')?.closest('.media-entry-section');(group?.querySelector('.media-tag-chips')||group||form).append(chip);}input.checked=true;}window.PupDictationText(capture.text||'');form.dispatchEvent(new Event('change',{bubbles:true}));};
  window.PupDictationText = text => {
    const editor = window.PupJournalEditor?.editor;
    if (!editor) return;
    const input = editor.active?.input || editor.host.querySelector('textarea');
    if (!input) return;
    input.hidden = false;
    input.closest('.media-block').querySelector('.media-paragraph-view').hidden = true;
    input.focus();
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  };
  const renderer = document.createElement('script'); renderer.src = '/static/journal-richtext.js'; document.body.append(renderer); await new Promise((resolve,reject) => { renderer.onload=resolve;renderer.onerror=()=>reject(Error('The journal editor could not load.')); });
  const script = document.createElement('script'); script.src = '/static/media-entry.js';
  await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('The journal editor could not load.'));document.body.append(script);});
  await window.PupJournalEditorReady;
  for(const button of top.querySelectorAll('button'))button.disabled=false;dateTrigger.disabled=false;
  const day=document.getElementById('journal-location-day');if(day)day.hidden=settingsPage;
  if (settingsPage) { form.hidden = true; extra.hidden = false; await M.settings(extra); }
  else if(query.get('view')==='places')await showView('Places');
})().catch(error => { const M=window.PupMedia,root=document.getElementById('mobile-root');root.replaceChildren(M.element('h2','','Journal unavailable'),M.element('p','muted',error.message || 'The saved journal could not be read. Your files have been kept.'),M.button('Retry',()=>location.reload())); });
