/* Local PMTiles v3 + MVT canvas viewer. No remote tiles or third-party JS. */
(function (global) {
  'use strict';
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  // Existing vector tiles scale beyond their stored zoom; no new detail is fetched.
  const MAX_ZOOM = 22;
  function project(lon,lat) { const s=Math.sin(clamp(lat,-85.0511287,85.0511287)*Math.PI/180); return {x:(lon+180)/360,y:.5-Math.log((1+s)/(1-s))/(4*Math.PI)}; }
  function unproject(x,y) { return {lon:x*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI}; }
  function tileId(z,x,y) {
    let n=2**z, d=0;
    for(let s=n/2;s>=1;s/=2){let rx=(x&s)?1:0,ry=(y&s)?1:0;d+=s*s*((3*rx)^ry);if(!ry){if(rx){x=s-1-x;y=s-1-y;}[x,y]=[y,x];}}
    return (4**z-1)/3+d;
  }
  class Reader {
    constructor(bytes){this.b=bytes;this.p=0;this.v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
    varint(){let n=0,m=1;for(let i=0;i<10;i++){if(this.p>=this.b.length)throw Error('Truncated map data');let c=this.b[this.p++];n+=(c&127)*m;if(!(c&128))return n;m*=128;}throw Error('Invalid map integer');}
    bytes(){let size=this.varint(),end=this.p+size;if(end>this.b.length)throw Error('Truncated map data');let b=this.b.subarray(this.p,end);this.p=end;return b;}
    skip(w){if(w===0)this.varint();else if(w===2)this.bytes();else if(w===1)this.p+=8;else if(w===5)this.p+=4;else throw Error('Invalid map field');if(this.p>this.b.length)throw Error('Truncated map data');}
    fields(fn){while(this.p<this.b.length){let t=this.varint();if(!fn(t>>3,t&7,this))this.skip(t&7);}}
  }
  function readDirectory(bytes){let r=new Reader(bytes),n=r.varint();if(n>1000000)throw Error('Invalid map directory');let rows=[],id=0;for(let i=0;i<n;i++){id+=r.varint();rows.push({id});}for(let row of rows)row.run=r.varint();for(let row of rows)row.length=r.varint();for(let i=0;i<n;i++){let v=r.varint();rows[i].offset=v?v-1:(i?rows[i-1].offset+rows[i-1].length:0);}return rows;}
  async function inflate(bytes,compression){if(compression===1)return bytes;if(compression!==2)throw Error('Unsupported map compression');return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());}
  class Archive {
    constructor(url,read){this.url=url;this.read=read||async function(offset,length){
      // WebView may apply Range again to an intercepted, already-sliced stream.
      // Explicit byte queries keep Android reads bounded without that second seek.
      const native=!!global.TodoPupNative, expected=native?200:206;
      const target=native?url+(url.includes('?')?'&':'?')+'offset='+offset+'&length='+length:url;
      const response=await fetch(target,native?{}:{headers:{Range:'bytes='+offset+'-'+(offset+length-1)}});
      if(response.status===409){
        const body=await response.json().catch(()=>({})),error=Error('Map version changed');
        if(response.headers.get('X-Datapom-Error')==='map_version_changed'||body.error==='map_version_changed'||body.error?.code==='map_version_changed'||body.code==='map_version_changed'){
          error.code='map_version_changed';throw error;
        }
      }
      if(response.status!==expected)throw Error('Map byte request returned HTTP '+response.status+' (expected '+expected+')');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length!==length)throw Error('Map byte request returned '+bytes.length+' bytes (expected '+length+')');return bytes;
    };this.cache=new Map();}
    async init(){if(!this.ready)this.ready=(async()=>{let b=await this.read(0,127),v=new DataView(b.buffer,b.byteOffset,b.byteLength);if(new TextDecoder().decode(b.subarray(0,7))!=='PMTiles'||b[7]!==3||b[99]!==1)throw Error('Invalid vector map pack');let u=o=>Number(v.getBigUint64(o,true));this.h={root:u(8),rootLength:u(16),leaf:u(40),tiles:u(56),internal:b[97],compression:b[98],min:b[100],max:b[101]};this.root=await this.directory(this.h.root,this.h.rootLength);})();return this.ready.catch(error=>{this.ready=null;this.cache.clear();throw error;});}
    async directory(offset,length){let key=offset+':'+length;if(!this.cache.has(key))this.cache.set(key,(async()=>readDirectory(await inflate(await this.read(offset,length),this.h.internal)))());return this.cache.get(key);}
    async tile(z,x,y){await this.init();let id=tileId(z,x,y),rows=this.root;for(let depth=0;depth<4;depth++){let low=0,high=rows.length-1,match=null;while(low<=high){let m=(low+high)>>1;if(rows[m].id<=id){match=rows[m];low=m+1;}else high=m-1;}if(!match)return null;if(match.run){if(id>=match.id+match.run)return null;return inflate(await this.read(this.h.tiles+match.offset,match.length),this.h.compression);}rows=await this.directory(this.h.leaf+match.offset,match.length);}throw Error('Invalid map directory depth');}
  }
  function value(bytes){let result;new Reader(bytes).fields((f,w,r)=>{if(f===1){result=new TextDecoder().decode(r.bytes());return true;}if(f===2&&w===5){result=r.v.getFloat32(r.p,true);r.p+=4;return true;}if(f===3&&w===1){result=r.v.getFloat64(r.p,true);r.p+=8;return true;}if(f>=4&&f<=7){let n=r.varint();result=f===6?(n%2?-(n+1)/2:n/2):f===7?!!n:n;return true;}return false;});return result;}
  function geometry(bytes){let r=new Reader(bytes),x=0,y=0,paths=[],path=[];while(r.p<bytes.length){let cmd=r.varint(),count=Math.floor(cmd/8),op=cmd&7;if(count>1000000)throw Error('Invalid geometry');if(op===7){if(path.length)path.push(path[0]);continue;}if(op!==1&&op!==2)throw Error('Invalid geometry command');for(let i=0;i<count;i++){let dx=r.varint(),dy=r.varint();x+=dx%2?-(dx+1)/2:dx/2;y+=dy%2?-(dy+1)/2:dy/2;if(op===1){if(path.length)paths.push(path);path=[];}path.push([x,y]);}}if(path.length)paths.push(path);return paths;}
  function decodeTile(bytes){let layers=[];new Reader(bytes).fields((f,w,r)=>{if(f!==3)return false;let keys=[],values=[],features=[],name='',extent=4096;new Reader(r.bytes()).fields((f,w,r)=>{if(f===1){name=new TextDecoder().decode(r.bytes());return true;}if(f===2){features.push(r.bytes());return true;}if(f===3){keys.push(new TextDecoder().decode(r.bytes()));return true;}if(f===4){values.push(value(r.bytes()));return true;}if(f===5){extent=r.varint();return true;}return false;});let decoded=features.map(bytes=>{let tags=[],type=0,geom=[];new Reader(bytes).fields((f,w,r)=>{if(f===2){let t=new Reader(r.bytes());while(t.p<t.b.length)tags.push(t.varint());return true;}if(f===3){type=r.varint();return true;}if(f===4){geom=geometry(r.bytes());return true;}return false;});let properties={};for(let i=0;i<tags.length;i+=2)properties[keys[tags[i]]]=values[tags[i+1]];return {type,geometry:geom,properties};});layers.push({name,extent,features:decoded});return true;});return layers;}
  function meters(a,b) { const p=Math.PI/180,dl=(b.lat-a.lat)*p,dn=(b.lon-a.lon)*p,h=Math.sin(dl/2)**2+Math.cos(a.lat*p)*Math.cos(b.lat*p)*Math.sin(dn/2)**2; return 12742017.6*Math.asin(Math.sqrt(Math.min(1,h))); }
  function nearestPlace(point, places) {
    const accuracy=point?.accuracy_m??0;
    if(!point||![point.lat,point.lon,accuracy].every(Number.isFinite)||accuracy<0)return null;
    return places.filter(p=>p&&!p.archived&&[p.lat,p.lon].every(Number.isFinite)).map(place=>({place,radius:Number(place.radius_m??100),distance:meters(point,place)}))
      .filter(p=>Number.isFinite(p.radius)&&p.radius>0&&accuracy<=p.radius&&p.distance<=p.radius)
      .sort((a,b)=>a.radius-b.radius||a.distance-b.distance||String(a.place.id||a.place.name||'').localeCompare(String(b.place.id||b.place.name||'')))[0]?.place||null;
  }
  const CURRENT_LOCATION_AGE = 30000;
  function playbackLocation(point) {
    return point && [point.lat,point.lon].every(Number.isFinite) && Math.abs(point.lat)<=90 && Math.abs(point.lon)<=180 ? {...point} : null;
  }
  function photoMarkerGroups(markers,pixel) {
    const rows=[],seen=new Set(),cells=new Map(),parents=[];
    const root=index=>{while(parents[index]!==index){parents[index]=parents[parents[index]];index=parents[index];}return index;};
    for(const marker of markers){
      const photo=!!(marker.thumbnail&&marker.asset_id);if(photo&&seen.has(marker.asset_id))continue;if(photo)seen.add(marker.asset_id);
      const index=rows.length,p=pixel(marker.lon,marker.lat);rows.push({marker,photo,p});parents.push(index);if(!photo)continue;
      const x=Math.floor(p.x/44),y=Math.floor(p.y/44);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const other of cells.get((x+dx)+':'+(y+dy))||[]){
        const q=rows[other].p;if(Math.abs(p.x-q.x)<=44&&Math.abs(p.y-q.y)<=44){const a=root(index),b=root(other);parents[Math.max(a,b)]=Math.min(a,b);}
      }
      const key=x+':'+y;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(index);
    }
    const groups=new Map();rows.forEach((row,index)=>{const key=root(index);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row.marker);});
    return [...groups.values()].map(members=>members.length===1?members[0]:{...members[0],markers:members,asset_ids:members.map(marker=>marker.asset_id)});
  }
  function markerAt(markers,pixel,point) {
    return photoMarkerGroups(markers,pixel).map(marker=>{const p=pixel(marker.lon,marker.lat),photo=!!marker.thumbnail,dx=point.x-p.x,dy=point.y-p.y+(photo?22:0);return {marker,distance:Math.hypot(dx,dy),hit:photo?Math.abs(dx)<=22&&Math.abs(dy)<=22:Math.hypot(dx,dy)<=22};})
      .filter(row=>row.hit).sort((a,b)=>a.distance-b.distance||Number(!!b.marker.asset_id)-Number(!!a.marker.asset_id))[0]?.marker||null;
  }
  function currentLocation(point, now=Date.now()) {
    if(!point||![point.lat,point.lon,point.accuracy_m].every(Number.isFinite)||Math.abs(point.lat)>90||Math.abs(point.lon)>180||point.accuracy_m<0)return null;
    const observed=Date.parse(point.observed_at);
    if(!Number.isFinite(observed)||now-observed>CURRENT_LOCATION_AGE||observed-now>5000)return null;
    return {lat:point.lat,lon:point.lon,accuracy_m:point.accuracy_m,observed_at:point.observed_at};
  }
  async function locateCurrentPosition({prompt=false,navigator=global.navigator,nativeRequest,now=Date.now}={}) {
    let result;
    if(nativeRequest)result=await nativeRequest({prompt});
    else {
      if(!navigator?.geolocation)return {status:'unavailable',message:'Location is unavailable in this browser. You can still tap the map to save a place.'};
      if(!prompt){let permission;try{permission=(await navigator.permissions?.query({name:'geolocation'}))?.state;}catch(_){}if(permission!=='granted')return {status:'permission_required',message:'Show your location to place a current-position marker on this map.'};}
      result=await new Promise(resolve=>navigator.geolocation.getCurrentPosition(position=>resolve({status:'ok',location:{lat:position.coords.latitude,lon:position.coords.longitude,accuracy_m:position.coords.accuracy,observed_at:Number.isFinite(position.timestamp)?new Date(position.timestamp).toISOString():''}}),error=>resolve({status:error.code===1?'permission_required':error.code===3?'timeout':'unavailable',message:error.code===1?'Location access is off. Allow it for Datapom in this browser’s site settings.':error.code===3?'Could not find your location yet. Try again near a window or outdoors.':'Your browser could not find your location. Check Location Services or try again when connected.'}),{enableHighAccuracy:true,maximumAge:0,timeout:12000}));
    }
    if(result?.status!=='ok')return result||{status:'unavailable',message:'Your current location is unavailable. Try again.'};
    const location=currentLocation(result.location,now());
    return location?{status:'ok',location}:{status:'unavailable',message:'A fresh location was not available. Try again to update the map.'};
  }
  function visitTotals(visits) {
    const totals=[];
    for(const v of visits){let row=totals.find(r=>v.place_id?r.place_id===v.place_id:!r.place_id&&meters(r,v)<=100);if(!row){row={place_id:v.place_id||null,name:v.name,lat:v.lat,lon:v.lon,duration_seconds:0,visits:0};totals.push(row);}row.duration_seconds+=v.duration_seconds;row.visits++;}
    return totals.sort((a,b)=>b.duration_seconds-a.duration_seconds||a.name.localeCompare(b.name));
  }
  function safeBounds(b) { return [clamp(b[0],-180,180),clamp(b[1],-85.0511,85.0511),clamp(b[2],-180,180),clamp(b[3],-85.0511,85.0511)]; }
  function lookupLimit(layer,p) { return layer==='pois'?100:p.kind_detail==='city'?30000:p.kind_detail==='town'?8000:2000; }
  function featureVisible(layer,p,z) {
    if(Number(p.min_zoom||0)>z)return false;
    if(layer==='buildings')return z>=14;
    if(layer==='transit')return z>=12;
    if(layer==='roads') {
      if(p.is_link&&z<12)return false;
      if((p.kind_detail||'').startsWith('secondary')&&z<11)return false;
      if((p.kind_detail||'').startsWith('tertiary')&&z<12)return false;
      return p.kind==='highway'||(p.kind==='major_road'&&z>=9)||(p.kind==='minor_road'&&z>=12)||(z>=14);
    }
    if(layer==='pois')return z>=15;
    if(layer==='places') {
      if(['neighbourhood','neighborhood','macrohood','microhood'].includes(p.kind))return z>=13;
      if(['town','village','hamlet','suburb','quarter'].includes(p.kind_detail))return z>=11;
    }
    return true;
  }
  const packURL=p=>p.url+(p.url.includes('?')?'&':'?')+'v='+encodeURIComponent(p.sha256||p.downloaded_at||p.bytes||'');
  const lookupArchives=new Map();
  async function lookup(point,packs) {
    const pack=packs.filter(p=>p.status==='ready'&&p.bounds[0]<=point.lon&&p.bounds[2]>=point.lon&&p.bounds[1]<=point.lat&&p.bounds[3]>=point.lat).sort((a,b)=>b.max_zoom-a.max_zoom)[0];
    if(!pack)return null;
    const url=packURL(pack);if(!lookupArchives.has(url))lookupArchives.set(url,new Archive(url));
    const archive=lookupArchives.get(url),p=project(point.lon,point.lat),candidates=[];
    for(const z of [...new Set([Math.min(pack.max_zoom,15),Math.min(pack.max_zoom,10)])]) {
      const n=2**z,tx=Math.floor(p.x*n),ty=Math.floor(p.y*n);
      for(let x=Math.max(0,tx-1);x<=Math.min(n-1,tx+1);x++)for(let y=Math.max(0,ty-1);y<=Math.min(n-1,ty+1);y++){
      const bytes=await archive.tile(z,x,y);if(!bytes)continue;
      for(const layer of decodeTile(bytes).filter(l=>['places','pois'].includes(l.name)))for(const feature of layer.features) {
        const xy=feature.geometry[0]?.[0],props=feature.properties,name=props.name||props['name:en']; if(!xy||!name||feature.type!==1)continue;
        const location=unproject((x+xy[0]/layer.extent)/n,(y+xy[1]/layer.extent)/n),distance=meters(point,location);
        if(distance<lookupLimit(layer.name,props))candidates.push({name:'Near '+name,distance,kind:layer.name,...location});
      }
    }
    }
    return candidates.sort((a,b)=>a.distance-b.distance)[0]||null;
  }
  const mapHeight=map=>(map.viewport||map.el).clientHeight;
  const ORDER=['earth','landcover','landuse','water','boundaries','roads','transit','buildings','places','pois'];
  class OfflineMap {
    constructor(container,options={}) {
      this.el=container;this.options=options;this.center=project(options.lon??121.47,options.lat??31.23);this.zoom=clamp(options.zoom??10,0,MAX_ZOOM);this.packs=[];this.archives=new Map();this.versions=new Map();this.tiles=new Map();this.markers=[];this.lines=[];this.coverage=[];this.generation=0;
      container.classList.add('offline-map');this.viewport=document.createElement('div');this.viewport.className='map-viewport';container.append(this.viewport);this.canvas=document.createElement('canvas');this.canvas.tabIndex=0;this.canvas.setAttribute('role','img');this.canvas.setAttribute('aria-label','Offline map. Arrow keys pan; plus and minus zoom.'+(options.onPick?' Enter selects the center.':''));this.viewport.append(this.canvas);this.ctx=this.canvas.getContext('2d');
      const controls=document.createElement('div');controls.className='map-controls';[['+','Zoom in',()=>this.setZoom(this.zoom+1)],['−','Zoom out',()=>this.setZoom(this.zoom-1)],[options.onFit?'↗':'⌂',options.onFit?(options.fitLabel||'Fit this day'):'World overview',()=>options.onFit?options.onFit():this.fit([-180,-65,180,75])]].forEach(([text,label,fn])=>{let b=document.createElement('button');b.type='button';b.textContent=text;b.title=label;b.setAttribute('aria-label',label);b.onclick=fn;controls.append(b);});this.viewport.append(controls);
      this.scale=document.createElement('div');this.scale.className='map-scale';container.append(this.scale);
      this.note=document.createElement('div');this.note.className='map-note';container.append(this.note);let credit=document.createElement('div');credit.className='map-credit';let osm=document.createElement('a');osm.textContent='© OpenStreetMap contributors';osm.href='https://www.openstreetmap.org/copyright';osm.target='_blank';osm.rel='noopener';let source=document.createElement('a');source.textContent='Protomaps';source.href='https://protomaps.com';source.target='_blank';source.rel='noopener';credit.append(osm,document.createTextNode(' · '),source);container.append(credit);
      this.events();this.resize=new ResizeObserver(()=>this.draw());this.resize.observe(container);this.resize.observe(this.viewport);if(options.packs)this.setPacks(options.packs);
    }
    setPacks(packs){this.packs=packs.filter(p=>p.status==='ready');for(let p of this.packs){let version=packURL(p);if(this.versions.get(p.id)!==version){this.archives.set(p.id,new Archive(version));this.versions.set(p.id,version);for(let key of this.tiles.keys())if(key.startsWith(p.id+':'))this.tiles.delete(key);}}this.draw();}
    setMarkers(markers){this.markers=markers;this.images ||= new Map();for(const marker of markers){if(!marker.thumbnail||this.images.has(marker.thumbnail))continue;const image=new Image();this.images.set(marker.thumbnail,image);image.onload=()=>this.draw();image.src=marker.thumbnail;}this.draw();}
    setCurrentLocation(point){this.currentLocation=currentLocation(point);this.draw();}
    setPlaybackLocation(point){this.setPlaybackLocations(point?[point]:[]);}
    setPlaybackLocations(points){this.playbacks=points.map(playbackLocation).filter(Boolean);this.playback=this.playbacks[0]||null;this.draw();}
    setLines(lines){this.lines=lines;this.draw();}
    setCoverage(bounds){this.coverage=bounds;this.draw();}
    fit(bounds){
      const controls=this.viewport?.querySelector('.map-controls'),padding=controls?this.el.clientWidth-controls.offsetLeft+30:30;
      if(this.el.clientWidth<=padding*2||mapHeight(this)<=60){this.pendingFit=bounds;return;}
      this.pendingFit=null;const a=project(bounds[0],bounds[3]),b=project(bounds[2],bounds[1]);
      this.zoom=clamp(Math.log2(Math.min((this.el.clientWidth-padding*2)/(256*(b.x-a.x)),(mapHeight(this)-60)/(256*(b.y-a.y)))),0,MAX_ZOOM);
      this.center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};this.draw();
    }
    setZoom(z,anchor){let before=anchor?this.at(anchor.x,anchor.y):null;this.zoom=clamp(z,0,MAX_ZOOM);if(before){let after=this.at(anchor.x,anchor.y);this.center.x+=project(before.lon,before.lat).x-project(after.lon,after.lat).x;this.center.y+=project(before.lon,before.lat).y-project(after.lon,after.lat).y;}this.draw();}
    at(x,y){let scale=256*2**this.zoom;return unproject(this.center.x+(x-this.el.clientWidth/2)/scale,this.center.y+(y-mapHeight(this)/2)/scale);}
    bounds(){let a=this.at(0,mapHeight(this)),b=this.at(this.el.clientWidth,0);return safeBounds([a.lon,a.lat,b.lon,b.lat]);}
    events(){const c=this.canvas,pointers=new Map();let last=null,start=null,moved=false,pinch=null;
      c.addEventListener('pointerdown',e=>{c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.offsetX,y:e.offsetY});last={x:e.offsetX,y:e.offsetY};if(pointers.size===1){start=last;moved=false;}if(pointers.size===2){moved=true;let p=[...pointers.values()];pinch={d:Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y),z:this.zoom};}});
      c.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;let old=pointers.get(e.pointerId),p={x:e.offsetX,y:e.offsetY};pointers.set(e.pointerId,p);if(start&&Math.hypot(p.x-start.x,p.y-start.y)>5)moved=true;if(pointers.size===2&&pinch){let a=[...pointers.values()],d=Math.hypot(a[1].x-a[0].x,a[1].y-a[0].y);this.setZoom(pinch.z+Math.log2(d/pinch.d),{x:(a[0].x+a[1].x)/2,y:(a[0].y+a[1].y)/2});}else{let scale=256*2**this.zoom;this.center.x-= (p.x-old.x)/scale;this.center.y=clamp(this.center.y-(p.y-old.y)/scale,0,1);this.draw();}last=p;});
      c.addEventListener('pointerup',e=>{pointers.delete(e.pointerId);if(!pointers.size&&!moved&&last){let point=this.at(last.x,last.y),near=markerAt(this.markers,(lon,lat)=>this.pixel(lon,lat),last);if(this.options.onPick)this.options.onPick(point,near);}pinch=null;});c.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);pinch=null;});
      c.addEventListener('wheel',e=>{e.preventDefault();this.setZoom(this.zoom-e.deltaY*.002,{x:e.offsetX,y:e.offsetY});},{passive:false});
      c.addEventListener('keydown',e=>{if(e.key==='Enter'&&this.options.onPick){e.preventDefault();const center={x:this.el.clientWidth/2,y:mapHeight(this)/2};this.options.onPick(this.at(center.x,center.y),markerAt(this.markers,(lon,lat)=>this.pixel(lon,lat),center));}else if(e.key==='+'||e.key==='=')this.setZoom(this.zoom+1);else if(e.key==='-')this.setZoom(this.zoom-1);else if(e.key.startsWith('Arrow')){e.preventDefault();let s=.15/2**this.zoom;if(e.key==='ArrowLeft')this.center.x-=s;if(e.key==='ArrowRight')this.center.x+=s;if(e.key==='ArrowUp')this.center.y-=s;if(e.key==='ArrowDown')this.center.y+=s;this.draw();}});
    }
    pixel(lon,lat){let p=project(lon,lat),s=256*2**this.zoom;return {x:(p.x-this.center.x)*s+this.el.clientWidth/2,y:(p.y-this.center.y)*s+mapHeight(this)/2};}
    async fetchTile(pack,z,x,y){let key=pack.id+':'+packURL(pack)+':'+z+':'+x+':'+y;if(!this.tiles.has(key)){this.tiles.set(key,this.archives.get(pack.id).tile(z,x,y).then(b=>b?decodeTile(b):[]).catch(e=>{this.tiles.delete(key);throw e;}));if(this.tiles.size>160)this.tiles.delete(this.tiles.keys().next().value);}return this.tiles.get(key);}
    async refreshVersions(packs){
      this.refreshedVersions ||= new Set();
      const stale=packs.filter(pack=>!this.refreshedVersions.has(packURL(pack)));
      if(!stale.length||!global.PupMedia?.request)return;
      stale.forEach(pack=>this.refreshedVersions.add(packURL(pack)));
      if(!this.manifestRefresh)this.manifestRefresh=global.PupMedia.request('maps').then(result=>{
        if(!this.destroyed&&Array.isArray(result?.packs))this.setPacks(result.packs);
      }).catch(()=>{}).finally(()=>{this.manifestRefresh=null;});
      await this.manifestRefresh;
    }
    async draw(){if(this.destroyed)return;this.center.x=clamp(this.center.x,0,1);this.center.y=clamp(this.center.y,0,1);let generation=++this.generation,w=this.el.clientWidth,h=mapHeight(this);if(!w||!h)return;if(this.pendingFit&&w>50&&h>60){this.fit(this.pendingFit);return;}let ratio=Math.min(devicePixelRatio||1,2);if(this.canvas.width!==Math.round(w*ratio)||this.canvas.height!==Math.round(h*ratio)){this.canvas.width=Math.round(w*ratio);this.canvas.height=Math.round(h*ratio);}this.canvas.style.width=w+'px';this.canvas.style.height=h+'px';this.ctx.setTransform(ratio,0,0,ratio,0,0);let css=getComputedStyle(this.el);this.colors={};this.font=css.fontFamily||'monospace';['bg','panel','border','muted','text','accent','map-water','map-land','map-green','map-road','location-phone','location-laptop'].forEach(k=>this.colors[k]=css.getPropertyValue('--'+k).trim());
      let jobs=[],view=this.bounds();for(let pack of this.packs){let b=pack.bounds;if(b[2]<view[0]||b[0]>view[2]||b[3]<view[1]||b[1]>view[3])continue;let z=Math.min(Math.floor(this.zoom),pack.max_zoom),n=2**z,a=project(Math.max(view[0],b[0]),Math.min(view[3],b[3])),e=project(Math.min(view[2],b[2]),Math.max(view[1],b[1]));for(let x=Math.max(0,Math.floor(a.x*n));x<=Math.min(n-1,Math.floor(e.x*n));x++)for(let y=Math.max(0,Math.floor(a.y*n));y<=Math.min(n-1,Math.floor(e.y*n));y++)jobs.push({pack,z,x,y});}
      let failed=false,stale=[];let loaded=await Promise.all(jobs.map(async j=>{try{return {...j,layers:await this.fetchTile(j.pack,j.z,j.x,j.y)};}catch(e){failed=true;if(e.code==='map_version_changed')stale.push(j.pack);else console.warn('Offline map tile unavailable ['+j.pack.id+', zoom '+j.z+']: '+(e.stack||e.message||String(e)));return {...j,layers:[]};}}));if(generation!==this.generation)return;if(stale.length)await this.refreshVersions(stale);if(generation!==this.generation)return;this.ctx.fillStyle=this.colors['map-water']||this.colors.bg;this.ctx.fillRect(0,0,w,h);let labels=[];for(let tile of loaded)this.paintTile(tile,labels);this.labels(labels);this.overlays();let detailed=this.packs.some(p=>p.id!=='world'&&p.bounds[0]<=this.center.x*360-180&&p.bounds[2]>=this.center.x*360-180&&project(0,p.bounds[3]).y<=this.center.y&&project(0,p.bounds[1]).y>=this.center.y);
      const perPixel=40075016.686*Math.cos(unproject(this.center.x,this.center.y).lat*Math.PI/180)/(256*2**this.zoom),unit=10**Math.floor(Math.log10(perPixel*100)),length=[5,2,1].map(n=>n*unit).find(n=>n<=perPixel*100)||unit;this.scale.style.width=(length/perPixel)+'px';this.scale.textContent=length>=1000?(length/1000)+' km':length+' m';
      this.note.textContent=failed?'Map file unavailable · open Downloads':!this.packs.length?'Download maps in Settings to get started':this.zoom>5&&!detailed?'World overview · download this region for street detail':'Offline · '+(detailed?'regional detail':'world overview');if(this.options.onMove)this.options.onMove(this.bounds());
    }
    paintTile(tile,labels){let {ctx:c,colors:k}=this,size=256*2**(this.zoom-tile.z),s=256*2**this.zoom,ox=tile.x*size-this.center.x*s+this.el.clientWidth/2,oy=tile.y*size-this.center.y*s+mapHeight(this)/2;c.save();c.beginPath();c.rect(ox,oy,size,size);c.clip();
      for(let name of ORDER){let layer=tile.layers.find(l=>l.name===name);if(!layer)continue;let scale=size/layer.extent;for(let f of layer.features){let p=f.properties;if(!featureVisible(name,p,this.zoom))continue;if(f.type===1){if(name==='places'||name==='pois'){let point=f.geometry[0]?.[0],label=p['name:en']||p.name;if(point&&label)labels.push({text:label,x:ox+point[0]*scale,y:oy+point[1]*scale,rank:Number(p.population_rank||0),major:name==='places',city:p.kind_detail==='city'||p.kind==='country',source:tile.pack.id});}continue;}
        c.beginPath();for(let path of f.geometry){path.forEach((point,i)=>{let x=ox+point[0]*scale,y=oy+point[1]*scale;i?c.lineTo(x,y):c.moveTo(x,y);});if(f.type===3)c.closePath();}
        if(f.type===3){c.fillStyle=name==='water'?(k['map-water']||k.bg):name==='earth'?(k['map-land']||k.panel):name==='buildings'?k.border:(k['map-green']||k.panel);c.fill('evenodd');}
        else{c.setLineDash(name==='boundaries'?[3,3]:[]);c.strokeStyle=name==='roads'?(k['map-road']||k.muted):k.border;c.lineWidth=name==='roads'?(p.kind==='highway'?Math.max(1.3,(this.zoom-8)*.5):p.kind==='major_road'?Math.max(.75,(this.zoom-10)*.38):Math.max(.5,(this.zoom-12)*.25)):1;c.globalAlpha=name==='roads'?(p.kind==='highway'?.9:p.kind==='major_road'?.65:.45):.7;c.lineCap='round';c.stroke();c.globalAlpha=1;
          if(name==='roads'&&this.zoom>=14&&!p.is_link){let text=p['name:en']||p.name||p.ref,path=f.geometry.reduce((a,b)=>b.length>a.length?b:a,[]);if(text&&path.length>1){let a=path[0],b=path.at(-1);if(Math.hypot(b[0]-a[0],b[1]-a[1])*scale>100){let q=path[Math.floor(path.length/2)];labels.push({text,x:ox+q[0]*scale,y:oy+q[1]*scale,rank:-1,major:false,road:true});}}}
        }
      }}c.restore();}
    labels(labels){
      const c=this.ctx,k=this.colors,boxes=[],seen=new Set(),width=this.el.clientWidth,height=mapHeight(this);
      for(const label of labels.sort((a,b)=>Number(b.city)-Number(a.city)||Number(b.major)-Number(a.major)||b.rank-a.rank)){
        if(seen.has(label.text)||label.x<12||label.y<20||label.x>width-12||label.y>height-34)continue;
        const fontSize=label.city?14:label.major?11:10,pad=label.city?24:label.major?14:7;
        c.font=(label.city?'bold ':'')+fontSize+'px '+this.font;
        const textWidth=c.measureText(label.text).width,box={x:label.x-textWidth/2-pad,y:label.y-fontSize-pad/2,w:textWidth+pad*2,h:fontSize+pad};
        if(box.x<0||box.x+box.w>width||boxes.some(b=>box.x<b.x+b.w&&box.x+box.w>b.x&&box.y<b.y+b.h&&box.y+box.h>b.y))continue;
        boxes.push(box);seen.add(label.text);c.textAlign='center';c.lineJoin='round';c.lineWidth=4;c.strokeStyle=k['map-land']||k.bg;c.strokeText(label.text,label.x,label.y);c.fillStyle=label.city?k.text:k.muted;c.fillText(label.text,label.x,label.y);
      }
    }
    overlays(){
      let c=this.ctx,k=this.colors;const deviceColor=point=>k['location-'+(point.source_device||'phone')]||k.accent;c.setLineDash([]);
      for(let b of this.coverage){let a=this.pixel(b[0],b[3]),e=this.pixel(b[2],b[1]);c.strokeStyle=k.accent;c.lineWidth=2;c.setLineDash([5,4]);c.strokeRect(a.x,a.y,e.x-a.x,e.y-a.y);c.setLineDash([]);}
      for(let line of this.lines){c.beginPath();line.forEach((p,i)=>{let q=this.pixel(p.lon,p.lat);i?c.lineTo(q.x,q.y):c.moveTo(q.x,q.y);});c.strokeStyle=deviceColor(line[0]||{});c.setLineDash(line[0]?.source_device==='laptop'?[7,4]:[]);c.lineWidth=2.5;c.stroke();}c.setLineDash([]);
      const radius=(point,r,color)=>{const p=this.pixel(point.lon,point.lat),pixels=r/(40075016.686*Math.max(.001,Math.cos(point.lat*Math.PI/180)))*256*2**this.zoom;c.beginPath();c.arc(p.x,p.y,pixels,0,Math.PI*2);c.globalAlpha=.15;c.fillStyle=color;c.fill();c.globalAlpha=1;c.strokeStyle=color;c.lineWidth=1;c.stroke();};
      for(let marker of photoMarkerGroups(this.markers,(lon,lat)=>this.pixel(lon,lat))){
        let p=this.pixel(marker.lon,marker.lat);if(marker.radius_m)radius(marker,marker.radius_m,marker.color||deviceColor(marker));
        if(marker.thumbnail){
          const image=this.images?.get(marker.thumbnail),left=p.x-18,top=p.y-40;
          c.beginPath();c.moveTo(p.x-5,p.y-5);c.lineTo(p.x,p.y+2);c.lineTo(p.x+5,p.y-5);c.fillStyle=k.accent;c.fill();
          c.fillStyle=k.panel;c.fillRect(left-2,top-2,40,40);c.strokeStyle=k.accent;c.lineWidth=2;c.strokeRect(left-2,top-2,40,40);
          if(image?.complete&&image.naturalWidth){const side=Math.min(image.naturalWidth,image.naturalHeight);c.drawImage(image,(image.naturalWidth-side)/2,(image.naturalHeight-side)/2,side,side,left,top,36,36);}
          else{c.fillStyle=k.muted;c.font='12px '+this.font;c.textAlign='center';c.fillText('▧',p.x,p.y-17);}
          if(marker.asset_ids?.length>1){c.beginPath();c.arc(p.x+12,p.y-8,10,0,Math.PI*2);c.fillStyle=k.accent;c.fill();c.fillStyle=k.bg;c.font='bold 10px '+this.font;c.textAlign='center';c.fillText(marker.asset_ids.length>99?'99+':String(marker.asset_ids.length),p.x+12,p.y-4);}continue;
        }
        c.beginPath();
        if(marker.starred){for(let i=0;i<10;i++){const angle=-Math.PI/2+i*Math.PI/5,r=i%2?4.4:10,x=p.x+Math.cos(angle)*r,y=p.y+Math.sin(angle)*r;i?c.lineTo(x,y):c.moveTo(x,y);}c.closePath();}
        else c.arc(p.x,p.y,marker.stop_id?12:6,0,Math.PI*2);
        c.fillStyle=marker.color||deviceColor(marker);c.fill();c.strokeStyle=k.bg;c.lineWidth=2;c.stroke();
        if(marker.number){c.font='bold 11px '+this.font;c.textAlign='center';c.fillStyle=k.bg;c.fillText(String(marker.number),p.x,p.y+4);}
      }
      for(const point of this.playbacks||(this.playback?[this.playback]:[])){const p=this.pixel(point.lon,point.lat),color=deviceColor(point);if(point.accuracy_m)radius(point,point.accuracy_m,color);c.beginPath();c.arc(p.x,p.y,12,0,Math.PI*2);c.fillStyle=k.panel;c.fill();c.strokeStyle=k.text;c.lineWidth=2;c.stroke();c.beginPath();c.arc(p.x,p.y,6,0,Math.PI*2);c.fillStyle=color;c.fill();if(this.playbacks?.length>1){const label=point.source_device==='laptop'?'Laptop':'Phone';c.font='bold 11px '+this.font;c.textAlign='center';c.lineWidth=4;c.strokeStyle=k.panel;c.strokeText(label,p.x,p.y-19);c.fillStyle=color;c.fillText(label,p.x,p.y-19);}}
      const current=currentLocation(this.currentLocation);
      if(current){
        const p=this.pixel(current.lon,current.lat);radius(current,current.accuracy_m,k.accent);
        c.beginPath();c.arc(p.x,p.y,11,0,Math.PI*2);c.fillStyle=k.panel;c.fill();c.strokeStyle=k.accent;c.lineWidth=2;c.stroke();
        c.beginPath();c.arc(p.x,p.y,5,0,Math.PI*2);c.fillStyle=k.accent;c.fill();
        c.font='bold 11px '+this.font;c.textAlign='center';c.lineJoin='round';c.lineWidth=4;c.strokeStyle=k.panel;c.strokeText('You are here',p.x,p.y-20);c.fillStyle=k.text;c.fillText('You are here',p.x,p.y-20);
      }
    }
    destroy(){this.destroyed=true;this.generation++;this.resize.disconnect();this.el.replaceChildren();}
  }
  const api={project,unproject,tileId,readDirectory,decodeTile,Archive,OfflineMap,lookup,nearestPlace,safeBounds,lookupLimit,featureVisible,visitTotals,currentLocation,playbackLocation,photoMarkerGroups,markerAt,locateCurrentPosition,CURRENT_LOCATION_AGE};if(typeof module!=='undefined')module.exports=api;global.TodoPupMap=api;
})(typeof window!=='undefined'?window:globalThis);
