import {BlackjackGame} from '../web/game.js';
import {FriendGame,secureRandom,serialize,soloGame,soloView} from './friend-game.js';
import {HttpError,statement,atomic,rateLimit,fail} from './storage.js';
import {credentials,hashPassword,verifyPassword,sessionAccount,newSession,sessionCookie,authLimit} from './auth.js';
import {adminRequest} from './admin.js';
import {recoverOwner} from './owner-recovery.js';
import {createRequestAdmission} from './admission.js';

const accountView=a=>({id:a.id,username:a.username,guest:!a.username,bankroll:a.chips/2,revision:a.revision});
const between=g=>['ready','settled'].includes(g.phase);
const codePattern=/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
function code(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from(crypto.getRandomValues(new Uint8Array(8)),v=>alphabet[v%alphabet.length]).join('');}
const tableTag=(user,room)=>`"edge:${user.id}:${user.revision}:${room?.code||'solo'}:${room?.revision??user.revision}"`;
function json(value,status=200,cookie,extra={}){const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra};if(value?.user&&value.table)headers.ETag=tableTag(value.user,value.room);if(cookie)headers['Set-Cookie']=cookie;return new Response(JSON.stringify(value),{status,headers});}
async function bodyOf(request){
  if(request.headers.get('origin')!==new URL(request.url).origin)fail(403,'Please open this table directly to continue.');
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail(415,'Use a JSON request.');
  if(Number(request.headers.get('content-length')||0)>8192)fail(413,'The request is too large.');
  const reader=request.body?.getReader(),bytes=new Uint8Array(8192);let size=0;
  if(reader)try{
    while(true){const {done,value}=await reader.read();if(done)break;if(size+value.byteLength>bytes.length){await reader.cancel().catch(()=>{});fail(413,'The request is too large.');}bytes.set(value,size);size+=value.byteLength;}
  }finally{reader.releaseLock();}
  try{const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));if(!body||Array.isArray(body)||typeof body!=='object')throw new Error();return body;}catch{fail(400,'The request could not be read.');}
}
function command(body){if(typeof body.requestId!=='string'||! /^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)||!Number.isInteger(body.revision))fail(400,'Refresh the table before trying again.');}
async function getAccount(db,id){return statement(db,'SELECT * FROM accounts WHERE id=?',id).first();}
async function getRoom(db,code){return statement(db,'SELECT * FROM rooms WHERE code=?',code).first();}
function roomView(row,g,id){return {code:row.code,host:g.players.find(p=>p.id===row.host_id)?.name,isHost:row.host_id===id,minimum:g.minimum,readyCount:g.players.filter(p=>p.ready).length,seats:g.players.length,deadline:g.deadline,revision:row.revision};}
function saveAccount(db,a,g,requestId){
  return statement(db,'UPDATE accounts SET chips=?,solo_state=?,revision=revision+1,last_request=? WHERE id=? AND revision=? AND active_room IS NULL',Math.round(g.bankroll*2),serialize(g),requestId,a.id,a.revision);
}
async function saveRoom(db,row,g,requestId,extra=[]){
  const writes=[statement(db,'UPDATE rooms SET state=?,revision=revision+1,updated_at=?,last_request=? WHERE code=? AND revision=?',serialize(g),Date.now(),requestId,row.code,row.revision)];
  for(const p of g.players)writes.push(statement(db,'UPDATE accounts SET chips=?,revision=revision+1 WHERE id=? AND active_room=?',Math.round(p.bankroll*2),p.id,row.code));
  writes.push(...extra);await atomic(db,writes);row.revision++;row.state=serialize(g);row.last_request=requestId;
}
async function tablePayload(db,a,{frames=true}={}){
  if(!a.active_room&&!a.solo_state){
    // Persist legacy untouched shoes once; never overwrite a concurrent game or room join.
    await statement(db,'UPDATE accounts SET solo_state=? WHERE id=? AND revision=? AND solo_state IS NULL AND active_room IS NULL',serialize(soloGame(a)),a.id,a.revision).run();
    a=await getAccount(db,a.id);if(!a)fail(401,'Your session expired. Please sign in again.');
    if(!a.active_room&&!a.solo_state)fail(409,'Your saved game changed. Please try again.');
  }
  if(a.active_room){
    const row=await getRoom(db,a.active_room);if(!row)fail(409,'This table is no longer available.');
    const g=FriendGame.load(row.state);if(!g.players.some(p=>p.id===a.id))fail(403,'You are not seated at this table.');
    if(g.phase==='playing'&&g.deadline&&g.deadline<=Date.now()){
      // Timeout advancement is a normal revision-checked transaction, even after everyone disconnects.
      const timeoutFrames=[];let steps=0;
      while(g.phase==='playing'&&g.deadline<=Date.now()&&steps++<20){g.act(g.actingSeat,'stand',g.deadline,true);timeoutFrames.push(...g.frames);}
      g.lastFrames=timeoutFrames;
      try{await saveRoom(db,row,g,`timeout-${crypto.randomUUID()}`);a=await getAccount(db,a.id);}catch(error){if(error.status===409)return tablePayload(db,await getAccount(db,a.id),{frames});throw error;}
    }
    const table=g.public(a.id);if(!frames)table.frames=[];
    return {user:accountView(a),revision:row.revision,room:roomView(row,g,a.id),table};
  }
  const g=soloGame(a),table=soloView(g);table.frames=[];
  return {user:accountView(a),revision:a.revision,room:null,table};
}
async function unchangedTable(request,db,a){
  const tag=request.headers.get('if-none-match');if(!tag)return null;
  let room=null;
  if(a.active_room){
    room=await statement(db,`SELECT code,revision,json_extract(state,'$.phase') AS phase,json_extract(state,'$.deadline') AS deadline,
      EXISTS (SELECT 1 FROM json_each(rooms.state,'$.players') AS seat WHERE json_extract(seat.value,'$.id')=?) AS member
      FROM rooms WHERE code=?`,a.id,a.active_room).first();
    if(!room)fail(409,'This table is no longer available.');if(!room.member)fail(403,'You are not seated at this table.');
    if(room.phase==='playing'&&room.deadline&&room.deadline<=Date.now())return null;
  }else if(!a.solo_state)return null;
  const current=tableTag(a,room);
  return tag===current?new Response(null,{status:304,headers:{ETag:current,'Cache-Control':'no-store'}}):null;
}

