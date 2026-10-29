export class Session {
  constructor(){this.data=null;this.snapshot=null;this.generation=0;}
  async request(path,body,{conditional=false}={}){
    if(body){this.snapshot=null;this.generation++;}
    const generation=this.generation,saved=this.snapshot?.data;
    const same=saved&&this.data&&saved.user.id===this.data.user.id&&saved.user.revision===this.data.user.revision&&saved.revision===this.data.revision&&saved.room?.code===this.data.room?.code;
    const cached=conditional&&path==='/api/me'&&same?this.snapshot:null;
    const headers=body?{'Content-Type':'application/json'}:{};if(cached)headers['If-None-Match']=cached.etag;
    const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    if(conditional&&generation!==this.generation&&response.ok)return this.data;
    if(response.status===304){if(!cached)throw new Error('Please refresh your table.');return generation===this.generation?cached.data:this.data;}
    let data;try{data=await response.json();}catch{throw new Error('The table is temporarily unavailable. Please retry.');}
    if(!response.ok){if(response.status===401)this.snapshot=null;const error=new Error(data.error||'Please try again.');error.status=response.status;error.retryAfter=Number(response.headers.get('Retry-After')||data.retryAfter)||0;throw error;}
    if(data.user&&data.table&&response.headers.get('ETag')&&generation===this.generation)this.snapshot={etag:response.headers.get('ETag'),data};
    return data;
  }
  async load(){try{return await this.request('/api/me');}catch(error){if(error.status===401)return this.request('/api/guest',{});throw error;}}
  async action(action,extra={},endpoint){
    const target=endpoint||(this.data?.room?'/api/rooms/action':'/api/solo'),requestId=crypto.randomUUID();
    const accountId=this.data.user.id;
    const send=()=>this.request(target,{action,...extra,revision:this.data.revision,accountId,requestId});
    try{return await send();}catch(error){
      // Independent ready toggles may cross in flight. Retry once; never replay a card action.
      if(error.status===409&&['ready','unready'].includes(action)){this.data=await this.request('/api/me');if(this.data.user.id===accountId)return send();}throw error;
    }
  }
}
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
