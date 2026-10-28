import test from 'node:test';
import assert from 'node:assert/strict';
import {BlackjackGame,createShoe,handValue,hiLo} from '../web/game.js';

function rig(ranks){
  const shoe=createShoe();
  const cards=ranks.map((rank,index)=>({rank:String(rank),suit:'♠',id:`rig-${index}`}));
  shoe.splice(-cards.length,cards.length,...cards.reverse());
  return new BlackjackGame({shoe,otherPlayers:4});
}
const standingTable=[10,9,10,10,10,6,7,8,8,7,8,10,5];
test('five-seat deal is round-robin, with eleven exposed cards and one hidden card',()=>{
  const g=rig(standingTable);g.deal(25);
  const deals=g.frames.filter(frame=>frame.type==='deal');
  assert.deepEqual(deals.map(frame=>frame.seat),['guest-0','guest-1','you','guest-2','guest-3','dealer','guest-0','guest-1','you','guest-2','guest-3','dealer']);
  assert.equal(g.seen.length,11);assert.equal(g.runningCount,-3);assert.equal(g.phase,'playing');assert.equal(g.actingSeat,'you');
  assert.equal(g.stats.decisions,0);assert.equal(g.bankroll,975);assert.equal(g.dealerRevealed,false);
  assert.equal(deals[0].state.otherPlayers[0].hands[0].cards.length,1);
  assert.equal(deals[0].state.hands[0].cards.length,0);
  assert.equal(deals.at(-1).state.runningCount,deals.at(-2).state.runningCount);
});
test('guest actions bracket the human turn and do not change human stakes or accuracy',()=>{
  const g=rig(standingTable);g.deal(25);
  assert.deepEqual(g.frames.filter(f=>f.type==='action').map(f=>f.seat),['guest-0','guest-1']);
  g.act('stand');assert.deepEqual(g.frames.filter(f=>f.type==='action').map(f=>f.seat),['you','guest-2','guest-3']);
  assert.equal(g.bankroll,975);assert.equal(g.stats.decisions,1);assert.equal(g.stats.correct,1);assert.equal(g.stats.rounds,1);
  assert.equal(g.phase,'settled');assert.equal(g.dealer.length,3);assert.equal(g.runningCount,-3);
  assert.equal(g.frames.filter(f=>f.type==='reveal').length,1);
});
test('human blackjack does not end the other players’ round',()=>{
  const g=rig([10,9,'A',10,10,6,7,8,'K',7,8,10,5]);g.deal(25);
  assert.equal(g.phase,'settled');assert.equal(g.dealer.length,3);assert.equal(g.bankroll,1037.5);
  assert.equal(g.stats.decisions,0);assert.ok(g.otherPlayers.every(p=>p.hands[0].outcome));
});
test('dealer still plays for other surviving hands after the user busts',()=>{
  const g=rig([10,9,10,10,10,6,7,8,6,7,8,10,10,5]);g.deal(25);g.act('hit');
  assert.equal(g.hands[0].outcome,'Bust');assert.equal(g.dealer.length,3);assert.equal(g.bankroll,975);
  assert.ok(g.otherPlayers.every(p=>p.hands[0].done));
});
test('simulated players can split and double without spending the user’s chips',()=>{
  const g=rig([8,9,10,10,10,6,8,8,8,7,8,10,3,2,'K','K',5]);g.deal(25);
  const alex=g.otherPlayers[0];assert.equal(alex.hands.length,2);
  assert.deepEqual(alex.hands.map(h=>h.bet),[50,50]);assert.deepEqual(alex.hands.map(h=>handValue(h.cards).total),[21,20]);
  assert.equal(g.bankroll,975);assert.equal(g.stats.decisions,0);g.act('stand');assert.equal(g.bankroll,975);
  assert.deepEqual(alex.hands.map(h=>h.net),[0,-50]);
});
test('dealer blackjack skips all player actions and reveals the hole card once',()=>{
  const g=rig([8,9,10,10,10,'A',8,8,8,7,8,'K']);g.deal(25);
  assert.equal(g.phase,'settled');assert.equal(g.stats.decisions,0);assert.equal(g.bankroll,975);
  assert.equal(g.frames.filter(f=>f.type==='action').length,0);assert.equal(g.frames.filter(f=>f.type==='reveal').length,1);
  assert.equal(g.seen.length,12);
});
test('1,000 full-table rounds preserve counts, payouts, card uniqueness, and ordered animation snapshots',()=>{
  let seed=8427;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const g=new BlackjackGame({random,otherPlayers:4});g.bankroll=100000;
  function verifyFrames(){
    let previous;
    for(const {state:s} of g.frames){
      assert.equal(s.runningCount,g.seen.slice(0,s.seenCount).reduce((sum,c)=>sum+hiLo(c),0));
      if(previous&&s.shoeNumber===previous.shoeNumber){assert.ok(s.seenCount-previous.seenCount>=0);assert.ok(s.seenCount-previous.seenCount<=1);}
      previous=s;
    }
  }
  for(let round=0;round<1000;round++){
    g.deal(25);verifyFrames();let actions=0;
    while(g.phase==='playing'){g.act(g.recommendation());verifyFrames();assert.ok(++actions<50);}
    assert.equal(g.shoe.length+g.seen.length,312);assert.equal(new Set(g.seen.map(c=>c.id)).size,g.seen.length);
    assert.equal(g.bankroll,g.roundStart+g.hands.reduce((sum,h)=>sum+h.net,0));
    assert.ok(g.otherPlayers.every(p=>p.hands.length<=4&&p.hands.every(h=>h.done)));
  }
  assert.equal(g.stats.rounds,1000);assert.equal(g.stats.correct,g.stats.decisions);
});
