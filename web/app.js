import {createShoe,hiLo,signed} from './game.js';
import {TableExperience,casinoCard} from './table.js';
import {LoungeMusic} from './music.js';

const $=selector=>document.querySelector(selector);
let toastTimer,drillTimer;
const drill={phase:'ready',speed:1500,length:20,cards:[],index:0,completed:0,correct:0,total:0,paused:false,answer:null};
function toast(message){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('show');toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3000);}
function pauseDrill(){if(drill.phase==='running'){clearTimeout(drillTimer);drill.paused=true;renderDrill();}}
const table=new TableExperience({isActive:()=>true,notify:toast,beforePlay(){pauseDrill();$('#drill-panel').open=false;}});
const music=new LoungeMusic(toast);

function updatePanelButtons(){
  document.querySelectorAll('[data-open-panel]').forEach(button=>button.setAttribute('aria-expanded',String($('#'+button.dataset.openPanel).open)));
}
function openPanel(id){
  if(table.busy)return;
  const panel=$('#'+id),opening=!panel.open;
  if(id!=='drill-panel'){pauseDrill();$('#drill-panel').open=false;}
  if(id!=='guide-panel')$('#guide-panel').open=false;
  panel.open=opening;updatePanelButtons();
  if(opening){panel.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});panel.querySelector('summary').focus({preventScroll:true});}
}
for(const id of ['drill-panel','guide-panel'])$('#'+id).addEventListener('toggle',()=>{if(id==='drill-panel'&&!$('#drill-panel').open)pauseDrill();updatePanelButtons();});

