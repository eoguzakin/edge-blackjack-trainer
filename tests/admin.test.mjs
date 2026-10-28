import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {localDatabase} from '../scripts/local-db.mjs';
import {newSession,hashPassword,verifyPassword} from '../src/auth.js';
import {soloGame,serialize,FriendGame} from '../src/friend-game.js';

const origin='https://edge.example';
function client(env){return {cookie:'',data:null,async call(path,body,headers={}){
  const response=await worker.fetch(new Request(origin+path,{method:body?'POST':'GET',headers:{origin,cookie:this.cookie,...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})}),env);
  if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
  const data=await response.json();if(data.table)this.data=data;return {status:response.status,data};
},async act(action,extra={},path='/api/solo'){return this.call(path,{action,accountId:this.data.user.id,revision:this.data.revision,requestId:crypto.randomUUID(),...extra});}};}
async function setup(t){
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const env={DB};
  async function add(name){const c=client(env);await c.call('/api/guest',{});const id=c.data.user.id;if(name)DB.sqlite.prepare('UPDATE accounts SET username=?,username_key=? WHERE id=?').run(name,name.toLowerCase(),id);await c.call('/api/me');return c;}
  const owner=await add('Owner'),user=await add('Player');env.ADMIN_ACCOUNT_ID=owner.data.user.id;
  const get=id=>DB.sqlite.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  const edit=(id,patch,extra={})=>owner.call(`/api/admin/users/${id}`,{accountId:env.ADMIN_ACCOUNT_ID,revision:get(id).revision,requestId:crypto.randomUUID(),...patch,...extra});
  const remove=(id,extra={},sender=owner)=>sender.call(`/api/admin/users/${id}/delete`,{accountId:env.ADMIN_ACCOUNT_ID,revision:get(id)?.revision??0,requestId:crypto.randomUUID(),confirmation:id,...extra});
  return {DB,env,owner,user,add,get,edit,remove};
}
test('admin APIs deny anonymous, guest, non-owner and forged roles; responses omit secret and game data',async t=>{
  const {env,owner,user,add}=await setup(t),anonymous=client(env),guest=await add(null);
  assert.equal((await anonymous.call('/api/admin/users')).status,401);
  assert.equal((await guest.call('/api/admin/access')).data.allowed,false);
  assert.equal((await guest.call('/api/admin/users')).status,403);
  assert.equal((await user.call('/api/admin/users',{admin:true,accountId:env.ADMIN_ACCOUNT_ID},{'x-admin':'true'})).status,403);
  assert.equal((await owner.call('/api/admin/access')).data.allowed,true);
  const list=await owner.call('/api/admin/users');assert.equal(list.status,200);assert.equal(list.data.users.length,3);
  assert.doesNotMatch(JSON.stringify(list.data),/password_hash|token_hash|solo_state|room_state|"shoe"/);
  const id=user.data.user.id;
  assert.equal((await owner.call(`/api/admin/users/${id}`,{accountId:env.ADMIN_ACCOUNT_ID,revision:0,requestId:crypto.randomUUID(),credits:50},{origin:'https://attacker.example'})).status,403);
  delete env.ADMIN_ACCOUNT_ID;assert.equal((await owner.call('/api/admin/users')).status,403);
});
test('owner edits username and half-chip credits atomically, rejects invalid values, and retains access after rename',async t=>{
  const {DB,env,owner,user,add,get,edit}=await setup(t),id=user.data.user.id;
  const result=await edit(id,{username:'New_Player',credits:1250.5});assert.equal(result.status,200);assert.equal(result.data.user.credits,1250.5);
  const loaded=await user.call('/api/me');assert.equal(loaded.data.user.bankroll,1250.5);assert.equal(loaded.data.table.state.bankroll,1250.5);assert.equal(loaded.data.user.username,'New_Player');
  for(const credits of [-1,1.25,null,'123',Number.MAX_SAFE_INTEGER])assert.equal((await edit(id,{credits})).status,400);
  assert.equal(get(id).chips,2501);
  assert.equal((await edit(id,{username:'OWNER',credits:99})).status,409);assert.equal(get(id).chips,2501);
  assert.equal((await edit(env.ADMIN_ACCOUNT_ID,{username:'RenamedOwner'})).status,200);
  const impostor=await add('Owner');assert.equal((await impostor.call('/api/admin/users')).status,403);assert.equal((await owner.call('/api/admin/users')).status,200);
  const audit=DB.sqlite.prepare('SELECT * FROM admin_audit WHERE target_id=?').get(id);assert.deepEqual(JSON.parse(audit.changed_fields),['username','credits']);assert.deepEqual(JSON.parse(audit.before_value),{username:'Player',credits:1000});
});
test('chip edits wait for the hand to finish, while username edits preserve live cards',async t=>{
  const {DB,user,get,edit}=await setup(t),id=user.data.user.id,g=soloGame(get(id));
  g.phase='playing';g.hands=[{cards:[{rank:'10',suit:'♠',id:'a'},{rank:'7',suit:'♥',id:'b'}],bet:25,done:false}];g.dealer=[{rank:'6',suit:'♣',id:'c'},{rank:'K',suit:'♦',id:'d'}];
  DB.sqlite.prepare('UPDATE accounts SET solo_state=? WHERE id=?').run(serialize(g),id);
  assert.equal((await edit(id,{credits:55})).status,409);assert.equal(get(id).chips,2000);
  assert.equal((await edit(id,{username:'In_Hand'})).status,200);assert.deepEqual(JSON.parse(get(id).solo_state).hands,g.hands);
});
test('friend edits update the shared wallet, clear readiness and prevent stale or partial writes',async t=>{
  const {DB,owner,user,get,edit}=await setup(t),id=user.data.user.id;
  await user.act(null,{minimum:25},'/api/rooms/create');const code=user.data.room.code;
  await owner.act(null,{code},'/api/rooms/join');await user.call('/api/me');await user.act('ready',{bet:100},'/api/rooms/action');
  const changed=await edit(id,{username:'Friend_Renamed',credits:70.5});assert.equal(changed.status,200);
  await user.call('/api/me');assert.equal(user.data.user.bankroll,70.5);assert.equal(user.data.table.state.bankroll,70.5);assert.equal(user.data.table.state.ready,false);
  await owner.call('/api/me');assert.equal(owner.data.table.state.otherPlayers[0].name,'Friend_Renamed');
  const before=DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),revision=get(id).revision;
  assert.equal((await edit(id,{credits:10},{revision:revision-1})).status,409);
  const batch=DB.batch;DB.batch=async statements=>{DB.sqlite.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').run(id);return batch(statements);};
  assert.equal((await edit(id,{credits:20,username:'ShouldRollback'})).status,409);DB.batch=batch;
  assert.equal(get(id).chips,141);assert.equal(get(id).username,'Friend_Renamed');assert.equal(DB.sqlite.prepare('SELECT state FROM rooms WHERE code=?').get(code).state,before.state);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit WHERE target_id=?').get(id).n,1);
  const roomGame=FriendGame.load(before.state);roomGame.phase='playing';DB.sqlite.prepare('UPDATE rooms SET state=? WHERE code=?').run(serialize(roomGame),code);
  assert.equal((await edit(id,{credits:99})).status,409);
});
test('password resets revoke every session, never expose hashes, and block a login verified before the reset',async t=>{
  const {DB,env,owner,user,get,edit}=await setup(t),id=user.data.user.id;
  const oldHash=await hashPassword('old password phrase 123');DB.sqlite.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(oldHash,id);
  const other=client(env);assert.equal((await other.call('/api/login',{username:'Player',password:'old password phrase 123'})).status,200);
  const changed=await edit(id,{password:'new password phrase 456'});assert.equal(changed.status,200);
  assert.equal(await verifyPassword('new password phrase 456',get(id).password_hash),true);
  assert.equal((await user.call('/api/me')).status,401);assert.equal((await other.call('/api/me')).status,401);
  assert.doesNotMatch(JSON.stringify(changed.data),/scrypt:|new password|old password|password_hash/);
  assert.doesNotMatch(JSON.stringify(DB.sqlite.prepare('SELECT * FROM admin_audit').all()),/scrypt:|new password|old password/);
  await assert.rejects(newSession(DB,id,oldHash),error=>error.status===401);
  assert.equal((await other.call('/api/login',{username:'Player',password:'old password phrase 123'})).status,401);
  assert.equal((await other.call('/api/login',{username:'Player',password:'new password phrase 456'})).status,200);
  const own=await edit(env.ADMIN_ACCOUNT_ID,{password:'owner new password 789'});assert.equal(own.data.signedOut,true);assert.equal((await owner.call('/api/admin/users')).status,401);
});
test('guest conversion requires a password, repeated saves are idempotent, and user search paginates',async t=>{
  const {DB,owner,add,get,edit}=await setup(t),guest=await add(null),id=guest.data.user.id;
  assert.equal((await edit(id,{username:'Converted'})).status,400);assert.equal((await edit(id,{password:'guest password 123'})).status,400);
  const requestId=crypto.randomUUID(),revision=get(id).revision;
  assert.equal((await edit(id,{username:'Converted',password:'guest password 123',credits:42.5},{requestId,revision})).status,200);
  assert.equal((await edit(id,{username:'Converted',password:'guest password 123',credits:42.5},{requestId,revision})).status,200);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit WHERE target_id=?').get(id).n,1);
  for(let i=0;i<30;i++)DB.sqlite.prepare('INSERT INTO accounts (id,chips,created_at) VALUES (?,2000,?)').run(`guest-${i}`,Date.now()+i);
  const first=await owner.call('/api/admin/users?kind=guest'),second=await owner.call('/api/admin/users?kind=guest&offset=25');
  assert.equal(first.data.users.length,25);assert.equal(first.data.hasMore,true);assert.equal(second.data.users.length,5);assert.equal(second.data.hasMore,false);
  const match=await owner.call('/api/admin/users?q=CONVERT');assert.equal(match.data.users.length,1);assert.equal(match.data.users[0].username,'Converted');
});

