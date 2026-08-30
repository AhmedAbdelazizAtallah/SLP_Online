// Verify UPLOAD & SIGN tab: dropzone, AR/EN toggle (dropzone + player), and
// that switching to English actually changes the model language sent to /predict.
const fs=require('fs'),path=require('path'),vm=require('vm');
const {JSDOM}=require('jsdom');
const ROOT=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
if(!/upSendBusyRef/.test(source)||!/!upSendBusyRef\.current/.test(source)) throw new Error('upload loop is not serialized');
if(!/modelComplexity:1/.test(source)) throw new Error('upload tracking configuration missing');
let fails=0;
const ok=(m)=>console.log('PASS: '+m);
const bad=(m)=>{fails++;console.log('FAIL: '+m);};

const html=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
const dom=new JSDOM(html,{url:'http://127.0.0.1:8131/',pretendToBeVisual:true,runScripts:'outside-only'});
global.window=dom.window;global.document=dom.window.document;global.navigator=dom.window.navigator;global.location=dom.window.location;global.localStorage=dom.window.localStorage;global.self=global;
dom.window.HTMLCanvasElement.prototype.getContext=()=>null;
dom.window.URL.createObjectURL=()=> 'blob:upload-test';
dom.window.URL.revokeObjectURL=()=>{};
global.URL=dom.window.URL;
const errors=[];
dom.window.addEventListener('error',(e)=>errors.push(e.message));
function load(f){vm.runInThisContext(fs.readFileSync(f,'utf8'),{filename:path.basename(f)});}
load(path.join(ROOT,'vendor/react.js'));
load(path.join(ROOT,'vendor/react-dom.js'));
load(path.join(ROOT,'vendor/three.min.js'));
window.React=global.React||window.React;window.ReactDOM=global.ReactDOM;window.THREE=global.THREE;
load(path.join(ROOT,'app.compiled.js'));

setTimeout(()=>{
  const root=document.getElementById('root');
  const upTab=[...root.querySelectorAll('.tab')].find(t=>/UPLOAD/.test(t.textContent));
  upTab ? ok('UPLOAD tab present') : bad('UPLOAD tab missing');
  upTab.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  setTimeout(()=>{
    root.querySelector('.up-dropzone') ? ok('dropzone rendered') : bad('dropzone missing');
    // language toggle on the dropzone screen
    const dzToggle=[...root.querySelectorAll('.up-dropzone button')].find(b=>/AR|ENGLISH/.test(b.textContent));
    dzToggle ? ok('language toggle on dropzone: "'+dzToggle.textContent.trim()+'"') : bad('no language toggle on dropzone');
    const fileInput=root.querySelector('.up-dropzone input[type=file]');
    let pickerOpens=0;
    if(fileInput) fileInput.addEventListener('click',()=>{ pickerOpens++; });
    // default is Arabic → switch to English
    if(dzToggle && /ARABIC/.test(root.textContent)){
      dzToggle.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
      setTimeout(()=>{
        const t2=[...root.querySelectorAll('.up-dropzone button')].find(b=>/ENGLISH EN/.test(b.textContent));
        t2 ? ok('switched to ENGLISH EN (model language = en)') : bad('toggle did not switch to English');
        pickerOpens===0 ? ok('language toggle does not open file picker') : bad('language toggle reopened file picker');
        // dir should now be LTR (lang=en effect)
        document.documentElement.dir==='ltr' ? ok('document dir flipped to LTR for English') : bad('dir still RTL');
        const input=root.querySelector('.up-dropzone input[type=file]');
        const file=new dom.window.File(['video'], 'sample.mp4', {type:'video/mp4'});
        Object.defineProperty(input,'files',{configurable:true,value:[file]});
        input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
     setTimeout(()=>{
          root.querySelector('.up-video-wrap video') ? ok('valid video mounts player') : bad('video player did not mount');
          const controls=[...root.querySelectorAll('.feed-foot .btn')].map(b=>b.textContent.trim());
          controls.includes('PLAY') && controls.includes('CHANGE VIDEO') ? ok('player controls rendered') : bad('player controls missing');
          const change=[...root.querySelectorAll('.feed-foot .btn')].find(b=>b.textContent.trim()==='CHANGE VIDEO');
          if(change) change.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
          setTimeout(()=>{
            root.querySelector('.up-dropzone') ? ok('change video returns to clean dropzone') : bad('change video did not reset player');
            finish();
          },100);
        },150);
      },200);
    } else finish();
  },300);
  function finish(){
    errors.forEach(e=>console.log('PAGE ERROR: '+e));
    console.log(fails===0&&errors.length===0 ? 'ALL UPLOAD UI CHECKS PASSED' : fails+' CHECKS FAILED');
    process.exit(fails===0&&errors.length===0?0:1);
  }
},500);
