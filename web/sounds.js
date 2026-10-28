export class TableSounds{
  constructor(notify){
    this.notify=notify;this.context=null;this.volume=.35;this.enabled=false;
    try{this.enabled=localStorage.getItem('edge-sounds')==='on';const saved=Number(localStorage.getItem('edge-sounds-volume')??.35);if(Number.isFinite(saved))this.volume=Math.min(1,Math.max(0,saved));}catch{}
    this.button=document.getElementById('sounds-toggle');this.slider=document.getElementById('sounds-volume');
    this.button.addEventListener('click',()=>{this.enabled=!this.enabled;this.unlock();this.save();this.update();if(this.enabled)this.play('chip');});
    this.slider.value=Math.round(this.volume*100);this.slider.addEventListener('input',()=>{this.volume=Number(this.slider.value)/100;this.save();});this.update();
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&this.context?.state==='running')this.context.suspend().catch(()=>{});else if(!document.hidden&&this.enabled&&this.context?.state==='suspended')this.context.resume().catch(()=>{});});
  }
  save(){try{localStorage.setItem('edge-sounds',this.enabled?'on':'off');localStorage.setItem('edge-sounds-volume',String(this.volume));}catch{}}
  update(){this.button.setAttribute('aria-pressed',String(this.enabled));this.button.textContent=`Sounds ${this.enabled?'on':'off'}`;}
  unlock(){if(!this.enabled)return;try{this.context??=new (window.AudioContext||window.webkitAudioContext)();if(this.context.state==='suspended')this.context.resume().catch(()=>{});}catch{this.enabled=false;this.update();this.notify('Game sounds are unavailable in this browser.');}}
  tone(freq,start,duration,volume,type='sine',end=freq){
    const c=this.context,osc=c.createOscillator(),gain=c.createGain();osc.type=type;osc.frequency.setValueAtTime(freq,start);osc.frequency.exponentialRampToValueAtTime(Math.max(1,end),start+duration);
    gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(volume*this.volume,start+.006);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);osc.connect(gain).connect(c.destination);osc.start(start);osc.stop(start+duration+.01);osc.onended=()=>{osc.disconnect();gain.disconnect();};
  }
  noise(start,duration,volume,frequency){
    const c=this.context,buffer=c.createBuffer(1,Math.ceil(c.sampleRate*duration),c.sampleRate),data=buffer.getChannelData(0);
    for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length)**2;
    const source=c.createBufferSource(),gain=c.createGain(),filter=c.createBiquadFilter();source.buffer=buffer;filter.type='bandpass';filter.frequency.value=frequency;filter.Q.value=.65;gain.gain.value=volume*this.volume;
    source.connect(filter).connect(gain).connect(c.destination);source.start(start);source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
  }
  cardTouch(start){
    // A brief, muted paper contact. No pitched sweep or bass thump.
    const c=this.context,duration=.042,buffer=c.createBuffer(1,Math.ceil(c.sampleRate*duration),c.sampleRate),data=buffer.getChannelData(0);
    for(let i=0;i<data.length;i++){const p=i/data.length;data[i]=(Math.random()*2-1)*Math.sin(Math.PI*Math.min(1,p*6))*Math.exp(-p*5);}
    const source=c.createBufferSource(),filter=c.createBiquadFilter(),gain=c.createGain();
    source.buffer=buffer;filter.type='lowpass';filter.frequency.value=1250;filter.Q.value=.45;gain.gain.value=.13*this.volume;
    source.connect(filter).connect(gain).connect(c.destination);source.start(start);
    source.onended=()=>{source.disconnect();filter.disconnect();gain.disconnect();};
  }
  play(event){
    if(!this.enabled||!this.context||this.context.state!=='running'||document.hidden)return;
    const t=this.context.currentTime+.005;
    if(event==='deal'||event==='reveal')this.cardTouch(t);
    if(event==='chip'){this.noise(t,.045,.25,3700);this.tone(1850,t,.055,.11,'sine',900);this.tone(2300,t+.035,.06,.07,'sine',1400);}
    if(event==='win')[523.25,659.25,783.99,1046.5].forEach((f,i)=>this.tone(f,t+i*.075,.4,.09,'sine'));
    if(event==='loss'){this.tone(220,t,.35,.09,'triangle',165);this.tone(130.8,t+.08,.4,.08);}
    if(event==='push'){this.tone(392,t,.25,.07);this.tone(523.25,t+.08,.3,.065);}
  }
}