test('user deletion requires the owner, matching account confirmation, current revision, and same origin; the owner is protected',async t=>{
  const {env,owner,user,add,get,remove}=await setup(t),id=user.data.user.id,guest=await add(null);
  assert.equal((await remove(id,{},client(env))).status,401);
  assert.equal((await remove(id,{},user)).status,403);
  assert.equal((await remove(id,{},guest)).status,403);
  assert.equal((await remove(env.ADMIN_ACCOUNT_ID)).status,403);
  assert.equal((await remove(id,{confirmation:env.ADMIN_ACCOUNT_ID})).status,400);
  assert.equal((await remove(id,{accountId:id})).status,409);
  assert.equal((await remove(id,{revision:-1})).status,409);
  assert.equal((await owner.call(`/api/admin/users/${id}/delete`)).status,405);
  assert.equal((await owner.call(`/api/admin/users/${id}/delete`,{accountId:env.ADMIN_ACCOUNT_ID,revision:get(id).revision,requestId:crypto.randomUUID(),confirmation:id},{origin:'https://attacker.example'})).status,403);
  assert.ok(get(id));assert.equal((await owner.call('/api/admin/access')).data.allowed,true);
});

test('deletion removes credentials, every session, audits and user limits without affecting other users; retries cannot delete a replacement account',async t=>{
  const {DB,env,owner,user,add,get,edit,remove}=await setup(t),id=user.data.user.id;
  await edit(id,{username:'Deleted_Player',credits:123.5,password:'disposable account password 123'});
  const hash=get(id).password_hash;await newSession(DB,id,hash);await newSession(DB,id,hash);
  for(const key of [`play:${id}`,`rooms:${id}`,'auth-user:deleted_player','auth-user:owner'])DB.sqlite.prepare('INSERT INTO rate_limits (key,count,expires) VALUES (?,1,?)').run(key,Date.now()+60000);
  const before=get(env.ADMIN_ACCOUNT_ID),revision=get(id).revision,requestId=crypto.randomUUID();
  const deleted=await remove(id,{revision,requestId});assert.equal(deleted.status,200);assert.deepEqual(deleted.data,{deleted:true,id});
  assert.equal(get(id),undefined);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(id).n,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit WHERE target_id=? OR actor_id=?').get(id,id).n,0);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM rate_limits WHERE key IN (?,?,?)').get(`play:${id}`,`rooms:${id}`,'auth-user:deleted_player').n,0);
  assert.ok(DB.sqlite.prepare('SELECT key FROM rate_limits WHERE key=?').get('auth-user:owner'));
  assert.deepEqual(get(env.ADMIN_ACCOUNT_ID),before);await assert.rejects(newSession(DB,id,hash),error=>error.status===401);
  assert.equal((await user.call('/api/me')).status,401);assert.equal((await owner.call(`/api/admin/users/${id}`)).status,404);
  assert.equal((await client(env).call('/api/login',{username:'Deleted_Player',password:'disposable account password 123'})).status,401);
  const replacement=await add('Deleted_Player');assert.notEqual(replacement.data.user.id,id);
  assert.equal((await remove(id,{revision,requestId})).status,200);assert.ok(get(replacement.data.user.id));
  const guest=await add(null);assert.equal((await remove(guest.data.user.id)).status,200);assert.equal(get(guest.data.user.id),undefined);
});

