/* Pure daily location analysis, mirrored in places.py. No network or DOM. */
(function (global) {
  'use strict';
  const MODES=['stationary','walking','cycling','vehicle','unknown'];
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  const seconds=at=>Date.parse(at)/1000;
  const minute=at=>Number(at.slice(11,13))*60+Number(at.slice(14,16))+Number(at.slice(17).match(/^\d+(?:\.\d+)?/)?.[0]||0)/60;
  const offset=at=>at.endsWith('Z')?'+00:00':at.slice(-6);
  const aware=at=>typeof at==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at));
  function stamp(at){return at.replace(/Z$/,'+00:00').replace(/\.([0-9]+)(?=[+-]\d{2}:\d{2}$)/,(_,n)=>Number(n)?'.'+n.padEnd(6,'0').slice(0,6):'');}
  function rounded(value){
    if(typeof value==='number')return Math.round(value*1e6)/1e6;
    if(Array.isArray(value))return value.map(rounded);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rounded(v)]));
    return value;
  }
  function coordinate(point){
    if(!point||point.lat==null||point.lon==null)return null;
    const lat=Number(point.lat),lon=Number(point.lon);
    return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?{lat,lon}:null;
  }
  function distance(a,b){const p=Math.PI/180,al=a.lat*p,bl=b.lat*p,dlat=bl-al,dlon=(b.lon-a.lon)*p,h=Math.sin(dlat/2)**2+Math.cos(al)*Math.cos(bl)*Math.sin(dlon/2)**2;return 12742017.6*Math.asin(Math.min(1,Math.sqrt(h)));}
  function transport(speed){return speed<.5?'stationary':speed<2.5?'walking':speed<7?'cycling':speed<=100?'vehicle':'unknown';}
  function sourceDevice(row){return row.source_device??'phone';}
  function clean(raw){
    const point=coordinate(raw),accuracy=Number(raw.accuracy_m??1000);
    if(!point||!Number.isFinite(accuracy)||accuracy<0||typeof raw.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(raw.id))return null;
    const result={...point,id:raw.id,at:stamp(raw.at),accuracy_m:accuracy,session:String(raw.session??'').slice(0,100),mode:['detailed','precise'].includes(raw.mode)?raw.mode:'visits'};
    for(const [field,max] of [['speed_mps',400],['speed_accuracy_mps',null],['bearing',360]]){
      if(raw[field]==null)continue;
      const n=Number(raw[field]);if(!Number.isFinite(n)||n<0||(max!==null&&(field==='bearing'?n>=max:n>max)))return null;
      result[field]=n;
    }
    if(raw.provider!=null)result.provider=String(raw.provider).slice(0,40);
    if(Object.hasOwn(raw,'source_device')){if(!['phone','laptop'].includes(raw.source_device))return null;result.source_device=raw.source_device;}
    return result;
  }
  function nearest(row,places){
    return places.filter(p=>!p.archived&&row.accuracy_m<=(p.radius_m??100)&&distance(row,p)<=(p.radius_m??100))
      .map(place=>({place,radius:place.radius_m??100,dist:distance(row,place)}))
      .sort((a,b)=>a.radius-b.radius||a.dist-b.dist||compare(a.place.id,b.place.id))[0]?.place||null;
  }
  function visits(rows,places){
    const result=[],specific=places.filter(p=>!p.is_city),cities=places.filter(p=>p.is_city);
    let run=[],current=null;
    function flush(next=null){
      if(!run.length)return;
      const elapsed=seconds(run.at(-1).at)-seconds(run[0].at);
      if(elapsed>=600)result.push({id:run[0].id,place_id:current.id??null,name:current.name,arrival:run[0].at,departure_after:run.at(-1).at,departure_before:next?.at??null,duration_seconds:elapsed,estimated:true,lat:current.lat,lon:current.lon,city_id:current.city_id??null,start:run[0].at,end:run.at(-1).at});
    }
    for(const row of rows){
      const accurate=row.accuracy_m<=100,moving=(row.speed_mps??0)>=.5&&(row.speed_accuracy_mps??0)<=Math.max(1,(row.speed_mps??0)*.5);
      const place=accurate?nearest(row,specific):null;
      const gap=run.length&&(seconds(row.at)-seconds(run.at(-1).at)>600||row.session!==run.at(-1).session);
      const sameUnknown=accurate&&!gap&&!place&&current&&!current.id&&distance(row,current)<=100;
      const sameSaved=place&&current&&place.id===current.id;
      if(gap||!accurate||moving||!(sameUnknown||sameSaved)){flush(gap||!accurate?null:row);run=[];current=null;}
      if(!accurate||moving)continue;
      if(!current){const city=nearest(row,cities);current=place||{id:null,name:'Unsaved place'+(city?' · '+city.name:''),lat:row.lat,lon:row.lon,city_id:city?.id??null};}
      run.push(row);
    }
    flush();return result;
  }
  function hourly(segments){
    const rows=Array.from({length:24},(_,hour)=>({hour,recorded_seconds:0,moving_seconds:0,distance_m:0}));
    for(const segment of segments){
      let start=minute(segment.start)*60,remaining=segment.duration_seconds;
      while(remaining>0){
        const hour=Math.floor(start/3600)%24,seconds=Math.min(remaining,3600-start%3600);
        rows[hour].recorded_seconds+=seconds;
        rows[hour].moving_seconds+=segment.mode!=='stationary'?seconds:0;
        rows[hour].distance_m+=segment.distance_m*seconds/segment.duration_seconds;
        remaining-=seconds;start+=seconds;
      }
    }
    return rows;
  }
  function analyze(date,samples=[],places=[],photos=[],source=null){
    let rows=samples.filter(r=>r&&aware(r.at)&&(!date||r.at.slice(0,10)===date))
      .map(raw=>clean(raw)||{at:stamp(raw.at),id:String(raw.id??''),accuracy_m:1000,...(['phone','laptop'].includes(raw.source_device)?{source_device:raw.source_device}:{})})
      .sort((a,b)=>seconds(a.at)-seconds(b.at)||compare(a.id,b.id));
    date=date||rows[0]?.at.slice(0,10)||null;
    if(date)rows=rows.filter(r=>r.at.slice(0,10)===date);
    source=source||(rows.some(r=>sourceDevice(r)==='phone'&&r.accuracy_m<=100)?'phone':rows.some(r=>sourceDevice(r)==='laptop')?'laptop':'phone');
    rows=rows.filter(r=>sourceDevice(r)===source);
    const points=[],routes=[],segments=[];
    let previous=null,recent=[];
    for(const row of rows){
      if(row.accuracy_m>100){previous=null;recent=[];continue;}
      points.push(row);
      const elapsed=previous?seconds(row.at)-seconds(previous.at):0;
      let connected=previous&&elapsed>0&&elapsed<=600&&row.session===previous.session;
      let meters=connected?distance(previous,row):0;
      connected=connected&&meters/elapsed<=400;
      if(!connected){routes.push([row]);recent=[row];}
      else{
        routes.at(-1).push(row);
        const uncertainty=Math.max(3,Math.hypot(previous.accuracy_m,row.accuracy_m));
        const measured=row.speed_mps,trusted=measured!=null&&(row.speed_accuracy_mps??0)<=Math.max(1,measured*.5);
        recent=recent.filter(p=>seconds(row.at)-seconds(p.at)<=30);
        const contextMotion=recent.some(p=>distance(p,row)>Math.max(3,Math.hypot(p.accuracy_m,row.accuracy_m)));
        let speed;
        if(meters<=uncertainty&&!contextMotion&&!(trusted&&measured>=.5)){meters=0;speed=0;}
        else{speed=meters/elapsed;if(trusted&&measured>=.5&&Math.abs(measured-speed)<=Math.max(3,speed*.75))speed=measured;}
        const mode=transport(speed);if(mode==='stationary')meters=0;
        segments.push({id:previous.id+':'+row.id,from:previous,to:row,start:previous.at,end:row.at,duration_seconds:elapsed,distance_m:meters,speed_mps:speed,mode,estimated:true});
        recent.push(row);
      }
      previous=row;
    }
    const stops=routes.flatMap(route=>visits(route,places));
    const modes=MODES.map(mode=>({mode,duration_seconds:segments.filter(s=>s.mode===mode).reduce((n,s)=>n+s.duration_seconds,0),distance_m:segments.filter(s=>s.mode===mode).reduce((n,s)=>n+s.distance_m,0)}));
    const moving=segments.filter(s=>s.mode!=='stationary').reduce((n,s)=>n+s.duration_seconds,0),meters=segments.reduce((n,s)=>n+s.distance_m,0);
    const summary={sample_count:points.length,distance_m:meters,recorded_seconds:segments.reduce((n,s)=>n+s.duration_seconds,0),moving_seconds:moving,stop_seconds:stops.reduce((n,s)=>n+s.duration_seconds,0),stationary_seconds:modes[0].duration_seconds,stay_count:stops.length,max_speed_mps:segments.reduce((n,s)=>Math.max(n,s.speed_mps),0),avg_moving_speed_mps:moving?meters/moving:null,transport:modes,first_at:points[0]?.at??null,last_at:points.at(-1)?.at??null};
    const day={date,source_device:source,samples:points,routes,segments,visits:stops,summary,photos:[],hourly:hourly(segments)};
    day.photos=photos.map(photo=>photoLocation(photo,day)).filter(Boolean);
    return rounded(day);
  }
  function localStamp(epoch,zone){
    const minutes=(zone[0]==='-'?-1:1)*(Number(zone.slice(1,3))*60+Number(zone.slice(4,6)));
    return stamp(new Date(epoch+minutes*60000).toISOString().replace('Z',zone));
  }
  function interpolate(segment,fraction,at){
    const a=segment.from,b=segment.to,delta=((b.lon-a.lon+540)%360)-180,lon=(a.lon+delta*fraction+540)%360-180;
    return rounded({lat:a.lat+(b.lat-a.lat)*fraction,lon,at,accuracy_m:Math.max(a.accuracy_m,b.accuracy_m),speed_mps:segment.speed_mps,transport:segment.mode,estimated:true});
  }
  const replayIndexes=new WeakMap();
  function replayIndex(day){
    let index=replayIndexes.get(day);
    if(!index){
      // An analyzed day is an immutable snapshot. Keep the index private so
      // serialized day payloads stay unchanged and old snapshots can be freed.
      index={segments:day.segments.map(segment=>({segment,start:seconds(segment.start),end:seconds(segment.end)})),samples:day.samples.map(point=>({point,time:seconds(point.at)})),offsets:[...new Set(day.samples.map(point=>offset(point.at)))]};
      replayIndexes.set(day,index);
    }
    return index;
  }
  function lowerBound(rows,beforeTarget){
    let low=0,high=rows.length;
    while(low<high){const middle=(low+high)>>>1;if(beforeTarget(rows[middle]))low=middle+1;else high=middle;}
    return low;
  }
  function atTime(day,at){
    const target=typeof at==='number'?at/1000:seconds(at);if(!Number.isFinite(target))return null;
    const index=replayIndex(day),row=index.segments[lowerBound(index.segments,row=>row.end<target)];
    // Search by the first interval ending at/after the requested time. At a
    // shared endpoint this preserves the earlier interval's speed and mode.
    if(row&&row.start<=target)return interpolate(row.segment,(target-row.start)/(row.end-row.start),localStamp(target*1000,offset(row.segment.start)));
    const sample=index.samples[lowerBound(index.samples,row=>target-row.time>=.001)];
    const point=sample&&Math.abs(sample.time-target)<.001?sample.point:null;
    return point?{lat:point.lat,lon:point.lon,at:point.at,accuracy_m:point.accuracy_m,speed_mps:point.speed_mps??null,transport:'unknown',estimated:false}:null;
  }
  function positionAt(day,minuteOfDay){
    minuteOfDay=Number(minuteOfDay);if(!Number.isFinite(minuteOfDay)||minuteOfDay<0||minuteOfDay>=1440)return null;
    const matches=[];
    for(const zone of replayIndex(day).offsets){
      const start=Date.parse(day.date+'T00:00:00'+zone),point=atTime(day,start+minuteOfDay*60000);
      if(point&&Math.abs(minute(point.at)-minuteOfDay)<.000001)matches.push(point);
    }
    return matches.length===1?matches[0]:null;
  }
  function photoLocation(photo,day){
    if(!photo||typeof photo!=='object')return null;
    const base={asset_id:photo.asset_id??photo.id??null,captured_at:photo.captured_at??null},gps=coordinate(photo.location);
    if(gps)return {...base,...gps,source:'gps',estimated:false};
    if(typeof photo.captured_at!=='string')return null;
    const captured=photo.captured_at;
    let point=null;
    if(aware(captured))point=atTime(day,captured);
    else if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(captured)&&captured.slice(0,10)===day.date)point=positionAt(day,minute(captured));
    return point?{...base,lat:point.lat,lon:point.lon,source:'route',estimated:true}:null;
  }
  function visitTotals(visits){
    const totals=[];
    for(const visit of visits){
      let row=totals.find(r=>visit.place_id?r.place_id===visit.place_id:!r.place_id&&distance(r,visit)<=100);
      if(!row){row={place_id:visit.place_id??null,name:visit.name,lat:visit.lat,lon:visit.lon,duration_seconds:0,visits:0};totals.push(row);}
      row.duration_seconds+=visit.duration_seconds;row.visits++;
    }
    return totals.sort((a,b)=>b.duration_seconds-a.duration_seconds||compare(a.name,b.name));
  }
  function aggregate(days=[]){
    const keys=['sample_count','distance_m','recorded_seconds','moving_seconds','stop_seconds','stationary_seconds','stay_count'];
    const summary=Object.fromEntries(keys.map(key=>[key,days.reduce((n,day)=>n+day.summary[key],0)]));
    Object.assign(summary,{days_tracked:days.filter(day=>day.summary.sample_count).length,max_speed_mps:days.reduce((n,d)=>Math.max(n,d.summary.max_speed_mps),0),avg_moving_speed_mps:summary.moving_seconds?summary.distance_m/summary.moving_seconds:null,transport:MODES.map(mode=>({mode,...Object.fromEntries(['duration_seconds','distance_m'].map(key=>[key,days.reduce((n,day)=>n+day.summary.transport.filter(row=>row.mode===mode).reduce((n,row)=>n+row[key],0),0)]))}))});
    const hours=hourly([]),dow=Array.from({length:7},(_,day)=>({day,recorded_seconds:0,moving_seconds:0,distance_m:0,days_tracked:0}));
    for(const day of days){
      const weekday=(new Date(day.date+'T00:00:00Z').getUTCDay()+6)%7;
      dow[weekday].days_tracked+=day.summary.sample_count?1:0;
      for(const key of ['recorded_seconds','moving_seconds','distance_m'])dow[weekday][key]+=day.summary[key];
      (day.hourly||hourly(day.segments||[])).forEach((row,hour)=>{for(const key of ['recorded_seconds','moving_seconds','distance_m'])hours[hour][key]+=row[key];});
    }
    return rounded({days:days.map(day=>({date:day.date,summary:day.summary,visits:day.visits})),summary,place_totals:visitTotals(days.flatMap(day=>day.visits)),hourly:hours,dow});
  }
  const api={analyze,positionAt,atTime,photoLocation,aggregate,distance,visitTotals,sourceDevice};
  global.PupLocationDay=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
