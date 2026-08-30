const fs=require('fs'),path=require('path'),vm=require('vm');
const {JSDOM}=require('jsdom');
const ROOT=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
const source=(html.match(/<script type="text\/plain" id="app-source">([\s\S]*?)<\/script>/)||[])[1]||'';
if(!source.includes("P([0.02,1,1,1,1],0,[0,0,-1.57],null,0.10)")) throw new Error('Arabic Alef is not oriented thumb-up');
if(!source.includes('const fitZ=4.72-') || !source.includes('motionDur={shake:1.15')) throw new Error('avatar framing or motion settling missing');

const dom=new JSDOM(html,{url:'http://127.0.0.1:8131/',pretendToBeVisual:true,runScripts:'outside-only'});
global.window=dom.window; global.document=dom.window.document;
global.navigator=dom.window.navigator; global.location=dom.window.location;
global.localStorage=dom.window.localStorage; global.self=global;
dom.window.HTMLCanvasElement.prototype.getContext=()=>null;
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
const button=(root,re)=>[...root.querySelectorAll('button')].find(b=>re.test(b.textContent.trim()));
(async()=>{
  await wait(250);
  const root=document.getElementById('root');
  click(button(root,/^ALPHABET$/));
  await wait(80);
  click(root.querySelector('.alpha-card'));
  await wait(40);
  if(!/SIGNING:/.test(root.textContent)) throw new Error('avatar card did not select a pose');
  click(button(root,/^ENGLISH \(26\)$/));
  await wait(40);
  if(root.querySelector('.alpha-card.alpha-on')) throw new Error('old-language pose remained selected');
  if(!root.textContent.includes('Pick a letter from the gallery.')) throw new Error('avatar status did not reset on language change');
  console.log('PASS avatar pose framing, motion limits, Alef orientation, and language reset');
  console.log('AVATAR UI TESTS PASSED');
  process.exit(0);
})().catch(err=>{ console.error('FAIL',err); process.exit(1); });
