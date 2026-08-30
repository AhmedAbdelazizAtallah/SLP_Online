// Latency + landmark-discrimination regression suite.
//
// Extracts the real helpers/constants from the built bundle and asserts the
// structural guarantees that keep recognition fast and keep the curled-finger
// Arabic families apart.
//
// Covered:
//   1. sign-boundary window flush (the ~1s stale-window latency + ج/ح/خ blend)
//   2. no prediction round trips are spent on a travelling hand
//   3. the mirror retry remembers the winning orientation (1 round trip, not 2)
//   4. the /predict payload is rounded (was ~28KB of JSON per frame)
//   5. the live pipeline uses the accurate landmark model, with a safe fallback
//   6. per-prediction full-App re-render churn is throttled
//   7. jhkArbitrate separates ج / ح / خ, is scale- and mirror-invariant, and
//      returns null on anything that is not one of the three
//   8. CONFUSABLE_AR covers خ and غ (both were missing)
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const bundle = fs.readFileSync(ROOT + '/app.compiled.js', 'utf8');

let fails = 0;
const ok = (m) => console.log('PASS: ' + m);
const bad = (m) => { fails++; console.log('FAIL: ' + m); };

function sliceBlock(startMarker) {
  const i = bundle.indexOf(startMarker);
  if (i < 0) throw new Error('marker not found: ' + startMarker);
  let j = bundle.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < bundle.length; k++) {
    if (bundle[k] === '{') depth++;
    else if (bundle[k] === '}') { depth--; if (depth === 0) return bundle.slice(j, k + 1); }
  }
  throw new Error('unbalanced block: ' + startMarker);
}
function topLevelFn(name) {
  const head = 'function ' + name + '(';
  const i = bundle.indexOf(head);
  if (i < 0) throw new Error('helper not found: ' + name);
  const args = bundle.slice(bundle.indexOf('(', i) + 1, bundle.indexOf(')', i));
  // eslint-disable-next-line no-new-func
  return new Function('return function ' + name + '(' + args + ')' + sliceBlock(head) + ';')();
}
function constNum(name) {
  const m = bundle.match(new RegExp('(?:var|const|let)\\s+' + name + '\\s*=\\s*([0-9.]+)'));
  if (!m) throw new Error('constant not found: ' + name);
  return parseFloat(m[1]);
}

/* ================= 1-2. sign-boundary window flush ================= */
const SIGN_BOUNDARY_FRAMES = constNum('SIGN_BOUNDARY_FRAMES');
SIGN_BOUNDARY_FRAMES >= 2 && SIGN_BOUNDARY_FRAMES <= 6
  ? ok('SIGN_BOUNDARY_FRAMES is a real transition, not jitter (' + SIGN_BOUNDARY_FRAMES + ')')
  : bad('SIGN_BOUNDARY_FRAMES out of range: ' + SIGN_BOUNDARY_FRAMES);

// The flush must drop the buffer AND the per-letter caches that describe the
// letter being left behind, on both pipelines.
const liveFlush = /travel\.flushed = true;[\s\S]{0,320}?bufferRef\.current = \[\][\s\S]{0,220}?recentPredsRef\.current = \[\]/.test(bundle);
const upFlush = /upTravel\.flushed = true;[\s\S]{0,320}?upBufferRef\.current = \[\][\s\S]{0,220}?upRecentPredsRef\.current = \[\]/.test(bundle);
liveFlush ? ok('live pipeline flushes the stale window at a sign boundary') : bad('live sign-boundary flush missing');
upFlush ? ok('upload pipeline flushes the stale window at a sign boundary') : bad('upload sign-boundary flush missing');

