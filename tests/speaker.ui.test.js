const fs=require('fs'),path=require('path'),vm=require('vm');
const {JSDOM}=require('jsdom');
const ROOT=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
const dom=new JSDOM(html,{url:'http://127.0.0.1:8131/',pretendToBeVisual:true,runScripts:'outside-only'});
global.window=dom.window; global.document=dom.window.document;
global.navigator=dom.window.navigator; global.location=dom.window.location;
global.localStorage=dom.window.localStorage; global.self=global;
dom.window.HTMLCanvasElement.prototype.getContext=()=>null;

class FakeRecognition {
  static latest=null;
  constructor(){ FakeRecognition.latest=this; this._results=[]; }
  start(){ if(this.onstart) this.onstart(); }
  abort(){ if(this.onend) this.onend(); }
  stop(){
    const result=[{transcript:'hello world'}]; result.isFinal=true;
    if(this.onresult) this.onresult({resultIndex:0,results:[result]});
    if(this.onend) this.onend();
  }
  interim(text){
    const result=[{transcript:text}]; result.isFinal=false;
    if(this.onresult) this.onresult({resultIndex:0,results:[result]});
  }
}
window.webkitSpeechRecognition=FakeRecognition;

function load(file){vm.runInThisContext(fs.readFileSync(file,'utf8'),{filename:path.basename(file)});}
load(path.join(ROOT,'vendor','react.js'));
load(path.join(ROOT,'vendor','react-dom.js'));
load(path.join(ROOT,'vendor','three.min.js'));
window.React=global.React||window.React; window.ReactDOM=global.ReactDOM; window.THREE=global.THREE;
load(path.join(ROOT,'app.compiled.js'));

const click=(el)=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

(async()=>{
  await wait(250);
  const root=document.getElementById('root');
  const rooms=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()==='SIGN ROOMS');
  click(rooms); await wait(100);
  const hearing=[...root.querySelectorAll('button')].find(b=>/HEARING/.test(b.textContent));
  click(hearing); await wait(50);
  const start=[...root.querySelectorAll('button')].find(b=>/START RECORDING/.test(b.textContent));
  click(start); await wait(20);
  FakeRecognition.latest.interim('hello'); await wait(20);
  const area=root.querySelector('#room-chat-card textarea');
  if(area.value!=='hello') throw new Error('interim speech not shown: '+area.value);
  const stop=[...root.querySelectorAll('button')].find(b=>/إيقاف التسجيل/.test(b.textContent));
  click(stop); await wait(30);
  if(area.value!=='hello world') throw new Error('final words lost on stop: '+area.value);
  console.log('PASS hearing mode preserves interim and stop-time final speech');
  console.log('SPEAKER UI TEST PASSED');
  process.exit(0);
})().catch(err=>{console.error('FAIL',err);process.exit(1);});
