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
  constructor(){ FakeRecognition.latest=this; }
  start(){ if(this.onstart) this.onstart(); }
  stop(){ if(this.onend) this.onend(); }
  emit(text,isFinal){
    const result=[{transcript:text}];
    result.isFinal=!!isFinal;
    if(this.onresult) this.onresult({resultIndex:0,results:[result]});
  }
}
window.webkitSpeechRecognition=FakeRecognition;

function load(file){ vm.runInThisContext(fs.readFileSync(file,'utf8'),{filename:path.basename(file)}); }
load(path.join(ROOT,'vendor','react.js'));
load(path.join(ROOT,'vendor','react-dom.js'));
load(path.join(ROOT,'vendor','three.min.js'));
window.React=global.React||window.React;
window.ReactDOM=global.ReactDOM;
window.THREE=global.THREE;
load(path.join(ROOT,'app.compiled.js'));

const click=el=>el.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const setTextarea=(el,value)=>{
  const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(el,value);
  el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
};
const button=(root,re)=>[...root.querySelectorAll('button')].find(b=>re.test(b.textContent.trim()));

(async()=>{
  await wait(250);
  const root=document.getElementById('root');
  click(button(root,/^TEXT TO SIGN$/));
  await wait(80);
  click(button(root,/^العربية AR$/));
  await wait(50);

  const area=root.querySelector('textarea[placeholder^="Type a sentence"]');
  if(!area) throw new Error('English Text to Sign input missing');
  setTextarea(area,'Hello,\n café!');
  await wait(60);
  const tokens=[...root.querySelectorAll('.tokens .token')];
  if(tokens.length!==11) throw new Error('token sequence is stale or malformed: '+tokens.length);
  if(tokens.some(t=>t.classList.contains('token-txt'))) throw new Error('common punctuation/accent became unsupported token');
  if(!root.textContent.includes('SIGNED 0/11')) throw new Error('token progress did not render immediately');
  console.log('PASS typed multilingual text renders normalized tokens immediately');

  setTextarea(area,'AB');
  await wait(40);
  click(button(root,/^400ms$/));
  click(button(root,/^PLAY SIGNS$/));
  await wait(40);
  const stop=button(root,/^STOP$/);
  if(!stop) throw new Error('avatar playback did not start');
  click(stop);
  await wait(40);
  if(!button(root,/^PLAY SIGNS$/)) throw new Error('avatar STOP did not interrupt promptly');
  console.log('PASS avatar play/stop lifecycle remains responsive');

  click(button(root,/^CLEAR$/));
  await wait(30);
  click(button(root,/^VOICE INPUT$/));
  await wait(10);
  FakeRecognition.latest.emit('hello',false);
  await wait(30);
  if(area.value!=='hello') throw new Error('voice interim missing: '+area.value);
  FakeRecognition.latest.emit('hello world',true);
  await wait(30);
  FakeRecognition.latest.emit('hello world',true);
  await wait(30);
  if(area.value!=='hello world') throw new Error('voice phrase duplicated or lost: '+area.value);
  click(button(root,/^STOP VOICE$/));
  await wait(30);
  if(area.value!=='hello world') throw new Error('stopping voice changed final text');
  console.log('PASS voice input merges interim, expanded, and duplicate results');

  console.log('TEXT TO SIGN TESTS PASSED');
  process.exit(0);
})().catch(err=>{ console.error('FAIL',err); process.exit(1); });