// Travelling frames must not enter the window, and must not buy a round trip.
const liveNoPush = /if \(!travelling\) \{\s*bufferRef\.current\.push/.test(bundle);
const liveNoPredict = /if \(!travelling && bufferRef\.current\.length >= minFill\)/.test(bundle);
const upNoPush = /if \(!upTravelling\) \{\s*upBufferRef\.current\.push/.test(bundle);
const upNoPredict = /if \(!upTravelling && upBufferRef\.current\.length >= MIN_FILL\)/.test(bundle);
liveNoPush ? ok('live: travelling frames never pollute the window') : bad('live still buffers travelling frames');
liveNoPredict ? ok('live: no round trip is spent on a travelling hand') : bad('live still predicts while travelling');
upNoPush ? ok('upload: travelling frames never pollute the window') : bad('upload still buffers travelling frames');
upNoPredict ? ok('upload: no round trip is spent on a travelling hand') : bad('upload still predicts while travelling');

// After a flush, padding must be able to refill the window from the new pose.
/while \(seq\.length < WINDOW\) \{\s*seq\.push\(seq\[seq\.length - 1\]\)/.test(bundle)
  ? ok('padding refills the window from the newest frame after a flush')
  : bad('window padding missing — a flush would stall prediction');

/* ================= 3. orientation memory ================= */
const mirrorSeq = topLevelFn('mirrorSeq');
const frame = Array.from({ length: 63 }, (_, i) => (i % 3 === 0 ? 0.2 + i / 400 : i % 3 === 1 ? 0.55 : -0.03));
const seq2 = [frame, frame.map((v, i) => (i % 3 === 0 ? v + 0.05 : v))];
const win = /flipWinRef\.current = mirrored \? -1 : 1/.test(bundle);
const first = /const mirrored = isRetry \? \(?flipWinRef\.current !== -1\)? : \(?flipWinRef\.current === -1\)?/.test(bundle);
win ? ok('the winning hand orientation is recorded') : bad('orientation win not recorded');
first ? ok('the first attempt uses the winning orientation (1 round trip, not 2)') : bad('orientation memory not used for the first attempt');
// The retry must mirror the ORIGINAL window, never a mirror-of-a-mirror, so the
// recursion cannot drift. (1-(1-x) is not bit-exact in binary floating point,
// hence the tolerance rather than a strict compare.)
/if \(!isRetry && p && p\.confidence < confGate\) return predictOne\(seq, true\)/.test(bundle)
  ? ok('the retry re-mirrors the original window (no cumulative drift)') : bad('retry does not re-derive from the original window');
const rt = mirrorSeq(mirrorSeq(seq2));
rt.every((f, i) => f.every((v, k) => Math.abs(v - seq2[i][k]) < 1e-12))
  ? ok('mirrorSeq round-trips to the original window') : bad('mirrorSeq is not an involution');
// and it must only move x
const m1 = mirrorSeq(seq2);
m1.every((f, i) => f.every((v, k) => (k % 3 === 0 ? Math.abs(v - (1 - seq2[i][k])) < 1e-12 : v === seq2[i][k])))
  ? ok('mirrorSeq flips x only (height and depth untouched)') : bad('mirrorSeq altered y or z');

/* ================= 4. payload size ================= */
const rounded = (bundle.match(/Math\.round\(v \/ maxVal \* 1e4\) \/ 1e4/g) || []).length;
rounded === 2 ? ok('both pipelines round the /predict payload to landmark precision') : bad('payload rounding count=' + rounded);
// prove the size win on a realistic window
const win23 = Array.from({ length: 23 }, () => Array.from({ length: 63 }, (_, i) => (i * 7 % 100) / 300 + 0.0001234567));
const full = JSON.stringify(win23);
const cut = JSON.stringify(win23.map(f => f.map(v => Math.round(v * 1e4) / 1e4)));
cut.length * 2 < full.length
  ? ok('rounding more than halves the JSON (' + full.length + ' -> ' + cut.length + ' bytes/frame)')
  : bad('rounding did not shrink the payload: ' + full.length + ' -> ' + cut.length);

/* ================= 5. landmark model quality ================= */
// The live tab must no longer be the least accurate path in the app.
/modelComplexity: handComplexityRef\.current/.test(bundle)
  ? ok('live landmark complexity is driven by handComplexityRef') : bad('live modelComplexity still hard-coded');
/handComplexityRef = useRef\(1\)/.test(bundle)
  ? ok('live pipeline defaults to the ACCURATE landmark model') : bad('live pipeline still defaults to the lite model');
const gates = (bundle.match(/minDetectionConfidence: 0\.5, minTrackingConfidence: 0\.5/g) || []).length;
gates >= 1 ? ok('tracking gates relaxed so curled-finger signs keep tracking') : bad('tracking gates still 0.6');
// the downgrade must be one-way so it cannot oscillate
/if \(handComplexityRef\.current === 1\)[\s\S]{0,400}?handComplexityRef\.current = 0/.test(bundle)
  ? ok('low-FPS downgrade is one-way (no oscillation)') : bad('adaptive complexity downgrade missing');
const strikes = constNum('LOW_FPS_STRIKES'), limit = constNum('LOW_FPS_LIMIT');
strikes >= 2 && limit > 0 && limit < 25
  ? ok('downgrade needs a sustained low-FPS spell (' + strikes + 'x under ' + limit + ' fps)')
  : bad('downgrade thresholds unreasonable: ' + strikes + '/' + limit);

/* ================= 6. re-render churn ================= */
/showPredicting = useCallback/.test(bundle) && !/predictingRef\.current = true; setPredicting\(true\)/.test(bundle)
  ? ok('setPredicting churn replaced by a throttled updater') : bad('setPredicting still fires per prediction');
/if \(s\.l !== shownL \|\| s\.c !== shownC\)/.test(bundle)
  ? ok('prediction display update is deduped (commit path untouched)') : bad('setPred still re-renders on every prediction');
// the commit path must NOT be throttled
/const feedPrediction = useCallback\(\(p\) => \{[\s\S]{0,900}?commit\(p\)/.test(bundle)
  ? ok('every prediction still reaches commit() unthrottled') : bad('commit path was throttled — recognition would lag');

/* ================= 7. ج / ح / خ arbitration ================= */
const jhkArbitrate = topLevelFn('jhkArbitrate');
const atArbitrate = topLevelFn('atArbitrate');
ok('jhkArbitrate extracted from bundle');

/* Build a 21-landmark hand. MediaPipe order: 0 wrist, 1-4 thumb, 5-8 index,
   9-12 middle, 13-16 ring, 17-20 pinky. y grows DOWNWARD. */
function hand(opts) {
  const o = Object.assign({ thumbUp: false, curlDown: false, spread: 0, cx: 0.5, cy: 0.5, s: 1 }, opts);
  const P = new Array(21);
  const put = (i, x, y) => { P[i] = [x, y]; };
  put(0, 0, 0.35);                                  // wrist
  put(9, 0, -0.05);                                 // middle MCP -> hand span ~0.4
  // knuckle row, slightly fanned by `spread`
  const mcp = { 5: -0.16, 9: 0, 13: 0.15, 17: 0.29 };
  put(5, mcp[5], -0.03); put(13, mcp[13], -0.02); put(17, mcp[17], 0.02);
  // fingertips: level with the knuckles (ح/خ, bent forward) or well below (ج)
  const tipDy = o.curlDown ? 0.20 : 0.02;
  const fan = o.spread;
  put(8, mcp[5] - fan * 0.9, -0.03 + tipDy);
  put(12, mcp[9] - fan * 0.3, -0.05 + tipDy);
  put(16, mcp[13] + fan * 0.3, -0.02 + tipDy);
  put(20, mcp[17] + fan * 0.9, 0.02 + tipDy);
  // intermediate joints (unused by the arbiter, kept plausible)
  put(6, mcp[5], -0.03 + tipDy * 0.5); put(7, mcp[5], -0.03 + tipDy * 0.8);
  put(10, mcp[9], -0.05 + tipDy * 0.5); put(11, mcp[9], -0.05 + tipDy * 0.8);
  put(14, mcp[13], -0.02 + tipDy * 0.5); put(15, mcp[13], -0.02 + tipDy * 0.8);
  put(18, mcp[17], 0.02 + tipDy * 0.5); put(19, mcp[17], 0.02 + tipDy * 0.8);
  // thumb: extended straight up (خ) or tucked against the palm
  put(1, -0.14, 0.26); put(2, -0.19, 0.18);
  if (o.thumbUp) { put(3, -0.23, 0.02); put(4, -0.26, -0.22); }
  else { put(3, -0.16, 0.14); put(4, -0.10, 0.10); }
  const feats = [];
  for (let i = 0; i < 21; i++) feats.push(o.cx + P[i][0] * o.s, o.cy + P[i][1] * o.s, 0);
  return feats;
}
const mirrorFeats = (f) => { const g = f.slice(); for (let k = 0; k < g.length; k += 3) g[k] = 1 - g[k]; return g; };
const scale = (f, s, cx, cy) => {
  const g = f.slice();
  for (let k = 0; k < g.length; k += 3) { g[k] = cx + (g[k] - 0.5) * s; g[k + 1] = cy + (g[k + 1] - 0.5) * s; }
  return g;
};

const poseHah = hand({});                              // ح: together, level, thumb tucked
const poseKhah = hand({ thumbUp: true });              // خ: ح + thumb straight up
const poseJeem = hand({ curlDown: true });             // ج: same fingers curled down

jhkArbitrate(poseHah) === 'ح' ? ok('ح pose -> ح') : bad('ح pose -> ' + jhkArbitrate(poseHah));
jhkArbitrate(poseKhah) === 'خ' ? ok('خ pose -> خ (thumb dot detected)') : bad('خ pose -> ' + jhkArbitrate(poseKhah));
jhkArbitrate(poseJeem) === 'ج' ? ok('ج pose -> ج (downward curl detected)') : bad('ج pose -> ' + jhkArbitrate(poseJeem));

// the three must never collide with each other
const three = { 'ح': poseHah, 'خ': poseKhah, 'ج': poseJeem };
let collide = 0;
for (const a of Object.keys(three)) for (const b of Object.keys(three)) {
  if (a !== b && jhkArbitrate(three[a]) === b) collide++;
}
collide === 0 ? ok('ج / ح / خ never resolve to each other') : bad(collide + ' cross-collisions between ج/ح/خ');

// invariance: distance and handedness must not change the answer
for (const [name, pose] of Object.entries(three)) {
  const far = scale(pose, 0.45, 0.5, 0.5);
  const near = scale(pose, 1.7, 0.5, 0.5);
  const mir = mirrorFeats(pose);
  jhkArbitrate(far) === name ? ok(name + ' at 0.45x distance -> still ' + name) : bad(name + ' inverted when far: ' + jhkArbitrate(far));
  jhkArbitrate(near) === name ? ok(name + ' at 1.7x closer -> still ' + name) : bad(name + ' inverted when near: ' + jhkArbitrate(near));
  jhkArbitrate(mir) === name ? ok('mirrored ' + name + ' -> still ' + name) : bad('mirrored ' + name + ' inverted: ' + jhkArbitrate(mir));
}

// must abstain on anything that is not the ج/ح/خ base shape
jhkArbitrate(hand({ spread: 0.16 })) === null ? ok('spread fingers (ش) -> null, model answer kept') : bad('spread hand was force-classified');
jhkArbitrate(null) === null ? ok('null feats -> null') : bad('null feats not handled');
jhkArbitrate([1, 2, 3]) === null ? ok('short feats -> null') : bad('short feats not handled');
const flat = new Array(63).fill(0.5);
jhkArbitrate(flat) === null ? ok('degenerate (zero-span) hand -> null') : bad('degenerate hand was classified');
// and it must not disturb the English A/T arbiter
typeof atArbitrate === 'function' ? ok('atArbitrate still present alongside jhkArbitrate') : bad('atArbitrate lost');

/* ================= 8. confusable table coverage ================= */
// esbuild escapes non-ASCII keys (\u062E), so assert on the PARSED table.
const tbl = sliceBlock('CONFUSABLE_AR =');
// eslint-disable-next-line no-new-func
const CONF_AR = new Function('return ' + tbl.replace(/\/\/[^\n]*/g, '') + ';')();
CONF_AR['خ'] ? ok('خ is now present in CONFUSABLE_AR (it was missing entirely)') : bad('خ still missing from CONFUSABLE_AR');
CONF_AR['غ'] ? ok('غ is now present in CONFUSABLE_AR') : bad('غ still missing from CONFUSABLE_AR');
const triple = ['ج', 'ح', 'خ'];
let sym = true;
for (const a of triple) for (const b of triple) {
  if (a !== b && (!CONF_AR[a] || CONF_AR[a].indexOf(b) < 0)) { sym = false; }
}
sym ? ok('ج/ح/خ form a fully mutual confusable triple') : bad('ج/ح/خ triple is not symmetric');
(CONF_AR['ع'] || []).indexOf('غ') >= 0 && (CONF_AR['غ'] || []).indexOf('ع') >= 0
  ? ok('ع/غ pair is symmetric') : bad('ع/غ pair not symmetric');
// every partner listed must itself exist as a key (no dangling one-way edges)
let dangling = [];
for (const [k, vs] of Object.entries(CONF_AR)) for (const v of vs) {
  if (!CONF_AR[v] || CONF_AR[v].indexOf(k) < 0) dangling.push(k + '->' + v);
}
dangling.length === 0 ? ok('no one-way confusable edges') : bad('one-way edges: ' + dangling.join(', '));
// the arbiter must be wired for exactly the letters it can judge
/JHK_AR = \{/.test(bundle) && /JHK_AR\[p\.letter\] \? jhkArbitrate : null/.test(bundle)
  ? ok('jhkArbitrate is wired only for ج/ح/خ') : bad('jhkArbitrate wiring missing');
(bundle.match(/JHK_AR\[p\.letter\] \? jhkArbitrate : null/g) || []).length === 2
  ? ok('arbitration wired in BOTH the live and upload gates') : bad('arbitration not wired in both gates');

console.log(fails === 0 ? 'ALL LATENCY + DISCRIMINATION CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
