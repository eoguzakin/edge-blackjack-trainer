import test from 'node:test';
import assert from 'node:assert/strict';
import { BlackjackGame, createShoe, handValue, hiLo, basicStrategy } from '../web/game.js';

const c = rank => ({ rank: String(rank), suit: '♠' });
const hand = (...ranks) => ranks.map(c);
function rig(...ranks) {
  const shoe = createShoe();
  shoe.splice(shoe.length - ranks.length, ranks.length, ...ranks.reverse().map(c));
  return new BlackjackGame({ shoe });
}
test('six decks contain 312 unique cards and sum to a balanced count', () => {
  const shoe = createShoe(); assert.equal(shoe.length,312); assert.equal(new Set(shoe.map(c=>c.id)).size,312);
  assert.equal(shoe.reduce((sum,c)=>sum+hiLo(c),0),0);
});
test('ace totals adjust without losing soft-hand information', () => {
  assert.deepEqual(handValue(hand('A','A',9)),{total:21,soft:true,bust:false,blackjack:false});
  assert.equal(handValue(hand('A',6,'K')).total,17); assert.equal(handValue(hand('A',6,'K')).soft,false);
  assert.equal(handValue(hand(10,8,4)).bust,true);
});
test('only three cards enter the initial count; hole card is counted once on reveal', () => {
  const g = rig(2,6,8,'K',3); g.deal(25); assert.equal(g.runningCount,2); assert.equal(g.seen.length,3);
  g.act('stand'); assert.equal(g.runningCount,2); assert.equal(g.seen.length,5);
  g.revealDealer(); assert.equal(g.seen.length,5);
});
test('natural blackjack pays 3:2 including fractional chips', () => {
  const g=rig('A',9,'K',8); g.deal(25); assert.equal(g.phase,'settled'); assert.equal(g.bankroll,1037.5); assert.equal(g.roundNet,37.5);
});
test('matching blackjacks push', () => {const g=rig('A','A','K','K');g.deal(25);assert.equal(g.bankroll,1000);});
test('dealer blackjack settles before extra stakes are possible', () => {
  const g=rig(8,'A',8,'K');g.deal(25);assert.equal(g.bankroll,975);assert.deepEqual(g.availableActions(),[]);assert.throws(()=>g.act('split'));
});
test('dealer stands on soft 17', () => {
  const g=rig(10,'A',8,6,10);g.deal(25);g.act('stand');assert.equal(g.dealer.length,2);assert.equal(g.bankroll,1025);
});
test('double takes exactly one card and pays the doubled stake', () => {
  const g=rig(5,6,6,10,'K',10);g.deal(25);g.act('double');assert.equal(g.hand.cards.length,3);assert.equal(g.hand.bet,50);assert.equal(g.bankroll,1050);
});
test('split hands advance, permit doubling, and settle independently', () => {
  const g=rig(8,6,8,10,3,2,10,10,5);g.deal(25);g.act('split');assert.equal(g.hands.length,2);g.act('double');assert.equal(g.active,1);g.act('double');
  assert.equal(g.phase,'settled');assert.equal(g.hands[0].outcome,'Push');assert.equal(g.hands[1].net,-50);assert.equal(g.bankroll,950);
});
test('split aces get one card each and 21 pays 1:1', () => {
  const g=rig('A',10,'A',7,'K','Q');g.deal(25);g.act('split');assert.equal(g.phase,'settled');assert.equal(g.bankroll,1050);
  assert.ok(g.hands.every(h=>h.cards.length===2&&h.fromSplit));
});
test('bust loses even when dealer would also bust', () => {
  const g=rig(10,6,6,10,'K','K');g.deal(25);g.act('hit');assert.equal(g.bankroll,975);assert.equal(g.dealer.length,2);
});
test('unavailable actions and overdrafts cannot mutate the round', () => {
  const g=rig(2,7,3,10,2);g.bankroll=25;g.deal(25);assert.deepEqual(g.availableActions(),['hit','stand']);assert.throws(()=>g.act('double'));
  g.act('hit');assert.equal(g.bankroll,0);assert.throws(()=>g.deal(25));
});
test('shuffle threshold is checked between hands and resets count', () => {
  const g=new BlackjackGame();g.shoe=createShoe().slice(0,78);g.runningCount=50;
  const result=g.deal(25);assert.equal(result.shuffled,true);assert.equal(g.shoeNumber,2);assert.ok(Math.abs(g.runningCount)<=4);
});
test('count answers score exact integers only', () => {
  const g=new BlackjackGame();g.runningCount=-3;assert.equal(g.checkCount(-3).correct,true);assert.equal(g.checkCount(3).correct,false);
  assert.equal(g.stats.countChecks,2);assert.equal(g.stats.correctCounts,1);assert.throws(()=>g.checkCount(NaN));assert.throws(()=>g.checkCount(1.5));
});
test('representative S17/DAS strategy decisions and fallback actions', () => {
  const cases=[[[8,8],10,'split'],[['A','A'],11,'split'],[[4,4],5,'split'],[[9,9],7,'stand'],[[9,9],9,'split'],[[5,5],6,'double'],[[5,6],'A','hit'],[['A',7],2,'stand'],[['A',7],3,'double'],[['A',7],9,'hit'],[['A',8],6,'stand'],[[10,2],3,'hit'],[[10,2],4,'stand'],[[10,6],10,'hit']];
  for(const [cards,dealer,action] of cases)assert.equal(basicStrategy(hand(...cards),c(dealer===11?'A':dealer)),action,`${cards} vs ${dealer}`);
  assert.equal(basicStrategy(hand('A',7),c(3),{canDouble:false,canSplit:false}),'stand');
  assert.equal(basicStrategy(hand(8,8),c(10),{canDouble:false,canSplit:false}),'hit');
});
test('500 simulated rounds conserve cards, exposed counts, and payouts', () => {
  let seed=123456;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const g=new BlackjackGame({random});g.bankroll=100000;
  for(let round=0;round<500;round++){
    g.deal(25);let actions=0;
    while(g.phase==='playing'){g.act(g.recommendation());assert.ok(++actions<50);}
    assert.equal(g.runningCount,g.seen.reduce((s,c)=>s+hiLo(c),0));assert.equal(g.shoe.length+g.seen.length,312);
    assert.equal(g.bankroll,g.roundStart+g.hands.reduce((s,h)=>s+h.net,0));assert.ok(g.hands.length<=4);
  }
  assert.equal(g.stats.rounds,500);assert.equal(g.stats.correct,g.stats.decisions);assert.ok(g.shoeNumber>1);
});