function renderDrill(){
  const running=drill.phase==='running',answering=drill.phase==='answer';
  let stage='';
  if(drill.phase==='ready')stage=`<p>Start at zero. Count each card.</p><button id="start-drill" class="gold-button">Start drill</button>`;
  if(running)stage=`<div class="drill-card">${casinoCard(drill.cards[drill.index])}</div><span class="drill-position">${drill.index+1} / ${drill.length}${drill.paused?' · Paused':''}</span><div class="drill-actions"><button id="pause-drill" class="gold-button">${drill.paused?'Resume':'Pause'}</button><button id="end-drill" class="text-control">End</button></div>`;
  if(answering)stage=`<form id="drill-answer-form"><label for="drill-answer">Your final count</label><div class="drill-answer-row"><input id="drill-answer" type="text" pattern="(?:[+]|-)?[0-9]+" maxlength="5" required autocomplete="off" placeholder="0"><button class="gold-button">Check</button></div></form>`;
  if(drill.phase==='result'){
    const right=drill.answer===drill.total;
    stage=`<p role="status">${right?'Correct.':`You entered ${signed(drill.answer)}.`} The count is <strong>${signed(drill.total)}</strong>.</p><button id="start-drill" class="gold-button">Try again</button><details class="drill-review"><summary>Review cards</summary><div class="review-grid">${drill.cards.map(c=>`<span>${c.rank}${c.suit}<b>${signed(hiLo(c))}</b></span>`).join('')}</div></details>`;
  }
  $('#drill-content').innerHTML=`<div class="drill-options"><label>Cards<select id="drill-length" ${running||answering?'disabled':''}>${[10,20,40].map(n=>`<option value="${n}" ${drill.length===n?'selected':''}>${n}</option>`).join('')}</select></label><label>Pace<select id="drill-speed" ${running||answering?'disabled':''}>${[[2500,'Relaxed'],[1500,'Natural'],[700,'Quick']].map(([value,label])=>`<option value="${value}" ${drill.speed===value?'selected':''}>${label}</option>`).join('')}</select></label>${drill.completed?`<span class="drill-score">${drill.correct} / ${drill.completed} correct</span>`:''}</div><div class="compact-drill-stage">${stage}</div>`;
}
function nextCard(){
  if(drill.phase!=='running'||drill.paused)return;
  if(++drill.index>=drill.length)drill.phase='answer';
  renderDrill();
  if(drill.phase==='running')drillTimer=setTimeout(nextCard,drill.speed);
  else $('#drill-answer').focus({preventScroll:true});
}
function startDrill(){
  if(table.busy)return;
  clearTimeout(drillTimer);drill.cards=createShoe().slice(0,drill.length);drill.total=drill.cards.reduce((sum,c)=>sum+hiLo(c),0);
  drill.index=0;drill.phase='running';drill.paused=false;drill.answer=null;renderDrill();drillTimer=setTimeout(nextCard,drill.speed);
}
const checks=[
  {question:'A queen appears. Add…',options:['+1','0','−1'],answer:2,explanation:'Tens, face cards, and aces subtract one.'},
  {question:'Count +2. A six and an ace appear. Now…',options:['0','+2','+4'],answer:1,explanation:'The +1 and −1 cancel out.'},
  {question:'Count +9, with 3 decks left. True count…',options:['+2','+3','+6'],answer:1,explanation:'9 ÷ 3 = +3.'},
  {question:'Reset the count after…',options:['Each hand','A loss','A shuffle'],answer:2,explanation:'Keep counting until the shoe is shuffled.'}
];
let checkIndex=0,checkAnswer=null;
function renderQuickCheck(){
  const c=checks[checkIndex];
  $('#quick-check').innerHTML=`<p>${c.question}</p><div class="quick-answers">${c.options.map((option,i)=>`<button data-answer="${i}" class="quiet-button ${checkAnswer===i?(i===c.answer?'correct':'wrong'):''}">${option}</button>`).join('')}</div>${checkAnswer!==null?`<p role="status">${checkAnswer===c.answer?'Correct.':'Try again.'} ${c.explanation}</p>`:''}<button id="next-check" class="text-control">Next question <span>${checkIndex+1} / ${checks.length}</span></button>`;
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  if(button.dataset.openPanel)openPanel(button.dataset.openPanel);
  if(button.id==='start-drill')startDrill();
  if(button.id==='pause-drill'){drill.paused=!drill.paused;clearTimeout(drillTimer);if(!drill.paused)drillTimer=setTimeout(nextCard,drill.speed);renderDrill();}
  if(button.id==='end-drill'){clearTimeout(drillTimer);drill.phase='ready';drill.paused=false;renderDrill();}
  if(button.dataset.answer!==undefined){checkAnswer=Number(button.dataset.answer);renderQuickCheck();}
  if(button.id==='next-check'){checkIndex=(checkIndex+1)%checks.length;checkAnswer=null;renderQuickCheck();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='drill-speed')drill.speed=Number(event.target.value);
  if(event.target.id==='drill-length')drill.length=Number(event.target.value);
  if(['drill-speed','drill-length'].includes(event.target.id)){drill.phase='ready';renderDrill();}
});
document.addEventListener('submit',event=>{
  if(event.target.id!=='drill-answer-form')return;
  event.preventDefault();if(drill.phase!=='answer')return;
  const answer=$('#drill-answer').value.trim();if(!/^[+-]?\d+$/.test(answer))return;
  drill.answer=Number(answer);drill.completed++;if(drill.answer===drill.total)drill.correct++;
  drill.phase='result';renderDrill();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseDrill();});
table.render();renderDrill();renderQuickCheck();
if(location.hash==='#drills')openPanel('drill-panel');
if(location.hash==='#learn')openPanel('guide-panel');

if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'read_training_status',title:'Read training status',description:'Read the table, public counts and scores. Hidden cards and counts are excluded.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute(){return{view:'table',panel:$('#drill-panel').open?'drills':$('#guide-panel').open?'learn':null,...table.publicState(),music:music.source?'playing':'off'};}});
  register({name:'navigate_training',title:'Open a practice tool',description:'Open an inline drill or guide, or return to the table. The current hand is preserved.',inputSchema:{type:'object',properties:{view:{type:'string',enum:['table','drills','learn']}},required:['view'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!['table','drills','learn'].includes(input?.view))throw new Error('Choose table, drills, or learn.');if(table.busy)return{view:'table',busy:true};if(input.view==='table'){pauseDrill();$('#drill-panel').open=false;$('#guide-panel').open=false;$('#main').scrollIntoView();}else{const id=input.view==='drills'?'drill-panel':'guide-panel';if(!$('#'+id).open)openPanel(id);}updatePanelButtons();return{view:'table',panel:input.view==='table'?null:input.view};}});
  addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}