async function api(request,env){
  const db=env.DB;if(!db)fail(503,'Saved games are temporarily unavailable. Please try again shortly.');
  const path=new URL(request.url).pathname;
  if(path==='/api/maintenance/owner-recovery')return json(await recoverOwner(request,env));
  let a=await sessionAccount(request,db);
  if(path.startsWith('/api/admin/'))return json(await adminRequest(request,env,a,request.method==='POST'?await bodyOf(request):undefined));
  if(request.method==='GET'){
    if(!a)fail(401,'Sign in or start as a guest.');
    if(path==='/api/me'){await rateLimit(db,`read:${a.id}`,120,60000);return await unchangedTable(request,db,a)||json(await tablePayload(db,a));}
    fail(404,'Not found.');
  }
  if(request.method!=='POST')fail(405,'Method not allowed.');
  const b=await bodyOf(request);
  if(path==='/api/guest'){
    if(a){await rateLimit(db,`read:${a.id}`,120,60000);return json(await tablePayload(db,a));}
    await authLimit(request,db);
    const id=crypto.randomUUID();await statement(db,'INSERT INTO accounts (id,chips,solo_state,created_at) VALUES (?,2000,?,?)',id,serialize(soloGame({chips:2000})),Date.now()).run();
    const token=await newSession(db,id);a=await getAccount(db,id);
    return json(await tablePayload(db,a),201,sessionCookie(request,token));
  }
  if(path==='/api/login'){
    const c=credentials(b);await authLimit(request,db,c.key);
    const found=await statement(db,'SELECT * FROM accounts WHERE username_key=?',c.key).first();
    if(!await verifyPassword(c.password,found?.password_hash))fail(401,'Username or password is incorrect.');
    const token=await newSession(db,found.id,found.password_hash);
    if(a)await statement(db,'DELETE FROM sessions WHERE token_hash=?',a.token_hash).run();
    return json(await tablePayload(db,found),200,sessionCookie(request,token));
  }
  if(!a)fail(401,'Your session expired. Please sign in again.');
  if(path==='/api/register'){
    if(a.username)fail(409,'You already have an account.');
    const c=credentials(b);await authLimit(request,db,c.key);
    const hash=await hashPassword(c.password);
    try{await atomic(db,[statement(db,'UPDATE accounts SET username=?,username_key=?,password_hash=?,revision=revision+1 WHERE id=? AND username IS NULL',c.username,c.key,hash,a.id)]);}
    catch(error){if(String(error).includes('UNIQUE'))fail(409,'That username is taken. Try another.');throw error;}
    const token=await newSession(db,a.id);await statement(db,'DELETE FROM sessions WHERE token_hash=?',a.token_hash).run();
    return json(await tablePayload(db,await getAccount(db,a.id)),201,sessionCookie(request,token));
  }
  if(path==='/api/logout'){
    await statement(db,'DELETE FROM sessions WHERE token_hash=?',a.token_hash).run();return json({ok:true},200,sessionCookie(request,'',0));
  }
  await rateLimit(db,`play:${a.id}`,100,60000);
  command(b);
  if(b.accountId!==a.id)fail(409,'The signed-in account changed. Please refresh your table.');
  if(path==='/api/solo'){
    if(a.active_room)fail(409,'Leave your friend table before playing solo.');
    if(a.last_request===b.requestId)return json(await tablePayload(db,a));
    if(a.revision!==b.revision)fail(409,'Your saved game changed. Please try again.');
    let g=soloGame(a),feedback;
    if(b.action==='deal')g.deal(b.bet);
    else if(['hit','stand','double','split'].includes(b.action))g.act(b.action);
    else if(b.action==='mode'||b.action==='shuffle'){
      if(!between(g))fail(409,'Finish this hand first.');
      if(b.action==='mode'){
        if(!['solo','full'].includes(b.mode))fail(400,'Choose Solo or Full table.');
        const old=g;g=new BlackjackGame({otherPlayers:b.mode==='full'?4:0,random:secureRandom});g.bankroll=old.bankroll;g.stats=old.stats;g.history=old.history;g.shoeNumber=old.shoeNumber+1;
      }else g.shuffle();
    }else if(b.action==='refill'){
      if(!between(g)||g.bankroll>=1)fail(409,'A refill is available when you run out of practice chips.');g.bankroll=1000;
    }else if(b.action==='count')feedback=g.checkCount(b.answer);
    else fail(400,'Unknown table action.');
    await atomic(db,[saveAccount(db,a,g,b.requestId)]);a=await getAccount(db,a.id);
    return json({user:accountView(a),revision:a.revision,room:null,table:soloView(g),feedback});
  }
  if(!a.username)fail(403,'Choose a username and password to play with friends.');
  if(path==='/api/rooms/create'||path==='/api/rooms/join'){
    if(a.active_room)return json(await tablePayload(db,a));
    if(a.revision!==b.revision)fail(409,'Your balance changed. Please try again.');
    if(!between(soloGame(a)))fail(409,'Finish your solo hand before joining a friend table.');
    await rateLimit(db,`rooms:${a.id}`,20,15*60000);
    let row,g;
    if(path.endsWith('/create')){
      if(!Number.isSafeInteger(b.minimum)||b.minimum<1||b.minimum>a.chips/2)fail(400,'Choose a minimum bet you can cover.');
      g=new FriendGame({minimum:b.minimum});g.add(a);row={code:code(),host_id:a.id,revision:0};
      await atomic(db,[
        statement(db,'INSERT INTO rooms (code,host_id,state,updated_at,last_request) VALUES (?,?,?,?,?)',row.code,a.id,serialize(g),Date.now(),b.requestId),
        statement(db,'UPDATE accounts SET active_room=?,revision=revision+1,last_request=? WHERE id=? AND revision=? AND active_room IS NULL',row.code,b.requestId,a.id,a.revision)
      ]);
    }else{
      const invite=typeof b.code==='string'?b.code.toUpperCase().replace(/[\s-]/g,''):'';
      if(!codePattern.test(invite))fail(400,'Enter the 8-character invite code.');
      row=await getRoom(db,invite);if(!row)fail(404,'That table was not found. Check the invite code.');
      g=FriendGame.load(row.state);g.add(a);delete g.lastFrames;
      await atomic(db,[
        statement(db,'UPDATE rooms SET state=?,revision=revision+1,updated_at=?,last_request=? WHERE code=? AND revision=?',serialize(g),Date.now(),b.requestId,row.code,row.revision),
        statement(db,'UPDATE accounts SET active_room=?,revision=revision+1,last_request=? WHERE id=? AND revision=? AND active_room IS NULL',row.code,b.requestId,a.id,a.revision)
      ]);
    }
    return json(await tablePayload(db,await getAccount(db,a.id),{frames:false}));
  }
  if(path==='/api/rooms/action'){
    if(!a.active_room)fail(409,'You are not at a friend table.');
    let row=await getRoom(db,a.active_room);if(!row)fail(404,'The table was not found.');
    let g=FriendGame.load(row.state);
    if(!g.players.some(p=>p.id===a.id))fail(403,'You are not seated at this table.');
    if(row.last_request===b.requestId)return json(await tablePayload(db,a));
    if(row.revision!==b.revision)fail(409,'The table changed. Please try again.');
    const p=g.players.find(p=>p.id===a.id);
    if(b.action==='leave'){
      if(!g.between&&p.hands.length)fail(409,'Finish this hand before leaving. Your chips are saved if you close the browser.');
      g.players=g.players.filter(p=>p.id!==a.id);delete g.lastFrames;
      const nextHost=row.host_id===a.id?g.players[0]?.id:row.host_id;
      const oldSolo=soloGame(a);oldSolo.bankroll=p.bankroll;oldSolo.shuffle();
      const writes=[statement(db,'UPDATE accounts SET active_room=NULL,solo_state=?,chips=?,revision=revision+1,last_request=? WHERE id=? AND active_room=? AND revision=?',serialize(oldSolo),Math.round(p.bankroll*2),b.requestId,a.id,row.code,a.revision)];
      if(g.players.length)writes.push(statement(db,'UPDATE rooms SET host_id=?,state=?,revision=revision+1,updated_at=?,last_request=? WHERE code=? AND revision=?',nextHost,serialize(g),Date.now(),b.requestId,row.code,row.revision));
      else writes.push(statement(db,'DELETE FROM rooms WHERE code=? AND revision=?',row.code,row.revision));
      await atomic(db,writes);return json(await tablePayload(db,await getAccount(db,a.id)));
    }
    delete g.lastFrames;
    if(b.action==='ready')g.ready(a.id,b.bet);
    else if(b.action==='unready'){if(!g.between)fail(409,'Wait for this hand to finish.');p.ready=false;p.status='Choose a bet';}
    else if(b.action==='deal'){if(row.host_id!==a.id)fail(403,'Only the host can deal the next hand.');g.deal();}
    else if(['hit','stand','double','split'].includes(b.action))g.act(a.id,b.action);
    else if(b.action==='count'){if(!Number.isInteger(b.answer))fail(400,'Enter a whole number.');p.stats.countChecks++;if(b.answer===g.runningCount)p.stats.correctCounts++;}
    else fail(400,'Unknown table action.');
    g.lastFrames=g.frames;await saveRoom(db,row,g,b.requestId);
    a=await getAccount(db,a.id);const response={user:accountView(a),revision:row.revision,room:roomView(row,g,a.id),table:g.public(a.id)};
    if(b.action==='count')response.feedback={correct:b.answer===g.runningCount,expected:g.runningCount};
    return json(response);
  }
  fail(404,'Not found.');
}

export function createWorker(){const admit=createRequestAdmission();return {async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')){
    try{admit(request);return await api(request,env);}catch(error){
      if(error instanceof HttpError)return json({error:error.message,...(error.retryAfter?{retryAfter:error.retryAfter}:{})},error.status,undefined,error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});
      if(error.message?.startsWith('Choose ')||error.message?.startsWith('Wait ')||error.message?.startsWith('Finish ')||error.message?.startsWith('Bet ')||error.message?.startsWith('At least ')||error.message==='This table is full.'||error.message==='That action is not available.')return json({error:error.message},400);
      console.error('Blackjack request failed',url.pathname,error?.message);return json({error:url.pathname.startsWith('/api/admin/')?'User management is temporarily unavailable. Please try again.':'Your game could not be saved. Please reconnect and try again.'},503);
    }
  }
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  if(env.ASSETS){const response=await env.ASSETS.fetch(request);const headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','same-origin');return new Response(response.body,{status:response.status,headers});}
  return new Response('Not found',{status:404});
}};}
export default createWorker();
