// Drives the frame profiler through a synthetic frame so its bookkeeping, window
// aggregation and posting payload can be checked without a browser.
//
//   node test/frame-profiler-regression.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.join(__dirname, '..');
const sent = [];

function makeStub(name) {
  const fn = function() { return stub; };
  const stub = new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 1;
      if (prop === 'valueOf') return () => 1;
      if (prop === 'toString') return () => '[stub ' + name + ']';
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
      if (prop === 'length') return 0;
      if (prop === 'name') return name;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'size' || prop === 'width' || prop === 'height') return 100;
      return stub;
    },
    set() { return true; }, has() { return true; }, apply() { return stub; }, construct() { return stub; },
  });
  return stub;
}

function buildContext() {
  let clock = 1000;
  const sandbox = {
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    Math, JSON, Date, Object, Array, Number, String, Boolean, Error, TypeError, RangeError, Map, Set,
    WeakMap, WeakSet, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array,
    Uint16Array, Uint32Array, Uint8ClampedArray, ArrayBuffer, DataView, Promise, Symbol, RegExp,
    isNaN, isFinite, parseFloat, parseInt, NaN, Infinity,
    performance : { now : () => clock },
    setClockMs : (v) => { clock = v; },
    requestAnimationFrame : () => 0, cancelAnimationFrame : () => {}, setInterval : () => 0, clearInterval : () => {},
    setTimeout : () => 0, clearTimeout : () => {}, addEventListener : () => {}, removeEventListener : () => {},
    localStorage : makeStub('localStorage'), navigator : makeStub('navigator'),
    location : { search : '?prof=1' },
    fetch : (url, opts) => { sent.push({ url, body : JSON.parse(opts.body) }); return Promise.resolve({ ok : true }); },
    XMLHttpRequest : makeStub('XHR'), WebSocket : makeStub('WS'), Image : makeStub('Image'), Audio : makeStub('Audio'),
    AudioContext : makeStub('AudioContext'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.document = makeStub('document');
  vm.createContext(sandbox);
  for (const rel of [ 'js/debugLog.js', 'js/utils.js' ]) {
    try { vm.runInContext(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), sandbox, { filename : rel }); }
    catch (e) { /* optional */ }
  }
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'app.js'), 'utf8'), sandbox, { filename : 'app.js' });
  return sandbox;
}

const sandbox = buildContext();
const run = (code) => vm.runInContext(code, sandbox);

