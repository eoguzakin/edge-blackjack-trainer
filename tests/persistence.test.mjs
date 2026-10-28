import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {localDatabase} from '../scripts/local-db.mjs';
import {atomic,statement} from '../src/storage.js';
import {FriendGame} from '../src/friend-game.js';
import {createShoe,hiLo} from '../web/game.js';

const origin='https://edge.example';
function client(DB){return {cookie:'',data:null,async call(path,body,opts={}){
  const request=new Request(origin+path,{method:body?'POST':'GET',headers:{cookie:this.cookie,origin, ...(body?{'Content-Type':'application/json'}:{}),...opts.headers},...(body?{body:JSON.stringify(body)}:{})});
  const response=await worker.fetch(request,{DB});const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0];
  const data=await response.json();if(data.table)this.data=data;return {status:response.status,data,cookie};
},async act(action,extra={},path){return this.call(path||(this.data.room?'/api/rooms/action':'/api/solo'),{action,accountId:this.data.user.id,revision:this.data.revision,requestId:crypto.randomUUID(),...extra});}};}
async function player(DB,name){const c=client(DB);assert.equal((await c.call('/api/guest',{})).status,201);const id=DB.sqlite.prepare('SELECT user_id FROM sessions ORDER BY rowid DESC LIMIT 1').get().user_id;DB.sqlite.prepare('UPDATE accounts SET username=?,username_key=? WHERE id=?').run(name,name.toLowerCase(),id);await c.call('/api/me');return c;}
async function finish(c){for(let i=0;c.data.table.state.phase==='playing'&&i<30;i++){const result=await c.act('stand');assert.equal(result.status,200);}}

