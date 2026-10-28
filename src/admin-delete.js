import {statement,atomic,fail} from './storage.js';
import {FriendGame,serialize} from './friend-game.js';

export async function deleteAccount(db,actor,id,body){
  if(id===actor.id)fail(403,'Your owner account cannot be deleted.');
  if(body.confirmation!==id)fail(400,'Confirm which account you want to delete.');
  const account=await statement(db,'SELECT * FROM accounts WHERE id=?',id).first();
  // Retrying a completed deletion must not affect a new account with the same username.
  if(!account)return {deleted:true,id};
  if(account.revision!==body.revision)fail(409,'This account changed. Reload it before deleting.');
  const duplicate=await statement(db,'SELECT id FROM admin_audit WHERE id=?',body.requestId).first();
  if(duplicate)fail(409,'This request has already been used.');
  const writes=[statement(db,'UPDATE accounts SET revision=revision+1 WHERE id=? AND revision=? AND active_room IS ?',id,account.revision,account.active_room)];
  // Include any lingering room reference so deleting an account never leaves a ghost seat.
  const rooms=await statement(db,"SELECT * FROM rooms WHERE code=? OR host_id=? OR EXISTS (SELECT 1 FROM json_each(rooms.state,'$.players') AS seat WHERE json_extract(seat.value,'$.id')=?)",account.active_room,id,id).all();
  for(const room of rooms.results){
    const game=FriendGame.load(room.state),wasActing=game.actingSeat===id;
    game.players=game.players.filter(player=>player.id!==id);delete game.lastFrames;
    if(!game.players.length){
      writes.push(statement(db,'DELETE FROM rooms WHERE code=? AND revision=?',room.code,room.revision));continue;
    }
    if(game.phase==='playing'&&wasActing)game.advance();
    const host=game.players.some(player=>player.id===room.host_id)?room.host_id:game.players[0].id;
    writes.push(statement(db,'UPDATE rooms SET host_id=?,state=?,revision=revision+1,updated_at=?,last_request=NULL WHERE code=? AND revision=?',host,serialize(game),Date.now(),room.code,room.revision));
    for(const player of game.players){
      const member=await statement(db,'SELECT revision FROM accounts WHERE id=? AND active_room=?',player.id,room.code).first();
      if(!member)fail(409,'This table changed. Reload the account before deleting.');
      writes.push(statement(db,'UPDATE accounts SET chips=?,revision=revision+1 WHERE id=? AND active_room=? AND revision=?',Math.round(player.bankroll*2),player.id,room.code,member.revision));
    }
  }
  // These removals can affect zero or many rows. The checked account claim and all
  // room/wallet changes share the same transaction with the final account removal.
  await atomic(db,writes,[
    statement(db,'DELETE FROM sessions WHERE user_id=?',id),
    statement(db,'DELETE FROM admin_audit WHERE target_id=? OR actor_id=?',id,id),
    statement(db,'DELETE FROM rate_limits WHERE key IN (?,?,?,?)',`play:${id}`,`rooms:${id}`,`admin:${id}`,`auth-user:${account.username_key||''}`),
    statement(db,'DELETE FROM accounts WHERE id=?',id)
  ]);
  return {deleted:true,id};
}
