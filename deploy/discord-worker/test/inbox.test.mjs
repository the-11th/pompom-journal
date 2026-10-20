import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest, validateConfig, selectedMessage, MAX_BODY_BYTES, RECEIPT_TTL_MS } from '../src/protocol.mjs';
import { InboxStore } from '../src/store.mjs';

const NOW=Date.parse('2026-09-09T12:00:00Z');
const keys=generateKeyPairSync('ed25519');
const ENV={DISCORD_PUBLIC_KEY:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),DISCORD_USER_ID:'42',DATAPOM_INBOX_TOKEN:'a'.repeat(43)};
const interaction=(id='444',content='Tea later?')=>({id,type:2,user:{id:'42'},channel_id:'22',data:{name:'Add to Datapom',type:3,target_id:'33',resolved:{messages:{'33':{id:'33',author:{id:'7',username:'alex'},content,timestamp:'2026-09-08T04:05:06+00:00',attachments:[{filename:'tea.png',size:24,url:'https://private.invalid/never-store'}]}}}}});
function signed(value,stamp=String(NOW/1000),path='/interactions'){
  const body=JSON.stringify(value);
  return new Request('https://receiver.example'+path,{method:'POST',body,headers:{'X-Signature-Timestamp':stamp,'X-Signature-Ed25519':sign(null,Buffer.from(stamp+body),keys.privateKey).toString('hex')}});
}
const authenticated=(path,body)=>new Request('https://receiver.example'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+ENV.DATAPOM_INBOX_TOKEN},...(body===undefined?{}:{body:JSON.stringify(body)})});
function storage(filename=':memory:'){
  const db=new DatabaseSync(filename);
  return {db,sql:{exec(query,...bindings){const rows=db.prepare(query).all(...bindings);return {toArray:()=>rows};}},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
}
function fixture(options={}){
  const state=storage();let clock=NOW;
  const store=new InboxStore(state,{now:()=>clock,...options});
  return {store,state,advance:ms=>clock+=ms,request:r=>handleRequest(r,ENV,store,{now:()=>clock})};
}

test('configuration fails closed and only stores selected normalized fields',()=>{
  assert.equal(validateConfig(ENV).userId,'42');
  for(const env of [{...ENV,DISCORD_PUBLIC_KEY:'bad'},{...ENV,DISCORD_USER_ID:'not-a-user'},{...ENV,DATAPOM_INBOX_TOKEN:'short'}])assert.throws(()=>validateConfig(env));
  const value=selectedMessage(interaction(), '42',NOW);
  assert.equal(value.source_url,'https://discord.com/channels/@me/22/33');
  assert.equal(value.timestamp,'2026-09-08T04:05:06+00:00');
  assert.deepEqual(value.attachments,[{filename:'tea.png',size:24}]);
  assert.equal(JSON.stringify(value).includes('private.invalid'),false);
  assert.throws(()=>selectedMessage({...interaction(),type:3},'42',NOW));
  for(const value of [null,[],{...interaction(),user:[]}])assert.throws(()=>selectedMessage(value,'42',NOW));
});

test('raw Ed25519 verification, recent timestamp, owner and strict JSON shape',async()=>{
  const f=fixture();
  const ping=await f.request(signed({type:1}));assert.deepEqual(await ping.json(),{type:1});
  assert.equal((await f.request(new Request('https://receiver.example/interactions',{method:'POST',body:'{}'}))).status,401);
  const changed=signed(interaction());assert.equal((await f.request(new Request(changed.url,{method:'POST',headers:changed.headers,body:(await changed.text())+' '}))).status,401);
  assert.equal((await f.request(signed(interaction(),String(NOW/1000-301)))).status,401);
  assert.equal((await f.request(signed(interaction(),String(NOW/1000+301)))).status,401);
  assert.equal((await f.request(signed({...interaction(),user:{id:'43'}}))).status,403);
  assert.equal((await f.request(signed([1]))).status,400);
  assert.equal((await f.request(signed({...interaction(),data:{}}))).status,400);
  assert.equal(f.store.list().messages.length,0);
});

test('capture, private retrieval and acknowledgement keep existing Mac API',async()=>{
  const f=fixture();const captured=await f.request(signed(interaction()));
  assert.equal(captured.status,200);assert.equal((await captured.json()).data.flags,64);
  for(const response of [captured,await f.request(authenticated('/inbox'))])assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal((await f.request(new Request('https://receiver.example/inbox'))).status,401);
  assert.equal((await f.request(new Request('https://receiver.example/inbox',{headers:{Authorization:'Bearer '+'b'.repeat(43)}}))).status,401);
  assert.equal((await f.request(new Request('https://receiver.example/inbox/ack',{method:'POST',body:'{"ids":["33"]}'}))).status,401);
  const inbox=await (await f.request(authenticated('/inbox'))).json();assert.equal(inbox.messages[0].content,'Tea later?');
  assert.deepEqual(await (await f.request(authenticated('/inbox/ack',{ids:['33']}))).json(),{ok:true});
  assert.equal(f.store.list().messages.length,0);
  await f.request(signed(interaction()));assert.equal(f.store.list().messages.length,0,'replay after ACK must not recreate the message');
});

test('immutable capture prevents GET and ACK racing a later snapshot',async()=>{
  const f=fixture();await f.request(signed(interaction('444','first')));
  const first=await (await f.request(authenticated('/inbox'))).json();
  const again=await f.request(signed(interaction('445','edited later')));assert.match((await again.json()).data.content,/already/i);
  assert.equal(f.store.list().messages[0].content,'first');
  await f.request(authenticated('/inbox/ack',{ids:first.messages.map(m=>m.id)}));
  assert.equal(f.store.list().messages.length,0);
});

test('strict streamed limits and ACK validation do not partly delete',async()=>{
  const f=fixture();await f.request(signed(interaction()));
  for(const body of [[1],{ids:['33',null]},{ids:['33','bad']},{ids:[] ,extra:true},{ids:new Array(1001).fill('33')}])assert.equal((await f.request(authenticated('/inbox/ack',body))).status,400);
  assert.equal(f.store.list().messages.length,1);
  const oversize=new Request('https://receiver.example/interactions',{method:'POST',body:'x'.repeat(MAX_BODY_BYTES+1),headers:{'X-Signature-Timestamp':String(NOW/1000),'X-Signature-Ed25519':'0'.repeat(128)}});
  assert.equal((await f.request(oversize)).status,413);
  assert.equal((await f.request(new Request('https://receiver.example/inbox?secret=x'))).status,404);
});

test('capacity and snapshot inserts are atomic; duplicates work while full',()=>{
  const f=fixture({maxMessages:1,maxBytes:10000});const one=selectedMessage(interaction(),'42',NOW);
  assert.equal(f.store.capture(one,'444').status,'saved');
  assert.equal(f.store.capture(one,'445').status,'duplicate');
  assert.equal(f.store.capture({...one,id:'34'},'446').status,'full');
  f.store.ack(['33']);assert.equal(f.store.capture({...one,id:'34'},'446').status,'saved','full attempt must not consume receipt');
  const tiny=fixture({maxBytes:10});assert.equal(tiny.store.capture(one,'447').status,'full');assert.equal(tiny.store.list().messages.length,0);
});

test('replay receipts expire beyond signature window without expiring queued messages',()=>{
  const f=fixture();const one=selectedMessage(interaction(),'42',NOW);f.store.capture(one,'444');
  assert.equal(f.store.nextExpiry(),NOW+RECEIPT_TTL_MS);
  f.advance(RECEIPT_TTL_MS+1);f.store.prune();assert.equal(f.store.nextExpiry(),null);
  assert.equal(f.store.list().messages.length,1);
});

test('future-dated signature cannot be replayed at the inclusive expiry boundary after ACK',async()=>{
  const f=fixture(),stamp=String(NOW/1000+300);
  assert.equal((await f.request(signed(interaction(),stamp))).status,200);
  await f.request(authenticated('/inbox/ack',{ids:['33']}));
  f.advance(600000);
  assert.equal((await f.request(signed(interaction(),stamp))).status,200);
  assert.equal(f.store.list().messages.length,0);
  f.advance(1);
  assert.equal((await f.request(signed(interaction(),stamp))).status,401);
});

test('SQLite state survives a new object and rollback leaves no partial receipt',()=>{
  const folder=mkdtempSync(join(tmpdir(),'datapom-inbox-worker-'));
  try{
    const filename=join(folder,'inbox.sqlite'),one=selectedMessage(interaction(),'42',NOW);
    const first=storage(filename);new InboxStore(first,{now:()=>NOW}).capture(one,'444');first.db.close();
    const second=storage(filename),store=new InboxStore(second,{now:()=>NOW});assert.equal(store.list().messages[0].content,'Tea later?');
    second.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    assert.throws(()=>store.capture({...one,id:'34'},'445'),/injected/);
    assert.equal(store.list().messages.length,1);second.db.close();
  }finally{rmSync(folder,{recursive:true,force:true});}
});

test('storage failures never report a Discord success or expose diagnostics',async()=>{
  const backend={capture(){throw Error('private token and selected message');}};
  const response=await handleRequest(signed(interaction()),ENV,backend,{now:()=>NOW});
  assert.equal(response.status,503);assert.equal((await response.text()).includes('private token'),false);
});
