const assert = require('node:assert/strict');
const M = require('../static/offline-map.js');
assert.equal(M.tileId(0, 0, 0), 0);
assert.deepEqual([[0,0],[0,1],[1,1],[1,0]].map(([x,y]) => M.tileId(1,x,y)), [1,2,3,4]);
assert.equal(M.tileId(12,3423,1763),19078479);
for (const [lon,lat] of [[121.47,31.23],[-121.9886,37.5485],[116.4,39.9]]) {
 const p=M.project(lon,lat), q=M.unproject(p.x,p.y);
 assert.ok(Math.abs(q.lon-lon)<1e-6 && Math.abs(q.lat-lat)<1e-6);
}
const dir=M.readDirectory(Uint8Array.from([2,5,3,1,2,10,20,1,0]));
assert.deepEqual(dir,[{id:5,run:1,length:10,offset:0},{id:8,run:2,length:20,offset:10}]);
assert.throws(()=>M.readDirectory(Uint8Array.from([255])));
assert.equal(M.nearestPlace({lon:121.5,lat:31.2}, [{name:'Home',lon:121.5,lat:31.2,radius_m:100}]).name, 'Home');
const nearbyPlaces=[{id:'farther',name:'Farther café',lon:121.5007,lat:31.2,radius_m:100},{id:'nearer',name:'Nearer café',lon:121.5001,lat:31.2,radius_m:100}];
assert.equal(M.nearestPlace({lon:121.5,lat:31.2,accuracy_m:10},nearbyPlaces).id,'nearer');
assert.equal(M.nearestPlace({lon:121.5,lat:31.2,accuracy_m:2000},nearbyPlaces),null);
assert.equal(M.nearestPlace({lon:121.5,lat:31.2,accuracy_m:NaN},nearbyPlaces),null);
const locationNow=Date.parse('2026-09-09T12:00:00Z');
const freshLocation={lat:31.2,lon:121.5,accuracy_m:35,observed_at:'2026-09-09T11:59:50.000Z'};
assert.deepEqual(M.currentLocation(freshLocation,locationNow),freshLocation);
assert.equal(M.currentLocation({...freshLocation,observed_at:'2026-09-09T11:59:00Z'},locationNow),null);
assert.equal(M.currentLocation({...freshLocation,observed_at:'2026-09-09T12:01:00Z'},locationNow),null);
assert.equal(M.currentLocation({...freshLocation,accuracy_m:NaN},locationNow),null);
assert.equal(M.currentLocation({...freshLocation,lat:91},locationNow),null);
assert.equal(M.currentLocation({lat:31.2,lon:121.5,at:'2026-09-09T12:00:00Z'},locationNow),null);
assert.equal(M.featureVisible('roads', {kind:'minor_road'}, 10), false);
assert.equal(M.featureVisible('roads', {kind:'minor_road'}, 13), true);
assert.equal(M.featureVisible('roads', {kind:'path'}, 13), false);
assert.equal(M.featureVisible('roads', {kind:'highway'}, 10), true);
assert.equal(M.featureVisible('roads', {kind:'major_road',kind_detail:'secondary'}, 10), false);
assert.equal(M.featureVisible('roads', {kind:'major_road',kind_detail:'primary'}, 10), true);
assert.equal(M.featureVisible('places', {kind:'neighbourhood'}, 10), false);
assert.equal(M.featureVisible('places', {kind:'locality',kind_detail:'town'}, 10), false);
assert.equal(M.featureVisible('places', {kind:'locality',kind_detail:'city'}, 10), true);
assert.equal(M.featureVisible('pois', {min_zoom:16}, 15), false);
assert.deepEqual(M.safeBounds([-190,-90,200,90]), [-180,-85.0511,180,85.0511]);
assert.equal(M.lookupLimit('pois',{kind:'cafe'}),100);
assert.equal(M.lookupLimit('places',{kind_detail:'village'}),2000);
const visits=[
 {place_id:'home',name:'Home',lat:31.2,lon:121.5,duration_seconds:300},
 {place_id:'home',name:'Home',lat:31.2,lon:121.5,duration_seconds:600},
 {place_id:null,name:'Unsaved place',lat:31.3,lon:121.5,duration_seconds:300},
 {place_id:null,name:'Unsaved place',lat:31.3,lon:121.5002,duration_seconds:300},
 {place_id:null,name:'Unsaved place',lat:31.4,lon:121.5,duration_seconds:300},
];
assert.deepEqual(M.visitTotals(visits).map(r=>[r.duration_seconds,r.visits]),[[900,2],[600,2],[300,1]]);

