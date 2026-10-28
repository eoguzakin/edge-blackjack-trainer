import {digest} from './auth.js';
import {atomic,fail,statement} from './storage.js';

// Disabled unless the Site owner provisions a short-lived recovery job in server secrets.
// The request can only consume that job; it cannot choose an account or password.
export async function recoverOwner(request,env){
  let job;try{job=JSON.parse(env.OWNER_RECOVERY_JOB||'null');}catch{fail(404,'Not found.');}
  const now=Date.now();
  if(!job||!env.ADMIN_ACCOUNT_ID||job.accountId!==env.ADMIN_ACCOUNT_ID||
    !/^recovery-[a-f0-9-]{36}$/.test(job.id)||typeof job.usernameKey!=='string'||
    !Number.isSafeInteger(job.expiresAt)||job.expiresAt<=now||job.expiresAt>now+3600000||
    !/^[a-f0-9]{64}$/.test(job.tokenHash)||
    !/^scrypt:32768:8:3:[a-f0-9]{32}:[a-f0-9]{64}$/.test(job.passwordHash))fail(404,'Not found.');
  if(request.method!=='POST')fail(405,'Method not allowed.');
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)fail(403,'Recovery is not authorized.');
  const token=request.headers.get('x-owner-recovery-token')||'';
  if(!/^[a-f0-9]{64}$/.test(token))fail(403,'Recovery is not authorized.');
  const actual=await digest(token);let mismatch=0;
  for(let i=0;i<64;i++)mismatch|=actual.charCodeAt(i)^job.tokenHash.charCodeAt(i);
  if(mismatch)fail(403,'Recovery is not authorized.');
  const db=env.DB;
  const used=await statement(db,'SELECT actor_id,target_id FROM admin_audit WHERE id=?',job.id).first();
  if(used){
    if(used.actor_id!==job.accountId||used.target_id!==job.accountId)fail(409,'Recovery could not be applied.');
    return {reset:true};
  }
  const account=await statement(db,'SELECT id,username,username_key,chips,revision FROM accounts WHERE id=?',job.accountId).first();
  if(!account?.username||account.username_key!==job.usernameKey)fail(409,'The owner account changed.');
  const snapshot=JSON.stringify({username:account.username,credits:account.chips/2});
  await atomic(db,[
    statement(db,'UPDATE accounts SET password_hash=?,revision=revision+1,last_request=NULL WHERE id=? AND revision=? AND username_key=?',job.passwordHash,account.id,account.revision,job.usernameKey),
    statement(db,'INSERT INTO admin_audit (id,actor_id,target_id,changed_fields,before_value,after_value,created_at) VALUES (?,?,?,?,?,?,?)',job.id,account.id,account.id,JSON.stringify(['password']),snapshot,snapshot,now)
  ],[statement(db,'DELETE FROM sessions WHERE user_id=?',account.id)]);
  return {reset:true};
}
