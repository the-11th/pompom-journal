/* Settings and analytics use the same offline maps and photo groups on both devices. */
(function () {
  'use strict';
  const M = window.PupMedia;
  if (!M) return;
  const size = n => n == null ? 'Size not checked' : n < 1000000 ? (n / 1000).toFixed(0) + ' KB' : n < 1000000000 ? (n / 1000000).toFixed(1) + ' MB' : (n / 1000000000).toFixed(2) + ' GB';
  function section(host, title, help) { const s = M.element('section', 'media-settings-section'); s.append(M.element('h3', '', title)); if (help) s.append(M.element('p', 'muted', help)); host.append(s); return s; }
  function packShortcuts(host, packs, map) {
    const row=M.element('div','media-place-tools');
    packs.filter(p=>p.id!=='world').forEach(p=>{const button=M.button(p.id==='bay-area'?'Bay Area':p.name,()=>map.fit(p.bounds));button.dataset.mapControl=p.id;row.append(button);});
    if(row.childNodes.length)host.append(row);
  }
  function currentLocationControls(host, map, changed) {
    const area=M.element('div','media-current-location'),actions=M.element('div','media-current-location-actions'),status=M.element('p','media-current-location-status muted');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    let point=null,disposed=false,expiry;
    const locate=M.button('◎ My location',()=>find(true)),star=M.button('☆ Star here',()=>{
      const fresh=TodoPupMap.currentLocation(point);if(!fresh){expire();return;}
      const place=TodoPupMap.nearestPlace(fresh,Object.values(M.getState().places).filter(p=>!p.is_city));
      editPlace(place?{...place,starred:true}:{starred:true,radius_m:Math.min(500000,Math.max(100,Math.ceil(fresh.accuracy_m/10)*10))},place?null:fresh,changed);
    });
    locate.setAttribute('aria-label','Show my current location');star.setAttribute('aria-label','Star current location');star.disabled=true;
    actions.append(locate,star);area.append(actions,status);host.append(area);
    function expire(){point=null;map.setCurrentLocation(null);star.disabled=true;star.textContent='☆ Star here';status.textContent='Location expired.';}
    async function find(prompt){
      locate.disabled=true;star.disabled=true;status.textContent='Finding your location…';
      try {
        const result=await TodoPupMap.locateCurrentPosition({prompt,nativeRequest:window.TodoPupNative?body=>M.request('current-location',body):undefined});
        if(disposed||!area.isConnected)return;
        clearTimeout(expiry);point=result.status==='ok'?result.location:null;map.setCurrentLocation(point);
        if(!point){status.textContent=result.message||'Your current location is unavailable. Try again.';return;}
        map.center=TodoPupMap.project(point.lon,point.lat);map.zoom=Math.min(15,Math.max(8,Math.log2(40075016.686*Math.cos(point.lat*Math.PI/180)/Math.max(256,point.accuracy_m*8)))) ;map.draw();
        const precision=point.accuracy_m>=1000?(point.accuracy_m/1000).toFixed(1)+' km':Math.max(1,Math.round(point.accuracy_m))+' m';
        status.textContent='You are here · within '+precision+' · '+new Date(point.observed_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
        const saved=TodoPupMap.nearestPlace(point,Object.values(M.getState().places).filter(p=>!p.is_city));
        star.textContent=saved?.starred?'★ Starred here':'☆ Star here';star.disabled=false;
        expiry=setTimeout(()=>{if(!disposed)expire();},Math.max(1,TodoPupMap.CURRENT_LOCATION_AGE-(Date.now()-Date.parse(point.observed_at))+1));
      } catch(e){if(!disposed&&area.isConnected){point=null;map.setCurrentLocation(null);status.textContent=e.message||'Your current location is unavailable. Try again.';}}
      finally{if(!disposed)locate.disabled=false;}
    }
    find(false);
    return ()=>{disposed=true;clearTimeout(expiry);};
  }
  async function editPlace(place = {}, point, changed) {
    const identity = place.id || crypto.randomUUID().replaceAll('-', '');
    const d = M.dialog(place.id ? 'Edit place' : 'Save a place', true);
    const name = M.field('Name', place.name || ''), city = M.field('City / nickname', place.city || '');
    const radius = M.field('Arrival radius (m)', place.radius_m || 100, 'number');
    const color = M.field('Color', place.color || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), 'color');
    name.input.required = true;
    radius.input.min = 10; radius.input.max = 500000; radius.input.step = 'any'; radius.input.required = true;
    d.box.classList.add('media-place-dialog');
    const fields = M.element('div', 'media-place-fields'); fields.append(name.wrap, city.wrap, radius.wrap, color.wrap);
    const error = M.element('p', 'media-form-error'); error.hidden = true;
    error.id = 'place-error-' + identity; error.setAttribute('role', 'alert');
    let errorTarget = null;
    function showError(message, input) {
      error.textContent = message; error.hidden = false; errorTarget = input;
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); input.focus(); }
    }
    for (const input of [name.input, radius.input]) input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
      if (errorTarget === input) { error.hidden = true; errorTarget = null; }
    });
    d.body.append(fields, error, M.element('p', 'muted', 'Tap the map to place the pin.'));
    name.input.focus();
    const host = M.element('div', 'media-map-host'), shortcuts = M.element('div');
    const mapStatus = M.element('p', 'media-map-status'); mapStatus.setAttribute('role', 'status');
    const mapActions = M.element('div', 'media-place-tools');
    const retryMaps = M.button('Retry maps', loadMaps); retryMaps.hidden = true; mapActions.append(retryMaps);
    d.body.append(mapStatus, mapActions, host, shortcuts);
    let center = point || {lon: place.lon ?? 121.47, lat: place.lat ?? 31.23};
    let isCity = !!place.is_city, starred = !!place.starred;
    const map = new TodoPupMap.OfflineMap(host, {packs: [], lon: center.lon, lat: center.lat, zoom: 13,
      onPick: position => { center = position; update(); }});
    d.onClose(() => map.destroy());
    const coordinate = M.element('p', 'media-map-coordinate'); d.body.append(coordinate);
    function update() {
      const value = Number(radius.input.value), previewRadius = Number.isFinite(value) ? Math.max(10, Math.min(500000, value)) : 100;
      coordinate.textContent = center.lat.toFixed(5) + '°, ' + center.lon.toFixed(5) + '°';
      map.setMarkers([{...center, radius_m: previewRadius, color: color.input.value, starred}]);
    }
    radius.input.oninput = update; color.input.oninput = update; update();
    d.body.append(M.toggle('This is a city or wider area', isCity, value => isCity = value));
    d.body.append(M.toggle('★ Starred place', starred, value => { starred = value; update(); }));
    const save = M.button('Save place', async () => {
      const value = Number(radius.input.value);
      if (!name.input.value.trim()) { showError('A name is required.', name.input); return; }
      if ([...name.input.value].length > 200) { showError('Use a name of 200 characters or fewer.', name.input); return; }
      if (!radius.input.value.trim() || !Number.isFinite(value) || value < 10 || value > 500000) {
        showError('Radius must be between 10 and 500,000 m.', radius.input); return;
      }
      error.hidden = true; d.setBusy(true); save.textContent = 'Saving…';
      try {
        await M.mutate('places', identity, {name: name.input.value.trim(), city: city.input.value,
          radius_m: value, lat: center.lat, lon: center.lon, color: color.input.value, is_city: isCity, starred});
      } catch (problem) { showError(problem.message); return; }
      finally { d.setBusy(false); save.textContent = 'Save place'; }
      d.close(); await changed?.();
    }, 'save');
    d.actions.append(M.button('Cancel', d.close), save);
    async function loadMaps() {
      mapStatus.textContent = 'Loading maps…'; mapStatus.hidden = false; retryMaps.hidden = true;
      try {
        const packs = (await M.request('maps')).packs || [];
        if (!d.overlay.isConnected) return;
        map.setPacks(packs); shortcuts.replaceChildren(); packShortcuts(shortcuts, packs, map); mapStatus.hidden = true;
      } catch (_) {
        if (!d.overlay.isConnected) return;
        mapStatus.textContent = 'Could not load maps.'; retryMaps.hidden = false;
      }
    }
    await loadMaps();
  }

  async function conflicts(host, changed, cancelled = () => false) {
    if(!window.TodoPupNative)return()=>{};
    const wrapper=M.element('div'),feedback=M.element('div'),settingsCancelled=cancelled;
    wrapper.dataset.mediaConflicts='';host.append(wrapper,feedback);
    let stopped=false,pending=false,resolving=false,signature=null,knownKeys=new Set();
    cancelled=()=>stopped||settingsCancelled();
    function paint(records){
    const focused=wrapper.contains(document.activeElement),choice=document.activeElement?.dataset.reviewChoice;
    wrapper.replaceChildren();
    const seen=new Set();
    if(!records.length){if(focused)host.querySelector('nav a')?.focus({preventScroll:true});return;}
    const area=section(wrapper,'Changes to review','Compare phone and Mac edits before syncing.');
    const labels={name:'Name',tags:'Tags',location_label:'Location label',location:'Coordinates',lat:'Latitude',lon:'Longitude',captured_at:'Photo time',radius_m:'Radius (m)',city:'City / nickname',share_entry:'Also tag entries',caption:'Caption',date:'Entry date',is_city:'City or wider area',starred:'Starred',color:'Color',archived:'Archived',hidden:'Hidden',imported:'Imported',is_sticker:'Sticker',source_asset_id:'Original photo',edit_layers:'Photo edits'};
    function valueText(key,value){
      if(value==null||value==='')return '—';
      if(typeof value==='boolean')return value?'Yes':'No';
      if(key==='location')return Number(value.lat).toFixed(5)+', '+Number(value.lon).toFixed(5);
      if(key==='source_asset_id')return M.getState().assets[value]?.filename||value;
      if(key==='edit_layers'&&Array.isArray(value)){
        const counts={stroke:0,sticker:0},lines=[];
        value.forEach(layer=>{if(layer.type in counts)counts[layer.type]++;else if(layer.type==='text')lines.push('Text: '+layer.text);else if(layer.type==='transform'){if(layer.rotation)lines.push('Rotation: '+layer.rotation+'°');if(layer.crop)lines.push('Crop: '+Object.values(layer.crop).map(n=>Math.round(n*100)+'%').join(', '));}});
        for(const [type,label] of [['stroke','pen stroke'],['sticker','sticker']])if(counts[type])lines.unshift(counts[type]+' '+label+(counts[type]===1?'':'s'));
        return lines.join(' · ')||'No edits';
      }
      return Array.isArray(value)?value.join(', ')||'—':String(value);
    }
    records.forEach(c=>{
      const key=c.kind+':'+c.id;if(seen.has(key))return;seen.add(key);
      const row=M.element('div','media-settings-section');
      row.append(M.element('strong','',c.local?.name||c.current?.name||c.local?.location_label||(c.kind==='messages'?'Message':'Photo details')));
      const fields=Object.keys(labels).filter(field=>JSON.stringify(c.local?.[field]??null)!==JSON.stringify(c.current?.[field]??null));
      const versions=M.element('div','media-conflict-values');
      [['Phone',c.local],['Mac',c.current]].forEach(([label,record])=>{
        const col=M.element('div','media-conflict-version');
        const text=!record?'This copy has no item.':fields.map(field=>labels[field]+': '+valueText(field,record[field])).join('\n')||'These copies now match.';
        col.append(M.element('strong','',label),M.element('p','',text));versions.append(col);
      });
      const error=M.element('p','media-form-error');error.hidden=true;error.setAttribute('role','alert');
      const actions=M.element('div','media-download-actions'),buttons=[];
      [['Keep phone','local'],['Use Mac','remote']].forEach(([label,choice])=>{
        const button=M.button(label,async()=>{
          resolving=true;error.hidden=true;buttons.forEach(item=>item.disabled=true);
          try { await M.request('media-conflicts/resolve',{id:c.id,kind:c.kind,choice,expected_revision:c.revision}); }
          catch(problem){
            if(problem.status===409){await changed(key+':'+choice);M.notice(problem.current?'Copies changed. Review them again.':'Already resolved. Settings refreshed.');}
            else {error.textContent=problem.message;error.hidden=false;}
            return;
          } finally {resolving=false;buttons.forEach(item=>item.disabled=false);}
          await changed(key+':'+choice);M.notice('Choice saved · sync over USB to finish');
        });button.dataset.reviewChoice=key+':'+choice;buttons.push(button);actions.append(button);
      });
      row.append(versions,error,actions);area.append(row);
    });
    if(focused)([...wrapper.querySelectorAll('[data-review-choice]')].find(button=>button.dataset.reviewChoice===choice)||wrapper.querySelector('button'))?.focus({preventScroll:true});
    }
    async function refresh(){
      if(cancelled()||pending||resolving)return;pending=true;
      try{
        const records=(await M.request('media-conflicts')).conflicts||[];
        if(cancelled()||resolving)return;
        const next=JSON.stringify(records),retryFocused=feedback.contains(document.activeElement);
        const newConflict=signature!==null&&records.some(record=>!knownKeys.has(record.kind+':'+record.id));
        if(next!==signature){signature=next;knownKeys=new Set(records.map(record=>record.kind+':'+record.id));paint(records);}feedback.replaceChildren();
        if(newConflict)M.notice('New changes to review.');
        if(retryFocused)(wrapper.querySelector('button')||host.querySelector('nav a'))?.focus({preventScroll:true});
      }catch(_){
        if(!cancelled()&&!feedback.children.length){
          const area=section(feedback,'Changes to review');
          area.append(M.element('p','muted','Could not load changes to review.'),M.button('Retry review',refresh));
        }
      }finally{pending=false;}
    }
    await refresh();
    if(cancelled())return()=>{};
    const timer=setInterval(()=>{if(!document.hidden)void refresh();},2500);
    return()=>{stopped=true;clearInterval(timer);};
  }
  async function settings(root) {
    const restoreScroll=root.dataset.mediaSettingsReady==='1',scrollTop=window.scrollY;
    let sectionJumped=false,pendingJump=null;
    root._mediaCleanup?.();
    const generation = (root._mediaSettingsGeneration || 0) + 1;
    root._mediaSettingsGeneration = generation;
    let disposed = false, pollTimer, map, coverage;
    let trackingCleanup = () => {}, clearCurrentLocation = () => {}, conflictCleanup = () => {};
    const cancelled = () => disposed || root._mediaSettingsGeneration !== generation || !root.isConnected;
    root._mediaCleanup = () => {
      disposed = true; clearTimeout(pollTimer); trackingCleanup(); clearCurrentLocation(); conflictCleanup();
      map?.destroy(); coverage?.destroy();
    };
    root.replaceChildren(M.element('p', 'muted', 'Opening local settings…'));
    try { await M.refresh(); }
    catch (_) {
      if (!cancelled()) root.replaceChildren(M.element('p', 'muted', 'Could not load settings.'),
        M.button('Retry settings', () => settings(root)));
      return;
    }
    if (cancelled()) return; root.replaceChildren();
    const jump=M.element('nav','media-settings-jump');jump.setAttribute('aria-label','Photos and places settings');[['Photo tags','photo-tags'],['Places','saved-places'],['Tracking','tracking'],['Maps','map-downloads'],['Discord','discord-inbox']].forEach(([label,id])=>{const a=M.element('a','section-filter',label);a.href='#'+id;jump.append(a);});root.append(jump);
    jump.addEventListener('click',event=>{const link=event.target.closest('a[href^="#"]');if(!link)return;sectionJumped=true;const target=link.hash.slice(1);pendingJump=document.getElementById(target)?null:target;});
    conflictCleanup=await conflicts(root,async choice=>{
      await settings(root);
      if(document.activeElement!==document.body)return;
      const target=[...root.querySelectorAll('[data-review-choice]')].find(button=>button.dataset.reviewChoice===choice)||root.querySelector('[data-review-choice]')||root.querySelector('#photo-tags h3');
      if(target){if(!target.matches('button,a,input'))target.tabIndex=-1;target.focus();}
    },cancelled);
    if (cancelled()){conflictCleanup();return;}
    const groups = section(root, 'Photo tags');
    groups.id='photo-tags';
    Object.values(M.getState().groups).filter(g => !g.archived).sort((a,b)=>Number(b.id==='people')-Number(a.id==='people')||a.name.localeCompare(b.name)).forEach(g => {
      const row = M.element('div', 'media-settings-row'), text = M.element('div', 'media-settings-copy', g.name);
      row.setAttribute('role', 'group'); row.setAttribute('aria-label', g.name);
      row.classList.add('media-photo-group-row');
      row.append(text, M.button('Manage tags', async () => {
        const history = await M.request('analytics'), d = M.dialog(g.name + ' photo tags');
        const picker = M.photoTagPicker(M.getState().groups[g.id]||g, [], Object.keys(history.tags?.[g.id] || {}), {}, true);
        const sharing=M.toggle('Also tag entries',!!picker.group.share_entry,value=>{picker.group.share_entry=value;picker.shareEntryEdited=true;});sharing.querySelector('input').setAttribute('data-tag-control','');
        d.body.append(picker.wrap,sharing);
        d.actions.append(M.button('Cancel', d.close), M.button('Save tags', async () => { picker.values(); d.setBusy(true); try { await M.savePhotoTagGroups([picker]); } finally { d.setBusy(false); } d.close(); await settings(root); }, 'save'));
      })); groups.append(row);
    });
    groups.append(M.button('＋ Photo-tag group', () => {
      const identity = crypto.randomUUID().replaceAll('-', '');
      const d = M.dialog('New photo-tag group'), name = M.field('Group name');
      name.input.required = true;
      const error = M.element('p', 'media-form-error'); error.hidden = true; error.setAttribute('role', 'alert');
      error.id = 'group-error-' + identity; name.input.setAttribute('aria-describedby', error.id);
      name.input.addEventListener('input', () => { error.hidden = true; name.input.removeAttribute('aria-invalid'); });
      let share = false;
      const sharing = M.toggle('Also tag entries', false, value => share = value);
      sharing.querySelector('input').setAttribute('data-tag-control', '');
      d.body.append(name.wrap, error, sharing); name.input.focus();
      const add = M.button('Add group', async () => {
        const value = name.input.value.trim().toLowerCase();
        if (!value || [...value].length > 200) {
          error.textContent = value ? 'Use a name of 200 characters or fewer.' : 'A name is required.';
          error.hidden = false; name.input.setAttribute('aria-invalid', 'true'); name.input.focus(); return;
        }
        error.hidden = true; d.setBusy(true); add.textContent = 'Adding…';
        try { await M.mutate('groups', identity, {name: value, share_entry: share}); }
        catch (problem) { error.textContent = problem.message; error.hidden = false; return; }
        finally { d.setBusy(false); add.textContent = 'Add group'; }
        d.close(); await settings(root);
      }, 'save');
      d.actions.append(M.button('Cancel', d.close), add);
    }));
    const saved = section(root, 'Cities & familiar places');
    saved.id='saved-places';
    const host = M.element('div', 'media-map-host'); saved.append(host);
    const manifest = await M.request('maps').catch(() => ({packs: []}));
    if (cancelled()) return;
    map = new TodoPupMap.OfflineMap(host, { packs: manifest.packs, onPick: (p, place) => editPlace(place || {}, place ? null : p, () => settings(root)) });
    const places = Object.values(M.getState().places).filter(p => !p.archived).sort((a,b)=>Number(!!b.starred)-Number(!!a.starred)||a.name.localeCompare(b.name)); map.setMarkers(places); if (places.length) map.fit([Math.min(...places.map(p => p.lon)) - .01, Math.min(...places.map(p => p.lat)) - .01, Math.max(...places.map(p => p.lon)) + .01, Math.max(...places.map(p => p.lat)) + .01]);
    clearCurrentLocation=currentLocationControls(saved,map,()=>settings(root));
    const shortcuts = M.element('div'); saved.append(shortcuts); packShortcuts(shortcuts,manifest.packs,map);
    saved.append(M.button('＋ Place / city', () => editPlace({}, null, () => settings(root))));
    places.forEach(p => { const row = M.element('div', 'media-settings-row'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', p.name); row.append(M.element('div', 'media-settings-copy', (p.starred?'★ ':'')+p.name + ' · ' + p.radius_m + ' m'), M.button('Edit', () => editPlace(p, null, () => settings(root))), M.button('Archive', async()=>{await M.mutate('places',p.id,{archived:true});await settings(root);})); saved.append(row); });
    const archivedPlaces=Object.values(M.getState().places).filter(p=>p.archived);if(archivedPlaces.length){const details=M.element('details');details.append(M.element('summary','','Archived places · '+archivedPlaces.length));archivedPlaces.forEach(p=>{const row=M.element('div','media-settings-row');row.append(M.element('span','media-settings-copy',p.name),M.button('Restore',async()=>{await M.mutate('places',p.id,{archived:false});settings(root);}));details.append(row);});saved.append(details);}
    const tracking = section(root, 'Location tracking');
    tracking.id='tracking';
    if (window.TodoPupNative) {
      let info,closed=false,pending=false;
      try { info=await M.request('tracking-status'); }
      catch (_) {
        if(!cancelled())tracking.append(M.element('p','muted','Could not load tracking status.'),M.button('Retry tracking',()=>settings(root)));
      }
      if (cancelled()) return;
      if(info){
      const status=M.element('p','muted'),lastSaved=M.element('p','muted');status.setAttribute('role','status');
      const toggle=M.button('',async()=>{toggle.disabled=true;try{await M.request('tracking-control',{enabled:!info.enabled});await refreshStatus();}finally{toggle.disabled=false;}},'save');
      const background=M.button('Allow restart after reboot…',()=>M.request('tracking-control',{background:true}));
      const help=M.element('p','muted','Locations save automatically on this phone, including in the background and without saving a journal entry. USB sync copies them to your Mac.');
      const reboot=M.element('p','muted','For tracking to resume after a reboot, set Location to Allow all the time in Android Settings.');
      function paint(){status.textContent=info.message;const saved=new Date(info.last_saved_at||'');lastSaved.textContent=Number.isFinite(saved.getTime())?'Last saved · '+saved.toLocaleString():'Waiting for the first saved location.';toggle.textContent=info.enabled?'Pause tracking':'Enable tracking';background.hidden=reboot.hidden=!info.enabled;}
      async function refreshStatus(){if(closed||pending)return;pending=true;try{const next=await M.request('tracking-status');if(!closed){info=next;paint();}}catch(_){if(!closed)status.textContent='Could not refresh save status. Recorded locations remain on this phone.';}finally{pending=false;}}
      tracking.append(status,lastSaved,toggle,help,background,reboot);paint();
      const timer=setInterval(()=>{if(root.isConnected&&!document.hidden)void refreshStatus();},10000);trackingCleanup=()=>{closed=true;clearInterval(timer);};
      }
    }
    else if(window.PupLaptopLocation)trackingCleanup=window.PupLaptopLocation.mount(tracking);
    const downloads = section(root, 'Offline map downloads', window.TodoPupNative ? 'Download on your Mac, then sync over USB.' : '');
    downloads.id='map-downloads';
    const totals=M.element('p','muted');downloads.append(totals);
    const downloadStatus = M.element('p', 'media-map-status'); downloadStatus.hidden = true; downloadStatus.setAttribute('role', 'status');
    const retryDownloads = M.button('Retry map status', paintDownloads); retryDownloads.hidden = true;
    downloads.append(downloadStatus, retryDownloads);
    const preview = M.element('div', 'media-map-host'); downloads.append(preview); coverage = new TodoPupMap.OfflineMap(preview, { packs: manifest.packs, zoom: 1, lon: 0, lat: 25 });
    coverage.setCoverage(manifest.packs.filter(p => p.id !== 'world').map(p => p.bounds));
    const list = M.element('div'); downloads.append(list);
    let downloadGeneration = 0;
    async function paintDownloads() {
      if (cancelled()) return;
      const requestGeneration = ++downloadGeneration; clearTimeout(pollTimer);
      let result;
      try { result = await M.request('maps'); }
      catch (_) {
        if (!cancelled() && requestGeneration === downloadGeneration) {
          downloadStatus.textContent = 'Could not refresh map status.'; downloadStatus.hidden = false; retryDownloads.hidden = false;
        }
        return;
      }
      if(cancelled() || requestGeneration !== downloadGeneration)return;
      const active=document.activeElement,focusArea=shortcuts.contains(active)?shortcuts:list.contains(active)?list:null,focusControl=active?.dataset.mapControl,retryFocused=active===retryDownloads;
      downloadStatus.hidden = true; retryDownloads.hidden = true;
      if (!manifest.packs.length) coverage.setCoverage(result.packs.filter(p => p.id !== 'world').map(p => p.bounds));
      manifest.packs = result.packs; shortcuts.replaceChildren(); packShortcuts(shortcuts, result.packs, map);
      list.replaceChildren();coverage.setPacks(result.packs);map.setPacks(result.packs);totals.textContent=size(result.packs.filter(p=>p.status==='ready').reduce((sum,p)=>sum+p.bytes,0))+' downloaded';
      result.packs.forEach(p => {
        const row = M.element('div', 'media-settings-row'), copy = M.element('div', 'media-settings-copy'); copy.append(M.element('strong', '', p.name));
        row.setAttribute('role', 'group'); row.setAttribute('aria-label', p.name);
        const activity=p.download_status||p.status;const details=activity==='downloading'?(window.TodoPupNative?'USB transfer · ':'Downloading · ')+size(p.downloaded_bytes)+(p.status==='ready'?' · existing pack remains available':''):activity==='failed'?p.error:activity==='checking_size'?'Checking download size…':p.status==='ready'?size(p.bytes)+' · downloaded · '+(p.id==='world'?'world overview':'street detail'):(p.estimated_bytes?'Estimated '+size(p.estimated_bytes):'Not downloaded');
        copy.append(M.element('p', '', details)); if (p.counties) copy.append(M.element('p', '', p.counties.join(' · ')));
        const actions=M.element('div','media-download-actions');row.append(copy,actions);actions.append(M.button('Coverage', () => { coverage.setCoverage([p.bounds]); coverage.fit(p.bounds);preview.scrollIntoView({behavior:'smooth',block:'center'}); }));
        if (!window.TodoPupNative && !['downloading', 'checking_size'].includes(activity)) actions.append(M.button(p.status === 'ready' ? 'Update' : 'Download', async () => { await M.request('maps', { action: 'download', id: p.id }); await paintDownloads(); }, p.status === 'ready' ? '' : 'save'));
        if (!window.TodoPupNative && p.status !== 'ready'&&!['downloading','checking_size'].includes(activity)) actions.append(M.button('Check size', async () => { await M.request('maps', {action:'estimate',id:p.id}); await paintDownloads(); }));
        if (window.TodoPupNative && p.status !== 'ready') actions.append(M.element('span', 'media-pack-size', activity==='downloading'?'Transferring over USB…':p.downloaded_bytes?'Connect USB to resume':'Connect USB to receive'));
        actions.querySelectorAll('button').forEach(button=>{button.dataset.mapControl=p.id+':'+button.textContent;});
        list.append(row);
      });
      if(focusArea)([...focusArea.querySelectorAll('[data-map-control]')].find(button=>button.dataset.mapControl===focusControl)||focusArea.querySelector('button'))?.focus({preventScroll:true});
      else if(retryFocused)list.querySelector('button')?.focus({preventScroll:true});
      if (result.packs.some(p => ['downloading', 'checking_size'].includes(p.download_status||p.status))) pollTimer=setTimeout(paintDownloads,2000);
    }
    await paintDownloads();
    if (cancelled()) return;
    if (!window.TodoPupNative) downloads.append(M.button('＋ Map area', () => {
      const identity = crypto.randomUUID().replaceAll('-', '');
      const d = M.dialog('Add map area', true), name = M.field('Area name'); name.input.required = true;
      const error = M.element('p', 'media-form-error'); error.hidden = true; error.setAttribute('role', 'alert');
      error.id = 'map-area-error-' + identity; name.input.setAttribute('aria-describedby', error.id);
      name.input.addEventListener('input', () => { name.input.removeAttribute('aria-invalid'); error.hidden = true; });
      d.body.append(name.wrap, error, M.element('p', 'muted', 'Pan and zoom to frame the area.')); name.input.focus();
      const host = M.element('div', 'media-map-host'); d.body.append(host);
      const picker = new TodoPupMap.OfflineMap(host, {packs: manifest.packs, zoom: 3, lat: 30, lon: 110});
      d.onClose(() => picker.destroy()); packShortcuts(d.body, manifest.packs, picker);
      const add = M.button('Add area', async () => {
        const value = name.input.value.trim();
        if (!value || [...value].length > 200) {
          error.textContent = value ? 'Use a name of 200 characters or fewer.' : 'A name is required.';
          error.hidden = false; name.input.setAttribute('aria-invalid', 'true'); name.input.focus(); return;
        }
        error.hidden = true; d.setBusy(true); add.textContent = 'Adding…';
        try { await M.request('maps', {action: 'add', id: identity, name: value, bounds: picker.bounds()}); }
        catch (problem) { error.textContent = problem.message; error.hidden = false; return; }
        finally { d.setBusy(false); add.textContent = 'Add area'; }
        d.close(); await paintDownloads();
      }, 'save');
      d.actions.append(M.button('Cancel', d.close), add);
    }));
    const discord = section(root, 'Discord inbox');
    discord.id='discord-inbox';
    if(window.TodoPupNative) {
      discord.append(M.element('p','muted','Set up Discord on your Mac.'));
    } else {
      const details = M.element('div'); discord.append(details);
      await paintDiscord();
      async function paintDiscord() {
      details.replaceChildren(M.element('p', 'muted', 'Checking connection…'));
      const info = await M.request('discord/status').catch(() => null);
      if (cancelled()) return;
      details.replaceChildren();
      if (!info) {
        details.append(M.element('p', 'muted', 'Could not check connection.'), M.button('Retry connection', paintDiscord));
        return;
      }
      details.append(M.element('p', 'muted', info.connected ? 'Connected' : 'Not connected'));
      if(info.last_sync)details.append(M.element('p','muted','Last checked '+new Date(info.last_sync).toLocaleString()));
      const guide=M.element('a','section-filter','Receiver setup guide ↗');guide.href='/journal/media/discord/setup';guide.target='_blank';guide.rel='noopener';details.append(guide);
      const config=M.element('details');config.open=!info.connected;config.append(M.element('summary','',info.connected?'Receiver settings':'Configure receiver'));
      const url=M.field('Receiver URL',info.receiver_url||'','url'),token=M.field(info.connected?'Receiver token · leave blank to keep it':'Receiver token','','password'),application=M.field('Discord application ID',info.application_id||'');
      url.input.placeholder='https://your-receiver.example';token.input.autocomplete='off';application.input.inputMode='numeric';
      const error = M.element('p', 'media-form-error'); error.hidden = true; error.setAttribute('role', 'alert');
      error.id = 'receiver-error-' + generation;
      const inputs = [url.input, token.input, application.input];
      inputs.forEach(input => input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); error.hidden = true;
      }));
      function invalid(message, input) {
        error.textContent = message; error.hidden = false;
        if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', error.id); input.focus(); }
      }
      const save = M.button('Save receiver', async () => {
        let address;
        try { address = new URL(url.input.value.trim()); } catch (_) {}
        if (!address || address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.search || address.hash) {
          invalid('Use the HTTPS address of your private receiver.', url.input); return;
        }
        if (!info.connected && !token.input.value.trim()) { invalid('A receiver token is required.', token.input); return; }
        if (!/^[0-9]{1,24}$/.test(application.input.value.trim())) { invalid('Use the application ID from Discord (digits only).', application.input); return; }
        error.hidden = true; save.disabled = true; save.textContent = 'Saving…'; inputs.forEach(input => input.disabled = true);
        try { await M.request('discord/config', {receiver_url: url.input.value.trim(), receiver_token: token.input.value.trim(), application_id: application.input.value.trim()}); }
        catch (problem) { invalid(problem.message); return; }
        finally { save.disabled = false; save.textContent = 'Save receiver'; inputs.forEach(input => input.disabled = false); }
        token.input.value = ''; await settings(root); M.notice('Receiver settings saved');
      }, 'save');
      config.append(url.wrap,token.wrap,application.wrap,error,save);details.append(config);
      if(info.connected)details.append(M.button('Sync inbox',async()=>{const result=await M.request('discord/pull',{});M.notice(result.added+' new messages imported');await settings(root);},'save'));
      if (info.install_url) { const link = M.element('a', 'section-filter', 'Install Add to Datapom in Discord ↗'); link.href = info.install_url; link.target = '_blank'; link.rel = 'noopener'; details.append(link); }
      }
    }
    if (cancelled()) return;
    root.dataset.mediaSettingsReady='1';
    if(pendingJump)document.getElementById(pendingJump)?.scrollIntoView({block:'start'});
    else if(!sectionJumped){if(restoreScroll)window.scrollTo({top:scrollTop});else if(['#photo-tags','#saved-places','#tracking','#map-downloads','#discord-inbox'].includes(location.hash))document.getElementById(location.hash.slice(1))?.scrollIntoView({block:'start'});}
  }
  async function photos(host, entries, retain=false, owner=null) {
    host._mediaCleanup?.(); let disposed = false, map;
    const mobile=!!window.TodoPupNative;
    owner ||= {};owner.active=true;owner.entries=entries;
    host._mediaCleanup = () => { disposed = true; owner.active=false; map?.destroy(); };
    host._refreshPhotos = next => photos(host, next || owner.entries, true, owner);
    if(!retain)host.replaceChildren(M.element('p', 'muted', 'Loading photos…'));
    try { await M.refresh(); }
    catch (_) {
      if (!disposed && host.isConnected) {
        const status=host.querySelector('[data-photo-status]')||M.element('div');status.dataset.photoStatus='';
        const message=M.element('p','muted',retain?'Could not refresh photos. Previous view kept.':'Could not load photos.');message.setAttribute('role','status');
        status.replaceChildren(message,M.button('Retry photos',()=>photos(host,entries,retain,owner)));
        if(!retain)host.replaceChildren(status);else host.append(status);
      }
      return;
    }
    if (disposed || !host.isConnected) return;
    const stats = M.photoStats(entries), all = stats.gallery;
    const locations=Object.create(null);
    for(const photo of all){
      const original=M.locationName(M.getState().assets[photo.asset_id]?.location_label).toLowerCase();
      if(!photo.tags?.locations?.length)continue;
      photo.tags.locations=[...new Set(photo.tags.locations.map(name=>original&&M.locationName(name).toLowerCase()===original?M.photoLocation(photo):M.locationName(name)).filter(Boolean))];
      for(const name of photo.tags.locations)locations[name]=(locations[name]||0)+1;
    }
    if(Object.keys(locations).length)stats.tags.locations=locations;
    const active=retain?host.querySelector('.media-filter-active'):null,group=active?.dataset.group,tag=active?.dataset.tag;
    const focused=host.contains(document.activeElement)?document.activeElement:null;
    const focusedKey=focused?{group:focused.dataset.group,tag:focused.dataset.tag,asset:focused.dataset.asset}:null;
    host.replaceChildren();
    const count=M.element('p','muted'),filters = M.element('div', 'media-toolbar media-photo-filters'), gallery = M.element('div', 'media-gallery');
    let from,to,mapStatus,rangeError,visible=all,selectedGroup=group,selectedTag=tag,openingPhoto=false;
    const assets=M.getState().assets;
    if(mobile){
      const dates=all.map(photo=>M.photoDate(photo,assets)).filter(Boolean).sort();
      owner.range ||= {from:dates[0]||'',to:dates.at(-1)||''};
      const range=M.element('div','media-photo-range');range.setAttribute('role','group');range.setAttribute('aria-label','Photo date range');
      from=M.field('From',owner.range.from,'date');to=M.field('To',owner.range.to,'date');
      from.input.setAttribute('aria-label','From');to.input.setAttribute('aria-label','To');
      rangeError=M.element('p','media-form-error');rangeError.setAttribute('role','status');rangeError.hidden=true;
      range.append(from.wrap,to.wrap,M.button('All dates',()=>{from.input.value='';to.input.value='';from.input.dispatchEvent(new Event('change'));to.input.dispatchEvent(new Event('change'));}));
      host.append(range,rangeError);window.enhanceDatetime(from.input);window.enhanceDatetime(to.input);
      const changed=()=>{owner.range={from:from.input.value,to:to.input.value};paint(selectedGroup,selectedTag);};
      from.input.addEventListener('change',changed);to.input.addEventListener('change',changed);
      const mapHost=M.element('div','media-map-host media-photo-map');mapStatus=M.element('p','media-map-status');mapStatus.setAttribute('role','status');
      host.append(mapHost,mapStatus);
      map=new window.TodoPupMap.OfflineMap(mapHost,{packs:[],onFit:fitPhotos,fitLabel:'Fit photos',onPick:(_point,marker)=>{
        if(!marker)return;
        if(marker.asset_ids?.length>1){
          const choices=M.dialog('Photos at this location',true),grid=M.element('div','media-gallery');
          for(const photo of visible.filter(p=>marker.asset_ids.includes(p.asset_id))){
            const label=photo.caption||assets[photo.asset_id]?.filename||'Photo',button=M.button('',async()=>{choices.close();await openPhoto(photo);},'media-gallery-card');
            button.setAttribute('aria-label',label);button.append(M.photoThumbnail(photo.edited_asset_id||photo.asset_id,label),M.element('span','',label));grid.append(button);
          }
          choices.body.append(grid);
        }else{const photo=visible.find(p=>p.asset_id===marker.asset_id);if(photo)void openPhoto(photo).catch(error=>M.notice(error.message));}
      }});
      const mapLoading=M.element('p','media-map-status','Loading map…'),retry=M.button('Retry map',loadMap);retry.hidden=true;host.append(mapLoading,retry);
      async function loadMap(){
        mapLoading.hidden=false;mapLoading.textContent='Loading map…';retry.hidden=true;
        try{const result=await M.request('maps');if(!disposed&&host.isConnected){map.setPacks(result.packs||[]);mapLoading.hidden=true;}}
        catch(_){if(!disposed&&host.isConnected){mapLoading.textContent='Map unavailable. Your photos are still below.';retry.hidden=false;}}
      }
      void loadMap();
    }
    host.append(count,filters,gallery);
    function fitPhotos(){
      const points=map?.markers||[];
      if(!points.length){map?.fit([-180,-65,180,75]);return;}
      const lats=points.map(p=>p.lat),lons=points.map(p=>p.lon);
      map.fit([Math.min(...lons)-.001,Math.min(...lats)-.001,Math.max(...lons)+.001,Math.max(...lats)+.001]);
    }
    async function openPhoto(p){
      if(openingPhoto||disposed||!host.isConnected)return;
      openingPhoto=true;
      try{
        const preview=mobile?await M.openEntryPhoto(p.details_date||p.date,p,async entry=>{
          if(!owner.active||!host.isConnected)return;
          owner.entries=owner.entries.map(previous=>previous.date===entry.date?entry:previous);
          await photos(host,owner.entries,true,owner);
        },()=>!disposed&&host.isConnected):M.viewPhotos([p]);
        if(!preview)return;
        preview.onClose(()=>queueMicrotask(()=>{
          if(!owner.active||!host.isConnected||document.querySelector('.media-overlay')||document.activeElement!==document.body)return;
          const target=[...host.querySelectorAll('.media-gallery-card')].find(button=>button.dataset.asset===p.asset_id)||host.querySelector('canvas');
          target?.focus({preventScroll:true});
        }));
      }finally{openingPhoto=false;}
    }
    function paint(group, tag) {
      selectedGroup=group;selectedTag=tag;
      gallery.replaceChildren();
      filters.querySelectorAll('button').forEach(b=>{const active=b.dataset.group===(group||'')&&b.dataset.tag===(tag||'');b.classList.toggle('media-filter-active',active);b.setAttribute('aria-pressed',String(active));});
      visible=all.filter(p => !group || (p.tags?.[group] || []).includes(tag));
      if(mobile){
        visible=M.photosInRange(visible,assets,from.input.value,to.input.value);
        const invalid=from.input.value&&to.input.value&&from.input.value>to.input.value;
        rangeError.hidden=!invalid;rangeError.textContent=invalid?'From must be on or before To.':'';
        const points=visible.flatMap(p=>{const point=assets[p.asset_id]?.location;return point&&Number.isFinite(point.lat)&&Number.isFinite(point.lon)&&Math.abs(point.lat)<=90&&Math.abs(point.lon)<=180?[{...point,asset_id:p.asset_id,thumbnail:M.fileURL(p.edited_asset_id||p.asset_id,'thumb.webp')}]:[];});
        map.setMarkers(points);fitPhotos();
        const missing=visible.length-points.length;
        mapStatus.textContent=points.length?'Tap a photo to open it · pinch or use + / − to zoom.':visible.length?'These photos have no saved locations.':'No photos in this date range.';
        if(missing)mapStatus.append(M.element('span','media-photo-unlocated',missing+(missing===1?' photo':' photos')+' without a location'));
      }
      const total=mobile?visible.length:stats.photos;
      count.textContent=total+(total===1?' unique photo':' unique photos');
      visible.forEach(p => {
        const photoDate=mobile?M.photoDate(p,assets):p.details_date||p.date;
        const card = M.button('',()=>openPhoto(p), 'media-gallery-card');
        card.dataset.asset=p.asset_id;
        const image = M.photoThumbnail(p.edited_asset_id || p.asset_id, M.getState().assets[p.asset_id]?.filename || 'Photo');
        card.setAttribute('aria-label', (p.caption || M.getState().assets[p.asset_id]?.filename || 'Photo') + ' · ' + photoDate);
        card.append(image, M.element('span', '', photoDate), M.element('span', '', p.caption || '')); gallery.append(card);
      });
      if(!visible.length)gallery.append(M.element('p','muted',mobile?'No photos in this date range.':'No photos yet.'));
    }
    const allButton=M.button('All photos',()=>paint());allButton.dataset.group='';allButton.dataset.tag='';filters.append(allButton); Object.entries(stats.tags).forEach(([gid,tags]) => Object.entries(tags).forEach(([tag,n]) => {
      if(mobile&&gid==='locations')return;
      const location=gid==='locations',photos=all.filter(p=>p.tags?.[gid]?.includes(tag));
      const label=location?M.photoLocation(photos.find(p=>M.locationName(tag).toLowerCase()===M.photoLocation(p).toLowerCase())||{})||M.locationName(tag):(M.getState().groups[gid]?.name||gid)+': '+tag;
      const b=M.button(label+' · '+n,()=>paint(gid,tag),'section-filter');b.dataset.group=gid;b.dataset.tag=tag;
      if(location)M.locationPreviewTrigger(b,label,()=>photos.map(p=>M.getState().assets[p.asset_id]?.location));filters.append(b);
    }));
    const keep=group&&Object.hasOwn(stats.tags,group)&&Object.hasOwn(stats.tags[group],tag)&&!(mobile&&group==='locations');paint(keep?group:null,keep?tag:null);
    if(focusedKey&&document.activeElement===document.body){
      const replacement=[...host.querySelectorAll('button')].find(button=>focusedKey.asset?button.dataset.asset===focusedKey.asset:
        focusedKey.group!==undefined&&button.dataset.group===focusedKey.group&&button.dataset.tag===focusedKey.tag);
      (replacement||allButton).focus({preventScroll:true});
    }
  }
  async function timeline(host, from, to) {
    return window.PupLocationAnalytics.render(host, {from, to});
  }
  Object.assign(M, { settings, photos, timeline, editPlace });
  const root = document.getElementById('media-settings-root'); if (root) settings(root).catch(e => { root.textContent = e.message; });
  if (window.__ANALYTICS_CHARTS__) {
    window.__ANALYTICS_CHARTS__.push({ id: 'photo-gallery', panel: 'photos', title: 'Photos & tags', render: (host, entries) => { photos(host, entries).catch(e => host.textContent = e.message); } });
    window.__ANALYTICS_CHARTS__.push({ id: 'place-timeline', panel: 'places', title: 'Location history & patterns', render: host => { timeline(host, document.getElementById('date-from')?.value, document.getElementById('date-to')?.value).catch(e => host.textContent = e.message); } });
    document.dispatchEvent(new Event('analytics:charts-ready'));
  }
})();
