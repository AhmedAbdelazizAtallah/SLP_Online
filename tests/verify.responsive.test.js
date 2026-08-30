// Ad-hoc verification: settings drawer semantics, ESC close, scroll lock,
// bigcap class, skip link, aria landmarks. Uses the compiled bundle like the
// real page does.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const ok = (m) => console.log('PASS: ' + m);
const bad = (m) => { fails++; console.log('FAIL: ' + m); };

const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
html.includes('.chat-sheet-body[hidden]{display:none}') ? ok('collapsed mobile chat removes hidden controls') : bad('collapsed mobile chat controls remain focusable');
html.includes('aspect-ratio:8/3') ? ok('desktop split stage matches two 4:3 video tiles') : bad('desktop split stage wastes video area');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:8131/', pretendToBeVisual: true, runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.navigator = dom.window.navigator; global.location = dom.window.location;
global.localStorage = dom.window.localStorage; global.self = global;
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

function load(file) { vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) }); }
load(path.join(ROOT, 'vendor', 'react.js'));
load(path.join(ROOT, 'vendor', 'react-dom.js'));
load(path.join(ROOT, 'vendor', 'three.min.js'));
window.React = global.React || window.React;
window.ReactDOM = global.ReactDOM || window.ReactDOM;
window.THREE = global.THREE || window.THREE;
load(path.join(ROOT, 'app.compiled.js'));

setTimeout(() => {
  const root = document.getElementById('root');
  if (!root || !root.children.length) { bad('root empty'); return done(); }

  // Landmarks & a11y
  root.querySelector('.skip-link') ? ok('skip link present') : bad('skip link missing');
  document.getElementById('main') ? ok('#main landmark present') : bad('#main missing');
  const nav = root.querySelector('nav[aria-label="Sections"]');
  nav ? ok('nav aria-label present') : bad('nav aria-label missing');

  // Regression: skip-link must be a small offscreen pill — if `right` is also
  // set to -9999px it stretches across the viewport (the "blue bar" bug in RTL).
  const skip = root.querySelector('.skip-link');
  const cs = dom.window.getComputedStyle(skip);
  (cs.left === '-9999px' && cs.right !== '-9999px')
    ? ok('skip-link offscreen without RTL stretch (no blue bar)')
    : bad('skip-link may stretch full-width (blue bar): left=' + cs.left + ' right=' + cs.right);

  // Regression guards in the stylesheet (mobile overflow fixes)
  const css = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  /\.grid-main>\*\{min-width:0\}/.test(css) ? ok('grid blowout guard present') : bad('grid min-width guard missing');
  const mq640 = css.match(/@media\(max-width:640px\)\{([\s\S]*?)\n\}/);
  const rc640 = mq640 && mq640[1].match(/\.room-controls\{[^}]*\}/);
  (rc640 && !/nowrap/.test(rc640[0]) && /flex-wrap:wrap/.test(rc640[0]))
    ? ok('room controls wrap (not forced single row) on mobile')
    : bad('room controls forced to one row on mobile');

  // Open settings drawer
  const btn = Array.from(root.querySelectorAll('button')).find(b => /SETTINGS/.test(b.textContent));
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  setTimeout(() => {
    const dlg = root.querySelector('[role="dialog"]');
    dlg ? ok('settings dialog mounted with role=dialog') : bad('dialog missing');
    if (dlg) {
      dlg.getAttribute('aria-modal') === 'true' ? ok('aria-modal=true') : bad('aria-modal missing');
      dlg.classList.contains('drawer') ? ok('drawer class applied (responsive CSS)') : bad('drawer class missing');
    }
    const overlay = root.querySelector('.drawer-overlay');
    overlay ? ok('overlay uses .drawer-overlay class') : bad('overlay class missing');
    document.body.style.overflow === 'hidden' ? ok('body scroll locked while open') : bad('body scroll not locked');
    const activeIsClose = document.activeElement && /CLOSE/.test(document.activeElement.textContent);
    activeIsClose ? ok('focus moved to CLOSE button') : bad('focus not on close button');

    // ESC closes + unlocks scroll
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    setTimeout(() => {
      !root.querySelector('[role="dialog"]') ? ok('ESC closes drawer') : bad('ESC did not close drawer');
      document.body.style.overflow !== 'hidden' ? ok('body scroll restored after close') : bad('scroll still locked');

      // Rooms tab renders big caption container correctly when needed
      const tabs = Array.from(root.querySelectorAll('.tab'));
      const netTab = tabs.find(t => /SIGN ROOMS/.test(t.textContent));
      netTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      setTimeout(() => {
        root.textContent.includes('JOIN ROOM') ? ok('rooms join form renders') : bad('join form missing');
        done();
      }, 250);
    }, 120);
  }, 150);

  function done() {
    console.log('--- DRAWER/A11Y CHECK ---');
    console.log(fails === 0 ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
    process.exit(fails === 0 ? 0 : 1);
  }
}, 500);
