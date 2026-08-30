// SLP Next - UI smoke test (jsdom): mounts the compiled bundle in a simulated
// browser and verifies the app shell, tabs, avatar portal and new features.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
let fails = 0;
const ok = (m) => console.log('PASS: ' + m);
const bad = (m) => { fails++; console.log('FAIL: ' + m); };

const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8131/', pretendToBeVisual: true, runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.navigator = dom.window.navigator; global.location = dom.window.location;
global.localStorage = dom.window.localStorage; global.self = global;
dom.window.HTMLCanvasElement.prototype.getContext = () => null; // force graceful WebGL degradation
dom.window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

function load(file) { vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) }); }
load(path.join(ROOT, 'vendor', 'react.js'));
load(path.join(ROOT, 'vendor', 'react-dom.js'));
load(path.join(ROOT, 'vendor', 'three.min.js'));
window.React = global.React || window.React;
window.ReactDOM = global.ReactDOM || window.ReactDOM;
window.THREE = global.THREE || window.THREE;

try { load(path.join(ROOT, 'app.compiled.js')); }
catch (e) { console.log('BUNDLE THREW:', e.message); process.exit(1); }

setTimeout(() => {
  const root = document.getElementById('root');
  if (!root || root.children.length === 0) { bad('root is EMPTY (black screen)'); return finish(); }
  ok('root mounted (' + root.querySelectorAll('*').length + ' elements)');
  for (const sel of ['.hdr', '.tabs', '.card', '.btn']) root.querySelector(sel) ? ok('found ' + sel) : bad('missing ' + sel);

  const tabs = Array.from(root.querySelectorAll('.tab')).map(t => t.textContent.trim());
  if (/ALPHABET/.test(tabs.join('|'))) ok('ALPHABET tab present'); else bad('ALPHABET tab missing');
  if (/HISTORY • STATS/.test(tabs.join('|'))) ok('merged HISTORY • STATS tab present'); else bad('history/stats merge missing');
  if (!/DEBUG/.test(tabs.join('|'))) ok('DEBUG hidden from main nav'); else bad('DEBUG visible');
  if (!root.textContent.includes('CHOOSE VIDEO')) ok('video-file translation removed'); else bad('video-file feature still present');
  if (!/VIDEO CALL/.test(tabs.join('|'))) ok('VIDEO CALL tab removed'); else bad('VIDEO CALL tab still present');

  // Alphabet tab: switch, click first card, expect active state + avatar host
  const alphaTab = Array.from(root.querySelectorAll('.tab')).find(t => /ALPHABET/.test(t.textContent));
  alphaTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  setTimeout(() => {
    const host = document.getElementById('av-host-alpha');
    host ? ok('av-host-alpha mounted') : bad('av-host-alpha missing');
    const card = root.querySelector('.alpha-card');
    card ? ok('alphabet cards rendered (' + root.querySelectorAll('.alpha-card').length + ')') : bad('no alphabet cards');
    if (card) {
      card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      setTimeout(() => {
        root.querySelector('.alpha-card.alpha-on') ? ok('card click activates sign preview') : bad('card click did not activate');
        // EN cards regression: switch to English, hints must exist & ids numeric
        const enChip = Array.from(root.querySelectorAll('.chips .chip')).find(ch => /ENGLISH/.test(ch.textContent));
        if (enChip) {
          enChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            const enCard = root.querySelector('.alpha-card');
            const hint = enCard && enCard.querySelector('.ah');
            (hint && hint.textContent.trim().length > 0) ? ok('EN card has hint text') : bad('EN card hint empty');
            const glyph = enCard && enCard.querySelector('.ag');
            (glyph && /^[A-Z]$/.test(glyph.textContent)) ? ok('EN glyph letter (' + glyph.textContent + ')') : bad('EN glyph wrong: ' + (glyph && glyph.textContent));
            finish();
          }, 300);
          return;
        } else { bad('EN lang chip not found in alpha tab'); finish(); }
        // Build tab portal round-trip
        const buildTab = Array.from(root.querySelectorAll('.tab')).find(t => /TEXT TO SIGN/.test(t.textContent));
        buildTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
        setTimeout(() => {
          document.getElementById('av-host-build') ? ok('av-host-build mounted') : bad('av-host-build missing');
          (window.__AV_MOUNTS || 0) >= 1 ? ok('avatar effect ran (' + window.__AV_MOUNTS + ' mounts)') : bad('avatar never mounted');
          // Settings toggles exist in source-of-truth DOM? (drawer closed; check bundle flags instead)
          typeof window.__SLP_BUNDLED !== 'undefined' ? ok('bundle bootstrap flag set') : bad('bootstrap flag missing');
          finish();
        }, 400);
      }, 300);
    } else finish();
  }, 400);

  function finish() {
    console.log('--- UI SMOKE TEST ---');
    errors.forEach(e => console.log('PAGE ERROR: ' + e));
    console.log((fails === 0 && errors.length === 0) ? 'UI SMOKE TEST PASSED' : 'UI SMOKE TEST FAILED');
    process.exit((fails === 0 && errors.length === 0) ? 0 : 1);
  }
}, 500);