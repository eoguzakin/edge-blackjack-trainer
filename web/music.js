// An original, quiet lounge loop: electric piano, bass, and brushed percussion.
// Render once, then loop a single buffer so playback has no timer drift or gaps.
const BPM=72, BEAT=60/BPM, BARS=16, LENGTH=BARS*4*BEAT, TAIL=6;
const hz=midi=>440*2**((midi-69)/12);

export async function renderLoungeLoop(OfflineContext=window.OfflineAudioContext) {
  const rate=32000, frames=Math.round(LENGTH*rate);
  const ctx=new OfflineContext(2,frames+TAIL*rate,rate);
  let seed=4129;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const master=ctx.createGain();master.gain.value=3.8;master.connect(ctx.destination);
  const reverb=ctx.createConvolver(),wet=ctx.createGain();wet.gain.value=.16;
  const impulse=ctx.createBuffer(2,rate*2,rate);
  for(let ch=0;ch<2;ch++){
    const data=impulse.getChannelData(ch);let smooth=0;
    for(let i=0;i<data.length;i++){smooth=.72*smooth+.28*(random()*2-1);data[i]=smooth*Math.exp(-i/(rate*.43));}
  }
  reverb.buffer=impulse;reverb.connect(wet);wet.connect(master);
  function output(envelope,pan,room=true){
    const panner=ctx.createStereoPanner();panner.pan.value=pan;
    envelope.connect(panner);panner.connect(master);if(room)panner.connect(reverb);
  }
  function piano(midi,time,duration=2.8,level=.07,pan=0){
    const t=time*BEAT,carrier=ctx.createOscillator(),modulator=ctx.createOscillator();
    const modulation=ctx.createGain(),envelope=ctx.createGain(),f=hz(midi);
    carrier.frequency.value=f;modulator.frequency.value=f*2;
    modulation.gain.setValueAtTime(f*.5,t);modulation.gain.exponentialRampToValueAtTime(f*.02,t+.65);
    modulator.connect(modulation);modulation.connect(carrier.frequency);
    envelope.gain.setValueAtTime(0,t);envelope.gain.linearRampToValueAtTime(level,t+.012);
    envelope.gain.exponentialRampToValueAtTime(.0001,t+duration);
    carrier.connect(envelope);output(envelope,pan);
    carrier.start(t);modulator.start(t);carrier.stop(t+duration+.05);modulator.stop(t+duration+.05);
  }
  function bass(midi,time,level=.13){
    const t=time*BEAT,osc=ctx.createOscillator(),env=ctx.createGain();
    osc.type='triangle';osc.frequency.value=hz(midi);
    const filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=260;
    env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(level,t+.024);env.gain.exponentialRampToValueAtTime(.0001,t+.75);
    osc.connect(filter);filter.connect(env);output(env,-.12,false);osc.start(t);osc.stop(t+.8);
  }
  const noise=ctx.createBuffer(1,rate,rate);
  const noiseData=noise.getChannelData(0);for(let i=0;i<noiseData.length;i++)noiseData[i]=random()*2-1;
  function brush(time,accent=false){
    const t=time*BEAT,source=ctx.createBufferSource(),high=ctx.createBiquadFilter(),low=ctx.createBiquadFilter(),env=ctx.createGain();
    source.buffer=noise;high.type='highpass';high.frequency.value=1400;low.type='lowpass';low.frequency.value=4300;
    env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(accent?.022:.009,t+.025);env.gain.exponentialRampToValueAtTime(.0001,t+(accent?.23:.1));
    source.connect(high);high.connect(low);low.connect(env);output(env,.28,false);source.start(t);source.stop(t+.3);
  }
  const progression=[
    {bass:41,chord:[57,60,64,67],melody:[72,69,67]}, // Fmaj9
    {bass:38,chord:[53,57,60,64],melody:[69,65,64]}, // Dm9
    {bass:43,chord:[53,57,58,62],melody:[69,70,74]}, // Gm9
    {bass:36,chord:[52,57,58,62],melody:[74,72,69]}, // C13
    {bass:41,chord:[57,60,64,67],melody:[76,72,69]},
    {bass:38,chord:[53,57,60,64],melody:[72,69,65]},
    {bass:43,chord:[53,57,58,62],melody:[70,69,67]},
    {bass:36,chord:[52,57,58,62],melody:[69,67,64]}
  ];
  for(let bar=0;bar<BARS;bar++){
    const harmony=progression[bar%8],start=bar*4;
    for(const [beat,velocity] of [[.12,.057],[2.64,.033]])harmony.chord.forEach((note,i)=>piano(note,start+beat+i*.035,2.8,velocity,-.3+i*.14));
    bass(harmony.bass,start);bass(harmony.bass+7,start+2,.085);
    if(bar%2===1)bass(harmony.bass+12,start+3.35,.055);
    for(let beat=0;beat<4;beat++){brush(start+beat,beat===1||beat===3);if(beat%2===0)brush(start+beat+.67);}
    // Space between the melody phrases keeps attention on the cards.
    if(bar%4!==3){
      const positions=bar<8?[.7,1.65,3.1]:[.4,1.72,2.8];
      harmony.melody.forEach((note,i)=>piano(note,start+positions[i],2.1,.047+i*.002,.22));
    }
  }
  const rendered=await ctx.startRendering();
  const loop=ctx.createBuffer(2,frames,rate);
  for(let ch=0;ch<2;ch++){
    const source=rendered.getChannelData(ch),target=loop.getChannelData(ch);
    target.set(source.subarray(0,frames));
    // Carry the final chord/reverb tail into the first bar for a seamless join.
    for(let i=frames;i<source.length;i++)target[i-frames]+=source[i];
  }
  return loop;
}