// 1. Frames accumulate into one window and the interval (the part of the frame that is not
//    draw() JavaScript) is measured from the gap between frame starts.
{
  run('frameProfilerBeginFrame();');
  run("frameProfilerRecord('phase-input', 1); frameProfilerRecord('phase-simulate', 12);");
  run("setClockMs(1016); frameProfilerBeginFrame();");
  run("frameProfilerRecord('phase-input', 1.5); frameProfilerRecord('phase-simulate', 13);");
  run("setClockMs(1032); frameProfilerBeginFrame();");
  run("frameProfilerRecord('phase-input', 2); frameProfilerRecord('phase-simulate', 14);");
  const state = run('({ frames: frameProfiler.frames, interval: frameProfiler.intervalMs, max: frameProfiler.intervalMsMax })');
  assert.strictEqual(state.frames, 3, 'three frames must be counted');
  assert.strictEqual(state.interval, 32, 'intervals are measured between frame starts');
  assert.strictEqual(state.max, 16, 'the slowest interval is tracked');

  assert.strictEqual(run('frameProfilerWantsPost("?prof=1")'), true, '?prof=1 must enable posting');
  assert.strictEqual(run('frameProfilerWantsPost("?foo=1&prof")'), true, '?prof without a value must enable posting');
  assert.strictEqual(run('frameProfilerWantsPost("?profile=1")'), false, '?profile must not enable posting');
  assert.strictEqual(run('frameProfilerWantsPost("")'), false, 'no query string must not enable posting');
  assert.strictEqual(run('frameProfilerWantsPost("", "localhost")'), true, 'the local dev server enables posting');
  assert.strictEqual(run('frameProfilerWantsPost("", "8080-abc.e2b.app")'), true, 'the preview host enables posting');
  assert.strictEqual(run('frameProfilerWantsPost("", "example.com")'), false, 'a production host must not post');
  assert.strictEqual(run('frameProfilerWantsPost("", "192.168.1.7")'), true, 'a LAN host enables posting');
  assert.strictEqual(run('frameProfilerWantsPost("", "abc.arena.ai")'), true, 'the arena host enables posting');
  assert.strictEqual(run('frameProfilerWantsPost("", "weatherapp.example.org")'), false,
    'a public host still must not post');
  assert.strictEqual(run('frameProfilerWantsPost("?prof=0", "localhost")'), false, '?prof=0 must opt out everywhere');
  assert.strictEqual(run('frameProfilerWantsPost("?prof=1", "example.com")'), true, '?prof=1 must opt in anywhere');
  run('frameProfiler.post = true;');
  // The first report waits for only a handful of frames, and carries one-time context.
  run('setClockMs(1700); frameProfilerReportIfDue();');
  assert.strictEqual(run('frameProfiler.lastSummary'), null,
    'six frames 700 ms in must still be too little for the boot report');
  for (let i = 0; i < 3; i++) {
    run('setClockMs(' + (1716 + i * 16) + '); frameProfilerBeginFrame();');
    run("frameProfilerRecord('phase-input', 1); frameProfilerRecord('phase-simulate', 12);");
  }
  run('setClockMs(2000); frameProfilerReportIfDue();');
  assert.strictEqual(sent.length, 1, 'the boot report must go out as soon as there are enough frames');
  assert.ok(sent[0].body.boot, 'the first report carries device/renderer context');
  assert.strictEqual(typeof sent[0].body.boot.ua, 'string', 'boot context includes the user agent');

  run('setClockMs(4100); frameProfilerBeginFrame(); frameProfilerRecord("phase-simulate", 11);');
  run('setClockMs(4200); frameProfilerReportIfDue();');
  const summary = run('frameProfiler.lastSummary');
  assert.ok(summary, 'the regular report must follow');
  assert.strictEqual(summary.rows.length, 1, 'the second window reports the sections it recorded');
  const firstSummary = { rows : sent[0].body.rows };
  assert.strictEqual(firstSummary.rows.length, 2, 'both sections must appear in the boot window report');
  assert.ok(summary.frameIntervalMs > 0, 'the interval between frames is measured');
  assert.ok(sent[0].body.jsMs >= 13, 'per-frame JavaScript is the sum of the recorded sections');
  assert.ok(sent[0].body.intervalMs > 0, 'the posted report carries the frame interval');
  assert.strictEqual(run('frameProfiler.frames'), 0, 'the window resets after reporting');
  assert.strictEqual(sent.length, 2, 'each reporting window posts once when the page opted in (?prof=1)');
  assert.strictEqual(sent[0].url, '/api/frame-profile');
  assert.strictEqual(sent[1].body.rows[0][0], 'phase-simulate', 'rows are sorted by cost');
  assert.ok(sent[1].body.rows[0][1] > 0, 'posted cost is per frame');
  console.log('  frame profiler aggregates sections, intervals and posts one payload');
}

// 2. A wrapped function shows up as its own section without changing its result.
{
  run('window.__box = (function() { var box = {}; box.tick = function(n) { var s = 0; for (var i = 0; i < n; i++) s += i; return s; }; window.__box = box; return box; })();');
  assert.strictEqual(run('frameProfilerWrap(window.__box, "tick")'), true, 'wrapping must succeed');
  assert.strictEqual(run('frameProfilerWrap(window.__box, "tick")'), false, 'double wrapping must be refused');
  const value = run('window.__box.tick(5)');
  assert.strictEqual(value, 10, 'the wrapped function must still return its value');
  assert.ok(run('frameProfiler.sections.has("fn:tick")'), 'the wrapped call must be timed');
  console.log('  wrapped functions are timed without changing their result');
}

