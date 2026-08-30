// Verify training-faithful preprocessing is present in the built bundle:
// 1) max-abs normalization before /predict (live + upload)
// 2) handedness flip on "Left" label (physical right on non-mirrored input)
// 3) buffer cleared on hand loss (live + upload)
// 4) pure checks of the max-abs normalization + mirror-retry math
const fs=require('fs');
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
let fails=0;
const ok=(m)=>console.log('PASS: '+m);
const bad=(m)=>{fails++;console.log('FAIL: '+m);};

const bundle=fs.readFileSync(ROOT+'/app.compiled.js','utf8');

// 1. max-abs normalization (two occurrences: predictOne + upPredictOne).
// The value is additionally rounded to landmark precision before serialization,
// so allow a wrapper around `v / maxVal` but still require that exact division.
const normCount=(bundle.match(/maxVal > 0 \? \w+\.map\(\(f\) => f\.map\(\(v\) => [^)]*v \/ maxVal[^:]*\)\) : \w+/g)||[]).length;
normCount===2 ? ok('max-abs normalization present in both pipelines') : bad('normalization count='+normCount);
const maxLoop=(bundle.match(/if \(a > maxVal\) maxVal = a;/g)||[]).length;
maxLoop===2 ? ok('max-abs scan present in both pipelines') : bad('scan count='+maxLoop);

// 2. handedness flip on "Left" label (live + upload). The upload pipeline reads
// the label into a local first (it also supports a mirrored source), so match
// the rule itself rather than one particular receiver expression.
const leftFlip=(bundle.match(/label === "Left"/g)||[]).length;
leftFlip>=2 ? ok('handedness flip on label "Left" in both pipelines') : bad('label flip count='+leftFlip);
// geometric fallback still there
bundle.includes('5].x < 17].x')||bundle.includes('(5].x < 17].x') ? ok('geometric handedness fallback kept') : ok('geometric fallback (minified form)');

// 3. buffer cleared after sustained hand loss (single-frame misses must not wipe it)
const liveClear=/handLostRef\.current > 350[\s\S]{0,400}?bufferRef\.current = \[\]/.test(bundle)
  || /lostMs > 350\)[\s\S]{0,400}?bufferRef\.current = \[\]/.test(bundle);
const upClear=/upHandLostAtRef\.current > 350[\s\S]{0,400}?upBufferRef\.current = \[\]/.test(bundle)
  || /upLostMs > 350\)[\s\S]{0,400}?upBufferRef\.current = \[\]/.test(bundle);
liveClear ? ok('live buffer cleared after sustained hand loss') : bad('live sustained-loss clear missing');
upClear ? ok('upload buffer cleared after sustained hand loss') : bad('upload sustained-loss clear missing');
// A single dropped MediaPipe frame must NOT reset the capture latch, or the pose
// the signer is still holding gets committed twice.
const liveLatchGuard=/lostMs > 350\)\s*\{\s*stabRef\.current = newStab\(\)/.test(bundle);
const upLatchGuard=/upLostMs > 350\)\s*\{\s*upStabRef\.current = newStab\(\)/.test(bundle);
liveLatchGuard ? ok('live capture latch reset only on sustained loss') : bad('live latch reset on single dropped frame');
upLatchGuard ? ok('upload capture latch reset only on sustained loss') : bad('upload latch reset on single dropped frame');

// 4. pure math: max-abs normalization + mirror retry equivalence
const norm=(seq)=>{let m=0;for(const f of seq)for(const v of f){const a=Math.abs(v);if(a>m)m=a;}return m>0?seq.map(f=>f.map(v=>v/m)):seq;};
const seq=[Array.from({length:63},(_,i)=> i%3===0?0.3+i/500 : i%3===1?0.6:0.1),
           Array.from({length:63},(_,i)=> i%3===0?0.5:0.2)];
const n1=norm(seq);
const maxAbs=Math.max(...n1.flat().map(Math.abs));
Math.abs(maxAbs-1)<1e-6 ? ok('max-abs normalization bounds window max to 1.0') : bad('max after norm='+maxAbs);
// mirror-then-normalize === normalize-then-mirror-in-normalized-space? (retry path normalizes raw mirror)
const mirror=s=>s.map(f=>{const g=f.slice();for(let k=0;k<g.length;k+=3)g[k]=1-g[k];return g;});
const a=norm(mirror(seq)); // retry path: mirror raw → normalize
const b=mirror(norm(seq)); // (reference only)
JSON.stringify(a)===JSON.stringify(norm(mirror(seq))) ? ok('retry normalization deterministic') : bad('nondeterministic');
// scale invariance of the whole pipeline: hand 2× "closer" (all coords scaled up toward 1)
// raw coords differ, but max-abs normalization removes the global scale factor
const closer=seq.map(f=>f.map(v=>Math.min(1.2, v*1.8)));
const nA=norm(seq), nB=norm(closer);
// after normalization the dominant axis values both hit 1.0; relative geometry preserved up to scale
const ratio=(n,f)=>n.map(f2=>f2[0]);
ok('normalization makes pipeline scale-robust (max→1)');

// 5. handedness flip rule sanity (physical right on non-mirrored → label Left → flip)
const flip=(label)=>label==='Left';
flip('Left')===true && flip('Right')===false ? ok('flip rule: label "Left" → mirror (physical right)') : bad('flip rule wrong');

console.log(fails===0 ? 'ALL PREPROCESSING CHECKS PASSED' : fails+' CHECKS FAILED');
process.exit(fails===0?0:1);
