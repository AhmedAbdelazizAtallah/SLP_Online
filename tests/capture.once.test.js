// Single-capture regression suite: "every letter is taken exactly once".
//
// This does NOT re-implement the gate. It slices the REAL commit()/upCommit()
// bodies out of the built bundle and runs them against synthetic frame streams
// with stubbed refs, so a regression in app.html fails here.
//
// Covered:
//   1. a held pose commits once, never AAAA
//   2. an A->B transition whose argmax flickers back to A never duplicates A
//   3. a deliberately re-articulated letter (LL in HELLO) IS captured twice
//   4. the uploaded-video gate behaves identically (no wall-clock debounce)
//   5. a single dropped MediaPipe frame cannot re-arm a held pose
//   6. armLatch re-opens the gate for one specific letter only
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const bundle = fs.readFileSync(ROOT + '/app.compiled.js', 'utf8');

let fails = 0;
const ok = (m) => console.log('PASS: ' + m);
const bad = (m) => { fails++; console.log('FAIL: ' + m); };

/* ---------- extract real code from the bundle ---------- */
function sliceBlock(startMarker, openChar, closeChar) {
  const i = bundle.indexOf(startMarker);
  if (i < 0) throw new Error('marker not found: ' + startMarker);
  let j = bundle.indexOf(openChar, i);
  let depth = 0;
  for (let k = j; k < bundle.length; k++) {
    if (bundle[k] === openChar) depth++;
    else if (bundle[k] === closeChar) { depth--; if (depth === 0) return bundle.slice(j, k + 1); }
  }
  throw new Error('unbalanced block: ' + startMarker);
}
function topLevelFn(name) {
  const head = 'function ' + name + '(';
  const i = bundle.indexOf(head);
  if (i < 0) throw new Error('helper not found: ' + name);
  const body = sliceBlock(head, '{', '}');
  const args = bundle.slice(bundle.indexOf('(', i) + 1, bundle.indexOf(')', i));
  // eslint-disable-next-line no-new-func
  return new Function('return function ' + name + '(' + args + ')' + body + ';')();
}

const releaseFrames = topLevelFn('releaseFrames');
const newStab = topLevelFn('newStab');
const addRelease = topLevelFn('addRelease');
const holdsLatch = topLevelFn('holdsLatch');
const framesNeeded = topLevelFn('framesNeeded');
const latch = topLevelFn('latch');
const armLatch = topLevelFn('armLatch');
ok('capture-gate helpers extracted from bundle');

/* Read tuning constants out of the bundle so the test cannot drift from source. */
function constFromBundle(name) {
  const m = bundle.match(new RegExp('(?:var|const|let)\\s+' + name + '\\s*=\\s*([0-9.]+)'));
  if (!m) throw new Error('constant not found: ' + name);
  return parseFloat(m[1]);
}
const MOTION_SETTLED = constFromBundle('MOTION_SETTLED');
const RELEASE_CONF_RATIO = constFromBundle('RELEASE_CONF_RATIO');
const SPEED_PRESETS = { smooth: { stab: 8, gap: 8 }, fast: { stab: 4, gap: 5 }, turbo: { stab: 2, gap: 3 } };
const ROOM_SIGN_STAB = 2, ROOM_SIGN_GAP = 2, ROOM_SIGN_RELEASE = 3;

// The gate must not resurrect the wall-clock debounce that duplicated letters.
/\bdebounce\b/.test(bundle) ? bad('wall-clock debounce still present in bundle') : ok('no wall-clock repeat debounce anywhere');

