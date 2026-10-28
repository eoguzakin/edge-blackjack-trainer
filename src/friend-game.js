import {BlackjackGame,createShoe,handValue,hiLo,cardValue,basicStrategy} from '../web/game.js';

export const freshStats=()=>({rounds:0,decisions:0,correct:0,countChecks:0,correctCounts:0});
export const secureRandom=()=>crypto.getRandomValues(new Uint32Array(1))[0]/2**32;
export function serialize(game){return JSON.stringify(Object.fromEntries(Object.entries(game).filter(([key])=>!['random','frames'].includes(key))));}
export function soloGame(account){
  if(account.solo_state){const game=Object.assign(Object.create(BlackjackGame.prototype),JSON.parse(account.solo_state));game.random=secureRandom;game.frames=[];game.bankroll=account.chips/2;return game;}
  const game=new BlackjackGame({random:secureRandom});game.bankroll=account.chips/2;return game;
}
export function redact(s){
  const copy=structuredClone(s);
  if(!copy.dealerRevealed&&copy.dealer.length>1)copy.dealer[1]={id:'hole'};
  return copy;
}
export function soloView(game){
  return {state:redact(game.snapshot()),actions:game.availableActions(),recommended:game.recommendation(),mode:game.otherPlayers.length?'full':'solo',frames:game.frames.map(f=>({...f,cardId:f.type==='deal'&&f.seat==='dealer'&&!f.state.dealerRevealed&&f.state.dealer.length===2?'hole':f.cardId,state:redact(f.state)}))};
}

