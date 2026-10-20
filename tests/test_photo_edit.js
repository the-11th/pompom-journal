const assert=require('node:assert/strict');
const E=require('../static/photo-edit.js');
let width=40,height=40,data=new Uint8ClampedArray(width*height*4).fill(255);
for(let y=12;y<28;y++)for(let x=12;x<28;x++){let i=(y*width+x)*4;data[i]=180;data[i+1]=30;data[i+2]=40;}
const mask=E.cutoutMask({data,width,height},[[6,6],[34,6],[34,34],[6,34]]);
assert.equal(mask[20*width+20],255);
assert.equal(mask[8*width+8],0);
assert.equal(mask[2*width+2],0);
console.log('sticker extraction contracts passed');
assert.deepEqual(E.sourcePoint(.25,.75,{x:.1,y:.2,w:.5,h:.6},90).map(n=>Math.round(n*1e6)/1e6),[.475,.65]);
assert.deepEqual(E.editState([{type:'stroke',points:[[.2,.3,1]]},{type:'transform',rotation:90,crop:{x:.1,y:.2,w:.5,h:.6}}]),{layers:[{type:'stroke',points:[[.2,.3,1]]}],rotation:90,crop:{x:.1,y:.2,w:.5,h:.6}});
assert.equal(E.editState([{type:'transform',rotation:17,crop:{x:-1,y:0,w:4,h:1}}]).rotation,0);
assert.equal(E.editState([{type:'transform',rotation:17,crop:{x:-1,y:0,w:4,h:1}}]).crop,null);
