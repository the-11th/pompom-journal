/* Local workerd + SQLite integration. Uses synthetic credentials and temp storage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('real local Worker verifies Discord, stores concurrently and survives restart',{timeout:45000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),'datapom-worker-runtime-'));
  const keys=generateKeyPairSync('ed25519'),token=randomBytes(32).toString('base64url');
  const bindings={DISCORD_PUBLIC_KEY:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),DISCORD_USER_ID:'42',DATAPOM_INBOX_TOKEN:token};
  const modules=['worker','protocol','store'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name+'.mjs',import.meta.url))}));
  const options=convertV4MiniflareOptions({workers:[{name:'datapom-inbox-runtime',modules,compatibilityDate:'2026-09-09',durableObjects:{INBOX:{className:'DatapomInbox',useSQLite:true}},bindings}],resourcePersistencePath:folder,telemetry:{enabled:false}});
  let worker;
  const send=async value=>{const body=JSON.stringify(value),stamp=String(Math.floor(Date.now()/1000));return worker.dispatchFetch('https://receiver.example/interactions',{method:'POST',body,headers:{'X-Signature-Timestamp':stamp,'X-Signature-Ed25519':sign(null,Buffer.from(stamp+body),keys.privateKey).toString('hex')}});};
  const get=()=>worker.dispatchFetch('https://receiver.example/inbox',{headers:{Authorization:'Bearer '+token}});
  const capture=(id,messageId,content='Local runtime fixture')=>send({id,type:2,user:{id:'42'},channel_id:'22',data:{name:'Add to Datapom',type:3,target_id:messageId,resolved:{messages:{[messageId]:{id:messageId,author:{id:'7',username:'fixture'},content,timestamp:new Date().toISOString(),attachments:[]}}}}});
  try{
    worker=new Miniflare(options);
    assert.deepEqual(await (await send({type:1})).json(),{type:1});
    assert.equal((await worker.dispatchFetch('https://receiver.example/inbox')).status,401);
    assert.equal((await worker.dispatchFetch('https://receiver.example/interactions',{method:'POST',body:'{}'})).status,401);
    assert.equal((await capture('444','33','First snapshot')).status,200);
    const replies=await Promise.all(Array.from({length:12},(_,i)=>capture(String(500+i),'33','Later snapshot')));
    assert.ok(replies.every(r=>r.status===200));
    const separate=await Promise.all(Array.from({length:12},(_,i)=>capture(String(600+i),String(100+i))));
    assert.ok(separate.every(r=>r.status===200));
    const response=await get();assert.equal(response.headers.get('Cache-Control'),'no-store');
    let messages=(await response.json()).messages;assert.equal(messages.length,13);assert.equal(messages.find(m=>m.id==='33').content,'First snapshot');
    await worker.dispose();worker=new Miniflare(options);
    messages=(await (await get()).json()).messages;assert.equal(messages.length,13);
    const ack=await worker.dispatchFetch('https://receiver.example/inbox/ack',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({ids:messages.map(m=>m.id)})});assert.equal(ack.status,200);
    assert.equal((await (await get()).json()).messages.length,0);
    await capture('444','33','Replay after acknowledgement');assert.equal((await (await get()).json()).messages.length,0);
  }finally{if(worker)await worker.dispose();await rm(folder,{recursive:true,force:true});}
});
