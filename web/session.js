export class Session {
  constructor(){this.data=null;}
  async request(path,body){
    const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
    let data;try{data=await response.json();}catch{throw new Error('The table is temporarily unavailable. Please retry.');}
    if(!response.ok){const error=new Error(data.error||'Please try again.');error.status=response.status;throw error;}
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
