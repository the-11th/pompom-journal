/* SQLite queue. All read/modify/write operations complete within a transaction. */
import { acknowledgement, snowflake, RECEIPT_TTL_MS, MAX_MESSAGE_BYTES } from './protocol.mjs';
export class InboxStore {
  constructor(storage,{now=Date.now,maxMessages=1000,maxBytes=8*1024*1024,maxReceipts=10000}={}){
    this.storage=storage;this.sql=storage.sql;this.now=now;this.limits={maxMessages,maxBytes,maxReceipts};
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, outcome TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS receipt_expiry ON receipts(expires_at)');
  }
  prune(){this.sql.exec('DELETE FROM receipts WHERE expires_at < ?',this.now());}
  nextExpiry(){return this.sql.exec('SELECT MIN(expires_at) AS expiry FROM receipts').toArray()[0].expiry??null;}
  capture(message,interactionId){
    snowflake(interactionId);snowflake(message.id);
    const payload=JSON.stringify(message),bytes=new TextEncoder().encode(payload).length;
    if(bytes>MAX_MESSAGE_BYTES)throw new Error('Normalized message exceeds storage limit');
    return this.storage.transactionSync(()=>{
      this.prune();
      const seen=this.sql.exec('SELECT outcome FROM receipts WHERE id = ?',interactionId).toArray()[0];
      if(seen)return {status:seen.outcome};
      if(this.sql.exec('SELECT COUNT(*) AS count FROM receipts').toArray()[0].count>=this.limits.maxReceipts)return {status:'busy'};
      const exists=this.sql.exec('SELECT id FROM messages WHERE id = ?',message.id).toArray().length>0;
      if(!exists){
        const totals=this.sql.exec('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM messages').toArray()[0];
        if(totals.count>=this.limits.maxMessages||totals.bytes+bytes>this.limits.maxBytes)return {status:'full'};
        this.sql.exec('INSERT INTO messages(id,payload,bytes,created_at) VALUES (?,?,?,?)',message.id,payload,bytes,this.now());
      }
      const status=exists?'duplicate':'saved';
      this.sql.exec('INSERT INTO receipts(id,expires_at,outcome) VALUES (?,?,?)',interactionId,this.now()+RECEIPT_TTL_MS,status);
      return {status};
    });
  }
  list(){
    return this.storage.transactionSync(()=>{this.prune();return {messages:this.sql.exec('SELECT payload FROM messages ORDER BY created_at,id LIMIT 1000').toArray().map(row=>JSON.parse(row.payload))};});
  }
  ack(ids){
    const valid=acknowledgement({ids});
    return this.storage.transactionSync(()=>{this.prune();for(const id of valid)this.sql.exec('DELETE FROM messages WHERE id = ?',id);return {ok:true};});
  }
}
