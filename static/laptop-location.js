/* Optional local recording while the laptop app is open; never runs in Android. */
(function(global){
  'use strict';
  const KEY='datapom:laptop-location';
  function localStamp(time){const d=new Date(time),offset=-d.getTimezoneOffset(),pad=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+(offset<0?'-':'+')+pad(Math.floor(Math.abs(offset)/60))+':'+pad(Math.abs(offset)%60);}
  function observation(position,session,id,now=Date.now()){
    const c=position?.coords,time=position?.timestamp;
    if(!c||![c.latitude,c.longitude,c.accuracy,time].every(Number.isFinite)||Math.abs(c.latitude)>90||Math.abs(c.longitude)>180||c.accuracy<0||time>now+5000||now-time>120000)return null;
    const row={id,session,at:localStamp(time),lat:c.latitude,lon:c.longitude,accuracy_m:c.accuracy,mode:'precise',source_device:'laptop',provider:'browser'};
    if(Number.isFinite(c.speed)&&c.speed>=0&&c.speed<=400)row.speed_mps=c.speed;
    if(Number.isFinite(c.heading)&&c.heading>=0&&c.heading<360)row.bearing=c.heading;
    return row;
  }
  if(typeof module!=='undefined')module.exports={observation};
  if(!global.document||global.TodoPupNative)return;
  let timer=null,retryTimer=null,enabled=false,locating=false,sending=false,session='',lastAt=null;
  let message='Allow location access to save laptop routes automatically.',queue=[],leader=false,epoch=0;
  let lastSavedAt='',saveFailed=false,storageFailed=false,permissionStatus=null,controller=null;
  const desired=()=>localStorage.getItem(KEY);
  function announce(){document.dispatchEvent(new CustomEvent('laptop:tracking-status'));}
  function persist(){
    try{localStorage.setItem(KEY+'.pending',JSON.stringify(queue));storageFailed=false;}
    catch(_){storageFailed=true;}
  }
  function statusText(){
    if(storageFailed)return 'Browser storage is full. Keep Datapom open while locations finish saving.';
    if(!leader&&desired()==='1')return 'Auto-saving in another Datapom tab.';
    const pending=queue.length?' · '+queue.length+' fixes saved in this browser · '+(saveFailed?'retrying automatically':'saving to Datapom…'):'';
    return message+(lastSavedAt?' · last saved '+localStamp(Date.parse(lastSavedAt)).slice(11,19):'')+pending;
  }
  // Saving is independent of GPS availability and continues for already recorded
  // fixes after Pause. Acknowledgements, rather than HTTP success alone, clear it.
  async function flush(){
    if(!leader||sending||!queue.length)return;
    const generation=epoch;sending=true;
    try{
      while(leader&&generation===epoch&&queue.length){
        const batch=queue.slice(0,2000),ids=new Set(batch.map(row=>row.id));
        controller=new AbortController();const active=controller,timeout=setTimeout(()=>active.abort(),15000);
        let result;
        try{
          const response=await fetch('/journal/media/tracking',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({samples:batch}),signal:active.signal});
          if(!response.ok)throw Error('Save unavailable');
          result=await response.json();
        }finally{clearTimeout(timeout);}
        if(!leader||generation!==epoch)return;
        const accepted=new Set(Array.isArray(result.accepted)?result.accepted.filter(id=>ids.has(id)):[]);
        if(result.ok!==true||!accepted.size)throw Error('Save not acknowledged');
        queue=queue.filter(row=>!accepted.has(row.id));persist();saveFailed=false;
        for(const row of batch)if(accepted.has(row.id)&&(!lastSavedAt||Date.parse(row.at)>Date.parse(lastSavedAt)))lastSavedAt=row.at;
        try{localStorage.setItem(KEY+'.savedAt',lastSavedAt);}catch(_){}
        document.dispatchEvent(new Event('location:recorded'));announce();
      }
    }catch(_){if(generation===epoch)saveFailed=true;}
    finally{if(generation===epoch){sending=false;controller=null;announce();}}
  }
  async function capture(){
    if(!enabled||!leader||locating)return;locating=true;
    const generation=epoch,currentSession=session;
    try{
      const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,maximumAge:0,timeout:15000}));
      if(!enabled||!leader||epoch!==generation||session!==currentSession)return;
      const row=observation(position,session,crypto.randomUUID());
      if(row&&row.at!==lastAt){queue.push(row);lastAt=row.at;persist();}
      message=row?'Auto-saving on this laptop':'Waiting for a fresh laptop location';
    }catch(error){
      if(epoch!==generation||!enabled||session!==currentSession)return;
      message=error.code===1?'Location access is off. Allow it to resume auto-saving':'Waiting for laptop location · saved history is kept';
    }finally{
      if(epoch===generation){locating=false;announce();await flush();}
    }
  }
  function stop(){clearInterval(timer);timer=null;enabled=false;session='';}
  async function start(){
    if(enabled||!leader)return;
    if(!navigator.geolocation){message='Location is unavailable in this browser.';announce();return;}
    enabled=true;session=crypto.randomUUID();message='Auto-saving on this laptop · finding location';
    announce();timer=setInterval(()=>void capture(),30000);await capture();
  }
  async function setEnabled(value){
    try{localStorage.setItem(KEY,value?'1':'0');}catch(_){}
    if(value){if(leader)await start();else message=navigator.locks?'Auto-saving in another Datapom tab.':'Auto-saving needs a browser with Web Locks support.';}
    else{stop();message='Laptop recording is paused';}
    announce();void flush();
  }
  async function restore(){
    const generation=epoch;
    if(desired()==='0'){stop();message='Laptop recording is paused';announce();return;}
    if(navigator.permissions){
      try{
        if(!permissionStatus){permissionStatus=await navigator.permissions.query({name:'geolocation'});permissionStatus.addEventListener('change',()=>void restore());}
        if(!leader||generation!==epoch||desired()==='0')return;
        if(permissionStatus.state!=='granted'){stop();message='Allow location access to save laptop routes automatically.';announce();return;}
      }catch(_){if(desired()!=='1')return;}
    }else if(desired()!=='1')return;
    if(leader&&generation===epoch&&desired()!=='0')await setEnabled(true);
  }
  function mount(host){
    const M=global.PupMedia,status=M.element('p','muted'),button=M.button('',()=>setEnabled(desired()!=='1'));status.setAttribute?.('role','status');
    function paint(){status.textContent=statusText();button.textContent=desired()==='1'?'Pause laptop recording':'Record this laptop';}
    host.append(status,button,M.element('p','muted','Locations save automatically, even without saving a journal entry. Records while Datapom is open; pending fixes retry when it is available again.'));
    document.addEventListener('laptop:tracking-status',paint);paint();return ()=>document.removeEventListener('laptop:tracking-status',paint);
  }
  global.PupLaptopLocation={mount,setEnabled};
  // A single tab owns capture and the durable queue, including across Back/Forward.
  const acquire=()=>navigator.locks?.request('datapom-laptop-location',async()=>{
    leader=true;epoch++;
    try{
      const raw=localStorage.getItem(KEY+'.pending');
      try{queue=JSON.parse(raw||'[]');if(!Array.isArray(queue))throw Error('Invalid pending locations');}
      catch(_){localStorage.setItem(KEY+'.pending.recovery',raw||'');queue=[];}
      lastSavedAt=localStorage.getItem(KEY+'.savedAt')||'';
      if(!Number.isFinite(Date.parse(lastSavedAt)))lastSavedAt='';
    }catch(_){storageFailed=true;leader=false;announce();return;}
    const lifetime=new Promise(resolve=>global.addEventListener('pagehide',()=>{
      leader=false;epoch++;stop();clearInterval(retryTimer);controller?.abort();sending=false;locating=false;resolve();
    },{once:true}));
    retryTimer=setInterval(()=>void flush(),30000);void flush();void restore();
    await lifetime;
  });
  if(navigator.locks)acquire();
  global.addEventListener('pageshow',event=>{if(event.persisted)acquire();});
  global.addEventListener('online',()=>void flush());
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){void flush();if(leader)void restore();}});
  global.addEventListener('storage',event=>{if(event.key===KEY){if(event.newValue==='0'){stop();message='Laptop recording is paused';}else if(leader)void restore();}if(event.key?.startsWith(KEY))announce();});
})(typeof window==='undefined'?globalThis:window);
