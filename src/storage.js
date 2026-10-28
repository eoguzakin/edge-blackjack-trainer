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
export async function rateLimit(db,key,limit=20,window=60000){
  const now=Date.now();
  const row=await statement(db,`INSERT INTO rate_limits (key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END,expires=CASE WHEN expires<? THEN ? ELSE expires END RETURNING count`,key,now+window,now,now,now+window).first();
  if(row.count>limit)fail(429,'Too many attempts. Please wait a few minutes and try again.');
}
