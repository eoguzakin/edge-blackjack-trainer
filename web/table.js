import {BlackjackGame, handValue, signed} from './game.js';
import {Session,escapeHTML as esc} from './session.js';
import {SocialControls} from './social.js';
import {TableSounds} from './sounds.js';

const $=s=>document.querySelector(s);
const chips=n=>n.toLocaleString('en-US',{maximumFractionDigits:1});
const percent=(n,total)=>total?`${Math.round(n/total*100)}%`:'—';
const names={hit:'Hit',stand:'Stand',double:'Double',split:'Split'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const suitNames={'♠':'spades','♥':'hearts','♦':'diamonds','♣':'clubs'};
const suitFiles={'♠':'S','♥':'H','♦':'D','♣':'C'};
const cardImage=card=>`./assets/cards/${card.rank==='10'?'T':card.rank}${suitFiles[card.suit]}.svg`;
class TableState{
  constructor(){this.value={state:new BlackjackGame().snapshot(),actions:[],recommended:null,frames:[]};}
  snapshot(){return structuredClone(this.value.state);}
  availableActions(){return this.value.actions;}
  recommendation(){return this.value.recommended;}
  get frames(){return this.value.frames;}
  get bankroll(){return this.value.state.bankroll;}
  get phase(){return this.value.state.phase;}
  get shoeNumber(){return this.value.state.shoeNumber;}
  get seen(){return {length:this.value.state.seenCount};}
}
function stack(value){
  let remainder=Math.floor(value);const pieces=[];
  for(const n of [500,100,25,10,5,1]){let count=Math.floor(remainder/n);remainder%=n;while(count-->0&&pieces.length<7)pieces.push(n);}
  return `<span class="chip-stack" aria-hidden="true">${pieces.map((n,i)=>`<i class="stack-chip chip-value-${n}" style="--level:${i}"></i>`).join('')}</span><span class="stack-total">${chips(value)}</span>`;
}

export function casinoCard(card,hidden=false) {
  if(!card)return '<div class="card-outline" aria-hidden="true"></div>';
  const red=['♥','♦'].includes(card.suit);
  return `<div class="casino-card ${red?'red':''} ${hidden?'face-down':''}" data-card-id="${card.id}" role="img" aria-label="${hidden?'Face-down card':`${card.rank} of ${suitNames[card.suit]}`}"><div class="card-inner"><div class="card-face card-front" aria-hidden="true">${hidden?'':`<img src="${cardImage(card)}" alt="" draggable="false" width="240" height="336">`}</div><div class="card-face card-reverse" aria-hidden="true"><img src="./assets/cards/1B.svg" alt="" draggable="false" width="240" height="336"></div></div></div>`;
}

export class TableExperience {
  constructor({isActive,notify,beforePlay=()=>{}}) {
    this.game=new TableState();this.api=new Session();this.connected=false;this.connectionError='';this.isActive=isActive;this.notify=notify;this.beforePlay=beforePlay;
    this.tableMode='solo';this.guidance='guided';this.showCount=true;this.bet=25;
    this.busy=false;this.presented=null;this.feedback=null;
    this.checkedKey='';this.exposedKey='';this.pace=550;this.message='Place your bet.';
    this.betHistory=[];this.sounds=new TableSounds(notify);this.social=new SocialControls(this);this.polling=false;
    document.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&!button.disabled&&this.isActive())this.click(button);});
    document.addEventListener('submit',event=>{if(event.target.id==='count-form'){event.preventDefault();this.checkCount();}});
    document.addEventListener('input',event=>{if(event.target.id==='bet-amount')this.editBet(event.target);});
    document.addEventListener('change',event=>{if(event.target.id==='table-mode')this.setMode(event.target.value);if(event.target.id==='table-pace')this.pace=Number(event.target.value);if(event.target.id==='table-hints'){this.guidance=event.target.checked?'guided':'test';this.render();}});
    document.addEventListener('keydown',event=>{
      if(!this.isActive()||!this.connected||this.busy||event.repeat||event.ctrlKey||event.metaKey||event.altKey||$('#drill-panel').open||$('#social-dialog').open)return;
      if(['INPUT','SELECT','TEXTAREA','BUTTON','A','SUMMARY'].includes(event.target.tagName))return;
      const action={h:'hit',s:'stand',d:'double',p:'split'}[event.key.toLowerCase()];
      if(action&&this.game.availableActions().includes(action)){event.preventDefault();this.act(action);}
      if(event.key==='Enter'&&!this.api.data.room&&['ready','settled'].includes(this.game.phase)){event.preventDefault();this.deal();}
    });
    queueMicrotask(()=>this.start());
    this.pollTimer=setInterval(()=>this.poll(),1500);
    addEventListener('pagehide',()=>clearInterval(this.pollTimer),{once:true});
  }
  async start(){try{this.accept(await this.api.load());}catch(error){this.connectionError=error.message;this.render();}}
  accept(data){const changed=this.api.data?.room?.code!==data.room?.code||this.tableMode!==data.table.mode;this.api.data=data;this.game.value=data.table;this.tableMode=data.table.mode;this.connected=true;this.connectionError='';if(data.table.state.ready)this.bet=data.table.state.bet;else if(['ready','settled'].includes(this.game.phase))this.bet=Math.min(Math.floor(this.game.bankroll),changed?Math.max(this.bet,data.room?.minimum||1):this.bet);this.social.update();this.render();}
  async refresh(){try{this.accept(await this.api.request('/api/me'));}catch(error){this.connectionError=error.message;this.render();}}
  async poll(){
    const clock=$('.turn-clock');if(clock&&this.state.deadline)clock.textContent=`Turn · ${Math.max(0,Math.ceil((this.state.deadline-Date.now())/1000))}s`;
    if(this.busy||this.polling||this.social.pending||document.hidden||!this.connected)return;
    if(!this.api.data.room&&Date.now()-(this.lastPoll||0)<15000)return;
    this.polling=true;this.lastPoll=Date.now();const revision=this.api.data.revision,room=this.api.data.room?.code;
    try{
      const data=await this.api.request('/api/me');if(this.busy||this.social.pending)return;
      if(data.revision!==revision||data.room?.code!==room||data.user.id!==this.api.data.user.id){const previous=this.state;this.accept(data);if(data.room?.code===room&&data.revision===revision+1&&data.table.frames.length){this.busy=true;this.presented=previous;await this.playFrames();}}
      else if(this.connectionError){this.connectionError='';this.render();}
    }catch(error){this.connectionError=error.status===401?'Your session expired. Reload to sign in.':'Connection lost. Reconnecting…';this.render();}finally{this.polling=false;}
  }
  get state(){return this.presented||this.game.snapshot();}
  key(){return `${this.game.shoeNumber}:${this.game.seen.length}`;}
  publicState(){
    const s=this.state;
    return {tableMode:this.tableMode,guidance:this.guidance,animating:this.busy,phase:s.phase,bankroll:s.bankroll,playerHands:s.hands.map(h=>({cards:h.cards,bet:h.bet})),otherPlayers:s.otherPlayers.map(p=>({name:p.name,hands:p.hands,status:p.status})),dealerCards:s.dealerRevealed?s.dealer:s.dealer.slice(0,1),runningCount:this.showCount?s.runningCount:null,trueCount:this.showCount?s.trueCount:null,availableActions:this.busy?[]:this.game.availableActions(),stats:s.stats};
  }
  handHTML(hand,index,{guest=false,current=false}={}){
    const value=handValue(hand.cards),count=hand.cards.length;
    return `<div class="casino-hand ${current?'active-hand':''}" style="--cards:${count}" data-hand-index="${index}"><div class="hand-cards ${count>4?'many-cards':''}">${hand.cards.map(c=>casinoCard(c)).join('')}</div><div class="hand-detail"><span class="hand-total">${count===2&&value.blackjack&&!hand.fromSplit?'BLACKJACK':count>1?`${value.soft?'soft ':''}${value.total}`:' '}</span>${hand.outcome?`<span class="hand-outcome ${hand.net>0?'positive':hand.net<0?'negative':''}">${guest?(hand.net>0?'Win':hand.net===0?'Push':'Loss'):hand.outcome}</span>`:hand.doubled?'<span class="hand-outcome">2×</span>':''}</div></div>`;
  }
  guestHTML(player,index,s){
    const active=s.actingSeat===player.id,wager=player.hands.length?player.hands.reduce((sum,h)=>sum+h.bet,0):player.bet;
    const position=this.tableMode==='friends'?[1,2,0,3][index]:index;
    return `<section class="table-seat guest-seat seat-${position} ${active?'active-seat':''}" aria-label="${esc(player.name)}, ${player.bot?'simulated player':'friend'}"><div class="guest-heading"><div class="seat-name"><span>${esc(player.name)}</span></div><div class="seat-wager" aria-label="Bet ${chips(wager)}">${stack(wager)}</div></div><div class="seat-hands ${player.hands.length>1?'split-hands':''}" style="--hands:${player.hands.length||1}">${player.hands.length?player.hands.map((h,i)=>this.handHTML(h,i,{guest:true,current:active&&i===player.active})).join(''):'<div class="empty-seat-cards">'+casinoCard(null)+casinoCard(null)+'</div>'}</div><div class="seat-bankroll">${chips(player.bankroll)} chips${active?' · Playing':player.ready?' · Ready':player.status==='Sitting out'?' · Sitting out':''}</div></section>`;
  }
  render(){
    if(!this.isActive())return;
    const s=this.state,settled=s.phase==='settled',room=this.api.data?.room;
    const actions=this.busy||!this.connected||this.connectionError?[]:this.game.availableActions(),playing=actions.length>0,locked=this.busy||!this.connected||!!this.connectionError||!['ready','settled'].includes(s.phase),betLocked=locked||s.ready;
    const recommended=playing?this.game.recommendation():null,minimum=room?.minimum||1;
    const broke=!locked&&s.bankroll<1;
    const net=settled?`${signed(s.roundNet)} chips`:'';
    let status=this.message;
    if(!this.busy&&playing)status=s.hands.length>1?`Your turn · hand ${s.active+1} of ${s.hands.length}`:'Your turn';
    if(!this.busy&&settled)status=`${s.hands.map(h=>h.outcome).join(' · ')}${net?` · ${net}`:''}`;
    if(room&&!this.busy&&!playing)status=locked?`${esc(s.otherPlayers.find(p=>p.id===s.actingSeat)?.name||'Dealer')} is playing`:`${s.ready?'You’re ready':s.bankroll<minimum?'Not enough chips for this minimum':'Place your bet'} · ${room.readyCount} ready`;
    if(!this.connected)status=this.connectionError?'Unable to load saved chips.':'Taking your seat…';
    const hint=playing&&this.guidance==='guided'?`Suggested: ${names[recommended]}`:'';
    const focusId=document.activeElement?.id;
    $('#view-content').innerHTML=`<section class="casino-room ${this.tableMode==='solo'?'solo-table':'full-table'} ${room?'friends-table':''}" data-seats="${s.otherPlayers.length+1}" aria-label="Blackjack practice table" aria-busy="${this.busy}">
      ${this.connectionError?`<div class="connection-banner" role="status">${esc(this.connectionError)} <button id="retry-connection" class="text-control">Retry</button></div>`:''}
      <div class="casino-toolbar">${room?`<button id="room-details" class="room-code" aria-label="Friend table ${room.code}"><span>FRIENDS · ${room.seats}/5</span><strong>${room.code}</strong><small>Min ${chips(room.minimum)}</small></button>`:`<div class="casino-segment" role="group" aria-label="Table mode"><button data-table-mode="solo" aria-pressed="${this.tableMode==='solo'}" ${locked?'disabled':''}>Solo</button><button data-table-mode="full" aria-pressed="${this.tableMode==='full'}" ${locked?'disabled':''}>Full table</button></div><select id="table-mode" class="table-mode-select" aria-label="Table mode" ${locked?'disabled':''}><option value="solo" ${this.tableMode==='solo'?'selected':''}>Solo</option><option value="full" ${this.tableMode==='full'?'selected':''}>Full table</option></select>`}${this.countHTML(s)}</div>
      <div class="casino-stage">
        <div class="table-surface" aria-hidden="true"><div class="inner-rail"></div></div>
        <div class="shoe-station"><div class="shoe-stack" aria-hidden="true"><div class="shoe-card"><img src="./assets/cards/1B.svg" alt="" draggable="false" width="240" height="336"></div></div><div class="shoe-meter" role="progressbar" aria-label="Cards remaining in shoe" aria-valuemin="0" aria-valuemax="312" aria-valuenow="${s.shoeLength}"><span style="width:${s.shoeLength/312*100}%"></span></div></div>
        <div class="discard-station"><strong>${s.decksRemaining.toFixed(1)}</strong><small>decks left</small></div>
        <section class="table-seat dealer-seat ${s.actingSeat==='dealer'&&this.busy?'active-seat':''}" aria-label="Dealer"><div class="dealer-label">DEALER${s.dealerRevealed?`<span>${handValue(s.dealer).total}</span>`:''}</div><div class="hand-cards dealer-cards">${s.dealer.length?s.dealer.map((c,i)=>casinoCard(c,i===1&&!s.dealerRevealed)).join(''):casinoCard(null)+casinoCard(null)}</div></section>
        <div class="felt-lettering" aria-hidden="true"><span class="felt-emblem">♠</span><span class="felt-wordmark">EDGE</span><span class="felt-payout">BLACKJACK PAYS 3 TO 2</span></div>
        ${s.otherPlayers.map((player,i)=>this.guestHTML(player,i,s)).join('')}
        <section class="table-seat your-seat ${playing?'active-seat':''} ${s.hands.length>1?'has-splits':''}" aria-label="Your seat"><div class="seat-wager your-wager">${stack(!locked?this.bet:s.hands.reduce((sum,h)=>sum+h.bet,0))}</div><div class="seat-hands ${s.hands.length>1?'split-hands':''}" style="--hands:${s.hands.length||1}">${s.hands.length?s.hands.map((h,i)=>this.handHTML(h,i,{current:playing&&i===s.active})).join(''):`<div class="empty-seat-cards">${casinoCard(null)}${casinoCard(null)}</div>`}</div><div class="seat-name your-name"><span class="seat-indicator"></span>YOUR SEAT </div></section>
      </div>
      <div class="casino-controls"><div class="round-status"><span role="status" id="round-message">${status}</span>${hint?`<span class="round-hint">${hint}</span>`:''}${room&&s.deadline&&s.actingSeat==='you'&&!this.busy?'<span class="turn-clock">60-second turns</span>':''}</div><div class="action-dock"><div class="bankroll-block" aria-label="Saved chips"><span>Chips</span><strong>${this.connected?chips(s.bankroll):'—'}</strong></div>
      <div class="wager-controls" ${locked?'hidden':''}><div class="bet-entry"><label for="bet-amount">Bet</label><input id="bet-amount" type="number" inputmode="numeric" min="${minimum}" step="1" max="${Math.floor(s.bankroll)}" value="${this.bet}" ${betLocked?'disabled':''}><button id="bet-undo" class="text-control" ${betLocked||!this.betHistory.length?'disabled':''}>Undo</button><details class="bet-tools"><summary aria-label="More bet options">•••</summary><div><button id="bet-clear" class="text-control" ${betLocked?'disabled':''}>Clear bet</button><button id="bet-max" class="text-control" ${betLocked?'disabled':''}>Bet maximum</button></div></details></div><div class="casino-chips">${[1,5,10,25,100,500].map(value=>`<button class="casino-chip chip-value-${value}" data-casino-bet="${value}" aria-label="Add ${value} chips" ${betLocked||s.bankroll<this.bet+value?'disabled':''}><span>${value}</span></button>`).join('')}</div></div>
      <div class="playing-actions" ${playing?'':'hidden'}>${Object.entries(names).map(([action,label])=>`<button class="casino-action ${recommended===action&&this.guidance==='guided'?'suggested':''}" data-casino-action="${action}" ${actions.includes(action)?'':'disabled'}>${label}<kbd>${action==='split'?'P':label[0]}</kbd></button>`).join('')}</div>
      ${room?`<div class="friend-actions" ${locked?'hidden':''}><button id="friend-ready" class="${s.ready?'quiet-button':'gold-button'}" ${this.busy||(!s.ready&&(this.bet<minimum||this.bet>s.bankroll))?'disabled':''}>${s.ready?'Change bet':'Ready'}</button>${room.isHost?`<button id="friend-deal" class="gold-button" ${room.readyCount<2?'disabled':''}>Deal · ${room.readyCount} ready</button>`:''}</div>`:`<button id="${broke?'casino-reset':'casino-deal'}" class="gold-button" ${playing?'hidden':''} ${locked||(!broke&&(this.bet<minimum||this.bet>s.bankroll))?'disabled':''}>${broke?'Refill chips':this.busy?'Dealing…':settled?'Next hand':'Deal hand'}<span aria-hidden="true">♠</span></button>`}
      </div></div></section>`;
    if(this.showCount)this.exposedKey=`${s.shoeNumber}:${s.seenCount}`;
    $('#table-pace').disabled=this.busy;
    document.querySelectorAll('[data-open-panel]').forEach(button=>button.disabled=this.busy);
    $('#new-session').disabled=locked||!!room;
    $('#account-button').disabled=this.busy||!this.connected;$('#friends-button').disabled=this.busy||!this.connected;
    $('#session-stats').textContent=`${s.stats.rounds} hands · Strategy ${percent(s.stats.correct,s.stats.decisions)} · Count checks ${percent(s.stats.correctCounts,s.stats.countChecks)}`;
    $('#session-history').innerHTML=s.history.map(h=>`<li><span>Hand ${h.round} · ${h.outcomes}</span><b>${signed(h.net)}</b></li>`).join('');
    if(focusId){const focus=document.getElementById(focusId);if(focus&&!focus.disabled)focus.focus({preventScroll:true});}
  }
  countHTML(s){
    const canCheck=!this.busy&&s.seenCount>0&&this.key()!==this.checkedKey&&this.key()!==this.exposedKey;
    return `<div class="count-strip"><div class="count-readout" role="group" aria-label="Live count"><span>Running <strong id="running-count">${this.showCount?signed(s.runningCount):'—'}</strong></span><span>True <strong id="true-count">${this.showCount?signed(s.trueCount.toFixed(1)):'—'}</strong></span><button id="casino-toggle-count" class="text-control" aria-label="${this.showCount?'Hide counts':'Show counts'}" aria-pressed="${this.showCount}">${this.showCount?'Hide':'Show count'}</button></div>${!this.showCount?`<form id="count-form" class="inline-count-check"><label class="sr-only" for="count-answer">Your running count</label><input id="count-answer" aria-label="Your running count" placeholder="Your count" autocomplete="off" type="text" maxlength="5" pattern="(?:[+]|-)?[0-9]+" required ${canCheck?'':'disabled'}><button class="text-control" ${canCheck?'':'disabled'}>Check</button><span class="count-feedback" role="status">${this.feedback?`${this.feedback.correct?'Correct':'Count'}: ${signed(this.feedback.expected)}`:canCheck?'':this.busy?'Dealing…':'Wait for new cards'}</span></form>`:''}</div>`;
  }
  async visible(){
    if(!document.hidden)return;
    await new Promise(resolve=>{const resume=()=>{if(!document.hidden){document.removeEventListener('visibilitychange',resume);resolve();}};document.addEventListener('visibilitychange',resume);});
  }
  async playFrames(){
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    try{
      const artwork=new Set();
      for(const {state} of this.game.frames){
        const hands=[...state.hands,...state.otherPlayers.flatMap(p=>p.hands)];
        for(const card of [...state.dealer,...hands.flatMap(h=>h.cards)])if(card.rank&&card.suit)artwork.add(cardImage(card));
      }
      await Promise.race([Promise.all([...artwork].map(src=>{const img=new Image();img.src=src;return img.decode().catch(()=>{});})),sleep(2000)]);
      for(const frame of this.game.frames){
        await this.visible();this.presented=frame.state;
        if(frame.message)this.message=frame.message;
        this.render();
        if(['deal','reveal'].includes(frame.type))this.sounds.play(frame.type);
        if(frame.type==='settled'&&frame.state.hands.length)this.sounds.play(frame.state.roundNet>0?'win':frame.state.roundNet<0?'loss':'push');
        const card=frame.cardId?[...document.querySelectorAll('.casino-card')].find(el=>el.dataset.cardId===frame.cardId):null;
        if(card&&!reduced&&(frame.type==='deal'||frame.type==='reveal')){
          const inner=card.querySelector('.card-inner'),duration=Math.min(440,this.pace*.8);
          if(frame.type==='deal'){
            const shoe=$('.shoe-card').getBoundingClientRect(),target=card.getBoundingClientRect();
            const dx=shoe.x+shoe.width/2-target.x-target.width/2,dy=shoe.y+shoe.height/2-target.y-target.height/2;
            card.style.zIndex='10';const seat=card.closest('.table-seat');seat.style.zIndex='10';
            const movement=card.animate([{transform:`translate(${dx}px,${dy}px) rotate(8deg) scale(.82)`,opacity:1},{transform:`translate(${dx*.12}px,${dy*.12}px) rotate(-3deg) scale(1)`,offset:.78},{transform:'translate(0,0) rotate(0deg) scale(1)'}],{duration,easing:'cubic-bezier(.2,.55,.3,1)',fill:'backwards'});
            movement.finished.then(()=>{card.style.zIndex='';seat.style.zIndex='';}).catch(()=>{});
            if(!card.classList.contains('face-down'))inner.animate([{transform:'rotateY(180deg)'},{transform:'rotateY(0deg)'}],{duration:duration*.45,delay:duration*.5,fill:'backwards',easing:'ease-out'});
          }else inner.animate([{transform:'rotateY(180deg)'},{transform:'rotateY(0deg)'}],{duration,easing:'ease-in-out'});
        }
        const duration=['deal','reveal'].includes(frame.type)?this.pace:frame.type==='action'?this.pace*.6:frame.type==='clear'||frame.type==='shuffle'?300:0;
        if(duration)await sleep(duration);
      }
    }finally{this.busy=false;this.presented=null;this.render();}
  }
  async deal(){
    if(this.busy||!['ready','settled'].includes(this.game.phase))return;
    await this.run('deal',{bet:this.bet});
  }
  async act(action){
    await this.run(action);
  }
  async run(action,extra={}){
    if(this.busy||!this.connected)return;this.beforePlay();this.sounds.unlock();
    const prior=this.game.snapshot();this.busy=true;this.presented=prior;this.render();
    try{const data=await this.api.action(action,extra);this.accept(data);this.feedback=data.feedback||null;await this.playFrames();const result=this.game.value.state.lastDecision;if(['hit','stand','double','split'].includes(action)&&result&&!result.correct&&this.guidance==='guided')this.notify(`Suggested move: ${names[result.recommended]}.`);}
    catch(error){this.busy=false;this.presented=null;this.notify(error.message);await this.refresh();}
    finally{this.busy=false;this.presented=null;this.render();}
  }
  async checkCount(){
    if(this.busy||this.showCount||this.key()===this.checkedKey||this.key()===this.exposedKey)return;
    const input=$('#count-answer')?.value.trim();if(!/^[+-]?\d+$/.test(input||''))return;
    this.checkedKey=this.key();await this.run('count',{answer:Number(input)});
  }
  click(button){
    const id=button.id;
    if(id==='retry-connection'){this.connected?this.refresh():this.start();return;}
    if(id==='room-details'){this.social.open('friends');return;}
    if(id==='casino-toggle-count'){this.showCount=!this.showCount;this.feedback=null;this.render();}
    if(this.busy)return;
    if(button.dataset.casinoBet)this.setBet(this.bet+Number(button.dataset.casinoBet));
    if(id==='bet-clear')this.setBet(0);
    if(id==='bet-max')this.setBet(Math.floor(this.game.bankroll));
    if(id==='bet-undo'&&this.betHistory.length){this.bet=this.betHistory.pop();this.sounds.unlock();this.sounds.play('chip');this.render();}
    if(button.dataset.casinoAction)this.act(button.dataset.casinoAction);
    if(id==='casino-deal')this.deal();
    if(button.dataset.tableMode)this.setMode(button.dataset.tableMode);
    if(id==='friend-ready')this.run(this.state.ready?'unready':'ready',{bet:this.bet});
    if(id==='friend-deal')this.run('deal');
    if(id==='casino-reset')this.run('refill');
    if(id==='new-session')this.run('shuffle');
  }
  editBet(input){
    if(this.busy||!['ready','settled'].includes(this.game.phase)||this.state.ready)return;
    const value=Number(input.value),minimum=this.api.data?.room?.minimum||1,valid=input.value!==''&&Number.isSafeInteger(value)&&value>=0&&value<=this.game.bankroll;
    if(valid&&value!==this.bet){this.betHistory.push(this.bet);this.betHistory=this.betHistory.slice(-30);this.bet=value;}
    const deal=$('#casino-deal')||$('#friend-ready');if(deal)deal.disabled=!valid||value<minimum;
    document.querySelectorAll('[data-casino-bet]').forEach(b=>b.disabled=!valid||value+Number(b.dataset.casinoBet)>this.game.bankroll);
    $('#bet-undo').disabled=!this.betHistory.length;
    if(valid)$('.your-wager').innerHTML=stack(value);
    $('#round-message').textContent=!valid?`Enter whole chips, up to ${chips(Math.floor(this.game.bankroll))}.`:value<minimum?`Minimum ${chips(minimum)} chips.`:'Place your bet.';
  }
  setBet(value){if(this.busy||!['ready','settled'].includes(this.game.phase)||this.state.ready)return;if(!Number.isSafeInteger(value)||value<0||value>this.game.bankroll){this.notify('Choose a whole-chip bet within your balance.');this.render();return;}if(value!==this.bet)this.betHistory.push(this.bet);this.betHistory=this.betHistory.slice(-30);this.bet=value;this.sounds.unlock();this.sounds.play('chip');this.render();}
  setMode(next){if(this.busy||!['ready','settled'].includes(this.game.phase)||!['solo','full'].includes(next)||next===this.tableMode)return;this.run('mode',{mode:next});}
}
