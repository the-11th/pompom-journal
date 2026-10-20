import { DurableObject } from 'cloudflare:workers';
import { handleRequest } from './protocol.mjs';
import { InboxStore } from './store.mjs';

export class DatapomInbox extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.inbox=new InboxStore(ctx.storage);}
  async scheduleExpiry(){
    const alarm=await this.ctx.storage.getAlarm(),next=this.inbox.nextExpiry();
    // +1 keeps the receipt valid at its inclusive expiry boundary.
    if(next!==null&&(alarm===null||alarm>next+1))await this.ctx.storage.setAlarm(next+1);
  }
  async capture(message,interactionId){
    const result=this.inbox.capture(message,interactionId);
    await this.scheduleExpiry();await this.ctx.storage.sync();return result;
  }
  async list(){const result=this.inbox.list();await this.ctx.storage.sync();return result;}
  async ack(ids){const result=this.inbox.ack(ids);await this.ctx.storage.sync();return result;}
  async alarm(){this.inbox.prune();await this.scheduleExpiry();await this.ctx.storage.sync();}
}

export default {
  fetch(request,env){
    // The singleton's RPC methods are available only through this private binding.
    // Public requests always pass signature/owner or bearer authentication first.
    const inbox=()=>env.INBOX.get(env.INBOX.idFromName('datapom-private-inbox-v1'));
    return handleRequest(request,env,{
      capture:(message,id)=>inbox().capture(message,id),
      list:()=>inbox().list(),
      ack:ids=>inbox().ack(ids),
    });
  },
};
