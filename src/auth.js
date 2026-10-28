import {scryptAsync} from '@noble/hashes/scrypt.js';
import {statement,rateLimit,fail} from './storage.js';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex=value=>Uint8Array.from(value.match(/../g)||[],v=>parseInt(v,16));
export const digest=async value=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const randomToken=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const kdf={N:32768,r:8,p:3,dkLen:32,maxmem:40*1024*1024,asyncTick:10};
// Serialize expensive hashes per isolate to stay comfortably below the Worker memory limit.
let hashing=Promise.resolve();
async function derive(password,salt){const previous=hashing;let release;hashing=new Promise(r=>release=r);await previous;try{return await scryptAsync(password,unhex(salt),kdf);}finally{release();}}
export async function hashPassword(password){const salt=hex(crypto.getRandomValues(new Uint8Array(16)));return `scrypt:32768:8:3:${salt}:${hex(await derive(password,salt))}`;}
export async function verifyPassword(password,encoded){
  const parts=encoded?.split(':');const salt=parts?.[4]||'00000000000000000000000000000000';
  const result=await derive(password,salt),expected=parts?.[5]?unhex(parts[5]):new Uint8Array(32);
  let mismatch=result.length^expected.length;for(let i=0;i<result.length;i++)mismatch|=result[i]^(expected[i]||0);
  return !!encoded&&mismatch===0;
}
export function credentials(body){
  if(typeof body.username!=='string'||! /^[A-Za-z0-9_]{3,20}$/.test(body.username))fail(400,'Use 3–20 letters, numbers, or underscores for your username.');
  if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)fail(400,'Use a password with 12–128 characters.');
  return {username:body.username,key:body.username.toLowerCase(),password:body.password};
}
export function sessionCookie(request,token,maxAge=60*60*24*365){return `edge_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol==='https:'?'; Secure':''}`;}
export async function newSession(db,id,verifiedHash){
  const token=randomToken();
  const values=[await digest(token),id,Date.now()+365*86400000];
  const result=verifiedHash===undefined
    ?await statement(db,'INSERT INTO sessions (token_hash,user_id,expires) VALUES (?,?,?)',...values).run()
    :await statement(db,'INSERT INTO sessions (token_hash,user_id,expires) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND password_hash=?)',...values,id,verifiedHash).run();
  if(result.meta.changes!==1)fail(401,'Your password changed. Please sign in again.');
  return token;
}
export async function sessionAccount(request,db){
  const token=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('edge_session='))?.slice(13);
  if(!token||! /^[a-f0-9]{64}$/.test(token))return null;
  return statement(db,'SELECT a.*,s.token_hash FROM accounts a JOIN sessions s ON s.user_id=a.id WHERE s.token_hash=? AND s.expires>?',await digest(token),Date.now()).first();
}
export async function authLimit(request,db,username=''){
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  await rateLimit(db,`auth-ip:${await digest(ip)}`,30,15*60000);
  if(username)await rateLimit(db,`auth-user:${username.toLowerCase()}`,10,15*60000);
}
