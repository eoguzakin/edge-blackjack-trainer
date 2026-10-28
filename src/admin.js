import {statement,atomic,rateLimit,fail} from './storage.js';
import {hashPassword} from './auth.js';
import {FriendGame,soloGame,serialize} from './friend-game.js';
import {deleteAccount} from './admin-delete.js';

// Access is bound to an immutable account ID in server configuration, never a username.
export const isAdmin=(account,env)=>!!(account?.username&&env.ADMIN_ACCOUNT_ID&&account.id===env.ADMIN_ACCOUNT_ID);
const idle=phase=>['ready','settled'].includes(phase);
const fields=a=>({username:a.username,credits:a.chips/2});
function view(a,room){
  const phase=room?JSON.parse(room.state).phase:a.solo_state?JSON.parse(a.solo_state).phase:'ready';
  return {id:a.id,...fields(a),guest:!a.username,createdAt:a.created_at,revision:a.revision,
    location:a.active_room?'Friend table':'Solo',inHand:!idle(phase),canEditCredits:idle(phase)&&(!a.active_room||!!room)};
}
async function detail(db,id){
  const a=await statement(db,'SELECT * FROM accounts WHERE id=?',id).first();
  if(!a)fail(404,'This account was not found.');
  const room=a.active_room?await statement(db,'SELECT * FROM rooms WHERE code=?',a.active_room).first():null;
  const history=await statement(db,'SELECT changed_fields,before_value,after_value,created_at FROM admin_audit WHERE target_id=? ORDER BY created_at DESC,id DESC LIMIT 15',id).all();
  return {user:view(a,room),history:history.results.map(r=>({fields:JSON.parse(r.changed_fields),before:JSON.parse(r.before_value),after:JSON.parse(r.after_value),at:r.created_at}))};
}
export async function adminRequest(request,env,actor,body){
  const db=env.DB,url=new URL(request.url),path=url.pathname;
  if(path==='/api/admin/access'&&request.method==='GET')return {allowed:isAdmin(actor,env),signedIn:!!actor?.username,username:actor?.username||null,accountId:actor?.id||null};
  if(!actor)fail(401,'Sign in with your owner account.');
  if(!isAdmin(actor,env))fail(403,'Only the owner account can manage users.');
  await rateLimit(db,`admin:${actor.id}`,request.method==='GET'?120:30,60000);
  if(path==='/api/admin/users'&&request.method==='GET'){
    const search=(url.searchParams.get('q')||'').trim().slice(0,64).toLowerCase(),kind=url.searchParams.get('kind')||'all';
    const offset=Number(url.searchParams.get('offset')||0);
    if(!['all','registered','guest'].includes(kind)||!Number.isSafeInteger(offset)||offset<0||offset>1000000)fail(400,'Invalid search.');
    const where=`(?='' OR instr(COALESCE(a.username_key,''),?)>0 OR a.id=?) AND (?='all' OR (?='guest' AND a.username IS NULL) OR (?='registered' AND a.username IS NOT NULL))`;
    const args=[search,search,search,kind,kind,kind];
    const total=await statement(db,`SELECT count(*) AS total FROM accounts a WHERE ${where}`,...args).first('total');
    const rows=await statement(db,`SELECT a.*,r.state AS room_state FROM accounts a LEFT JOIN rooms r ON r.code=a.active_room WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT 25 OFFSET ?`,...args,offset).all();
    return {users:rows.results.map(a=>view(a,a.room_state?{state:a.room_state}:null)),total,offset,hasMore:offset+25<total};
  }
  const match=path.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]{1,80})(\/delete)?$/);
  if(!match)fail(404,'Not found.');
  const id=match[1];
  if(request.method==='GET'&&!match[2])return detail(db,id);
  if(request.method!=='POST')fail(405,'Method not allowed.');
  if(body.accountId!==actor.id)fail(409,'The signed-in account changed. Sign in again.');
  if(!Number.isInteger(body.revision)||typeof body.requestId!=='string'||! /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId))fail(400,'Reload the account before saving.');
  if(match[2])return deleteAccount(db,actor,id,body);
  const duplicate=await statement(db,'SELECT actor_id,target_id FROM admin_audit WHERE id=?',body.requestId).first();
  if(duplicate){if(duplicate.actor_id!==actor.id||duplicate.target_id!==id)fail(409,'This change has already been used.');return {...await detail(db,id),saved:true};}
  const a=await statement(db,'SELECT * FROM accounts WHERE id=?',id).first();if(!a)fail(404,'This account was not found.');
  if(a.revision!==body.revision)fail(409,'This account changed since you opened it. Reload it before saving.');
  const next={...a},changed=[];
  if(Object.hasOwn(body,'username')&&body.username!==a.username){
    if(typeof body.username!=='string'||! /^[A-Za-z0-9_]{3,20}$/.test(body.username))fail(400,'Use 3–20 letters, numbers, or underscores for the username.');
    next.username=body.username;next.username_key=body.username.toLowerCase();changed.push('username');
  }
  if(Object.hasOwn(body,'credits')&&body.credits!==a.chips/2){
    if(typeof body.credits!=='number'||body.credits<0||!Number.isSafeInteger(body.credits*2))fail(400,'Credits must be a non-negative amount in steps of 0.5.');
    next.chips=body.credits*2;changed.push('credits');
  }
  if(Object.hasOwn(body,'password')){
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)fail(400,'Use a new password with 12–128 characters.');
    if(!next.username)fail(400,'Give this guest a username before setting a password.');
    changed.push('password');
  }
  if(!a.username&&next.username&&!changed.includes('password'))fail(400,'Set a password when giving a guest a username.');
  if(!changed.length)fail(400,'Change at least one field before saving.');
  const room=a.active_room?await statement(db,'SELECT * FROM rooms WHERE code=?',a.active_room).first():null;
  if(a.active_room&&!room)fail(409,'The friend table is unavailable. Try again after the player leaves it.');
  const game=room?FriendGame.load(room.state):soloGame(a);
  if(changed.includes('credits')&&!idle(game.phase))fail(409,'Credits can be changed between hands. Let this hand finish, then reload the account.');
  const writes=[],extras=[];
  if(room){
    const p=game.players.find(p=>p.id===id);if(!p)fail(409,'This player changed tables. Reload the account.');
    p.name=next.username;
    if(changed.includes('credits')){p.bankroll=next.chips/2;p.ready=false;p.status='Choose a bet';}
    // Do not replay old animation snapshots after an administrative edit.
    delete game.lastFrames;
    writes.push(statement(db,'UPDATE rooms SET state=?,revision=revision+1,updated_at=?,last_request=NULL WHERE code=? AND revision=?',serialize(game),Date.now(),room.code,room.revision));
  }else if(changed.includes('credits')){game.bankroll=next.chips/2;next.solo_state=serialize(game);}
  if(changed.includes('password')){
    next.password_hash=await hashPassword(body.password);
    extras.push(statement(db,'DELETE FROM sessions WHERE user_id=?',id));
  }
  writes.push(statement(db,'UPDATE accounts SET username=?,username_key=?,password_hash=?,chips=?,solo_state=?,revision=revision+1,last_request=NULL WHERE id=? AND revision=? AND active_room IS ?',next.username,next.username_key,next.password_hash,next.chips,next.solo_state,id,a.revision,a.active_room));
  writes.push(statement(db,'INSERT INTO admin_audit (id,actor_id,target_id,changed_fields,before_value,after_value,created_at) VALUES (?,?,?,?,?,?,?)',body.requestId,actor.id,id,JSON.stringify(changed),JSON.stringify(fields(a)),JSON.stringify(fields(next)),Date.now()));
  try{await atomic(db,writes,extras);}catch(error){if(String(error).includes('UNIQUE constraint failed: accounts.username_key'))fail(409,'That username is already taken.');if(error.status===409)fail(409,'This account or its table changed. Reload the account before saving.');throw error;}
  return {...await detail(db,id),saved:true,signedOut:changed.includes('password')&&id===actor.id};
}
