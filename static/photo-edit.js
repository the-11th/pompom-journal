/* On-device pen layers, movable stickers, and outline-assisted cutouts. */
(function (global) {
  'use strict';
  function inside(x,y,polygon) { let yes=false; for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes; }
  function cutoutMask(image, outline, tolerance=55) {
    const {data,width:w,height:h}=image, mask=new Uint8ClampedArray(w*h),seen=new Uint8Array(w*h),queue=new Int32Array(w*h);let head=0,tail=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=y*w+x;mask[p]=inside(x+.5,y+.5,outline)?255:0;if(!mask[p]){seen[p]=1;queue[tail++]=p;}}
    // Grow connected background from outside the user's outline, following color
    // continuity. The mask is editable: textured backgrounds may need refinement.
    while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);for(const q of [x>0?p-1:-1,x<w-1?p+1:-1,y>0?p-w:-1,y<h-1?p+w:-1]){if(q<0||seen[q])continue;let d=0;for(let c=0;c<3;c++)d+=(data[p*4+c]-data[q*4+c])**2;if(d<tolerance*tolerance){seen[q]=1;mask[q]=0;queue[tail++]=q;}}}
    return mask;
  }
  function editState(value) {
    const layers=Array.isArray(value)?JSON.parse(JSON.stringify(value)):[], transform=layers.find(l=>l.type==='transform') || {};
    const area=transform.crop, crop=area&&[area.x,area.y,area.w,area.h].every(Number.isFinite)&&area.x>=0&&area.y>=0&&area.w>0&&area.h>0&&area.x+area.w<=1.001&&area.y+area.h<=1.001 ? area : null;
    return {layers:layers.filter(l=>['stroke','text','sticker'].includes(l.type)),rotation:[0,90,180,270].includes(transform.rotation)?transform.rotation:0,crop};
  }
  function sourcePoint(x,y,crop,rotation) {
    const p=rotation===90?[y,1-x]:rotation===180?[1-x,1-y]:rotation===270?[1-y,x]:[x,y], a=crop||{x:0,y:0,w:1,h:1};
    return [a.x+p[0]*a.w,a.y+p[1]*a.h];
  }
  const api={cutoutMask,editState,sourcePoint};if(typeof module!=='undefined')module.exports=api;if(typeof document==='undefined')return;
  const M=global.PupMedia;
  const load=url=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(Error('Photo is unavailable'));i.src=url;});
  async function storeCanvas(canvas,source,isSticker,layers) {
    let asset;
    if(global.TodoPupNative){const result=await M.request('save-image',{png:canvas.toDataURL('image/png').split(',')[1]});asset=result.asset;}
    else{const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));asset=await M.upload(new File([blob],isSticker?'sticker.png':'edited-photo.png',{type:'image/png'}));}
    await M.refresh();
    await M.mutate('assets',asset.id,{is_sticker:isSticker,source_asset_id:source.id,location:source.location||null,captured_at:source.captured_at||null,edit_layers:layers||[]});
    return asset;
  }
  async function stickerMaker() {
    const picked=await M.pickPhotos();if(!picked.length)return null;const source=picked[0],image=await load(M.fileURL(source.id));
    const d=M.dialog('New sticker',true),help=M.element('p','muted','Trace the subject, then cut it out.');d.body.append(help);
    const tools=M.element('div','media-photo-tools'),stage=M.element('div','media-photo-stage'),canvas=M.element('canvas');stage.append(canvas);d.body.append(tools,stage);
    const scale=Math.min(1,1000/image.naturalWidth,1000/image.naturalHeight);canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(image,0,0,canvas.width,canvas.height);const original=c.getImageData(0,0,canvas.width,canvas.height);let mask=null,outline=[],mode='trace',pointer=null,zoom=1,history=[];
    const color=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    let saveButton;
    function paint(){
      if(!mask&&mode!=='trace')mode='trace';
      for(const [value,button] of modeButtons){const selected=mode===value;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',selected);button.disabled=value!=='trace'&&!mask;}
      cut.disabled=outline.length<3;undo.disabled=!history.length;if(saveButton)saveButton.disabled=!mask;
      c.putImageData(original,0,0);if(mask){const pixels=c.getImageData(0,0,canvas.width,canvas.height);for(let i=0;i<mask.length;i++)pixels.data[i*4+3]=Math.min(mask[i],original.data[i*4+3]);c.putImageData(pixels,0,0);}if(mode==='trace'&&outline.length){c.beginPath();outline.forEach((p,i)=>i?c.lineTo(...p):c.moveTo(...p));c.strokeStyle=color;c.lineWidth=2;c.stroke();}}
    const point=e=>{const r=canvas.getBoundingClientRect();return [(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height];};
    function brush(p){if(!mask)return;const radius=8/zoom;for(let y=Math.max(0,Math.floor(p[1]-radius));y<Math.min(canvas.height,p[1]+radius);y++)for(let x=Math.max(0,Math.floor(p[0]-radius));x<Math.min(canvas.width,p[0]+radius);x++)if(Math.hypot(x-p[0],y-p[1])<=radius)mask[y*canvas.width+x]=mode==='keep'?255:0;}
    canvas.setAttribute('aria-label','Draw an outline or refine the sticker'); canvas.onpointerdown=e=>{if(pointer!==null)return;pointer=e.pointerId;canvas.setPointerCapture(e.pointerId);if(mode==='trace')outline=[point(e)];else{history.push(mask?.slice());brush(point(e));}paint();};
    canvas.onpointermove=e=>{if(pointer!==e.pointerId)return;for(const ev of e.getCoalescedEvents?.()||[e]){if(mode==='trace')outline.push(point(ev));else brush(point(ev));}paint();};
    canvas.onpointerup=e=>{if(pointer===e.pointerId)pointer=null;};canvas.onpointercancel=e=>{if(pointer===e.pointerId){pointer=null;if(mode==='trace')outline=[];else if(history.length)mask=history.pop();paint();}};
    const modeButtons=[['trace','Trace'],['keep','Keep'],['erase','Erase']].map(([value,label])=>[value,M.button(label,()=>{mode=value;if(value==='trace')outline=[];paint();})]);
    const cut=M.button('Cut out',()=>{if(outline.length<3)return;history.push(mask?.slice());mask=cutoutMask(original,outline);outline=[];mode='keep';paint();},'save');
    const undo=M.button('Undo',()=>{if(history.length){mask=history.pop();paint();}});
    tools.setAttribute('role','group');tools.setAttribute('aria-label','Sticker tools');
    tools.append(modeButtons[0][1],cut,modeButtons[1][1],modeButtons[2][1],undo,M.button('Zoom +',()=>{zoom=Math.min(5,zoom+.5);canvas.style.maxWidth='none';canvas.style.width=canvas.width*zoom+'px';}),M.button('Zoom −',()=>{zoom=Math.max(.5,zoom-.5);canvas.style.width=canvas.width*zoom+'px';}));
    return new Promise(resolve=>{let saved=false;d.onClose(()=>{if(!saved)resolve(null);});saveButton=M.button('Save',async()=>{
      if(!mask){M.notice('Cut out the subject first.');return;}
      mode='keep';outline=[];paint();d.setBusy(true);
      let asset;
      try {asset=await storeCanvas(trimCanvas(canvas),source,true);}
      finally {d.setBusy(false);}
      saved=true;resolve(asset);d.close();
    },'save');d.actions.append(M.button('Cancel',()=>{d.close();resolve(null);}),saveButton);paint();});
  }
  function trimCanvas(canvas) {
    const c=canvas.getContext('2d'),pixels=c.getImageData(0,0,canvas.width,canvas.height).data;
    let left=canvas.width,top=canvas.height,right=0,bottom=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}
    if(right<=left)return canvas;
    const result=document.createElement('canvas');result.width=right-left;result.height=bottom-top;result.getContext('2d').drawImage(canvas,left,top,result.width,result.height,0,0,result.width,result.height);return result;
  }
  async function open(block,onSave) {
    const source=M.getState().assets[block.asset_id];if(!source)return;
    const image=await load(M.fileURL(block.asset_id)),d=M.dialog('Edit photo',true),tools=M.element('div','media-photo-tools'),stage=M.element('div','media-photo-stage'),canvas=M.element('canvas'),work=document.createElement('canvas');
    canvas.setAttribute('aria-label','Photo drawing canvas');stage.append(canvas);d.body.append(tools,stage);
    const hint=M.element('p','muted');hint.hidden=true;d.body.prepend(hint);
    const scale=Math.min(1,1600/image.naturalWidth,1600/image.naturalHeight);work.width=Math.round(image.naturalWidth*scale);work.height=Math.round(image.naturalHeight*scale);
    const c=work.getContext('2d'),view=canvas.getContext('2d');
    let {layers,rotation,crop}=editState(M.getState().assets[block.edited_asset_id]?.edit_layers),undo=[],redo=[],mode='pen',stroke=null,selected=null,drag=null,pointer=null,pendingCrop=null;
    const images=new Map();for(const layer of layers)if(layer.type==='sticker')images.set(layer.asset_id,await load(M.fileURL(layer.asset_id)));
    const color=M.field('Ink',getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),'color'),size=M.field('Pen size',5,'number');size.input.min=1;size.input.max=80;
    const modes=[],contextControls=[];
    function toolGroup(label){const row=M.element('div','media-photo-tool-group');row.setAttribute('role','group');row.setAttribute('aria-label',label);tools.append(row);return row;}
    const modeTools=toolGroup('Photo tools'),drawingTools=toolGroup('Drawing settings'),insertTools=toolGroup('Add or rotate'),selectedTools=toolGroup('Selected item'),cropTools=toolGroup('Crop settings'),historyTools=toolGroup('Edit history');
    function contextButton(text,action,visible){const b=M.button(text,action);contextControls.push([b,visible]);return b;}
    function setMode(value){mode=value;modes.forEach(([name,b])=>{b.classList.toggle('selected',name===mode);b.setAttribute('aria-pressed',name===mode);});hint.textContent=mode==='crop'?'Drag to crop.':mode==='move'?'Select and drag an item.':'';hint.hidden=!hint.textContent;paint();}
    function modeButton(text,name){const b=M.button(text,()=>setMode(name));modes.push([name,b]);return b;}
    const snapshot=()=>JSON.parse(JSON.stringify({layers,rotation,crop}));
    function remember(){undo.push(snapshot());if(undo.length>60)undo.shift();redo=[];}
    function restore(value){({layers,rotation,crop}=value);selected=null;pendingCrop=null;paint();}
    function transform(){const a=crop||{x:0,y:0,w:1,h:1},w=Math.max(1,Math.round(a.w*work.width)),h=Math.max(1,Math.round(a.h*work.height));canvas.width=rotation%180?h:w;canvas.height=rotation%180?w:h;view.save();view.translate(canvas.width/2,canvas.height/2);view.rotate(rotation*Math.PI/180);view.drawImage(work,a.x*work.width,a.y*work.height,a.w*work.width,a.h*work.height,-w/2,-h/2,w,h);view.restore();}
    function paint(clean=false){
      contextControls.forEach(([button,visible])=>{button.hidden=!visible();});
      drawingTools.hidden=mode!=='pen';selectedTools.hidden=mode!=='move'||!selected;cropTools.hidden=mode!=='crop';
      undoButton.disabled=!undo.length;redoButton.disabled=!redo.length;
      c.clearRect(0,0,work.width,work.height);c.drawImage(image,0,0,work.width,work.height);
      for(const layer of layers){
        if(layer.type==='stroke'){
          c.strokeStyle=layer.color;c.fillStyle=layer.color;c.lineCap='round';c.lineJoin='round';
          if(layer.points.length===1){const p=layer.points[0];c.beginPath();c.arc(p[0]*work.width,p[1]*work.height,layer.size*p[2]/2,0,Math.PI*2);c.fill();}
          for(let i=1;i<layer.points.length;i++){const a=layer.points[i-1],b=layer.points[i];c.beginPath();c.lineWidth=layer.size*((a[2]+b[2])/2);c.moveTo(a[0]*work.width,a[1]*work.height);c.lineTo(b[0]*work.width,b[1]*work.height);c.stroke();}
        }else if(layer.type==='sticker'){
          const img=images.get(layer.asset_id);if(!img)continue;c.save();c.translate(layer.x*work.width,layer.y*work.height);c.rotate(layer.angle||0);const w=layer.width*work.width,h=w*img.naturalHeight/img.naturalWidth;c.drawImage(img,-w/2,-h/2,w,h);if(!clean&&layer===selected){c.strokeStyle=color.input.value;c.lineWidth=2;c.strokeRect(-w/2,-h/2,w,h);}c.restore();
        }else if(layer.type==='text'){c.fillStyle=layer.color;c.font=layer.size+'px monospace';c.fillText(layer.text,layer.x*work.width,layer.y*work.height);if(!clean&&layer===selected){c.strokeStyle=color.input.value;c.lineWidth=1;c.strokeRect(layer.x*work.width,layer.y*work.height-layer.size,c.measureText(layer.text).width,layer.size*1.3);}}
      }
      if(!clean&&pendingCrop){c.strokeStyle=color.input.value;c.lineWidth=2;c.setLineDash([6,4]);c.strokeRect(pendingCrop.x*work.width,pendingCrop.y*work.height,pendingCrop.w*work.width,pendingCrop.h*work.height);c.setLineDash([]);}
      transform();
    }
    function point(e){const r=canvas.getBoundingClientRect(),p=sourcePoint(Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height)),crop,rotation);return [...p,e.pointerType==='pen'?Math.max(.2,e.pressure)*2:1];}
    function hit(layer,p){
      if(layer.type==='sticker'){const image=images.get(layer.asset_id),dx=p[0]-layer.x,dy=(p[1]-layer.y)*work.height/work.width,a=-(layer.angle||0),x=dx*Math.cos(a)-dy*Math.sin(a),y=dx*Math.sin(a)+dy*Math.cos(a);return Math.abs(x)<=layer.width/2&&Math.abs(y)<=layer.width*(image?.naturalHeight||1)/(image?.naturalWidth||1)/2;}
      if(layer.type==='text'){c.font=layer.size+'px monospace';return p[0]>=layer.x&&p[0]<=layer.x+c.measureText(layer.text).width/work.width&&p[1]>=layer.y-layer.size/work.height&&p[1]<=layer.y+layer.size*.3/work.height;}
      return false;
    }
    canvas.onpointerdown=e=>{if(pointer!==null)return;pointer=e.pointerId;canvas.setPointerCapture(e.pointerId);const p=point(e);remember();
      if(mode==='pen'){stroke={type:'stroke',color:color.input.value,size:Math.max(1,Math.min(80,Number(size.input.value)||5)),points:[p]};layers.push(stroke);}
      else if(mode==='move'){selected=[...layers].reverse().find(l=>hit(l,p))||null;if(selected)drag={x:p[0]-selected.x,y:p[1]-selected.y};}
      else if(mode==='crop'){pendingCrop={x:p[0],y:p[1],w:0,h:0};drag={x:p[0],y:p[1]};}paint();};
    canvas.onpointermove=e=>{if(pointer!==e.pointerId)return;const p=point(e);if(stroke){for(const ev of e.getCoalescedEvents?.()||[e])stroke.points.push(point(ev));}
      else if(drag&&mode==='move'&&selected){selected.x=p[0]-drag.x;selected.y=p[1]-drag.y;}
      else if(drag&&mode==='crop'){pendingCrop={x:Math.min(drag.x,p[0]),y:Math.min(drag.y,p[1]),w:Math.abs(p[0]-drag.x),h:Math.abs(p[1]-drag.y)};}paint();};
    canvas.onpointerup=e=>{if(pointer!==e.pointerId)return;stroke=null;drag=null;pointer=null;};
    canvas.onpointercancel=e=>{if(pointer!==e.pointerId)return;stroke=null;drag=null;pointer=null;if(undo.length)restore(undo.pop());};
    async function chooseSticker(){await M.refresh();const picker=M.dialog('Stickers'),grid=M.element('div','media-sticker-grid');picker.body.append(grid);
      const add=async a=>{if(!a)return;images.set(a.id,await load(M.fileURL(a.id)));remember();const center=sourcePoint(.5,.5,crop,rotation);selected={type:'sticker',asset_id:a.id,x:center[0],y:center[1],width:.3*(crop?.w||1),angle:0};layers.push(selected);setMode('move');picker.close();paint();};
      const stickers=Object.values(M.getState().assets).filter(a=>a.is_sticker);if(!stickers.length)picker.body.append(M.element('p','muted','No stickers yet.'));
      stickers.forEach(a=>{const b=M.button('',()=>add(a)),i=M.element('img');b.setAttribute('aria-label','Use '+(a.filename||'saved sticker'));i.src=M.fileURL(a.id,'thumb.webp');i.alt='';b.append(i);grid.append(b);});picker.actions.append(M.button('Make a sticker…',async()=>{const a=await stickerMaker();await add(a);}));
    }
    const selectedChange=fn=>{if(!selected){M.notice('Choose Move, then tap a sticker or text first.');return;}remember();fn(selected);paint();};
    modeTools.append(modeButton('Pen','pen'),modeButton('Move','move'),modeButton('Crop','crop'));
    drawingTools.append(color.wrap,size.wrap);
    insertTools.append(M.button('Text',()=>{
      const p=M.dialog('Add text'),f=M.field('Text'),ink=M.field('Ink',color.input.value,'color');p.body.append(f.wrap,ink.wrap);
      p.actions.append(M.button('Add',()=>{
        if(!f.input.value.trim())return;
        remember();color.input.value=ink.input.value;
        const center=sourcePoint(.2,.5,crop,rotation);
        selected={type:'text',text:f.input.value,x:center[0],y:center[1],size:Math.max(24,(Number(size.input.value)||5)*5),color:ink.input.value};
        layers.push(selected);p.close();setMode('move');
      },'save'));f.input.focus();
    }),M.button('Stickers',chooseSticker),M.button('Rotate photo',()=>{remember();rotation=(rotation+90)%360;paint();}));
    selectedTools.append(
      contextButton('Larger',()=>selectedChange(l=>l.type==='sticker'?l.width=Math.min(2,l.width*1.15):l.size=Math.min(300,l.size*1.15)),()=>mode==='move'&&!!selected),
      contextButton('Smaller',()=>selectedChange(l=>l.type==='sticker'?l.width=Math.max(.03,l.width/1.15):l.size=Math.max(12,l.size/1.15)),()=>mode==='move'&&!!selected),
      contextButton('Rotate sticker',()=>selectedChange(l=>{if(l.type==='sticker')l.angle=(l.angle||0)+Math.PI/12;}),()=>mode==='move'&&selected?.type==='sticker'),
      contextButton('Remove item',()=>selectedChange(l=>{layers=layers.filter(x=>x!==l);selected=null;}),()=>mode==='move'&&!!selected));
    cropTools.append(
      contextButton('Apply crop',()=>{if(!pendingCrop||pendingCrop.w<.01||pendingCrop.h<.01){M.notice('Use Crop and drag a rectangle first.');return;}remember();crop=pendingCrop;pendingCrop=null;setMode('pen');},()=>mode==='crop'),
      contextButton('Reset crop',()=>{remember();crop=null;pendingCrop=null;paint();},()=>mode==='crop'&&!!crop));
    const undoButton=M.button('Undo',()=>{if(undo.length){redo.push(snapshot());restore(undo.pop());}}),redoButton=M.button('Redo',()=>{if(redo.length){undo.push(snapshot());restore(redo.pop());}});
    historyTools.append(undoButton,redoButton);
    let accepted=false;const completed=new Promise(resolve=>d.onClose(()=>resolve(accepted)));
    setMode('pen');d.actions.append(M.button('Cancel',d.close),M.button('Save',async()=>{
      paint(true);const edits=[...layers,{type:'transform',rotation,crop}];d.setBusy(true);
      try {const asset=await storeCanvas(canvas,source,false,edits);block.edited_asset_id=asset.id;await onSave();accepted=true;}
      finally {d.setBusy(false);if(!accepted)paint();}
      d.close();
    },'save'));
    return completed;
  }
  Object.assign(api,{open,stickerMaker});global.PupPhotoEdit=api;
})(typeof window!=='undefined'?window:globalThis);
