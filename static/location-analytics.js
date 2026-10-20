/* Cross-day location analytics. Calculations come from places.py / location-day.js. */
(function (global) {
  'use strict';
  const number = n => typeof n === 'number' && Number.isFinite(n);
  function duration(n) {
    if(!number(n))return '—';
    const minutes=Math.max(0,Math.round(n/60));
    return minutes<60?minutes+' min':Math.floor(minutes/60)+' hr'+(minutes%60?' '+minutes%60+' min':'');
  }
  const distance = n => !number(n) ? '—' : n < 1000 ? Math.round(n) + ' m' : (n / 1000).toFixed(1) + ' km';
  const speed = n => !number(n) ? '—' : (n * 3.6).toFixed(1) + ' km/h';
  const modes = {stationary:'Stationary', walking:'Walking', cycling:'Cycling', vehicle:'Vehicle', unknown:'Uncertain'};
  function trendSeries(days, metric) {
    const result = []; let last = null;
    for (const day of [...days].sort((a,b) => a.date.localeCompare(b.date))) {
      const time = Date.parse(day.date + 'T00:00:00Z');
      if (last !== null && time - last > 86400000) result.push(null);
      result.push({date:day.date, value:day.summary.sample_count===0?null:day.summary[metric] ?? null}); last = time;
    }
    return result;
  }
  function svgElement(name, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    Object.entries(attrs).forEach(([key,value]) => el.setAttribute(key,value)); return el;
  }
  function chart(host, days, metric, format, label) {
    const values = trendSeries(days, metric), rows = values.filter(p => p && number(p.value));
    if (!rows.length) return () => {};
    const h = 150, pad = 34, max = Math.max(1, ...rows.map(p => p.value));
    const first = Date.parse(rows[0].date), last = Date.parse(rows.at(-1).date);
    const svg = svgElement('svg', {role: 'img', 'aria-label': label, class: 'location-trend chart-svg'});
    let lastWidth = 0;
    function draw() {
      const w = Math.min(620, host.clientWidth || 620);
      if (w === lastWidth) return;
      lastWidth = w;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.replaceChildren();
      const x = p => first === last ? w / 2 : pad + (Date.parse(p.date) - first) / (last - first) * (w - pad * 2);
      const y = p => h - pad - p.value / max * (h - pad * 2);
      svg.append(svgElement('line', {x1: pad, y1: h-pad, x2: w-pad, y2: h-pad, class: 'location-chart-axis'}));
      let run = [];
      function flush() {
        if (run.length > 1) svg.append(svgElement('polyline', {
          points: run.map(p => `${x(p)},${y(p)}`).join(' '), class: 'location-chart-line',
        }));
        run = [];
      }
      for (const point of values) {
        if (!point || !number(point.value)) { flush(); continue; }
        run.push(point);
      }
      flush();
      for (const point of rows) {
        const circle = svgElement('circle', {cx: x(point), cy: y(point), r: 3.5, class: 'location-chart-point'});
        const title = svgElement('title'); title.textContent = point.date + ' · ' + format(point.value);
        circle.append(title); svg.append(circle);
      }
      const dates = first === last
        ? [[rows[0].date.slice(5), w / 2, h-8, 'middle']]
        : [[rows[0].date.slice(5), pad, h-8, 'start'], [rows.at(-1).date.slice(5), w-pad, h-8, 'end']];
      for (const [text, xx, yy, anchor] of [[format(max), pad, 18, 'start'], ...dates]) {
        const node = svgElement('text', {x: xx, y: yy, 'text-anchor': anchor, class: 'location-chart-label'});
        node.textContent = text; svg.append(node);
      }
    }
    host.append(svg); draw();
    const observer = global.ResizeObserver ? new global.ResizeObserver(draw) : null;
    observer?.observe(host);
    return () => observer?.disconnect();
  }
  async function load(from,to,onProgress,cancelled) {
    const M=global.PupMedia,query=new URLSearchParams({summary:'1'});
    if(from)query.set('from',from);if(to)query.set('to',to);
    if(!global.TodoPupNative)return M.request('tracking?'+query);
    // One daily bridge response at a time bounds memory for years of history.
    const manifest=await M.request('tracking?manifest=1'),days=[],places=Object.values(M.getState().places);
    const dates=(manifest.days||[]).map(d=>d.date).filter(d=>(!from||d>=from)&&(!to||d<=to)).sort();
    for(const date of dates){
      if(cancelled())return null;
      onProgress('Reading '+date+' · '+(days.length+1)+' of '+dates.length+' days');
      const rows=await M.request('tracking?from='+date+'&to='+date);
      const day=global.PupLocationDay.analyze(date,rows.samples||[],places,[]);
      if(day.summary.sample_count)days.push({date:day.date,summary:day.summary,visits:day.visits,hourly:day.hourly});
      // Retain only compact totals; raw points leave scope after each daily read.
    }
    return global.PupLocationDay.aggregate(days);
  }
  async function render(host, {from=null,to=null} = {}, retained=null) {
    const M=global.PupMedia;
    host._mediaCleanup?.();host._refreshLocations=null;let disposed=false,dayView=retained?.dayView||null;const cleanups=[];
    host._mediaCleanup=()=>{disposed=true;dayView?.destroy();cleanups.forEach(cleanup=>cleanup());};
    host.replaceChildren();host.classList.add('location-dashboard');
    const pending=M.element('p','muted','Opening location history…');pending.setAttribute('role','status');if(!retained)host.append(pending);
    let data=retained?.data;
    try { if(!retained){
      await M.refresh();
      if(disposed||!host.isConnected)return;
      data=await load(from,to,text=>{if(!disposed)pending.textContent=text;},()=>disposed);
    }
    } catch (_) {
      if(!disposed&&host.isConnected)host.replaceChildren(M.element('p','muted','Could not load location history.'),M.button('Retry locations',()=>render(host,{from,to})));
      return;
    }
    if(disposed||!host.isConnected||!data)return;
    host.replaceChildren();
    const days=[...(data.days||[])].sort((a,b)=>a.date.localeCompare(b.date)),s=data.summary||{};
    if(!days.length){dayView?.destroy();dayView=null;host.append(M.element('p','muted','No locations recorded.'));host._refreshLocations=range=>render(host,range||{from,to});return;}
    const tracked=s.days_tracked??days.length;
    const toolbar=M.element('div','media-toolbar');
    const range=days[0].date===days.at(-1).date?days[0].date:days[0].date+' → '+days.at(-1).date;
    toolbar.append(M.element('p','muted',range+' · '+tracked+(tracked===1?' day':' days')+' tracked'));host.append(toolbar);
    function statCards(area,facts){const cards=M.element('div','stat-cards location-stat-cards');facts.forEach(([value,label])=>{const card=M.element('div','stat-card');card.append(M.element('div','stat-card-value',value),M.element('div','stat-card-label',label));cards.append(card);});area.append(cards);}
    statCards(host,[[distance(s.distance_m),'Distance travelled'],[duration(s.moving_seconds),'Time moving'],[String(s.stay_count??days.reduce((n,d)=>n+(d.summary.stay_count||0),0)),'Stops · 10+ min'],[String(tracked),'Days tracked']]);
    function section(title,help){const area=M.element('section','location-insight');area.append(M.element('h3','',title));if(help)area.append(M.element('p','chart-muted',help));host.append(area);return area;}
    function bars(area,rows,format,onSelect){
      const max=Math.max(1,...rows.map(r=>r.value));
      if(!rows.length){area.append(M.element('p','muted','No observations yet in this range.'));return;}
      rows.forEach(row=>{const item=M.element('div','location-rank'),label=onSelect?M.button(row.label,()=>onSelect(row)):M.element('span','',row.label);item.append(label,M.element('span','location-rank-value',format(row.value)+(row.detail?' · '+row.detail:'')));const track=M.element('div','location-rank-track'),fill=M.element('span','location-rank-fill');fill.style.width=(row.value/max*100)+'%';track.append(fill);item.append(track);area.append(item);});
    }
    const totals=section('Where you spend time','Stops of 10+ min. Select a place for visits.');
    const details=M.element('div','location-place-detail');let selectedPlace=null;
    const placeKey=place=>place.place_id||[place.name,place.lat,place.lon].join(':');
    function showPlace(row,scroll=true){
      selectedPlace=row;
      details.replaceChildren(M.element('h4','',row.name));
      const same=v=>row.place_id?v.place_id===row.place_id:!v.place_id&&global.TodoPupMap.nearestPlace(v,[{...row,radius_m:100}]);
      const visits=days.flatMap(d=>(d.visits||[]).filter(same).map(v=>({date:d.date,...v}))).sort((a,b)=>b.arrival.localeCompare(a.arrival));
      visits.slice(0,50).forEach(v=>{const button=M.button(v.date+' · '+v.arrival.slice(11,16)+'–'+v.departure_after.slice(11,16)+' · '+duration(v.duration_seconds),()=>openDay(v.date));button.dataset.locationVisit=[v.date,v.arrival,v.source_device||''].join('|');details.append(button);});
      if(scroll)details.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
    bars(totals,(data.place_totals||[]).slice(0,15).map(p=>({...p,label:p.name,value:p.duration_seconds,detail:p.visits+(p.visits===1?' visit':' visits')})),duration,showPlace);totals.append(details);
    const travel=section('Travel over time','Distance per day; missing days stay blank.');cleanups.push(chart(travel,days,'distance_m',distance,'Daily recorded travel distance'));
    statCards(travel,[[distance(tracked?s.distance_m/tracked:null),'Distance / tracked day'],[duration(tracked?s.moving_seconds/tracked:null),'Moving time / tracked day'],[speed(s.avg_moving_speed_mps),'Average moving speed'],[speed(s.max_speed_mps),'Top recorded speed']]);
    const transport=section('How you get around','Estimated movement. Vehicle includes cars, buses, and trains.');
    bars(transport,(s.transport||[]).filter(t=>t.mode!=='stationary'&&t.duration_seconds>0).map(t=>({label:modes[t.mode]||t.mode,value:t.duration_seconds,detail:distance(t.distance_m)})),duration);
    const hours=(data.hourly||[]).filter(h=>h.moving_seconds>0);
    if(hours.length){const area=section('Movement by hour','Moving time by local hour.');bars(area,hours.map(h=>({label:String(h.hour).padStart(2,'0')+':00',value:h.moving_seconds})),duration);}
    if(data.dow?.some(d=>d.days_tracked)){const names=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],area=section('Movement by weekday','Average distance per tracked day.');bars(area,data.dow.filter(d=>d.days_tracked).map(d=>({label:names[d.day],value:d.distance_m/d.days_tracked,detail:d.days_tracked+(d.days_tracked===1?' day':' days')})),distance);}
    const recorded=section('Recording coverage',duration(s.recorded_seconds)+' recorded · '+duration(tracked?s.recorded_seconds/tracked:null)+' / tracked day. Gaps and poor fixes excluded.');cleanups.push(chart(recorded,days,'recorded_seconds',duration,'Recorded time per day'));
    if(number(s.stationary_seconds))recorded.append(M.element('p','chart-muted',duration(s.stationary_seconds)+' stationary, including stops under 10 min.'));
    const browse=section('Explore a day','Daily route, photos, and replay.'),picker=M.element('select');picker.setAttribute('aria-label','Choose a recorded day');
    [...days].reverse().forEach(d=>{const option=M.element('option','',d.date+' · '+distance(d.summary.distance_m));option.value=d.date;picker.append(option);});
    const daily=M.element('div','location-selected-day'),selected=retained?.selected||M.element('div','location-selected-day');daily.hidden=true;daily.append(picker,selected);
    let expanded=!!retained?.expanded&&days.some(day=>day.date===retained.date);
    if(expanded)picker.value=retained.date;
    const toggle=M.button('Open daily map',()=>setExpanded(!expanded));toggle.setAttribute('aria-expanded','false');browse.append(toggle,daily);global.enhanceSelect?.(picker);
    function drawDay(){dayView?.destroy();selected.replaceChildren();dayView=global.PupLocationDayView.mount(selected,picker.value);}
    function setExpanded(value){if(disposed)return;expanded=value;daily.hidden=!value;toggle.textContent=value?'Close daily map':'Open daily map';toggle.setAttribute('aria-expanded',String(value));if(value)drawDay();else{dayView?.destroy();dayView=null;selected.replaceChildren();}}
    function openDay(date){if(disposed)return;picker.value=date;picker.dispatchEvent(new Event('change'));if(!expanded)setExpanded(true);browse.scrollIntoView({behavior:'smooth',block:'start'});}
    picker.addEventListener('change',()=>{if(expanded&&!disposed)drawDay();});
    if(expanded){daily.hidden=false;toggle.textContent='Close daily map';toggle.setAttribute('aria-expanded','true');void dayView?.refresh();}
    else if(dayView){dayView.destroy();dayView=null;selected.replaceChildren();}
    if(retained?.selectedPlace){const place=(data.place_totals||[]).find(row=>placeKey(row)===placeKey(retained.selectedPlace));if(place)showPlace(place,false);}
    const refreshStatus=M.element('div');host.append(refreshStatus);let refreshVersion=0;
    host._refreshLocations=async range=>{
      if(disposed)return;
      if(range){from=range.from??null;to=range.to??null;}
      const version=++refreshVersion;
      try{
        await M.refresh();if(disposed||version!==refreshVersion)return;
        const fresh=await load(from,to,()=>{},()=>disposed||version!==refreshVersion);
        if(disposed||version!==refreshVersion||!fresh)return;
        const focused=host.contains(document.activeElement)?document.activeElement:null;
        const snapshot={data:fresh,dayView,selected,expanded,selectedPlace,date:picker.value,focused,
          focusPicker:!!focused?.closest('.custom-select')?.contains(picker),
          focusVisit:focused?.dataset.locationVisit,
          focusText:focused?.tagName==='BUTTON'?focused.textContent:null,scrollTop:window.scrollY};
        dayView=null;
        await render(host,{from,to},snapshot);
      }catch(_){
        if(disposed||version!==refreshVersion)return;
        const error=M.element('p','muted','Could not refresh location history. Previous view kept.');error.setAttribute('role','status');
        refreshStatus.replaceChildren(error,M.button('Retry locations',()=>host._refreshLocations()));
      }
    };
    if(retained){
      window.scrollTo({top:retained.scrollTop,behavior:'instant'});
      if(retained.focused&&document.activeElement===document.body){
        const focus=retained.focused.isConnected?retained.focused:retained.focusPicker?picker.parentElement.querySelector('.cs-trigger'):
          [...host.querySelectorAll('button')].find(button=>retained.focusVisit?button.dataset.locationVisit===retained.focusVisit:button.textContent===retained.focusText)||toggle;
        focus?.focus({preventScroll:true});
      }
    }
  }
  const api={duration,distance,speed,trendSeries,render};
  if(typeof module!=='undefined')module.exports=api;
  global.PupLocationAnalytics=api;
})(typeof window==='undefined'?globalThis:window);