/* Build a runnable copy of the real commit()/upCommit() body. */
function buildGate(kind) {
  const marker = kind === 'live' ? 'const commit = useCallback((p) =>' : 'const upCommit = useCallback((p) =>';
  const body = sliceBlock(marker, '{', '}');
  const env = {
    SPEED_PRESETS, MOTION_SETTLED, RELEASE_CONF_RATIO,
    ROOM_SIGN_STAB, ROOM_SIGN_GAP, ROOM_SIGN_RELEASE,
    releaseFrames, addRelease, holdsLatch, framesNeeded, latch,
    CONFUSABLE_AR: {}, CONFUSABLE_EN: {},          // isolate the gate from arbitration
    pairMass: () => ({ sX: 1, sP: {} }),
    atArbitrate: () => null
  };
  const state = {
    st: newStab(),
    committed: [],
    motion: 0,
    speed: 'fast',
    conf: 0.6
  };
  env.stabRef = { get current() { return state.st; }, set current(v) { state.st = v; } };
  env.upStabRef = env.stabRef;
  env.motionRef = { current: { get value() { return state.motion; } } };
  env.upMotionRef = env.motionRef;
  env.speedNowRef = { get current() { return state.speed; } };
  env.langRef = { current: 'en' };
  env.netOnRef = { current: false };
  env.tabRef = { current: 'sign' };
  env.netRoleRef = { current: 'hearing' };
  env.emaRef = { current: {} };
  env.upEmaRef = env.emaRef;
  env.recentPredsRef = { current: [] };
  env.upRecentPredsRef = env.recentPredsRef;
  env.lastStdFeatsRef = { current: null };
  env.upLastStdFeatsRef = env.lastStdFeatsRef;
  env.applyCommit = (p) => state.committed.push(p.letter);
  env.upApplyCommit = env.applyCommit;
  env.confGate = 0.55;

  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, 'return function gate(p)' + body + ';')(...names.map(n => env[n]));
  return {
    state,
    /* feed N frames of one letter; opts.motion / opts.conf simulate the camera */
    feed(letter, n, opts) {
      opts = opts || {};
      state.motion = opts.motion === undefined ? 0.001 : opts.motion;
      const conf = opts.conf === undefined ? 0.9 : opts.conf;
      for (let i = 0; i < n; i++) fn({ letter, class_id: letter.charCodeAt(0) - 65, confidence: conf, top3: [] });
    },
    /* the tracking handler's "hand present but travelling" path */
    move(n) { this.feed('?', n, { motion: 0.4 }); },
    /* the tracking handler's no-hand branch, transient (<350ms) form. The real
       handler also nulls motionRef.prev, so the first frame back reports full
       motion — replicate that rebound or the test is easier than reality. */
    dropFrames(n) {
      for (let i = 0; i < n; i++) {
        state.st.cur = null; state.st.count = 0;
        addRelease(state.st, releaseFrames(SPEED_PRESETS[state.speed]));
      }
      this.move(1);
    },
    out() { return state.committed.join(''); },
    reset() { state.st = newStab(); state.committed.length = 0; }
  };
}

const live = buildGate('live');
const up = buildGate('upload');
ok('real commit() and upCommit() bodies extracted and runnable');

/* ---------- 1. a held pose is taken exactly once ---------- */
live.reset();
live.feed('A', 120);                       // 4 seconds of a perfectly still "A"
live.out() === 'A' ? ok('held pose committed exactly once (was AAAA)') : bad('held pose -> "' + live.out() + '"');

/* ---------- 2. transition flicker cannot duplicate the previous letter ---------- */
// The old gate unlocked the latch after just 2 settled frames of ANY other
// letter, so the argmax bouncing back mid-transition retyped the letter that
// was already in the sentence. A non-committing letter must never be a release.
live.reset();
live.feed('A', 10);                        // commit A
live.feed('B', 2);                         // 2 settled frames of B: NOT enough to commit B
live.feed('A', 20);                        // argmax bounces back to A
live.feed('B', 10);                        // user really did mean B
live.out() === 'AB' ? ok('sub-threshold other letter is not a release (was "AAB")') : bad('flicker unlock -> "' + live.out() + '"');

live.reset();
live.feed('A', 10);                        // commit A
live.move(12);                             // hand travels A -> B (release evidence)
live.feed('A', 4);                         // argmax bounces back to A for stab frames
live.feed('B', 10);                        // then settles on B
live.out() === 'AB' ? ok('A->B travel + flicker did not duplicate A') : bad('transition -> "' + live.out() + '"');

