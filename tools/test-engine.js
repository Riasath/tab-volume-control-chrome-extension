/* Runs engine.js against a minimal DOM stub to check the volume math. */
const fs = require('fs');
const vm = require('vm');

const listeners = { window: {}, document: {} };

class HTMLMediaElement {
  constructor() {
    this._native = 1; // what the browser would actually output
    this.isConnected = true;
    this.src = 'blob:test';
  }
  play() {}
}
Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
  configurable: true,
  enumerable: true,
  get() { return this._native; },
  set(v) { this._native = v; },
});

const media = [];
const sandbox = {
  HTMLMediaElement,
  MutationObserver: class { observe() {} },
  setInterval: () => 0,
  clearInterval: () => {},
  console,
  document: {
    documentElement: {},
    addEventListener: (t, f) => ((listeners.document[t] = f)),
    querySelectorAll: () => media,
  },
};
sandbox.window = sandbox;
sandbox.window.addEventListener = (t, f) => ((listeners.window[t] = f));
let innerWindow = null; // vm's global proxy !== the raw sandbox object
sandbox.window.postMessage = (data) => {
  const f = listeners.window.message;
  if (f) f({ source: innerWindow, data });
};

vm.createContext(sandbox);
innerWindow = vm.runInContext('window', sandbox);
const ENGINE = require('path').join(__dirname, '..', 'engine.js');
vm.runInContext(fs.readFileSync(ENGINE, 'utf8'), sandbox);

const set = (gain, muted) =>
  sandbox.window.postMessage({ __tvc: 'set', gain, muted });

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Math.abs(actual - expected) < 1e-9;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${actual}, want ${expected}`);
};

// --- a tab at 30%, site's player sitting at its own 100% ------------------
const meet = new HTMLMediaElement();
media.push(meet);
set(0.3, false);
check('Meet @30%, site vol 1.0 -> output', meet._native, 0.3);
check('site still reads its own volume', meet.volume, 1);

// --- the site moves its own slider to 50% while we hold 30% ---------------
meet.volume = 0.5;
check('site sets 0.5 under 30% -> output', meet._native, 0.15);
check('site reads back what it set', meet.volume, 0.5);

// --- read-back loop: a player that echoes volume back must not compound ---
for (let i = 0; i < 5; i++) meet.volume = meet.volume;
check('no compounding after 5 echo cycles', meet._native, 0.15);

// --- YouTube tab at 80% ---------------------------------------------------
const yt = new HTMLMediaElement();
media.push(yt);
set(0.8, false);
check('YouTube @80%, site vol 1.0', yt._native, 0.8);
check('Meet element rescaled too (site 0.5)', meet._native, 0.4);

// --- mute, then restore ---------------------------------------------------
set(0.8, true);
check('muted -> output 0', yt._native, 0);
check('site volume untouched while muted', yt.volume, 1);
set(0.8, false);
check('unmuted -> back to 80%', yt._native, 0.8);

// --- an element created after the level was set ---------------------------
set(0.3, false);
const late = new HTMLMediaElement();
media.push(late);
listeners.document.playing({ target: late });
check('element added later picks up 30%', late._native, 0.3);

// --- clamping -------------------------------------------------------------
set(0, false);
check('0% -> silent', yt._native, 0);

process.exit(failures ? 1 : 0);
