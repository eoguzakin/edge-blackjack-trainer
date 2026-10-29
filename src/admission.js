import {sessionToken} from './auth.js';
import {limitExceeded} from './storage.js';

// Cheap per-isolate protection before any database call. Durable account limits
// remain authoritative across isolates, IP addresses, and signed-in sessions.
export function createRequestAdmission(){
  const buckets=new Map(),window=60000,capacity=4096;
  return request=>{
    const now=Date.now(),path=new URL(request.url).pathname,token=sessionToken(request);
    const checks=[['all',2400],['ip:'+(request.headers.get('CF-Connecting-IP')||'local').slice(0,64),600]];
    if(token&&((request.method==='GET'&&path==='/api/me')||(request.method==='POST'&&path==='/api/guest')))checks.push(['snapshot:'+token,120]);
    for(const [key,limit] of checks){const bucket=buckets.get(key);if(bucket?.expires>now&&bucket.count>=limit)limitExceeded(bucket.expires);}
    const missing=checks.filter(([key])=>!buckets.has(key)).length;
    if(buckets.size+missing>capacity){
      for(const [key,bucket] of buckets)if(bucket.expires<=now)buckets.delete(key);
      if(buckets.size+missing>capacity)limitExceeded(now+window);
    }
    for(const [key] of checks){const bucket=buckets.get(key);if(bucket?.expires>now)bucket.count++;else buckets.set(key,{count:1,expires:now+window});}
  };
}
