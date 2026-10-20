/* A daily travel diary shared by the web journal and the offline phone. */
(function (global) {
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const modeLabel={stationary:'Stopped',walking:'Walking',cycling:'Cycling',vehicle:'In a vehicle',unknown:'Transport unknown'};
  const deviceLabel={phone:'Phone',laptop:'Laptop'};
  const photoReferences=typeof module!=='undefined'?require('./media-ui.js').photoReferences:documentValue=>global.PupMedia.photoReferences(documentValue);
  const visitKey=visit=>(visit.source_device||'phone')+':'+(visit.id||visit.arrival||visit.start);
  function clockLabel(minute) { const value=clamp(Math.floor(Number(minute)||0),0,1440);return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0'); }
  function minuteAt(at) { const match=String(at||'').match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);return match?Number(match[1])*60+Number(match[2])+Number(match[3]||0)/60:null; }
  function duration(seconds) { const minutes=Math.max(0,Math.round((Number(seconds)||0)/60));return minutes>=60?Math.floor(minutes/60)+' hr'+(minutes%60?' '+minutes%60+' min':''):minutes+' min'; }
  function distance(meters) { return meters>=1000?(meters/1000).toFixed(1)+' km':Math.round(meters||0)+' m'; }
  function coverageBands(segments) {
    const bands=[];for(const next of segments.map(segment=>({start:minuteAt(segment.start),end:minuteAt(segment.end)})).filter(band=>band.start!=null&&band.end!=null&&band.end>band.start).sort((a,b)=>a.start-b.start)){
      const last=bands.at(-1);if(last&&next.start<=last.end)last.end=Math.max(last.end,next.end);else bands.push({...next});
    }return bands;
  }
  function photoAssets(documentValue,state) {
    const seen=new Set();return photoReferences(documentValue).filter(block=>!seen.has(block.asset_id)&&state.assets?.[block.asset_id]&&seen.add(block.asset_id))
      .map(block=>({...state.assets[block.asset_id],asset_id:block.asset_id,preview_asset_id:block.edited_asset_id||block.asset_id,caption:block.caption||'',block}));
  }
  function dayBounds(points) {
    const good=points.filter(point=>point&&[point.lat,point.lon].every(Number.isFinite)&&Math.abs(point.lat)<=90&&Math.abs(point.lon)<=180);if(!good.length)return null;
    const lons=good.map(point=>point.lon),lats=good.map(point=>point.lat),west=Math.min(...lons),east=Math.max(...lons),south=Math.min(...lats),north=Math.max(...lats),padX=Math.max(.001,(east-west)*.02),padY=Math.max(.001,(north-south)*.02);
    return [Math.max(-180,west-padX),Math.max(-85.05,south-padY),Math.min(180,east+padX),Math.min(85.05,north+padY)];
  }
  class DayView {
    constructor(host,date,options={}) {
      this.host=host;this.date=date;this.options=options;this.generation=0;this.destroyed=false;this.minute=null;this.follow=false;this.sourceFilter='both';
      this.onSaved=event=>{if(!event.detail?.date||event.detail.date===this.date)void this.refresh();};this.onLocation=()=>{void this.refresh();};
      document.addEventListener('journal:saved',this.onSaved);document.addEventListener('media:location-changed',this.onLocation);
      // A cached page resumes with these same controls and map on browser Back.
      this.onPageHide=event=>{if(!event.persisted)this.destroy();};global.addEventListener('pagehide',this.onPageHide);
      this.timer=setInterval(()=>{const now=new Date(),today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');if(!document.hidden&&!host.hidden&&today===date)void this.refresh();},60000);
      this.ready=this.refresh();
    }
    async refresh() {
      if(this.destroyed)return;const generation=++this.generation,M=global.PupMedia;
      if(!this.day)this.host.replaceChildren(M.element('p','location-day-loading','Opening your day in places…'));
      try {
        const [tracking,maps,saved]=await Promise.all([M.request('tracking?from='+this.date+'&to='+this.date),M.request('maps'),this.options.getDocument?null:this.options.document?null:M.request('entry/'+this.date)]);
        if(this.destroyed||generation!==this.generation)return;
        const doc=this.options.getDocument?.()||this.options.document||saved?.entry?.document||[],state=M.getState();
        this.assets=photoAssets(doc,state);this.sourceDays=Object.fromEntries(['phone','laptop'].map(source=>[source,global.PupLocationDay.analyze(this.date,tracking.samples||[],Object.values(state.places||{}),this.assets,source)]));this.packs=maps.packs||[];
        this.render(true);
      } catch(error) {
        if(this.destroyed||generation!==this.generation)return;
        if(this.day){this.notice.textContent='Could not refresh location history · showing the last loaded day';return;}
        this.host.replaceChildren(M.element('h3','','Your day in places'),M.element('p','muted',error.message||'Location history is unavailable.'),M.button('Try again',()=>this.refresh()));
      }
    }
    render(preserve = false) {
      const scrollTop=global.scrollY,scrollLeft=global.scrollX;
      const previousMap = preserve ? this.map : null, previousHost = this.mapHost;
      const focused = document.activeElement;
      const focusKey = preserve && this.host.contains?.(focused) ? focused.getAttribute?.('data-location-control') : null;
      const selectedStop = preserve && this.detail && !this.detail.hidden ? this.selectedStop : null;
      const selectedPhotos = preserve && this.detail && !this.detail.hidden ? this.selectedPhotos : null;
      const stopOrigin = this.stopOrigin;
      const primary=this.sourceDays.phone.samples.length?'phone':'laptop';
      this.day=this.sourceDays[this.sourceFilter==='both'?primary:this.sourceFilter];this.photos=this.sourceDays[primary].photos||[];
      this.routeDays=(this.sourceFilter==='both'?['phone','laptop']:[this.sourceFilter]).map(source=>this.sourceDays[source]);
      this.visibleVisits=this.routeDays.flatMap(day=>(day.visits||[]).map(visit=>({...visit,source_device:day.source_device}))).sort((a,b)=>(a.arrival||a.start).localeCompare(b.arrival||b.start));
      const M=global.PupMedia,day=this.day,summary=day.summary||{};if(!previousMap)this.map?.destroy();this.map=previousMap;this.slider=null;this.detail=null;this.host.replaceChildren();this.host.classList.add('location-day');this.host.setAttribute('aria-label','Location diary for '+this.date);
      if(this.options.showHeading!==false){const heading=M.element('div','location-day-heading');heading.append(M.element('h3','','Your day in places'),M.element('span','location-day-date',this.date));this.host.append(heading);}
      const stats=M.element('div','location-day-stats');for(const [value,label] of [[distance(summary.distance_m),'travelled'],[duration(summary.moving_seconds),'moving'],[String(summary.stay_count??day.visits?.length??0),'stops over 10 min'],[duration(summary.recorded_seconds),'recorded']]){const stat=M.element('div','location-day-stat');stat.append(M.element('strong','',value),M.element('span','',label));stats.append(stat);}
      const points=[...this.routeDays.flatMap(day=>day.samples||[]),...this.photos,...this.visibleVisits];this.bounds=dayBounds(points);
      this.notice=M.element('p','location-day-note');
      if(!this.bounds){this.map?.destroy();this.map=null;this.renderSourceFilter();this.notice.textContent='No '+(this.sourceFilter==='both'?'location':this.sourceFilter)+' recordings for this day yet.';this.host.append(this.notice);if(focusKey)this.sourceButtons[this.sourceFilter]?.focus({preventScroll:true});return;}
      const mapHost=previousMap?previousHost:M.element('div','location-day-map');this.host.append(mapHost);this.mapHost=mapHost;
      if(previousMap)this.map.setPacks(this.packs);
      else this.map=new global.TodoPupMap.OfflineMap(mapHost,{packs:this.packs,onFit:()=>this.fit(),onPick:(_point,marker)=>{if(marker?.stop_id)this.showStop(marker.visit);else if(marker?.asset_ids?.length>1)this.showPhotoGroup(marker.asset_ids);else if(marker?.asset_id)this.showPhoto(marker.asset_id);}});
      this.map.canvas?.setAttribute('data-location-control','map');
      mapHost.querySelectorAll?.('button').forEach(button=>button.setAttribute('data-location-control','map:'+button.getAttribute('aria-label')));
      this.map.setLines(this.routeDays.flatMap(day=>day.routes||[]));
      this.map.setMarkers([...this.visibleVisits.map((visit,index)=>({...visit,stop_id:visit.id||'stop-'+index,number:index+1,visit})),...this.photos.map(photo=>({...photo,thumbnail:M.fileURL(this.assets.find(asset=>asset.asset_id===photo.asset_id)?.preview_asset_id||photo.asset_id,'thumb.webp')}))]);
      if(!previousMap)this.fit();
      this.renderSourceFilter();this.renderScrubber();
      if(day.samples.length){this.host.append(M.element('p','location-day-note',deviceLabel[day.source_device]+' totals'+(this.sourceFilter==='both'?' · devices are not added together':'')),stats);}else this.host.append(M.element('p','location-day-note','No '+this.sourceFilter+' recordings for this day.'));
      this.renderStops();this.renderPhotos();if(this.options.showAnalytics&&day.samples.length)this.renderMovement();
      const missing=Math.max(0,this.assets.length-this.photos.length),estimated=this.photos.filter(photo=>photo.source==='route').length;
      this.notice.textContent='Transport is estimated from movement. Gaps stay unfilled.'+(estimated?' '+estimated+' photo'+(estimated===1?'':'s')+' placed from capture time.':'')+(missing?' '+missing+' photo'+(missing===1?' has':'s have')+' no known location.':'');
      this.host.append(this.notice);
      if(selectedStop){const visit=this.visibleVisits.find(item=>visitKey(item)===selectedStop);if(visit)this.showStop(visit,{restore:true,origin:stopOrigin});}
      else if(selectedPhotos)this.showPhotoGroup(selectedPhotos,{restore:true});
      if(focusKey){const target=[...this.host.querySelectorAll('[data-location-control]')].find(node=>node.getAttribute('data-location-control')===focusKey);(target||this.slider||this.sourceButtons[this.sourceFilter])?.focus({preventScroll:true});}
      if(preserve)global.scrollTo?.({top:scrollTop,left:scrollLeft,behavior:'instant'});
    }
    renderSourceFilter() {
      const M = global.PupMedia, controls = M.element('div', 'location-source-filter');
      controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Visible location devices');
      this.sourceButtons = {};
      for (const [value, label] of [['phone', 'Phone'], ['laptop', 'Laptop'], ['both', 'Both']]) {
        const button = M.button(label, () => {
          this.sourceFilter = value;
          this.render();
          this.sourceButtons[value].focus({preventScroll: true});
        }, 'location-source-option');
        button.setAttribute('data-source', value);
        button.setAttribute('data-location-control','source:'+value);
        button.setAttribute('aria-pressed', String(this.sourceFilter === value));
        this.sourceButtons[value] = button; controls.append(button);
      }
      this.host.append(controls);
    }
    fit() { if(this.bounds&&this.map){this.map.fit(this.bounds);this.map.zoom=Math.min(this.map.zoom,16);this.map.draw();} }
    renderScrubber() {
      const M=global.PupMedia,wrap=M.element('div','location-day-replay'),readout=M.element('div','location-day-readout');
      this.clock=M.element('strong','location-day-clock');this.positionText=M.element('span','location-day-position');readout.append(this.clock,this.positionText);
      const controls=M.element('div','location-day-replay-controls');
      const previous=M.button('−1 hr',()=>this.setMinute(Number(this.slider.value)-60,{follow:true})),next=M.button('+1 hr',()=>this.setMinute(Number(this.slider.value)+60,{follow:true}));
      previous.setAttribute('data-location-control','hour-back');next.setAttribute('data-location-control','hour-forward');
      this.followButton=M.button('Follow dot',()=>this.setMinute(this.slider.value,{follow:!this.follow}));this.followButton.setAttribute('aria-pressed',String(this.follow));this.followButton.classList.toggle('selected',this.follow);
      this.followButton.setAttribute('data-location-control','follow');
      controls.append(previous,this.followButton,next);wrap.append(readout);
      const rail=M.element('div','location-day-rail'),coverage=M.element('div','location-day-coverage');coverage.setAttribute('aria-hidden','true');
      for(const {start,end} of coverageBands(this.routeDays.flatMap(day=>day.segments||[]))){const band=M.element('span','location-day-coverage-band');band.style.left=(start/1440*100)+'%';band.style.width=((end-start)/1440*100)+'%';coverage.append(band);}
      this.slider=M.element('input','location-day-slider');this.slider.type='range';this.slider.min='0';this.slider.max='1440';this.slider.step='1';this.slider.setAttribute('aria-label','Time of day for recorded location');this.slider.oninput=()=>this.setMinute(this.slider.value,{follow:true});rail.append(coverage,this.slider);wrap.append(rail);
      this.slider.setAttribute('data-location-control','replay');
      const hours=M.element('div','location-day-hours');for(const hour of ['00','06','12','18','24'])hours.append(M.element('span','',hour));wrap.append(hours,controls);
      const last=minuteAt(this.day.summary?.last_at);this.minute=this.minute??Math.floor(last??720);this.host.append(wrap);this.setMinute(this.minute,{recenter:false});
      this.detail=M.element('div','location-day-detail');this.detail.hidden=true;this.detail.tabIndex=-1;this.detail.setAttribute('role','region');this.detail.setAttribute('data-location-control','detail');this.host.append(this.detail);
    }
    setMinute(minute,{follow=this.follow,recenter=true}={}) {
      if(!this.slider)return;this.follow=follow;this.followButton.classList.toggle('selected',follow);this.followButton.setAttribute('aria-pressed',String(follow));if(this.detail)this.detail.hidden=true;this.selectedStop=null;this.selectedPhotos=null;this.minute=clamp(Number(minute)||0,0,1440);this.slider.value=String(this.minute);const clock=clockLabel(this.minute),point=global.PupLocationDay.positionAt(this.day,this.minute);this.clock.textContent=clock;
      let label='No recorded position';
      if(point){const mode=point.transport||point.mode||'unknown',speed=point.speed_mps;label=(modeLabel[mode]||'Recorded position')+(Number.isFinite(speed)&&mode!=='stationary'?' · '+(speed*3.6).toFixed(1)+' km/h':'');const stop=(this.day.visits||[]).find(visit=>{const start=minuteAt(visit.start||visit.arrival),end=minuteAt(visit.end||visit.departure_after);return start!=null&&end!=null&&this.minute>=start&&this.minute<=end;});if(stop)label=stop.name+' · '+duration(stop.duration_seconds);}
      const positions=this.routeDays.map(day=>{const p=global.PupLocationDay.positionAt(day,this.minute);return p?{...p,source_device:day.source_device}:null;}).filter(Boolean);
      if(this.sourceFilter==='both'&&positions.length>1)label=deviceLabel[this.day.source_device]+' · '+label+' · Laptop also shown';
      else if(!point&&positions.length)label=deviceLabel[positions[0].source_device]+' · Recorded position';
      this.positionText.textContent=label;this.slider.setAttribute('aria-valuetext',clock+' · '+label);this.map.setPlaybackLocations(positions);
      const followed=point||positions[0];if(recenter&&this.follow&&followed){this.map.center=global.TodoPupMap.project(followed.lon,followed.lat);this.map.draw();}
    }
    showStop(visit, {restore = false, origin = null} = {}) {
      const M=global.PupMedia,start=minuteAt(visit.start||visit.arrival),end=minuteAt(visit.end||visit.departure_after);
      if(!restore){if(start!=null)this.setMinute(Math.floor(start+Math.max(0,(end??start)-start)/2));this.map.center=global.TodoPupMap.project(visit.lon,visit.lat);this.map.zoom=16;this.map.draw();}
      this.selectedStop=visitKey(visit);this.stopOrigin=origin||document.activeElement?.getAttribute?.('data-location-control')||'map';
      this.detail.onkeydown=null;
      this.detail.hidden=false;this.detail.setAttribute('aria-label',(visit.name||'Unlabelled stop')+' details');
      const heading=M.element('div','location-day-detail-heading');
      const close=M.button('×',()=>{this.detail.hidden=true;this.selectedStop=null;const target=[...this.host.querySelectorAll('[data-location-control]')].find(node=>node.getAttribute('data-location-control')===this.stopOrigin);(target||this.slider)?.focus({preventScroll:true});});
      close.setAttribute('aria-label','Close stop details');close.setAttribute('data-location-control','detail-close');
      heading.append(M.element('strong','',(visit.name||'Unlabelled stop')+(visit.source_device?' · '+deviceLabel[visit.source_device]:'')),close);
      this.detail.replaceChildren(heading,M.element('p','',duration(visit.duration_seconds)+' here · '+clockLabel(start)+'–'+clockLabel(end)),M.element('p','location-day-note','Observed time; arrival and departure may vary between fixes.'));
      if(!restore){this.detail.focus({preventScroll:true});this.detail.scrollIntoView?.({block:'nearest'});}
    }
    renderStops() {
      const M=global.PupMedia,visits=this.visibleVisits;if(!visits.length)return;const heading=M.element('h4','location-day-subtitle','Stops · tap for time here'),list=M.element('ol','location-day-stops');
      visits.forEach((visit,index)=>{const row=M.element('li'),button=M.button('',()=>this.showStop(visit),'location-day-stop');button.setAttribute('data-source',visit.source_device);button.setAttribute('data-location-control','stop:'+visitKey(visit));button.append(M.element('span','location-day-stop-number',String(index+1)),M.element('span','location-day-stop-name',(visit.name||'Unlabelled stop')+' · '+deviceLabel[visit.source_device]),M.element('span','location-day-stop-time',duration(visit.duration_seconds)));row.append(button);list.append(row);});this.host.append(heading,list);
    }
    async showPhoto(assetId) {
      const asset=this.assets.find(item=>item.asset_id===assetId);if(!asset||this.destroyed||this.openingPhoto)return null;
      const M=global.PupMedia,origin=document.activeElement,focusKey=this.host.contains(origin)?origin.getAttribute('data-location-control'):'map';
      this.openingPhoto=true;origin?.setAttribute('aria-busy','true');
      try{
        const preview=global.TodoPupNative?await M.openEntryPhoto(this.date,asset.block,entry=>{
          if(this.options.document&&Array.isArray(entry?.document))this.options.document=entry.document;
        },()=>!this.destroyed&&this.host.isConnected):M.viewPhotos([asset.block]);
        if(!preview)return null;
        if(this.destroyed||!this.host.isConnected){preview.close();return null;}
        preview.onClose(()=>queueMicrotask(()=>{
          if(this.destroyed||!this.host.isConnected||document.querySelector('.media-overlay')||document.activeElement!==document.body)return;
          const target=[...this.host.querySelectorAll('[data-location-control]')].find(node=>node.getAttribute('data-location-control')===focusKey);
          (target||this.map?.canvas||this.slider)?.focus({preventScroll:true});
        }));
        return preview;
      }catch(error){if(!this.destroyed&&this.host.isConnected)M.notice(error.message||'Could not open photo. Try again.');return null;}
      finally{this.openingPhoto=false;origin?.removeAttribute('aria-busy');}
    }
    showPhotoGroup(assetIds,{restore=false}={}) {
      const M=global.PupMedia,photos=assetIds.map(id=>this.photos.find(photo=>photo.asset_id===id)).filter(Boolean);if(!photos.length)return;
      this.selectedStop=null;this.selectedPhotos=photos.map(photo=>photo.asset_id);this.detail.hidden=false;
      const title=photos.length+' photo'+(photos.length===1?'':'s')+' here';this.detail.setAttribute('aria-label',title);
      const dismiss=()=>{this.detail.hidden=true;this.selectedPhotos=null;(this.map.canvas||this.slider)?.focus({preventScroll:true});};
      const heading=M.element('div','location-day-detail-heading'),close=M.button('×',dismiss);
      this.detail.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismiss();}};
      close.setAttribute('aria-label','Close photo choices');close.setAttribute('data-location-control','photo-choices-close');heading.append(M.element('strong','',title),close);
      const strip=M.element('div','location-day-photos');photos.forEach(photo=>strip.append(this.photoButton(photo,'choice:')));this.detail.replaceChildren(heading,strip);
      if(!restore){this.detail.focus({preventScroll:true});this.detail.scrollIntoView?.({block:'nearest'});}
    }
    photoButton(photo,prefix='photo:') {
      const M=global.PupMedia,asset=this.assets.find(item=>item.asset_id===photo.asset_id),name=asset?.caption||asset?.filename||'Open photo',button=M.button('',()=>this.showPhoto(photo.asset_id),'location-day-photo'),image=M.photoThumbnail(asset?.preview_asset_id||photo.asset_id,asset?.filename||'Photo'),at=minuteAt(photo.captured_at);
      button.append(image,M.element('span','',at==null?'Time unknown':clockLabel(at)));button.setAttribute('aria-label',name+(at==null?'':' · '+clockLabel(at)));button.setAttribute('data-location-control',prefix+photo.asset_id);return button;
    }
    renderPhotos() {
      const M=global.PupMedia,photos=this.photos;if(!photos.length)return;this.host.append(M.element('h4','location-day-subtitle','Photos along the way'));const strip=M.element('div','location-day-photos');
      photos.forEach(photo=>strip.append(this.photoButton(photo)));this.host.append(strip);
    }
    renderMovement() {
      const M=global.PupMedia,summary=this.day.summary||{},area=M.element('section','location-day-movement');
      area.append(M.element('h4','location-day-subtitle','Movement this day'));
      const stats=M.element('div','location-day-speeds'),speed=value=>Number.isFinite(value)?(value*3.6).toFixed(1)+' km/h':'—';
      for(const [value,label] of [[summary.avg_moving_speed_mps,'average moving speed'],[summary.max_speed_mps,'top recorded speed']]){const stat=M.element('div','location-day-stat');stat.append(M.element('strong','',speed(value)),M.element('span','',label));stats.append(stat);}area.append(stats);
      const rows=(summary.transport||[]).filter(row=>row.mode!=='stationary'&&row.duration_seconds>0),max=Math.max(1,...rows.map(row=>row.duration_seconds));
      for(const row of rows){const item=M.element('div','location-rank');item.append(M.element('span','',modeLabel[row.mode]||'Transport unknown'),M.element('span','location-rank-value',duration(row.duration_seconds)+' · '+distance(row.distance_m)));const track=M.element('div','location-rank-track'),fill=M.element('span','location-rank-fill');fill.style.width=(row.duration_seconds/max*100)+'%';track.append(fill);item.append(track);area.append(item);}
      if(!rows.length)area.append(M.element('p','location-day-note','No movement recorded for this day.'));
      this.host.append(area);
    }
    destroy() { if(this.destroyed)return;this.destroyed=true;this.generation++;clearInterval(this.timer);this.map?.destroy();document.removeEventListener('journal:saved',this.onSaved);document.removeEventListener('media:location-changed',this.onLocation);global.removeEventListener('pagehide',this.onPageHide); }
  }
  function mount(host,date,options={}) { return new DayView(host,date,options); }
  const api={mount,DayView,photoAssets,clockLabel,minuteAt,duration,distance,dayBounds,coverageBands};global.PupLocationDayView=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