export class LoungeMusic {
  constructor(notify){
    this.notify=notify;this.context=null;this.buffer=null;this.source=null;this.loading=false;
    this.level=.3;
    try{const saved=localStorage.getItem('edge-music-volume');if(saved!==null&&Number.isFinite(Number(saved)))this.level=Math.min(1,Math.max(0,Number(saved)));}catch{}
    this.button=document.querySelector('#music-toggle');this.slider=document.querySelector('#music-volume');
    this.slider.value=String(Math.round(this.level*100));
    this.button.addEventListener('click',()=>this.toggle());
    this.slider.addEventListener('input',()=>{this.level=Number(this.slider.value)/100;if(this.gain)this.gain.gain.setTargetAtTime(this.level,this.context.currentTime,.08);try{localStorage.setItem('edge-music-volume',String(this.level));}catch{}});
    addEventListener('pagehide',()=>{this.source?.stop();this.source=null;if(this.context&&this.context.state!=='closed')this.context.close().catch(()=>{});this.update();});
    this.update();
  }
  update(){
    const playing=!!this.source;
    this.button.setAttribute('aria-pressed',String(playing));this.button.disabled=this.loading;
    this.button.dataset.state=this.loading?'loading':playing?'playing':'off';
    this.button.setAttribute('aria-label',playing?'Pause background music':'Play background music');
    this.button.querySelector('span').textContent=this.loading?'Loading…':playing?'Music on':'Music off';
  }
  async toggle(){
    if(this.loading)return;
    if(this.source){this.source.stop();this.source=null;await this.context.suspend();this.update();return;}
    try{
      const Audio=window.AudioContext||window.webkitAudioContext;
      if(!Audio||!window.OfflineAudioContext)throw new Error('Audio unavailable');
      if(!this.context||this.context.state==='closed'){
        this.context=new Audio();this.gain=this.context.createGain();this.gain.gain.value=this.level;this.gain.connect(this.context.destination);
      }
      // Resume directly in the click gesture; never autoplay on load.
      const resumed=this.context.resume();this.loading=true;this.update();await resumed;
      this.buffer??=await renderLoungeLoop();
      this.source=this.context.createBufferSource();this.source.buffer=this.buffer;this.source.loop=true;this.source.connect(this.gain);this.source.start();
    }catch{this.source?.stop();this.source=null;this.notify('Music could not start. Tap Music to try again.');}
    finally{this.loading=false;this.update();}
  }
}
