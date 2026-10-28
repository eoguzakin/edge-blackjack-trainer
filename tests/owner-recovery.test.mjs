import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {localDatabase} from '../scripts/local-db.mjs';
import {digest,hashPassword,newSession,verifyPassword} from '../src/auth.js';

const origin='https://edge.example';
async function setup(t){
  const DB=localDatabase();t.after(()=>DB.sqlite.close());
  const id=crypto.randomUUID(),other=crypto.randomUUID(),password='temporary test password 123';
  const oldHash=await hashPassword('original test password 456');
  for(const [accountId,name] of [[id,'Owner'],[other,'Player']])DB.sqlite.prepare('INSERT INTO accounts (id,username,username_key,password_hash,chips,created_at,solo_state) VALUES (?,?,?,?,2469,?,?)').run(accountId,name,name.toLowerCase(),oldHash,Date.now(),'{"phase":"playing","bankroll":1234.5}');
  const sessions=[await newSession(DB,id),await newSession(DB,id)];await newSession(DB,other);
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  const job={id:`recovery-${crypto.randomUUID()}`,accountId:id,usernameKey:'owner',passwordHash:await hashPassword(password),tokenHash:await digest(token),expiresAt:Date.now()+600000};
  const env={DB,ADMIN_ACCOUNT_ID:id,OWNER_RECOVERY_JOB:JSON.stringify(job)};
  const call=async(options={})=>{
    const response=await worker.fetch(new Request(origin+'/api/maintenance/owner-recovery',{method:options.method||'POST',headers:{'x-owner-recovery-token':token,...options.headers}}),env);
    return {status:response.status,data:await response.json()};
  };
  const row=()=>DB.sqlite.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  return {DB,id,other,password,oldHash,sessions,token,job,env,call,row};
}

test('owner recovery is disabled by default and rejects invalid or expired authorization',async t=>{
  const {DB,job,env,call,row,oldHash,other}=await setup(t);
  for(const invalid of [null,{...job,accountId:other},{...job,expiresAt:Date.now()-1},{...job,expiresAt:Date.now()+7200000},{...job,passwordHash:'invalid'}]){
    env.OWNER_RECOVERY_JOB=JSON.stringify(invalid);assert.equal((await call()).status,404);
  }
  env.OWNER_RECOVERY_JOB=JSON.stringify(job);
  assert.equal((await call({headers:{'x-owner-recovery-token':'0'.repeat(64)}})).status,403);
  assert.equal((await call({headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal((await call({method:'GET'})).status,405);
  env.OWNER_RECOVERY_JOB=JSON.stringify({...job,usernameKey:'player'});assert.equal((await call()).status,409);
  assert.equal(row().password_hash,oldHash);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n,3);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit').get().n,0);
});

test('owner recovery resets once, revokes owner sessions, and preserves chips, games, and other accounts',async t=>{
  const {DB,id,other,password,oldHash,job,env,call,row}=await setup(t),before=row();
  const response=await call();assert.equal(response.status,200);assert.deepEqual(response.data,{reset:true});
  const after=row();assert.equal(await verifyPassword(password,after.password_hash),true);
  for(const key of ['username','username_key','chips','solo_state','active_room'])assert.equal(after[key],before[key]);
  assert.equal(after.revision,before.revision+1);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(id).n,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(other).n,1);
  assert.equal(DB.sqlite.prepare('SELECT password_hash FROM accounts WHERE id=?').get(other).password_hash,oldHash);
  await assert.rejects(newSession(DB,id,oldHash),error=>error.status===401);
  const audit=DB.sqlite.prepare('SELECT * FROM admin_audit WHERE id=?').get(job.id);
  assert.deepEqual(JSON.parse(audit.changed_fields),['password']);assert.equal(audit.before_value,audit.after_value);
  assert.doesNotMatch(JSON.stringify(audit),/scrypt:|temporary test password|tokenHash/);
  // A consumed job must never revert a later password change or revoke a new session.
  DB.sqlite.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(oldHash,id);await newSession(DB,id,oldHash);
  assert.equal((await call()).status,200);assert.equal(row().password_hash,oldHash);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(id).n,1);
  delete env.OWNER_RECOVERY_JOB;assert.equal((await call()).status,404);
});

test('owner recovery conflicts roll back password, audit, and session changes together',async t=>{
  const {DB,id,oldHash,call,row}=await setup(t),batch=DB.batch;
  DB.batch=async statements=>{DB.sqlite.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').run(id);return batch(statements);};
  assert.equal((await call()).status,409);DB.batch=batch;
  assert.equal(row().password_hash,oldHash);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(id).n,2);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit').get().n,0);
});
