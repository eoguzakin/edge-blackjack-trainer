export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const cardValue = card => card.rank === 'A' ? 11 : (Number(card.rank) || 10);
export const hiLo = card => cardValue(card) <= 6 ? 1 : cardValue(card) >= 10 ? -1 : 0;
export const signed = n => n > 0 ? `+${n}` : String(n).replace('-', '−');

export function createShoe(decks = 6, random = Math.random) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit, id: `${d}-${suit}-${rank}` });
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function handValue(cards) {
  let total = 0, aces = 0;
  for (const card of cards) { total += cardValue(card); if (card.rank === 'A') aces++; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0, bust: total > 21, blackjack: cards.length === 2 && total === 21 };
}

// Six-deck, S17, DAS, no surrender. Only recommend actions available at this table.
export function basicStrategy(cards, upcard, { canDouble = true, canSplit = true } = {}) {
  const dealer = cardValue(upcard), { total, soft } = handValue(cards);
  if (canSplit && cards.length === 2 && cardValue(cards[0]) === cardValue(cards[1])) {
    const pair = cardValue(cards[0]);
    if (pair === 11 || pair === 8 ||
        ([2, 3, 7].includes(pair) && dealer <= 7) ||
        (pair === 4 && [5, 6].includes(dealer)) ||
        (pair === 6 && dealer <= 6) ||
        (pair === 9 && (dealer <= 6 || [8, 9].includes(dealer)))) return 'split';
  }
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) return canDouble && dealer >= 3 && dealer <= 6 ? 'double' : dealer <= 8 ? 'stand' : 'hit';
    if (canDouble && (([13, 14].includes(total) && [5, 6].includes(dealer)) ||
      ([15, 16].includes(total) && dealer >= 4 && dealer <= 6) ||
      (total === 17 && dealer >= 3 && dealer <= 6))) return 'double';
    return 'hit';
  }
  if (total >= 17) return 'stand';
  if (total >= 13 && dealer <= 6) return 'stand';
  if (total === 12 && dealer >= 4 && dealer <= 6) return 'stand';
  if (canDouble && ((total === 9 && dealer >= 3 && dealer <= 6) || (total === 10 && dealer <= 9) || (total === 11 && dealer <= 10))) return 'double';
  return 'hit';
}

export function strategyReason(cards, upcard, action) {
  const value = handValue(cards), dealer = upcard.rank;
  if (action === 'split') return `Split this pair against ${dealer}. Play each new hand separately.`;
  if (action === 'double') return `${value.soft ? 'Soft' : 'Hard'} ${value.total} against ${dealer}: double if you can. You receive exactly one more card.`;
  if (action === 'stand') return `${value.soft ? 'Soft' : 'Hard'} ${value.total} against ${dealer}: basic strategy says stand.`;
  return `${value.soft ? 'Soft' : 'Hard'} ${value.total} against ${dealer}: basic strategy says hit.`;
}