export class FriendGame {
  constructor({minimum=10,random=secureRandom,shoe}={}){
    this.minimum=minimum;this.random=random;this.shoe=shoe||createShoe(6,random);this.shoeNumber=1;this.runningCount=0;this.seenCount=0;
    this.players=[];this.phase='ready';this.dealer=[];this.dealerRevealed=false;this.actingSeat=null;this.round=0;this.deadline=null;this.frames=[];
  }
  static load(state){const game=Object.assign(Object.create(FriendGame.prototype),JSON.parse(state));game.random=secureRandom;game.frames=[];return game;}
  add(account){
    if(this.players.length>=5)throw new Error('This table is full.');
    if(this.players.some(p=>p.id===account.id))return;
    this.players.push({id:account.id,name:account.username,bankroll:account.chips/2,roundStart:account.chips/2,hands:[],active:0,bet:this.minimum,ready:false,status:'Choose a bet',stats:freshStats(),history:[],roundNet:0});
  }
  get player(){return this.players.find(p=>p.id===this.actingSeat);}
  get hand(){return this.player?.hands[this.player.active];}
  get between(){return ['ready','settled'].includes(this.phase);}
  record(type='state',seat=null,card=null,message=''){
    const state=JSON.parse(serialize(this));delete state.lastFrames;
    // Frames never carry the shoe, which also keeps room rows small.
    state.shoeLength=this.shoe.length;delete state.shoe;
    this.frames.push({type,seat,cardId:card?.id,state,message});
  }
  expose(card){this.runningCount+=hiLo(card);this.seenCount++;}
  put(hand,seat,visible=true){const card=this.shoe.pop();if(!card)throw new Error('The shoe is empty.');hand.cards.push(card);if(visible)this.expose(card);this.record('deal',seat,card);}
  ready(id,bet){
    if(!this.between)throw new Error('Wait for this hand to finish.');
    const p=this.players.find(p=>p.id===id);
    if(!Number.isSafeInteger(bet)||bet<this.minimum||bet>p.bankroll)throw new Error(`Bet at least ${this.minimum} chips, within your balance.`);
    p.bet=bet;p.ready=true;p.status='Ready';
  }
  deal(now=Date.now()){
    if(!this.between)throw new Error('Finish the current hand first.');
    const seats=this.players.filter(p=>p.ready&&p.bet>=this.minimum&&p.bet<=p.bankroll);
    if(seats.length<2)throw new Error('At least two players need to be ready.');
    this.frames=[];delete this.lastFrames;
    if(this.shoe.length<=78){this.shoe=createShoe(6,this.random);this.shoeNumber++;this.runningCount=0;this.seenCount=0;this.record('shuffle',null,null,'New shoe. Count starts at zero.');}
    this.round++;this.phase='dealing';this.dealer=[];this.dealerRevealed=false;this.actingSeat='dealer';
    for(const p of this.players){p.hands=[];p.active=0;p.roundNet=0;p.lastDecision=null;p.roundStart=p.bankroll;if(seats.includes(p)){p.bankroll-=p.bet;p.hands=[{cards:[],bet:p.bet,fromSplit:false,done:false}];p.status='Waiting';}else p.status='Sitting out';p.ready=false;}
    this.record('clear',null,null,'The dealer is dealing.');
    for(let pass=0;pass<2;pass++){for(const p of seats)this.put(p.hands[0],p.id);this.put({cards:this.dealer},'dealer',pass===0);}
    for(const p of seats)if(handValue(p.hands[0].cards).blackjack){p.hands[0].done=true;p.status='Blackjack';}
    if(handValue(this.dealer).blackjack)this.finish();else this.advance(now);
  }
  actions(id){
    if(this.phase!=='playing'||this.actingSeat!==id||!this.hand||this.hand.done)return [];
    const actions=['hit','stand'];
    if(this.hand.cards.length===2&&this.player.bankroll>=this.hand.bet){actions.push('double');if(this.player.hands.length<4&&cardValue(this.hand.cards[0])===cardValue(this.hand.cards[1]))actions.push('split');}
    return actions;
  }
  recommendation(id){const actions=this.actions(id);return actions.length?basicStrategy(this.hand.cards,this.dealer[0],{canDouble:actions.includes('double'),canSplit:actions.includes('split')}):null;}
  act(id,action,now=Date.now(),automatic=false){
    if(!this.actions(id).includes(action))throw new Error('Wait for your turn.');
    this.frames=[];delete this.lastFrames;
    const p=this.player,h=this.hand,recommended=this.recommendation(id);
    if(!automatic){p.stats.decisions++;if(action===recommended)p.stats.correct++;p.lastDecision={action,recommended,correct:action===recommended};}
    if(action==='stand'){h.done=true;p.status=automatic?'Stands · timed out':'Stands';this.record('action',id,null,`${p.name} ${automatic?'stands (turn timed out)':'stands'}.`);}
    if(action==='hit'){this.put(h,id);if(handValue(h.cards).total>=21)h.done=true;}
    if(action==='double'){p.bankroll-=h.bet;h.bet*=2;h.doubled=true;this.put(h,id);h.done=true;}
    if(action==='split'){
      p.bankroll-=h.bet;const aces=h.cards[0].rank==='A';
      const split=h.cards.map(card=>({cards:[card],bet:h.bet,fromSplit:true,done:aces}));
      p.hands.splice(p.active,1,...split);this.record('split',id);
      for(const hand of split){this.put(hand,id);if(handValue(hand.cards).total===21)hand.done=true;}
    }
    this.advance(now);
  }
  advance(now=Date.now()){
    for(const p of this.players){const index=p.hands.findIndex(h=>!h.done);if(index>=0){p.active=index;p.status='Playing';this.phase='playing';this.actingSeat=p.id;this.deadline=now+60000;this.record('turn',p.id,null,`${p.name}'s turn.`);return;}}
    this.finish();
  }
  finish(){
    this.phase='dealer';this.actingSeat='dealer';
    if(!this.dealerRevealed){this.dealerRevealed=true;this.expose(this.dealer[1]);this.record('reveal','dealer',this.dealer[1]);}
    const needsDealer=this.players.some(p=>p.hands.some(h=>!handValue(h.cards).bust&&!(handValue(h.cards).blackjack&&!h.fromSplit)));
    if(needsDealer)while(handValue(this.dealer).total<17)this.put({cards:this.dealer},'dealer');
    const dealer=handValue(this.dealer);
    for(const p of this.players){
      for(const h of p.hands){
        const v=handValue(h.cards),natural=v.blackjack&&!h.fromSplit;
        if(v.bust){h.net=-h.bet;h.outcome='Bust';}
        else if(dealer.blackjack){h.net=natural?0:-h.bet;h.outcome=natural?'Push':'Dealer blackjack';}
        else if(natural){h.net=h.bet*1.5;h.outcome='Blackjack';}
        else if(dealer.bust||v.total>dealer.total){h.net=h.bet;h.outcome='You win';}
        else if(v.total===dealer.total){h.net=0;h.outcome='Push';}
        else{h.net=-h.bet;h.outcome='Dealer wins';}
        p.bankroll+=h.bet+h.net;h.done=true;
      }
      p.roundNet=p.bankroll-p.roundStart;
      if(p.hands.length){p.stats.rounds++;p.history.unshift({round:p.stats.rounds,net:p.roundNet,outcomes:p.hands.map(h=>h.outcome).join(' · ')});p.history=p.history.slice(0,8);}
      p.status=p.hands.length?p.hands.map(h=>h.net>0?'Win':h.net<0?'Loss':'Push').join(' · '):'Sitting out';
    }
    this.phase='settled';this.actingSeat=null;this.deadline=null;this.record('settled',null,null,'Place your next bet.');
  }
  view(id,state=this){
    const p=state.players.find(p=>p.id===id);if(!p)throw new Error('You are not seated at this table.');
    const others=state.players.filter(p=>p.id!==id);
    return redact({bankroll:p.bankroll,bet:p.bet,stats:p.stats,history:p.history,phase:state.phase,hands:p.hands,dealer:state.dealer,dealerRevealed:state.dealerRevealed,active:p.active,otherPlayers:others,actingSeat:state.actingSeat===id?'you':state.actingSeat,shoeNumber:state.shoeNumber,shoeLength:state.shoe?.length??state.shoeLength,seenCount:state.seenCount,runningCount:state.runningCount,decksRemaining:Math.max(.25,(state.shoe?.length??state.shoeLength)/52),trueCount:state.runningCount/Math.max(.25,(state.shoe?.length??state.shoeLength)/52),roundNet:p.roundNet,lastDecision:p.lastDecision,ready:p.ready,deadline:state.deadline});
  }
  public(id){
    return {mode:'friends',state:this.view(id),actions:this.actions(id),recommended:this.recommendation(id),frames:(this.lastFrames||this.frames).map(f=>({...f,seat:f.seat===id?'you':f.seat,cardId:f.type==='deal'&&f.seat==='dealer'&&!f.state.dealerRevealed&&f.state.dealer.length===2?'hole':f.cardId,state:this.view(id,f.state)}))};
  }
}
