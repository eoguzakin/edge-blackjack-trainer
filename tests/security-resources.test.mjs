import test from 'node:test';
import assert from 'node:assert/strict';
import worker,* as workerModule from '../src/worker.js';
import {localDatabase} from '../scripts/local-db.mjs';
import {rateLimit} from '../src/storage.js';
import {newSession} from '../src/auth.js';
import {soloGame,serialize,FriendGame} from '../src/friend-game.js';
import {Session} from '../web/session.js';

const origin='https://edge.example';
function setup(t){
  const DB=localDatabase();t.after(()=>DB.sqlite.close());
  const app=workerModule.createWorker?.()||worker;
  const call=(path,{body,cookie='',headers={},method=body===undefined?'GET':'POST'}={})=>app.fetch(new Request(origin+path,{method,headers:{origin,cookie,...(body===undefined?{}:{'content-type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),{DB});
  return {DB,app,call};
}
async function guest(call){const response=await call('/api/guest',{body:{}});assert.equal(response.status,201);return {cookie:response.headers.get('set-cookie').split(';')[0],data:await response.json()};}
const changes=DB=>DB.sqlite.prepare('SELECT total_changes() AS n').get().n;

test('Worker cancels an oversized body stream before consuming its remaining chunks',async t=>{
  const {app,DB,call}=setup(t);assert.equal((await call('/api/guest',{body:{}})).status,201);
  let pulls=0,canceled=false;
  const stream=new ReadableStream({pull(controller){if(++pulls===1)controller.enqueue(new Uint8Array(9000).fill(32));else controller.error(new Error('read past the body limit'));},cancel(){canceled=true;}},{highWaterMark:0});
  const response=await app.fetch(new Request(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:stream,duplex:'half'}),{DB});
  assert.equal(response.status,413);assert.equal(pulls,1);assert.equal(canceled,true);
});

test('saturated rate limits perform no further persistent writes',async t=>{
  const {DB}=setup(t);await rateLimit(DB,'security-test',2,60000);await rateLimit(DB,'security-test',2,60000);const before=changes(DB);
  for(let i=0;i<5;i++)await assert.rejects(rateLimit(DB,'security-test',2,60000),error=>error.status===429);
  assert.equal(DB.sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get('security-test').count,2);
  assert.equal(changes(DB),before);
});

test('snapshot aliases and separate sessions share an authoritative account quota',async t=>{
  const {DB,call}=setup(t),g=await guest(call),id=g.data.user.id;
  // Keep the reproduction focused on admission rather than repeated initial shuffles.
  const row=DB.sqlite.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  DB.sqlite.prepare('UPDATE accounts SET solo_state=? WHERE id=?').run(serialize(soloGame(row)),id);
  for(let i=0;i<120;i++)assert.equal((await call('/api/me',{cookie:g.cookie})).status,200);
  const before=changes(DB);assert.equal((await call('/api/me',{cookie:g.cookie})).status,429);
  assert.equal((await call('/api/guest',{cookie:g.cookie,body:{}})).status,429);assert.equal(changes(DB),before);
  const token=await newSession(DB,id),second=workerModule.createWorker?.()||worker;
  const response=await second.fetch(new Request(origin+'/api/me',{headers:{origin,cookie:`edge_session=${token}`,'cf-connecting-ip':'203.0.113.22'}}),{DB:{...DB}});
  assert.equal(response.status,429);
});

test('new and legacy untouched solo accounts persist their initial shoe once',async t=>{
  const {DB,call}=setup(t),g=await guest(call),id=g.data.user.id;
  const saved=()=>DB.sqlite.prepare('SELECT solo_state FROM accounts WHERE id=?').get(id).solo_state;
  assert.ok(saved());const initial=saved();assert.equal((await call('/api/me',{cookie:g.cookie})).status,200);assert.equal(saved(),initial);
  DB.sqlite.prepare('UPDATE accounts SET solo_state=NULL WHERE id=?').run(id);
  assert.equal((await call('/api/me',{cookie:g.cookie})).status,200);assert.ok(saved());const legacy=saved();
  assert.equal((await call('/api/me',{cookie:g.cookie})).status,200);assert.equal(saved(),legacy);
});

test('JSON bodies are limited by streamed bytes, including multibyte and misleading length headers',async t=>{
  const {app,DB}=setup(t);
  const send=(body,headers={})=>app.fetch(new Request(origin+'/api/guest',{method:'POST',headers:{origin,'content-type':'application/json',...headers},body}),{DB});
  assert.equal((await send('{"padding":"'+'a'.repeat(8178)+'"}')).status,201); // exactly 8192 bytes
  assert.equal((await send('{"padding":"'+'a'.repeat(8179)+'"}')).status,413);
  assert.equal((await send(JSON.stringify({padding:'é'.repeat(5000)}),{'content-length':'2'})).status,413);
  assert.equal((await send('{}',{'content-length':'8193'})).status,413);
  for(const body of ['null','[]','{',new Uint8Array([123,34,120,34,58,34,255,34,125])])assert.equal((await send(body)).status,400);
  assert.equal((await send('{}',{origin:'https://other.example'})).status,403);
  assert.equal((await send('{}',{'content-type':'text/plain'})).status,415);
});

test('shared limits are atomic, survive cold caches, and reset at the exact expiry',async t=>{
  const {DB}=setup(t);let now=100000;t.mock.method(Date,'now',()=>now);
  const copies=Array.from({length:20},()=>({...DB}));
  const results=await Promise.allSettled(copies.map(db=>rateLimit(db,'shared',5,60000)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
  assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===429));
  const before=changes(DB);
  await assert.rejects(rateLimit({...DB},'shared',5,60000),e=>e.status===429&&e.retryAfter===60);
  assert.equal(changes(DB),before);
  now+=59999;await assert.rejects(rateLimit(DB,'shared',5,60000),e=>e.status===429&&e.retryAfter===1);
  now++;await rateLimit(DB,'shared',5,60000);
  assert.equal(DB.sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get('shared').count,1);
});

test('blocked caches preserve different admin limits and separate databases',async t=>{
  const {DB}=setup(t),other=localDatabase();t.after(()=>other.sqlite.close());
  for(let i=0;i<30;i++)await rateLimit(DB,'admin:owner',30,60000);
  await assert.rejects(rateLimit(DB,'admin:owner',30,60000),e=>e.status===429);
  await rateLimit(DB,'admin:owner',120,60000);
  await rateLimit(other,'admin:owner',30,60000);
  assert.equal(DB.sqlite.prepare('SELECT count FROM rate_limits').get().count,31);
  assert.equal(other.sqlite.prepare('SELECT count FROM rate_limits').get().count,1);
});

test('anonymous authentication and authenticated action floods stop writing after saturation',async t=>{
  const {DB,call}=setup(t);
  for(let i=0;i<30;i++)assert.equal((await call('/api/guest',{body:{}})).status,201);
  let before=changes(DB);
  for(let i=0;i<5;i++)assert.equal((await call('/api/guest',{body:{}})).status,429);
  assert.equal(changes(DB),before);
  const g=await guest((path,options)=>call(path,{...options,headers:{'cf-connecting-ip':'203.0.113.99'}}));
  for(let i=0;i<100;i++)assert.equal((await call('/api/solo',{body:{},cookie:g.cookie})).status,400);
  before=changes(DB);
  for(let i=0;i<5;i++)assert.equal((await call('/api/solo',{body:{},cookie:g.cookie})).status,429);
  assert.equal(changes(DB),before);assert.equal(DB.sqlite.prepare('SELECT count FROM rate_limits WHERE key=?').get('play:'+g.data.user.id).count,100);
});

test('API ingress rejects a flood before database access and leaves static assets available',async t=>{
  const {DB,app}=setup(t);let queries=0;const prepare=DB.prepare;DB.prepare=(...args)=>{queries++;return prepare(...args);};
  const request=(ip='203.0.113.1')=>new Request(origin+'/api/unknown',{headers:{cookie:`edge_session=${'a'.repeat(64)}`,'cf-connecting-ip':ip}});
  for(let i=0;i<600;i++)assert.equal((await app.fetch(request(),{DB})).status,401);
  assert.equal(queries,600);const response=await app.fetch(request(),{DB});assert.equal(response.status,429);assert.equal(queries,600);assert.ok(Number(response.headers.get('retry-after'))>0);
  const assets={fetch:async()=>new Response('asset')};assert.equal((await app.fetch(new Request(origin+'/assets/card.svg'),{DB,ASSETS:assets})).status,200);
  // A separate isolate still has an aggregate bound when a caller rotates IPs.
  const second=workerModule.createWorker();
  for(let i=0;i<2400;i++)assert.equal((await second.fetch(request('ip-'+i),{DB})).status,401);
  const before=queries;assert.equal((await second.fetch(request('new-ip'),{DB})).status,429);assert.equal(queries,before);
});

test('rotating tokens and IPs cannot evict active ingress buckets to escape the guard',async t=>{
  const {DB,app}=setup(t);let queries=0;const prepare=DB.prepare;DB.prepare=(...args)=>{queries++;return prepare(...args);};
  let rejected=0;
  for(let i=0;i<2500;i++){
    const response=await app.fetch(new Request(origin+'/api/me',{headers:{cookie:`edge_session=${i.toString(16).padStart(64,'0')}`,'cf-connecting-ip':'ip-'+i}}),{DB});
    if(response.status===429)rejected++;else assert.equal(response.status,401);
  }
  assert.ok(rejected>0);const before=queries;
  assert.equal((await app.fetch(new Request(origin+'/api/me',{headers:{cookie:`edge_session=${'f'.repeat(64)}`,'cf-connecting-ip':'another-ip'}}),{DB})).status,429);assert.equal(queries,before);
});

test('conditional solo reads follow revisions and identity and never cache session authorization',async t=>{
  const {DB,call}=setup(t),g=await guest(call),tag=g.data;
  let response=await call('/api/me',{cookie:g.cookie});const etag=response.headers.get('etag');assert.ok(etag);
  response=await call('/api/me',{cookie:g.cookie,headers:{'if-none-match':etag}});assert.equal(response.status,304);assert.equal(await response.text(),'');
  DB.sqlite.prepare('UPDATE accounts SET chips=chips+1,revision=revision+1 WHERE id=?').run(tag.user.id);
  response=await call('/api/me',{cookie:g.cookie,headers:{'if-none-match':etag}});assert.equal(response.status,200);assert.notEqual(response.headers.get('etag'),etag);
  const other=await guest(call);assert.equal((await call('/api/me',{cookie:other.cookie,headers:{'if-none-match':etag}})).status,200);
  assert.equal((await call('/api/logout',{cookie:g.cookie,body:{}})).status,200);
  assert.equal((await call('/api/me',{cookie:g.cookie,headers:{'if-none-match':etag}})).status,401);
});

test('unchanged friend polls skip projection, preserve membership checks, and advance expired turns',async t=>{
  const {DB,call}=setup(t),host=await guest(call),friend=await guest(call),code='ABCDEFGH';
  const account=id=>DB.sqlite.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  const game=new FriendGame();for(const g of [host,friend]){DB.sqlite.prepare('UPDATE accounts SET username=?,active_room=?,revision=1 WHERE id=?').run('P'+g.data.user.id.slice(0,5),code,g.data.user.id);game.add(account(g.data.user.id));game.ready(g.data.user.id,10);}
  const ranks=[10,10,6,7,8,10,5];game.shoe.splice(-ranks.length,ranks.length,...ranks.map((rank,i)=>({rank:String(rank),suit:'♠',id:'timeout-'+i})).reverse());
  let now=Date.now();t.mock.method(Date,'now',()=>now);game.deal(now);game.lastFrames=game.frames;assert.equal(game.phase,'playing');
  DB.sqlite.prepare('INSERT INTO rooms (code,host_id,state,updated_at) VALUES (?,?,?,?)').run(code,host.data.user.id,serialize(game),now);
  let response=await call('/api/me',{cookie:host.cookie});const etag=response.headers.get('etag');assert.equal(response.status,200);
  const original=FriendGame.prototype.public;let projections=0;t.mock.method(FriendGame.prototype,'public',function(...args){projections++;return original.apply(this,args);});
  for(let i=0;i<40;i++)assert.equal((await call('/api/me',{cookie:host.cookie,headers:{'if-none-match':etag}})).status,304);
  assert.equal(projections,0);
  now+=300000;response=await call('/api/me',{cookie:host.cookie,headers:{'if-none-match':etag}});assert.equal(response.status,200);assert.equal((await response.json()).table.state.phase,'settled');assert.notEqual(response.headers.get('etag'),etag);
  const row=DB.sqlite.prepare('SELECT * FROM rooms WHERE code=?').get(code),changed=FriendGame.load(row.state);changed.players=changed.players.filter(p=>p.id!==host.data.user.id);
  DB.sqlite.prepare('UPDATE rooms SET state=? WHERE code=?').run(serialize(changed),code);
  assert.equal((await call('/api/me',{cookie:host.cookie,headers:{'if-none-match':response.headers.get('etag')}})).status,403);
});

test('browser polling handles empty 304s, clears tags on writes, and exposes retry delays',async t=>{
  const api=new Session(),payload={user:{id:'player',revision:0},revision:0,room:null,table:{state:{}}};let step=0;
  t.mock.method(globalThis,'fetch',async(path,options)=>{
    step++;
    if(step===1)return new Response(JSON.stringify(payload),{headers:{etag:'"initial"'}});
    if(step===2){assert.equal(options.headers['If-None-Match'],'"initial"');return new Response(null,{status:304});}
    if(step===3){assert.equal(options.method,'POST');return new Response('{"ok":true}');}
    assert.equal(options.headers['If-None-Match'],undefined);return new Response('{"error":"Wait","retryAfter":12}',{status:429,headers:{'Retry-After':'12'}});
  });
  api.data=await api.request('/api/me');assert.deepEqual(await api.request('/api/me',undefined,{conditional:true}),payload);
  await api.request('/api/logout',{});assert.equal(api.snapshot,null);
  await assert.rejects(api.request('/api/me',undefined,{conditional:true}),e=>e.status===429&&e.retryAfter===12);
});

test('a delayed conditional response cannot restore state from before a browser mutation',async t=>{
  const api=new Session(),initial={user:{id:'player',revision:0},revision:0,room:null,table:{state:{}}},updated={...initial,user:{id:'player',revision:1},revision:1};let resolvePoll;
  api.data=initial;api.snapshot={etag:'"old"',data:initial};
  t.mock.method(globalThis,'fetch',async(path,options)=>options.method==='POST'?new Response(JSON.stringify(updated),{headers:{etag:'"new"'}}):new Promise(resolve=>resolvePoll=resolve));
  const polling=api.request('/api/me',undefined,{conditional:true});api.data=await api.request('/api/solo',{});
  resolvePoll(new Response(null,{status:304}));assert.equal(await polling,api.data);assert.equal(api.snapshot.etag,'"new"');
});