/* ---------- 2b. partial release evidence must not arm the latch ---------- */
live.reset();
live.feed('A', 10);
live.move(2);                              // a brief wobble, below the release threshold
live.feed('A', 30);
live.out() === 'A' ? ok('brief wobble is not enough release to repeat a letter') : bad('wobble -> "' + live.out() + '"');
live.reset();
live.feed('A', 10);
live.feed('A', 40, { conf: 0.52 });        // borderline pose: noise just under the gate
live.feed('A', 30);
live.out() === 'A' ? ok('borderline confidence noise does not repeat a letter') : bad('conf noise -> "' + live.out() + '"');
live.reset();
live.feed('A', 10);
live.feed('A', 12, { conf: 0.05 });        // the pose is genuinely gone for a while
live.feed('A', 30);                        // ...and is then formed again
live.out() === 'AA' ? ok('losing then re-forming the pose is two real letters') : bad('lost pose -> "' + live.out() + '"');

/* ---------- 3. a deliberate double letter is still capturable ---------- */
live.reset();
live.feed('H', 10); live.move(10);
live.feed('E', 10); live.move(10);
live.feed('L', 10); live.move(10);         // re-articulate: hand moves, then L again
live.feed('L', 10); live.move(10);
live.feed('O', 10);
live.out() === 'HELLO' ? ok('re-articulated double letter captured (HELLO)') : bad('double letter -> "' + live.out() + '"');

/* ---------- 3b. holding the same pose is NOT a double letter ---------- */
live.reset();
live.feed('L', 200);
live.out() === 'L' ? ok('holding one pose never becomes a double letter') : bad('hold -> "' + live.out() + '"');

/* ---------- 4. uploaded video: no wall-clock duplication ---------- */
up.reset();
up.feed('A', 400);                         // a long held pose in a decoded clip
up.out() === 'A' ? ok('upload gate takes a long held pose once (was AAA)') : bad('upload hold -> "' + up.out() + '"');
up.reset();
up.feed('A', 10); up.move(12); up.feed('A', 4); up.feed('B', 10);
up.out() === 'AB' ? ok('upload gate ignores transition flicker too') : bad('upload transition -> "' + up.out() + '"');

/* ---------- 5. a transient tracking miss cannot re-arm a held pose ---------- */
live.reset();
live.feed('A', 10);
live.dropFrames(1);                        // MediaPipe misses ONE frame
live.feed('A', 30);                        // signer never moved
live.out() === 'A' ? ok('single dropped frame did not duplicate the held letter') : bad('dropped frame -> "' + live.out() + '"');
live.reset();
live.feed('A', 10);
live.dropFrames(3);                        // a short burst of misses (~100ms)
live.feed('A', 30);
live.out() === 'A' ? ok('short burst of dropped frames did not duplicate the letter') : bad('dropped burst -> "' + live.out() + '"');

/* ---------- 6. armLatch is scoped to one specific letter ---------- */
const st = newStab();
latch(st, 'A');
armLatch(st, 'B') === false && st.armed === false ? ok('armLatch ignores a letter that is not latched') : bad('armLatch leaked to another letter');
armLatch(st, 'A') === true && st.armed === true ? ok('armLatch re-opens the gate for the latched letter') : bad('armLatch did not arm the latched letter');
st.count === 0 && st.cur === null ? ok('armLatch still demands a fresh stabilization') : bad('armLatch bypassed stabilization');

/* ---------- 7. helper invariants ---------- */
framesNeeded(4, false) === 4 && framesNeeded(4, true) > 4 ? ok('a repeat needs more evidence than a new letter') : bad('repeat bar not raised');
releaseFrames({ stab: 4 }) > 4 && releaseFrames({ stab: 2 }) >= 3 ? ok('release threshold exceeds stabilization') : bad('release threshold too low');
holdsLatch({ last: 'A' }, 'A') === true && holdsLatch({ last: 'A' }, 'B') === false ? ok('only the latched pose cancels release evidence') : bad('holdsLatch wrong');

console.log(fails === 0 ? 'ALL SINGLE-CAPTURE CHECKS PASSED' : fails + ' CHECKS FAILED');
process.exit(fails === 0 ? 0 : 1);
