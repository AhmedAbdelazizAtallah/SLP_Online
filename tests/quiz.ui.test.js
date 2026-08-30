// Learn & Quiz smoke test: verifies that the quiz can start and advance even
// though the SIGN preview canvas is not mounted on the quiz tab.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8'), {
  url: 'http://127.0.0.1:8131/',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.location = dom.window.location;
global.localStorage = dom.window.localStorage;
global.self = global;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
  if (type !== '2d') return null;
  return {
    save() {}, restore() {}, clearRect() {}, translate() {}, scale() {}, drawImage() {}
  };
};

function load(file) {
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: path.basename(file) });
}

load(path.join(ROOT, 'vendor', 'react.js'));
load(path.join(ROOT, 'vendor', 'react-dom.js'));
load(path.join(ROOT, 'vendor', 'three.min.js'));
window.React = global.React || window.React;
window.ReactDOM = global.ReactDOM || window.ReactDOM;
window.THREE = global.THREE || window.THREE;
load(path.join(ROOT, 'app.compiled.js'));

setTimeout(() => {
  const root = document.getElementById('root');
  const quizTab = Array.from(root.querySelectorAll('.tab')).find((tab) => /LEARN & QUIZ/.test(tab.textContent));
  if (!quizTab) throw new Error('LEARN & QUIZ tab missing');
  quizTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  setTimeout(() => {
    const start = Array.from(root.querySelectorAll('.btn')).find((button) => button.textContent.trim() === 'START');
    if (!start) throw new Error('quiz START button missing');
    start.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    setTimeout(() => {
      if (!root.textContent.includes('TIME LEFT')) throw new Error('quiz did not enter run phase');
      const skip = Array.from(root.querySelectorAll('.btn')).find((button) => button.textContent.trim() === 'SKIP');
      if (!skip) throw new Error('quiz SKIP button missing');
      for (let i = 0; i < 8; i++) skip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

      setTimeout(() => {
        if (!root.textContent.includes('QUIZ RESULTS')) throw new Error('quiz did not enter results phase');
        console.log('LEARN & QUIZ UI TEST PASSED');
        process.exit(0);
      }, 100);
    }, 100);
  }, 100);
}, 300);
