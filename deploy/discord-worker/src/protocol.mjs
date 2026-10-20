/* Shared request/validation logic: no account access, network clients, or storage. */
export const MAX_BODY_BYTES=1024*1024;
export const MAX_ACK_BYTES=32768;
export const RECEIPT_TTL_MS=660000; // Beyond the inclusive ±300-second signature window.
export const MAX_MESSAGE_BYTES=65536;
const SIGNATURE_WINDOW_MS=300000;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true});
const ID=/^\d{1,24}$/;

export class RequestError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
export function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function requireObject(value){if(!object(value))throw new RequestError(400,'Expected a JSON object');return value;}
export function snowflake(value){if(typeof value!=='string'||!ID.test(value))throw new RequestError(400,'Invalid Discord identifier');return value;}
function text(value,max){if(typeof value!=='string'||[...value].length>max)throw new RequestError(400,'Invalid message text');return value;}
export function validateConfig(env){
  if(typeof env.DISCORD_PUBLIC_KEY!=='string'||!/^[a-f\d]{64}$/i.test(env.DISCORD_PUBLIC_KEY))throw new Error('Receiver public key is not configured');
  if(typeof env.DISCORD_USER_ID!=='string'||!ID.test(env.DISCORD_USER_ID))throw new Error('Receiver owner is not configured');
  if(typeof env.DATAPOM_INBOX_TOKEN!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(env.DATAPOM_INBOX_TOKEN))throw new Error('Receiver token is not configured');
  return {publicKey:env.DISCORD_PUBLIC_KEY,userId:env.DISCORD_USER_ID,token:env.DATAPOM_INBOX_TOKEN};
}
function timestamp(value){
  const match=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if(!match)throw new RequestError(400,'Message timestamp needs a timezone');
  const [,y,m,d,h,min,s,,oh='0',om='0']=match,n=[y,m,d,h,min,s,oh,om].map(Number),[year,month,day,hour,minute,second,offsetHour,offsetMinute]=n;
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59||offsetHour>23||offsetMinute>59||!Number.isFinite(Date.parse(value)))throw new RequestError(400,'Invalid message timestamp');
  return value;
}
export function selectedMessage(interaction,allowedUser,now=Date.now()){
  requireObject(interaction);
  const user=interaction.user??requireObject(interaction.member??{}).user;
  requireObject(user);
  if(user.id!==allowedUser)throw new RequestError(403,'This inbox belongs to another user');
  const data=requireObject(interaction.data);
  if(interaction.type!==2||data.type!==3||data.name!=='Add to Datapom')throw new RequestError(400,'Choose Add to Datapom on a message');
  snowflake(interaction.id);
  const target=snowflake(data.target_id),messages=requireObject(requireObject(data.resolved).messages),message=requireObject(messages[target]);
  if(message.id!==target)throw new RequestError(400,'Selected message was not included by Discord');
  const channel=snowflake(message.channel_id??interaction.channel_id),guild=interaction.guild_id?snowflake(interaction.guild_id):'@me',author=requireObject(message.author);
  const attachments=message.attachments??[];
  if(!Array.isArray(attachments)||attachments.length>10)throw new RequestError(400,'Invalid message attachments');
  const clean={id:target,rev:0,author_id:snowflake(author.id),author_name:text(author.global_name||author.username||'Discord user',100),content:text(message.content??'',100000),timestamp:timestamp(message.timestamp),source_url:`https://discord.com/channels/${guild}/${channel}/${target}`,attachments:attachments.map(value=>{
    const a=requireObject(value),size=a.size??0;if(!Number.isSafeInteger(size)||size<0)throw new RequestError(400,'Invalid attachment size');
    return {filename:text(a.filename??'attachment',300),size};
  }),captured_at:new Date(now).toISOString()};
  if(encoder.encode(JSON.stringify(clean)).length>MAX_MESSAGE_BYTES)throw new RequestError(413,'This selected message is too large for the inbox');
  return clean;
}
export function acknowledgement(value){
  requireObject(value);
  if(Object.keys(value).some(key=>key!=='ids')||!Array.isArray(value.ids)||value.ids.length>1000)throw new RequestError(400,'Invalid acknowledgement');
  return [...new Set(value.ids.map(snowflake))];
}
export function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}
async function bytes(request,limit){
  const length=request.headers.get('Content-Length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw new RequestError(413,'Request is too large');
  if(!request.body)return new Uint8Array();
  const reader=request.body.getReader(),chunks=[];let total=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw new RequestError(413,'Request is too large');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
function parse(body){try{return requireObject(JSON.parse(decoder.decode(body)));}catch(error){if(error instanceof RequestError)throw error;throw new RequestError(400,'Invalid JSON body');}}
function hex(value){return Uint8Array.from(value.match(/../g),pair=>parseInt(pair,16));}
async function verified(body,request,publicKey,now){
  const signature=request.headers.get('X-Signature-Ed25519')||'',stamp=request.headers.get('X-Signature-Timestamp')||'';
  if(!/^[a-f\d]{128}$/i.test(signature)||!/^\d{1,12}$/.test(stamp)||Math.abs(now-Number(stamp)*1000)>SIGNATURE_WINDOW_MS)return false;
  const prefix=encoder.encode(stamp),signed=new Uint8Array(prefix.length+body.length);signed.set(prefix);signed.set(body,prefix.length);
  try{const key=await crypto.subtle.importKey('raw',hex(publicKey),{name:'Ed25519'},false,['verify']);return await crypto.subtle.verify('Ed25519',key,hex(signature),signed);}catch(_){return false;}
}
async function authenticated(request,token){
  const expected='Bearer '+token,received=request.headers.get('Authorization')||'';
  if(received.length!==expected.length)return false;
  // Let Web Crypto compare MACs, instead of a JavaScript string equality check.
  const key=await crypto.subtle.importKey('raw',encoder.encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  const mac=await crypto.subtle.sign('HMAC',key,encoder.encode(expected));
  return crypto.subtle.verify('HMAC',key,mac,encoder.encode(received));
}
export async function handleRequest(request,env,backend,{now=Date.now}={}){
  try{
    const config=validateConfig(env),url=new URL(request.url),path=url.pathname;
    if(url.search||!['/interactions','/inbox','/inbox/ack'].includes(path))return json({error:'Not found'},404);
    if(path==='/interactions'){
      if(request.method!=='POST')return json({error:'Method not allowed'},405);
      const body=await bytes(request,MAX_BODY_BYTES),at=now();
      if(!await verified(body,request,config.publicKey,at))return json({error:'Invalid signature'},401);
      const value=parse(body);if(value.type===1)return json({type:1});
      const message=selectedMessage(value,config.userId,at);
      const result=await backend.capture(message,value.id);
      const content=result.status==='saved'?'Saved to your Datapom inbox. Add it to a journal day when you are ready.':result.status==='duplicate'?'This message is already in your Datapom inbox. Its first selected copy is preserved.':result.status==='full'?'Inbox is full. Sync Datapom on your Mac, then try again.':result.status==='busy'?'The inbox is busy. Please try again in a few minutes.':null;
      if(!content)throw new Error('Invalid storage result');
      return json({type:4,data:{content,flags:64,allowed_mentions:{parse:[]}}});
    }
    if(!await authenticated(request,config.token))return json({error:'Unauthorized'},401);
    if(path==='/inbox'&&request.method==='GET')return json(await backend.list());
    if(path==='/inbox/ack'&&request.method==='POST')return json(await backend.ack(acknowledgement(parse(await bytes(request,MAX_ACK_BYTES)))));
    return json({error:'Method not allowed'},405);
  }catch(error){
    if(error instanceof RequestError)return json({error:error.message},error.status);
    // Never serialize exception text, message contents, headers, or secrets.
    return json({error:'The inbox is temporarily unavailable. Please try again.'},503);
  }
}
