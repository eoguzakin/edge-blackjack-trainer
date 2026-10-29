export class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
export const fail=(status,message)=>{throw new HttpError(status,message);};
export const statement=(db,sql,...values)=>db.prepare(sql).bind(...values);
export async function atomic(db,writes,extras=[]){
  const id=crypto.randomUUID(),batch=[];
  for(let i=0;i<writes.length;i++){
    batch.push(writes[i],statement(db,'INSERT INTO write_checks (id,ok) VALUES (?,changes())',`${id}-${i}`));
  }
  // Extras may legitimately affect zero or many rows (for example, revoking sessions).
  batch.push(...extras,statement(db,'DELETE FROM write_checks WHERE id LIKE ?',`${id}-%`));
  try{return await db.batch(batch);}
  catch(error){if(String(error).includes('atomic_write_conflict'))fail(409,'The table changed. Your balance is safe; please try again.');throw error;}
}
export function limitExceeded(expires){
  const error=new HttpError(429,'Too many attempts. Please wait a little and try again.');
  error.retryAfter=Math.max(1,Math.ceil((expires-Date.now())/1000));throw error;
}
// Only denied decisions are cached. Every admission still uses the shared database.
const blockedDatabases=new WeakMap(),blockedCapacity=4096;
export async function rateLimit(db,key,limit=20,window=60000){
  const now=Date.now(),cacheKey=JSON.stringify([key,limit,window]);
  let blocked=blockedDatabases.get(db);if(!blocked){blocked=new Map();blockedDatabases.set(db,blocked);}
  const until=blocked.get(cacheKey);if(until>now)limitExceeded(until);blocked.delete(cacheKey);
  const row=await statement(db,`INSERT INTO rate_limits (key,count,expires) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
    expires=CASE WHEN expires<=? THEN ? ELSE expires END
    WHERE rate_limits.expires<=? OR rate_limits.count<? RETURNING count,expires`,key,now+window,now,now,now+window,now,limit).first();
  if(!row||row.count>=limit){
    const expires=row?.expires??await statement(db,'SELECT expires FROM rate_limits WHERE key=?',key).first('expires')??now+window;
    if(blocked.size>=blockedCapacity){for(const [k,end] of blocked)if(end<=now)blocked.delete(k);}
    if(blocked.size>=blockedCapacity)blocked.delete(blocked.keys().next().value);
    blocked.set(cacheKey,expires);
    if(!row)limitExceeded(expires);
  }
}