test('deleting a friend-table host transfers hosting and deleting the last seat removes the table',async t=>{
  const {DB,env,owner,user,get,remove}=await setup(t),id=user.data.user.id;
  await user.act(null,{minimum:25},'/api/rooms/create');const code=user.data.room.code;
  await owner.act(null,{code},'/api/rooms/join');
  assert.equal((await remove(id)).status,200);
  const room=DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),state=JSON.parse(room.state);
  assert.equal(room.host_id,env.ADMIN_ACCOUNT_ID);assert.deepEqual(state.players.map(p=>p.id),[env.ADMIN_ACCOUNT_ID]);assert.equal(state.lastFrames,undefined);
  assert.equal((await owner.call('/api/me')).data.room.isHost,true);assert.equal(get(env.ADMIN_ACCOUNT_ID).chips,2000);
  const lone=client(env);await lone.call('/api/guest',{});DB.sqlite.prepare('UPDATE accounts SET username=?,username_key=? WHERE id=?').run('Lone','lone',lone.data.user.id);
  await lone.call('/api/me');await lone.act(null,{minimum:10},'/api/rooms/create');const emptyCode=lone.data.room.code;
  assert.equal((await remove(lone.data.user.id)).status,200);assert.equal(DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(emptyCode),undefined);
});

test('deleting a player during a hand preserves another live turn or settles remaining hands with correct payouts',async t=>{
  for(const deleteActing of [false,true]){
    const {DB,env,owner,user,get,remove}=await setup(t),id=user.data.user.id,ownerId=env.ADMIN_ACCOUNT_ID,code='ABCDEFGH';
    const card=(rank,n)=>({rank,suit:'♠',id:`card-${n}`});
    const game=new FriendGame({shoe:[card('K',7)]});game.add(get(ownerId));game.add(get(id));
    game.phase='playing';game.dealer=[card('6',5),card('10',6)];game.actingSeat=deleteActing?id:ownerId;game.deadline=Date.now()+30000;
    game.runningCount=1;game.seenCount=5;
    game.players[0].hands=[{cards:[card('9',1),card('8',2)],bet:25,done:deleteActing}];
    game.players[1].hands=[{cards:[card('10',3),card('5',4)],bet:25,done:false}];
    for(const p of game.players){p.bankroll=975;p.roundStart=1000;}
    const deadline=game.deadline,ownerCards=structuredClone(game.players[0].hands[0].cards);
    DB.sqlite.prepare('INSERT INTO rooms (code,host_id,state,updated_at) VALUES (?,?,?,?)').run(code,id,serialize(game),Date.now());
    for(const p of game.players)DB.sqlite.prepare('UPDATE accounts SET active_room=?,chips=1950,revision=revision+1 WHERE id=?').run(code,p.id);
    assert.equal((await remove(id)).status,200);const row=DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),state=JSON.parse(row.state);
    assert.equal(row.host_id,ownerId);assert.equal(state.players.length,1);assert.deepEqual(state.players[0].hands[0].cards,ownerCards);
    if(deleteActing){assert.equal(state.phase,'settled');assert.equal(state.players[0].bankroll,1025);assert.equal(get(ownerId).chips,2050);assert.equal(state.seenCount,7);assert.equal(state.runningCount,-1);}
    else{assert.equal(state.phase,'playing');assert.equal(state.actingSeat,ownerId);assert.equal(state.deadline,deadline);await owner.call('/api/me');assert.equal((await owner.act('stand',{},'/api/rooms/action')).status,200);assert.equal(get(ownerId).chips,2050);}
    assert.equal((await owner.call('/api/me')).status,200);
  }
});

test('a deletion conflict rolls back table, wallets, audit removal and session revocation together',async t=>{
  const {DB,env,owner,user,get,edit,remove}=await setup(t),id=user.data.user.id;
  await user.act(null,{minimum:25},'/api/rooms/create');const code=user.data.room.code;await owner.act(null,{code},'/api/rooms/join');
  await edit(id,{username:'Delete_Test'});
  const before=get(id),roomBefore=DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),batch=DB.batch;
  DB.batch=async statements=>{DB.sqlite.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').run(env.ADMIN_ACCOUNT_ID);return batch(statements);};
  assert.equal((await remove(id)).status,409);DB.batch=batch;
  assert.deepEqual(get(id),before);assert.deepEqual(DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),roomBefore);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM admin_audit WHERE target_id=?').get(id).n,1);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(id).n,1);
  assert.equal((await user.call('/api/me')).status,200);assert.equal((await remove(id)).status,200);
});
