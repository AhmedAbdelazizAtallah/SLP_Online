// Unit checks for confusable-letter hardening v2 (distance-ratio A/T test)
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
let fails=0;
const ok=(m)=>console.log('PASS: '+m);
const bad=(m)=>{fails++;console.log('FAIL: '+m);};

const html=fs.readFileSync(path.join(ROOT,'app.html'),'utf8');
const m=html.match(/<script type="text\/plain" id="app-source">([\s\S]*?)<\/script>/);
if(!m){console.log('FAIL: app-source not found');process.exit(1);}
const src=m[1];

function grab(name){
  const i=src.indexOf('function '+name+'(');
  if(i<0) return null;
  let d=0,st=false,j=i;
  for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true;}if(c==='}'){d--;if(st&&d===0){j++;break;}}}
  return src.slice(i,j);
}
const atSrc=grab('atArbitrate'), pmSrc=grab('pairMass');
const CONF=src.match(/const CONFUSABLE_EN = \{[\s\S]*?\n\};/)?.[0]||'';
const CONFA=src.match(/const CONFUSABLE_AR = \{[\s\S]*?\n\};/)?.[0]||'';
if(!atSrc||!pmSrc||!CONF||!CONFA){console.log('FAIL: helper extraction failed');process.exit(1);}
const sandbox={console};
vm.createContext(sandbox);
vm.runInContext(CONF+'\n'+CONFA+'\n'+atSrc+'\n'+pmSrc+'\nthis.__out={atArbitrate,pairMass,CONFUSABLE_EN,CONFUSABLE_AR};', sandbox, {filename:'helpers.js'});
const at=sandbox.__out.atArbitrate, pm=sandbox.__out.pairMass;
(typeof at==='function') ? ok('atArbitrate extracted') : bad('atArbitrate missing');
(typeof pm==='function') ? ok('pairMass extracted') : bad('pairMass missing');

// Synthetic hand builder. thumbMode:
//  'A'  → thumb tip hugging index PIP (clearly closer to index)
//  'T'  → thumb tip between index and middle (≈equidistant), PIPs spread
//  'S'  → thumb crossed over, near middle/ring but fingers TOGETHER (guard)
function hand(mode, scale){
  scale=scale||1;
  const f=new Array(63).fill(0);
  const S=(v)=>0.5+(v-0.5)*scale; // scale all x/y toward frame center
  const set=(i,x,y)=>{f[i*3]=S(x);f[i*3+1]=S(y);f[i*3+2]=0;};
  set(0, 0.50,0.90);  // wrist
  set(5, 0.44,0.70);  // index MCP
  set(6, 0.44,0.61);  // index PIP
  set(9, 0.50,0.68);  // middle MCP
  set(10,0.50,0.60);  // middle PIP
  set(17,0.60,0.72);  // pinky MCP
  if(mode==='A'){ set(4,0.435,0.615); }            // thumb at index PIP
  else if(mode==='T'){ set(6,0.425,0.615); set(10,0.535,0.595); set(4,0.472,0.645); } // spread + between
  else if(mode==='S'){ set(4,0.50,0.615); }        // thumb over middle, fingers together
  return f;
}
at(hand('A'))==='A' ? ok('A pose → A') : bad('A pose → '+at(hand('A')));
at(hand('T'))==='T' ? ok('T pose → T') : bad('T pose → '+at(hand('T')));
at(hand('S'))===null ? ok('S pose → null (guard: model answer kept)') : bad('S pose → '+at(hand('S')));
// THE INVERSION CHECKS — closer & further must not flip the letter
at(hand('A',0.5))==='A' ? ok('A at 2× distance → still A (no inversion)') : bad('A far → '+at(hand('A',0.5)));
at(hand('A',2.0))==='A' ? ok('A at 2× closer → still A (no inversion)') : bad('A near → '+at(hand('A',2.0)));
at(hand('T',0.5))==='T' ? ok('T at 2× distance → still T (no inversion)') : bad('T far → '+at(hand('T',0.5)));
at(hand('T',2.0))==='T' ? ok('T at 2× closer → still T (no inversion)') : bad('T near → '+at(hand('T',2.0)));
// mirrored input must not change the verdict (distance ratios are mirror-invariant)
const mir=f=>f.map((v,i)=> i%3===0 ? 1-v : v);
at(mir(hand('A')))==='A' ? ok('mirrored A → A') : bad('mirrored A → '+at(mir(hand('A'))));
at(mir(hand('T')))==='T' ? ok('mirrored T → T') : bad('mirrored T → '+at(mir(hand('T'))));
at(null)===null ? ok('null feats → null') : bad('null crash');
at(new Array(10).fill(0))===null ? ok('short feats → null') : bad('short crash');

// pairMass regression
const rec=[
  {top3:[{letter:'A',conf:0.5},{letter:'T',conf:0.4}]},
  {top3:[{letter:'T',conf:0.6},{letter:'A',conf:0.3}]},
  {top3:[{letter:'T',conf:0.55},{letter:'A',conf:0.35}]},
];
let r=pm(rec,'A',['T']);
r.sP['T']>r.sX ? ok('mass voting detects T dominance') : bad('mass wrong: '+JSON.stringify(r));
r=pm([{top3:[{letter:'A',conf:0.9}]}],'A',['T']);
r.sX>r.sP['T'] ? ok('clear A keeps committing') : bad('clear A blocked');

console.log(fails===0 ? 'ALL HARDENING CHECKS PASSED' : fails+' CHECKS FAILED');
process.exit(fails===0?0:1);