test('guest balance and unfinished hand survive a new browser session; above-100 bets work',async t=>{
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const c=client(DB);
  const first=await c.call('/api/guest',{});assert.equal(first.status,201);assert.match(first.cookie,/HttpOnly/);assert.match(first.cookie,/Secure/);assert.match(first.cookie,/Max-Age=31536000/);
  assert.equal((await c.act('deal',{bet:175})).status,200);const before=c.data;
  const reopened=client(DB);reopened.cookie=c.cookie;assert.equal((await reopened.call('/api/me')).status,200);
  assert.deepEqual(reopened.data.table.state,before.table.state);assert.equal(reopened.data.user.bankroll,before.user.bankroll);
  await finish(reopened);const funds=reopened.data.user.bankroll;await reopened.act('mode',{mode:'full'});assert.equal(reopened.data.user.bankroll,funds);
  assert.equal((await reopened.act('deal',{bet:Math.floor(funds)+1})).status,400);assert.equal((await reopened.call('/api/me')).data.user.bankroll,funds);
  assert.equal((await reopened.act('deal',{bet:1.5})).status,400);
});
test('account creation retains guest chips; password login restores the same wallet',async t=>{
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const c=client(DB);await c.call('/api/guest',{});await c.act('deal',{bet:125});await finish(c);const funds=c.data.user.bankroll;
  const registered=await c.call('/api/register',{username:'Player_One',password:'test passphrase 4729'});assert.equal(registered.status,201);assert.equal(registered.data.user.bankroll,funds);
  const row=DB.sqlite.prepare('SELECT * FROM accounts').get();assert.ok(!row.password_hash.includes('test passphrase'));assert.match(row.password_hash,/^scrypt:32768:8:3:/);
  const other=client(DB);assert.equal((await other.call('/api/login',{username:'player_one',password:'wrong passphrase 4729'})).status,401);
  assert.equal((await other.call('/api/login',{username:'PLAYER_ONE',password:'test passphrase 4729'})).status,200);assert.equal(other.data.user.bankroll,funds);
  assert.equal((await other.call('/api/solo',{action:'deal',bet:5,revision:other.data.revision,requestId:crypto.randomUUID()},{headers:{origin:'https://attacker.example'}})).status,403);
  await other.call('/api/logout',{});assert.equal((await other.call('/api/me')).status,401);
});
test('room invitations, minimum bets, shared wallets, stale actions, and host transfer',async t=>{
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const host=await player(DB,'Host'),friend=await player(DB,'Friend'),stranger=await player(DB,'Stranger');
  assert.equal((await host.act(null,{minimum:25},'/api/rooms/create')).status,200);const invite=host.data.room.code;assert.match(invite,/^[A-Z2-9]{8}$/);
  assert.equal((await friend.act(null,{code:invite},'/api/rooms/join')).status,200);await host.call('/api/me');
  assert.equal((await stranger.act('stand',{},'/api/rooms/action')).status,409);
  assert.equal((await host.act('ready',{bet:24})).status,400);assert.equal((await host.act('ready',{bet:175})).status,200);
  await friend.call('/api/me');assert.equal((await friend.act('ready',{bet:260})).status,200);await host.call('/api/me');
  const deal={action:'deal',accountId:host.data.user.id,revision:host.data.revision,requestId:crypto.randomUUID()};assert.equal((await host.call('/api/rooms/action',deal)).status,200);
  const dealt=host.data,duplicate=await host.call('/api/rooms/action',deal);assert.equal(duplicate.status,200);assert.equal(duplicate.data.user.bankroll,dealt.user.bankroll);
  assert.equal((await host.call('/api/rooms/action',{...deal,requestId:crypto.randomUUID()})).status,409);
  if(!dealt.table.state.dealerRevealed)assert.deepEqual(dealt.table.state.dealer[1],{id:'hole'});
  for(const frame of dealt.table.frames)if(!frame.state.dealerRevealed&&frame.state.dealer.length===2)assert.deepEqual(frame.state.dealer[1],{id:'hole'});
  for(let i=0;i<20;i++){
    await host.call('/api/me');await friend.call('/api/me');if(host.data.table.state.phase==='settled')break;
    const current=host.data.table.actions.length?host:friend,waiting=current===host?friend:host;
    assert.equal((await waiting.act('hit')).status,400);assert.equal((await current.act('stand')).status,200);
  }
  await host.call('/api/me');await friend.call('/api/me');assert.equal(host.data.table.state.phase,'settled');
  const hostChips=host.data.user.bankroll,friendChips=friend.data.user.bankroll;
  assert.equal((await host.act('leave')).status,200);assert.equal(host.data.room,null);assert.equal(host.data.user.bankroll,hostChips);
  await friend.call('/api/me');assert.equal(friend.data.room.isHost,true);assert.equal((await friend.act('leave')).status,200);assert.equal(friend.data.user.bankroll,friendChips);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM rooms').get().n,0);
});
test('concurrent writes and failed room transfers roll back without losing or duplicating chips',async t=>{
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const c=await player(DB,'CAS');const data=c.data;
  const requests=await Promise.all([125,250].map(bet=>c.call('/api/solo',{action:'deal',bet,accountId:data.user.id,revision:data.revision,requestId:crypto.randomUUID()})));
  assert.deepEqual(requests.map(r=>r.status).sort(),[200,409]);
  const row=DB.sqlite.prepare('SELECT * FROM accounts').get(),chips=row.chips;
  await assert.rejects(atomic(DB,[statement(DB,'UPDATE accounts SET chips=0 WHERE id=?',row.id),statement(DB,'UPDATE rooms SET revision=revision+1 WHERE code=?','MISSING')]),e=>e.status===409);
  assert.equal(DB.sqlite.prepare('SELECT chips FROM accounts').get().chips,chips);assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM write_checks').get().n,0);
  const unrelated=await player(DB,'OtherAccount');c.cookie=unrelated.cookie;
  assert.equal((await c.call('/api/solo',{action:'deal',bet:125,accountId:row.id,revision:unrelated.data.revision,requestId:crypto.randomUUID()})).status,409);
  assert.equal((await unrelated.call('/api/me')).data.user.bankroll,1000);
});
test('expired friend turns auto-stand after a disconnection',async t=>{
  const DB=localDatabase();t.after(()=>DB.sqlite.close());const host=await player(DB,'Timer'),friend=await player(DB,'Away');await host.act(null,{minimum:10},'/api/rooms/create');await friend.act(null,{code:host.data.room.code},'/api/rooms/join');await host.call('/api/me');await host.act('ready',{bet:10});await friend.call('/api/me');await friend.act('ready',{bet:10});await host.call('/api/me');
  const row=DB.sqlite.prepare('SELECT * FROM rooms').get(),g=FriendGame.load(row.state),shoe=createShoe();
  const ranks=[10,10,6,7,8,10,5];shoe.splice(-ranks.length,ranks.length,...ranks.map((rank,i)=>({rank:String(rank),suit:'♠',id:`time-${i}`})).reverse());g.shoe=shoe;g.deal(Date.now()-300000);g.lastFrames=g.frames;
  DB.sqlite.prepare('UPDATE rooms SET state=? WHERE code=?').run(JSON.stringify({...g,random:undefined,frames:undefined}),row.code);
  const response=await friend.call('/api/me');assert.equal(response.status,200);assert.equal(response.data.table.state.phase,'settled');assert.equal(response.data.user.bankroll,990);
});
test('500 shared-table rounds preserve shoe counts, turn order, wager coverage, and payouts',()=>{
  let seed=3712;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
  const g=new FriendGame({random});for(let i=0;i<5;i++)g.add({id:`p${i}`,username:`P${i}`,chips:2000000});
  for(let round=0;round<500;round++){
    for(const p of g.players)g.ready(p.id,125+round%7);g.deal();let actions=0;
    while(g.phase==='playing'){assert.ok(++actions<60);g.act(g.actingSeat,g.recommendation(g.actingSeat));}
    assert.equal(g.phase,'settled');assert.equal(g.shoe.length+g.seenCount,312);
    const known=createShoe().filter(card=>!g.shoe.some(c=>c.id===card.id));assert.equal(known.reduce((sum,c)=>sum+hiLo(c),0),g.runningCount);
    for(const p of g.players){assert.ok(p.bankroll>=0);assert.equal(p.bankroll,p.roundStart+p.hands.reduce((sum,h)=>sum+h.net,0));assert.ok(p.hands.length<=4);}
  }
});