export class BlackjackGame {
  constructor({ random = Math.random, shoe, otherPlayers = 0 } = {}) {
    if (![0,4].includes(otherPlayers)) throw new Error('Choose a solo or five-seat table.');
    this.random = random;
    this.bankroll = 1000;
    this.stats = { rounds:0, decisions:0, correct:0, countChecks:0, correctCounts:0 };
    this.history = []; this.frames = [];
    this.shoe = shoe || createShoe(6, random);
    this.runningCount = 0; this.seen = [];
    this.phase = 'ready'; this.hands = []; this.dealer = [];
    this.dealerRevealed = false; this.active = 0; this.shoeNumber = 1;
    this.otherPlayers = ['Alex','Camille','Theo','James'].slice(0,otherPlayers).map((name,index)=>({id:`guest-${index}`,name,hands:[],active:0,status:'Ready',bankroll:1000,bet:[25,50,25,100][index],bot:true}));
    this.actingSeat = null; this.lastDecision = null;
  }
  get decksRemaining() { return Math.max(.25,this.shoe.length/52); }
  get trueCount() { return this.runningCount/this.decksRemaining; }
  get hand() { return this.hands[this.active]; }
  get seats() {
    const you={id:'you',name:'You',hands:this.hands};
    return this.otherPlayers.length ? [...this.otherPlayers.slice(0,2),you,...this.otherPlayers.slice(2)] : [you];
  }
  snapshot() {
    return structuredClone({bankroll:this.bankroll,stats:this.stats,history:this.history,phase:this.phase,hands:this.hands,dealer:this.dealer,dealerRevealed:this.dealerRevealed,active:this.active,otherPlayers:this.otherPlayers,actingSeat:this.actingSeat,shoeNumber:this.shoeNumber,shoeLength:this.shoe.length,seenCount:this.seen.length,runningCount:this.runningCount,trueCount:this.trueCount,decksRemaining:this.decksRemaining,roundNet:this.roundNet,lastDecision:this.lastDecision});
  }
  record(type='state',seat=null,card=null,message='') {
    this.frames.push({type,seat,cardId:card?.id,state:this.snapshot(),message});
  }
  expose(card) { this.runningCount+=hiLo(card); this.seen.push(card); return card; }
  draw(visible=true) {
    if(!this.shoe.length)throw new Error('The shoe is empty.');
    const card=this.shoe.pop();
    return visible?this.expose(card):card;
  }
  putCard(hand,seat,visible=true) {
    const card=this.draw(visible); hand.cards.push(card);
    this.record('deal',seat,card); return card;
  }
  shuffle() {
    if(!['ready','settled'].includes(this.phase))throw new Error('Finish your hand before shuffling.');
    this.shoe=createShoe(6,this.random); this.runningCount=0; this.seen=[]; this.shoeNumber++;
    this.hands=[]; this.dealer=[]; this.phase='ready'; this.dealerRevealed=false; this.actingSeat=null;
    this.otherPlayers.forEach(player=>{player.hands=[];player.active=0;player.status='Ready';});
  }
  deal(bet) {
    if(!['ready','settled'].includes(this.phase))throw new Error('Finish the current hand first.');
    if(!Number.isSafeInteger(bet)||bet<1||bet>this.bankroll)throw new Error('Choose a whole-chip bet you can cover.');
    this.frames=[]; let shuffled=false;
    if(this.shoe.length<=78){this.shuffle();shuffled=true;this.record('shuffle',null,null,'New shoe. The count starts at zero.');}
    this.roundStart=this.bankroll;this.bankroll-=bet;
    this.hands=[{cards:[],bet,fromSplit:false,done:false}];this.dealer=[];this.dealerRevealed=false;
    this.active=0;this.phase='dealing';this.lastDecision=null;this.roundNet=undefined;this.actingSeat='dealer';
    this.otherPlayers.forEach(player=>{
      const choices=[10,25,35,50,75,100,125,150,200,250].filter(b=>b<=player.bankroll&&b<=Math.max(25,player.bankroll*.25));
      // The opening stake keeps the established table personalities; later stakes vary.
      if(this.stats.rounds)player.bet=choices.length?choices[Math.floor(this.random()*choices.length)]:Math.floor(player.bankroll);
      player.bet=Math.min(player.bet,Math.floor(player.bankroll));
      player.hands=player.bet>=1?[{cards:[],bet:player.bet,fromSplit:false,done:false}]:[];
      player.bankroll-=player.bet;player.active=0;player.status=player.hands.length?'Waiting':'Out of chips';
    });
    this.record('clear',null,null,'The dealer is dealing.');
    for(let pass=0;pass<2;pass++){
      for(const seat of this.seats)if(seat.hands.length)this.putCard(seat.hands[0],seat.id);
      this.putCard({cards:this.dealer},'dealer',pass===0);
    }
    for(const seat of this.seats){
      if(seat.hands.length&&handValue(seat.hands[0].cards).blackjack){seat.hands[0].done=true;if(seat.id!=='you')seat.status='Blackjack';}
    }
    if(handValue(this.dealer).blackjack){this.revealDealer();this.settle();return{shuffled};}
    this.playGuests(this.otherPlayers.slice(0,2));
    if(this.hand.done)this.finishPlayers();
    else{this.phase='playing';this.actingSeat='you';this.record('turn','you',null,'Your turn.');}
    return{shuffled};
  }
  availableActions() {
    if(this.phase!=='playing'||this.actingSeat!=='you'||!this.hand||this.hand.done)return[];
    const actions=['hit','stand'];
    if(this.hand.cards.length===2&&this.bankroll>=this.hand.bet){
      actions.push('double');
      if(this.hands.length<4&&cardValue(this.hand.cards[0])===cardValue(this.hand.cards[1]))actions.push('split');
    }
    return actions;
  }
  recommendation() {
    const available=this.availableActions();if(!available.length)return null;
    return basicStrategy(this.hand.cards,this.dealer[0],{canDouble:available.includes('double'),canSplit:available.includes('split')});
  }
  act(action) {
    if(!this.availableActions().includes(action))throw new Error('That action is not available.');
    this.frames=[];
    const recommended=this.recommendation(),reason=strategyReason(this.hand.cards,this.dealer[0],recommended);
    this.stats.decisions++;const correct=action===recommended;if(correct)this.stats.correct++;
    this.lastDecision={action,recommended,correct,reason};const hand=this.hand;
    if(action==='hit'){
      this.putCard(hand,'you');if(handValue(hand.cards).total>=21){hand.done=true;this.advance();}
    }else if(action==='stand'){
      hand.done=true;this.record('action','you',null,'You stand.');this.advance();
    }else if(action==='double'){
      this.bankroll-=hand.bet;hand.bet*=2;hand.doubled=true;
      this.putCard(hand,'you');hand.done=true;this.advance();
    }else{
      this.bankroll-=hand.bet;this.splitHand(this.hands,this.active,'you');
      if(this.hand.done)this.advance();
    }
    this.record('state');return this.lastDecision;
  }
  splitHand(hands,index,seat) {
    const original=hands[index],aces=original.cards[0].rank==='A';
    const first={cards:[original.cards[0]],bet:original.bet,fromSplit:true,done:aces};
    const second={cards:[original.cards[1]],bet:original.bet,fromSplit:true,done:aces};
    hands.splice(index,1,first,second);this.record('split',seat);
    this.putCard(first,seat);this.putCard(second,seat);
    if(handValue(first.cards).total===21)first.done=true;
    if(handValue(second.cards).total===21)second.done=true;
  }
  playGuests(players) {
    for(const player of players){
      this.phase='others';this.actingSeat=player.id;
      for(let index=0;index<player.hands.length;index++){
        player.active=index;const hand=player.hands[index];
        while(!hand.done){
          if(handValue(hand.cards).total>=21){hand.done=true;break;}
          const funded=player.bankroll>=hand.bet;
          const action=basicStrategy(hand.cards,this.dealer[0],{canDouble:funded&&hand.cards.length===2,canSplit:funded&&player.hands.length<4});
          player.status={hit:'Hits',stand:'Stands',double:'Doubles',split:'Splits'}[action];
          this.record('action',player.id,null,`${player.name} ${player.status.toLowerCase()}.`);
          if(action==='stand')hand.done=true;
          else if(action==='hit')this.putCard(hand,player.id);
          else if(action==='double'){player.bankroll-=hand.bet;hand.bet*=2;hand.doubled=true;this.putCard(hand,player.id);hand.done=true;}
          else{player.bankroll-=hand.bet;this.splitHand(player.hands,index,player.id);index--;break;}
        }
      }
      player.status=player.hands.every(h=>handValue(h.cards).bust)?'Bust':'Waiting for dealer';
      this.record('state',player.id);
    }
  }
  advance() {
    const next=this.hands.findIndex((hand,index)=>index>=this.active&&!hand.done);
    if(next>=0){this.active=next;this.actingSeat='you';this.record('turn','you',null,`Your turn · hand ${next+1}.`);}
    else this.finishPlayers();
  }
  finishPlayers() {
    this.playGuests(this.otherPlayers.slice(2));
    this.phase='dealer';this.actingSeat='dealer';this.revealDealer();
    const needsDealer=this.seats.some(seat=>seat.hands.some(hand=>!handValue(hand.cards).bust&&!(handValue(hand.cards).blackjack&&!hand.fromSplit)));
    if(needsDealer)while(handValue(this.dealer).total<17)this.putCard({cards:this.dealer},'dealer');
    this.settle();
  }
  revealDealer() {
    if(!this.dealerRevealed){this.dealerRevealed=true;this.expose(this.dealer[1]);this.record('reveal','dealer',this.dealer[1],'The dealer reveals the hole card.');}
  }
  settle() {
    const dealer=handValue(this.dealer);
    for(const seat of this.seats)for(const hand of seat.hands){
      const value=handValue(hand.cards),natural=value.blackjack&&!hand.fromSplit;
      if(value.bust){hand.outcome='Bust';hand.net=-hand.bet;}
      else if(dealer.blackjack){hand.outcome=natural?'Push':'Dealer blackjack';hand.net=natural?0:-hand.bet;}
      else if(natural){hand.outcome='Blackjack';hand.net=hand.bet*1.5;}
      else if(dealer.bust||value.total>dealer.total){hand.outcome=seat.id==='you'?'You win':'Win';hand.net=hand.bet;}
      else if(value.total===dealer.total){hand.outcome='Push';hand.net=0;}
      else{hand.outcome='Dealer wins';hand.net=-hand.bet;}
      if(seat.id==='you')this.bankroll+=hand.bet+hand.net;
      else seat.bankroll+=hand.bet+hand.net;
      hand.done=true;
    }
    this.otherPlayers.forEach(player=>{player.status=player.hands.map(h=>h.outcome).join(' · ');});
    this.phase='settled';this.actingSeat=null;this.stats.rounds++;this.roundNet=this.bankroll-this.roundStart;
    this.history.unshift({round:this.stats.rounds,net:this.roundNet,outcomes:this.hands.map(h=>h.outcome).join(' · ')});this.history=this.history.slice(0,8);
    this.record('settled',null,null,this.hands.map(h=>h.outcome).join(' · '));
  }
  checkCount(answer) {
    if(!Number.isInteger(answer))throw new Error('Enter a whole number for the running count.');
    const correct=answer===this.runningCount;this.stats.countChecks++;if(correct)this.stats.correctCounts++;
    return{correct,expected:this.runningCount};
  }
}