// 3. The profiler must never throw into the frame, whatever it is handed.
{
  run('frameProfilerRecord("phase-x", undefined); frameProfilerRecord("phase-x", NaN); frameProfilerRecord("phase-x", -5);');
  run('frameProfilerReportIfDue(); frameProfilerReportIfDue();');
  assert.strictEqual(typeof run('frameProfilerSummaryLines()'), 'string', 'the F3 summary must always be a string');
  console.log('  profiler bookkeeping tolerates missing and invalid timings');
}

// 4. Display refresh pacing: the controller must aim at whole refresh intervals so it
//    cannot oscillate between "grow" and "cut" on every frame.
{
  const tune = (smoothed, period) => run('autoTuneTargetMs(' + smoothed + ', ' + period + ')');
  assert.strictEqual(tune(16.7, 16.7), 16.7, 'a one-refresh frame aims at one refresh');
  assert.strictEqual(tune(33.3, 16.7), 33.4, 'a two-refresh frame aims at two refreshes');
  assert.strictEqual(tune(1000, 16.7), 33.4,
    'a frame many refreshes long still aims at a whole refresh count, not a fractional one');
  assert.ok(1000 - tune(1000, 16.7) > 900,
    'and it stays far over budget, so the cut branch keeps reducing the load');
  assert.strictEqual(tune(8.3, 8.3), 8.3, 'a 120 Hz panel settles on one 8.3 ms refresh');
  assert.strictEqual(tune(16.7, 33.3), 33.3, 'a 30 Hz panel settles on one 33.3 ms refresh');
  // The point of the policy: neither branch may fire for a frame that is exactly on target.
  const hold = (period) => {
    const smoothed = period * 2;
    const over = smoothed - tune(smoothed, period);
    return over;
  };
  assert.ok(Math.abs(hold(16.7)) < 0.2, 'a two-refresh frame is exactly on target, not over it');
  assert.ok(Math.abs(hold(8.3)) < 0.2, 'the same holds on a 120 Hz panel');

  // Period measurement cannot creep upward: a device that is merely busy must never be
  // mistaken for a slow panel, or the target would relax until the sim crawls.
  run('displayRefreshPeriodMs = 16.7; displayRefreshMinMs = 16.7;');
  for (let i = 0; i < 120; i++) run('noteFrameIntervalForPacing(33.3)');
  assert.ok(Math.abs(run('displayRefreshPeriodMs') - 16.7) < 0.01,
    'a window of slow frames must not raise the measured period');
  assert.strictEqual(tune(33.3, run('displayRefreshPeriodMs')), 33.4,
    'and the target stays at two refreshes, not three');
  // A 30 Hz panel is recognised because no frame can ever be faster than 33 ms.
  run('displayRefreshPeriodMs = 33.3; displayRefreshMinMs = 33.3;');
  for (let i = 0; i < 120; i++) run('noteFrameIntervalForPacing(33.3)');
  assert.ok(Math.abs(run('displayRefreshPeriodMs') - 33.3) < 0.5, 'a 30 Hz panel measures 33.3 ms');
  assert.strictEqual(tune(33.3, 33.3), 33.3, 'and a one-refresh frame targets one refresh');
  // A genuinely faster panel is picked up: the estimate only ever moves down.
  run('displayRefreshPeriodMs = 33.3; displayRefreshMinMs = 33.3;');
  for (let i = 0; i < 300; i++) run('noteFrameIntervalForPacing(16.7)');
  assert.ok(run('displayRefreshPeriodMs') < 18,
    'a 60 Hz panel is recognised within a few windows (got ' + run('displayRefreshPeriodMs') + ')');
  run('noteFrameIntervalForPacing(NaN); noteFrameIntervalForPacing(-5); noteFrameIntervalForPacing(99999);');
  console.log('  display refresh pacing aims at whole refresh intervals');
}

console.log('Frame profiler regression test passed');