(async()=>{
 let geoCalls=0,permissionPrompts=[];
 const navigator={permissions:{query:async()=>({state:'prompt'})},geolocation:{getCurrentPosition(success,error,options){geoCalls++;assert.equal(options.maximumAge,0);success({coords:{latitude:31.2,longitude:121.5,accuracy:35},timestamp:locationNow-10000});}}};
 assert.equal((await M.locateCurrentPosition({navigator,now:()=>locationNow})).status,'permission_required');
 assert.equal(geoCalls,0);
 assert.deepEqual((await M.locateCurrentPosition({navigator,prompt:true,now:()=>locationNow})).location,freshLocation);
 assert.equal(geoCalls,1);
 navigator.permissions.query=async()=>({state:'granted'});
 assert.equal((await M.locateCurrentPosition({navigator,now:()=>locationNow})).status,'ok');
 assert.equal(geoCalls,2);
 navigator.geolocation.getCurrentPosition=(success,error)=>error({code:1});
 assert.equal((await M.locateCurrentPosition({navigator,prompt:true})).status,'permission_required');
 const nativeRequest=async body=>{permissionPrompts.push(body.prompt);return {status:'ok',location:freshLocation};};
 assert.equal((await M.locateCurrentPosition({nativeRequest,now:()=>locationNow})).status,'ok');
 assert.equal((await M.locateCurrentPosition({nativeRequest,prompt:true,now:()=>locationNow+60000})).status,'unavailable');
 assert.deepEqual(permissionPrompts,[false,true]);
 const originalFetch=global.fetch, originalNative=global.TodoPupNative;
 try {
  global.fetch=async()=>({status:200,arrayBuffer:async()=>new ArrayBuffer(127)});
  await assert.rejects(()=>new M.Archive('/test-map').read(0,127), /HTTP 200.*expected 206/);
  global.fetch=async()=>({status:206,arrayBuffer:async()=>new ArrayBuffer(126)});
  await assert.rejects(()=>new M.Archive('/test-map').read(0,127), /126 bytes.*expected 127/);
  global.fetch=async()=>({status:206,arrayBuffer:async()=>new ArrayBuffer(127)});
  assert.equal((await new M.Archive('/test-map').read(0,127)).length,127);
  global.TodoPupNative={};
  let captured;
  global.fetch=async(url,options)=>{captured={url,options};return {status:200,arrayBuffer:async()=>Uint8Array.from([5,6,7]).buffer};};
  assert.deepEqual([...await new M.Archive('/test-map?v=checksum').read(4096,3)],[5,6,7]);
  assert.equal(captured.url,'/test-map?v=checksum&offset=4096&length=3');
  assert.equal(captured.options?.headers?.Range,undefined);
  global.fetch=async()=>({status:200,arrayBuffer:async()=>new ArrayBuffer(2)});
  await assert.rejects(()=>new M.Archive('/test-map').read(4096,3), /2 bytes.*expected 3/);
 } finally {global.fetch=originalFetch;global.TodoPupNative=originalNative;}
 console.log('offline map contracts passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

// The scrubbed position is historical and must never be expired as a live fix.
assert.deepEqual(M.playbackLocation({lat:31.2,lon:121.5,accuracy_m:20,at:'2020-01-01T10:00:00Z'}),{lat:31.2,lon:121.5,accuracy_m:20,at:'2020-01-01T10:00:00Z'});
assert.equal(M.playbackLocation({lat:91,lon:121.5}),null);
assert.equal(M.playbackLocation({lat:31.2,lon:Infinity}),null);
const screenPoint=(lon,lat)=>({x:lon,y:lat});
const photoMarker={lat:100,lon:100,asset_id:'photo',thumbnail:'/preview.webp'};
const stopMarker={lat:100,lon:100,stop_id:'stop'};
assert.equal(M.markerAt([stopMarker,photoMarker],screenPoint,{x:116,y:70}),photoMarker);
assert.equal(M.markerAt([stopMarker],screenPoint,{x:118,y:100}),stopMarker);
assert.equal(M.markerAt([photoMarker],screenPoint,{x:130,y:70}),null);
const nearbyPhoto={lat:102,lon:102,asset_id:'nearby',thumbnail:'/nearby.webp'},farPhoto={lat:300,lon:300,asset_id:'far',thumbnail:'/far.webp'};
const grouped=M.photoMarkerGroups([stopMarker,photoMarker,nearbyPhoto,farPhoto],screenPoint);
assert.equal(grouped.length,3);assert.equal(grouped[0],stopMarker);assert.equal(grouped[2],farPhoto);
assert.deepEqual(grouped[1].asset_ids,['photo','nearby']);assert.deepEqual(grouped[1].markers,[photoMarker,nearbyPhoto]);
assert.equal(grouped[1].lon,photoMarker.lon);assert.equal(grouped[1].lat,photoMarker.lat);
assert.deepEqual(M.markerAt([stopMarker,photoMarker,nearbyPhoto],screenPoint,{x:100,y:78}).asset_ids,['photo','nearby']);
assert.equal(M.markerAt([stopMarker,photoMarker,nearbyPhoto],screenPoint,{x:100,y:100}),stopMarker);
assert.equal(M.photoMarkerGroups([photoMarker,nearbyPhoto],(lon,lat)=>({x:lon*100,y:lat*100})).length,2);
assert.deepEqual(M.photoMarkerGroups([photoMarker,{...photoMarker}],screenPoint).map(marker=>marker.asset_id),['photo']);

// Daily cards can finish loading while the native Places/Settings view hides them.
const hiddenMap={el:{clientWidth:0,clientHeight:0},zoom:10,draw(){},pendingFit:null};
M.OfflineMap.prototype.fit.call(hiddenMap,[121.4,31.1,121.5,31.2]);
assert.equal(hiddenMap.zoom,10);
assert.deepEqual(hiddenMap.pendingFit,[121.4,31.1,121.5,31.2]);
hiddenMap.el={clientWidth:360,clientHeight:320};
M.OfflineMap.prototype.fit.call(hiddenMap,hiddenMap.pendingFit);
assert.equal(hiddenMap.pendingFit,null);
assert.ok(Number.isFinite(hiddenMap.zoom));

// Vector overzoom separates pins at street level without unbounded magnification.
const zoomMap={el:{clientWidth:360,clientHeight:320},center:M.project(121.47,31.23),zoom:18,draw(){}};
zoomMap.at=M.OfflineMap.prototype.at;
const zoomAnchor={x:70,y:95},anchorBefore=zoomMap.at(zoomAnchor.x,zoomAnchor.y);
M.OfflineMap.prototype.setZoom.call(zoomMap,22,zoomAnchor);
assert.equal(zoomMap.zoom,22);
const anchorAfter=zoomMap.at(zoomAnchor.x,zoomAnchor.y);
assert.ok(Math.abs(anchorBefore.lon-anchorAfter.lon)<1e-8&&Math.abs(anchorBefore.lat-anchorAfter.lat)<1e-8);
M.OfflineMap.prototype.setZoom.call(zoomMap,30);assert.equal(zoomMap.zoom,22);
M.OfflineMap.prototype.setZoom.call(zoomMap,-2);assert.equal(zoomMap.zoom,0);
M.OfflineMap.prototype.fit.call(zoomMap,[121.47,31.23,121.47000001,31.23000001]);assert.equal(zoomMap.zoom,22);

// Real overlay drawing keeps phone and laptop routes visibly distinct.
const strokes=[];
const canvas={setLineDash(value){this.dash=value;},beginPath(){},moveTo(){},lineTo(){},stroke(){strokes.push([this.strokeStyle,this.dash]);}};
M.OfflineMap.prototype.overlays.call({ctx:canvas,colors:{accent:'amber','location-phone':'amber','location-laptop':'blue'},coverage:[],markers:[],lines:[[{lat:0,lon:0},{lat:1,lon:1}],[{lat:0,lon:0,source_device:'laptop'},{lat:2,lon:2,source_device:'laptop'}]],pixel:(lon,lat)=>({x:lon,y:lat})});
assert.deepEqual(strokes,[['amber',[]],['blue',[7,4]]]);
