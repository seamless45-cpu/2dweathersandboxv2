// Parity test for the sounding/CAPE column metrics in app.js.
//
// The scan path dominated frame CPU, so per-column values that do not depend on the
// parcel (row pressure, environmental virtual temperature) are now cached once per
// column, and the per-parcel working arrays are reused. This test loads the previous
// implementation (git HEAD) and the current one side by side and requires *identical*
// results — every metric, every column, NaN patterns included — so the speedup cannot
// have changed what the app computes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const currentSource = fs.readFileSync(path.join(repoRoot, 'app.js'), 'utf8');
// Base commit of this work: the implementation the optimizations are measured against.
const BASELINE_REVS = [
  'cad69c6040d8961d05b7d7dd68aa83d718af3cd8',   // branch point of the lag work
  'HEAD',                                        // fallback (e.g. shallow clone)
];
let baselineSource = null;
let baselineRev = null;
for (const rev of BASELINE_REVS) {
  try {
    baselineSource = execFileSync('git', [ 'show', rev + ':app.js' ], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
    baselineRev = rev;
    break;
  } catch (e) { /* try the next rev */ }
}
if (!baselineSource) {
  console.log('SKIP: could not read a baseline app.js from git');
  process.exit(0);
}
if (baselineSource === currentSource)
  console.log('NOTE: the baseline equals the working tree (nothing to compare yet)');

const PREFIX_SCRIPTS = [
  'js/debugLog.js', 'js/utils.js', 'js/sounding.js', 'js/weatherLabels.js', 'js/tornadoDetection.js',
  'js/eas.js', 'js/meteogram.js', 'js/stationPlot.js', 'js/settlementAtlas.js', 'js/terrainGen.js',
  'lightningV2.js', 'js/synopticBoundaries.js', 'js/radar.js',
];

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
    set() { return true; },
    has() { return true; },
    apply() { return stub; },
    construct() { return stub; },
  });
  return stub;
}

function buildContext(appSource) {
  const sandbox = {
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    Math, JSON, Date, Object, Array, Number, String, Boolean, Error, TypeError, RangeError, Map, Set,
    WeakMap, WeakSet, Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array,
    Uint16Array, Uint32Array, Uint8ClampedArray, ArrayBuffer, DataView, Promise, Symbol, RegExp,
    isNaN, isFinite, parseFloat, parseInt, NaN, Infinity,
    performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    localStorage: makeStub('localStorage'), navigator: makeStub('navigator'), location: makeStub('location'),
    fetch: () => Promise.resolve(makeStub('r')), XMLHttpRequest: makeStub('XHR'), WebSocket: makeStub('WS'),
    Image: makeStub('Image'), Audio: makeStub('Audio'), AudioContext: makeStub('AudioContext'),
    atob: (x) => Buffer.from(String(x), 'base64').toString('binary'),
    btoa: (x) => Buffer.from(String(x), 'binary').toString('base64'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.document = makeStub('document');
  vm.createContext(sandbox);
  for (const rel of PREFIX_SCRIPTS) {
    try { vm.runInContext(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), sandbox, { filename: rel }); }
    catch (e) { /* optional module */ }
  }
  vm.runInContext(appSource, sandbox, { filename: 'app.js' });
  return sandbox;
}

const current = buildContext(currentSource);
const baseline = buildContext(baselineSource);

function setGlobals(ctx, { simResX, simResY, simHeight }) {
  ctx.sim_res_x = simResX;
  ctx.sim_res_y = simResY;
  vm.runInContext(`guiControls = Object.assign({}, guiControls_default);
    guiControls.simHeight = ${simHeight};
    sim_res_x = ${simResX};
    sim_res_y = ${simResY};`, ctx);
}

// Deterministic pseudo-random column generator (varied stability, cloud, gaps, NaN).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeColumn(rng, simResY, surfaceLevel, dz, mode) {
  const envTempsC = new Float32Array(simResY).fill(NaN);
  const envDewC = new Float32Array(simResY).fill(NaN);
  const isFluid = new Array(simResY).fill(false);
  const vxRaw = new Float32Array(simResY);
  const vyRaw = new Float32Array(simResY);
  const waterArr = new Float32Array(simResY);
  const fluidPressure = new Float32Array(simResY);
  const lapse = mode === 'unstable' ? 0.0085 : (mode === 'stable' ? 0.004 : 0.0065);
  const sfcT = mode === 'cold' ? -8 : 12 + rng() * 22;
  const dewDep = mode === 'dry' ? 28 : (mode === 'moist' ? 2 : 8);
  for (let y = surfaceLevel; y < simResY; y++) {
    if (mode === 'gaps' && y > surfaceLevel + 20 && y % 37 > 27)
      continue; // leave a non-fluid / NaN band
    const alt = (y - surfaceLevel) * dz;
    envTempsC[y] = sfcT - alt * lapse + Math.sin(y * 0.21) * 1.6;
    envDewC[y] = envTempsC[y] - dewDep + Math.cos(y * 0.13) * 2.2;
    isFluid[y] = true;
    vxRaw[y] = Math.sin(y * 0.05) * 30 + 10;
    vyRaw[y] = Math.cos(y * 0.07) * 3;
    waterArr[y] = Math.max(0, 4 + Math.sin(y * 0.09) * 3);
    fluidPressure[y] = 101300 - alt * 11 + Math.sin(y * 0.05) * 250;
  }
  return { envTempsC, envDewC, isFluid, vxRaw, vyRaw, waterArr, fluidPressure, surfaceLevel };
}

function nanEqual(a, b, path_) {
  if (Number.isNaN(a) && Number.isNaN(b)) return;      // both NaN counts as equal
  if (typeof a === 'number' && typeof b === 'number') {
    assert.ok(Object.is(a, b), 'value changed at ' + path_ + ': ' + a + ' vs ' + b);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    assert.deepStrictEqual(a, b, 'value changed at ' + path_);
    return;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  assert.deepStrictEqual(ka.slice().sort(), kb.slice().sort(), 'key set changed at ' + path_);
  for (const k of ka)
    nanEqual(a[k], b[k], path_ + '.' + k);
}

// --- compare computeColumnSoundingMetrics across a matrix of columns ---------
const modes = [ 'stable', 'unstable', 'dry', 'moist', 'cold', 'gaps' ];
const geometries = [
  { simResX : 3000, simResY : 300, simHeight : 12000 },
  { simResX : 900, simResY : 200, simHeight : 16000 },
  { simResX : 512, simResY : 90, simHeight : 6000 },
];
let cases = 0;
for (const geo of geometries) {
  for (const mode of modes) {
    for (const lite of [ true, false ]) {
      for (let seed = 1; seed <= 3; seed++) {
        const rng = makeRng(seed * 7919 + mode.length * 131);
        const dz = geo.simHeight / geo.simResY;
        const surfaceLevel = 12 + Math.floor(rng() * 30);
        const col = makeColumn(rng, geo.simResY, surfaceLevel, dz, mode);
        setGlobals(current, geo);
        setGlobals(baseline, geo);
        const args = [ col.envTempsC, col.envDewC, col.isFluid, col.vxRaw, col.vyRaw, col.waterArr,
          geo.simResY, dz, { lite, fluidPressure : col.fluidPressure, columnX : 7 + seed } ];
        const got = current.computeColumnSoundingMetrics(...args);
        const want = baseline.computeColumnSoundingMetrics(...args);
        if (want === null || got === null) {
          assert.strictEqual(got, want, 'null-ness changed for mode ' + mode);
          continue;
        }
        nanEqual(got, want, mode + '/' + JSON.stringify(geo) + '/lite=' + lite + '/seed=' + seed);
        cases++;
      }
    }
  }
}
console.log('  column metrics identical across ' + cases + ' column configurations');

// --- compare the low-level parcel helpers directly --------------------------
{
  const geo = { simResX : 3000, simResY : 300, simHeight : 12000 };
  setGlobals(current, geo);
  setGlobals(baseline, geo);
  const dz = geo.simHeight / geo.simResY;
  const rng = makeRng(4242);
  const col = makeColumn(rng, geo.simResY, 20, dz, 'unstable');
  for (const startIndex of [ 20, 25, 40, 60 ]) {
    const gotProfile = current.computeParcelProfileForColumn(30, 20, startIndex, geo.simResY, dz);
    const wantProfile = baseline.computeParcelProfileForColumn(30, 20, startIndex, geo.simResY, dz);
    assert.deepStrictEqual(Array.from(gotProfile), Array.from(wantProfile),
      'parcel profile changed at startIndex ' + startIndex);
    for (const thermo of [ undefined, current.buildColumnThermoCache(col.envTempsC, col.envDewC, geo.simResY, dz) ]) {
      const gotCape = current.computeCAPEForColumn(col.envTempsC, col.envDewC, wantProfile, startIndex,
        col.isFluid, geo.simResY, dz, startIndex * dz, col.envDewC[startIndex], thermo);
      const wantCape = baseline.computeCAPEForColumn(col.envTempsC, col.envDewC, wantProfile, startIndex,
        col.isFluid, geo.simResY, dz, startIndex * dz, col.envDewC[startIndex]);
      nanEqual(gotCape, wantCape, 'cape@' + startIndex + (thermo ? ' (cached)' : ' (uncached)'));
    }
    const gotMl = current.meanLayerParcelForColumn(col.envTempsC, col.envDewC, startIndex, geo.simResY, dz);
    const wantMl = baseline.meanLayerParcelForColumn(col.envTempsC, col.envDewC, startIndex, geo.simResY, dz);
    assert.deepStrictEqual(Array.from(gotMl), Array.from(wantMl), 'mean-layer profile changed at ' + startIndex);
  }
}
console.log('  parcel profile / CAPE helpers identical with and without the cache');

// --- the cached path must not leak stale values between columns -------------
{
  const geo = { simResX : 3000, simResY : 300, simHeight : 12000 };
  setGlobals(current, geo);
  setGlobals(baseline, geo);
  const dz = geo.simHeight / geo.simResY;
  const a = makeColumn(makeRng(11), geo.simResY, 20, dz, 'unstable');
  const b = makeColumn(makeRng(22), geo.simResY, 26, dz, 'stable');
  const runBoth = (col) => {
    const args = [ col.envTempsC, col.envDewC, col.isFluid, col.vxRaw, col.vyRaw, col.waterArr,
      geo.simResY, dz, { lite : true, fluidPressure : col.fluidPressure, columnX : 3 } ];
    return { got : current.computeColumnSoundingMetrics(...args), want : baseline.computeColumnSoundingMetrics(...args) };
  };
  for (let round = 0; round < 3; round++) {
    for (const col of [ a, b, a ]) {
      const { got, want } = runBoth(col);
      nanEqual(got, want, 'interleaved round ' + round);
    }
  }
}
console.log('  interleaved columns produce identical metrics (no stale cache)');

// --- the graph's fused MU / elevated / 0-3 km search must equal the three separate ones
// The skew-T graph used to run three overlapping searches (each with its own parcel profile
// and CAPE per candidate level). They are now a single pass; this checks value-for-value that
// the fusion changed nothing, including which level wins the most-unstable search.
{
  const geo = { simResX : 3000, simResY : 300, simHeight : 12000 };
  setGlobals(current, geo);
  const dz = geo.simHeight / geo.simResY;
  const referenceSource = `
    function __referenceSearches(envTempsC, envDewC, columnIsFluid, isFluidAt, simResY, dz, sfcAltM, surfaceLevel, muSearchMax) {
      let muCape = 0, muCinh = NaN, muLcl = NaN, muLfc = NaN, muEl = NaN, muParcelLevel = -1;
      for (let y = surfaceLevel; y <= muSearchMax; y++) {
        if (!isFluidAt(y)) continue;
        const pp = computeParcelProfileForColumn(envTempsC[y], envDewC[y], y, simResY, dz);
        const m = computeCAPEForColumn(envTempsC, envDewC, pp, y, columnIsFluid, simResY, dz, sfcAltM, envDewC[y]);
        if (m.cape > muCape) { muCape = m.cape; muCinh = m.cinh; muLcl = m.lclAlt; muLfc = m.lfcAlt; muEl = m.elAlt; muParcelLevel = y; }
      }
      let elevatedCape = 0;
      const elevOriginMin = surfaceLevel + Math.round(1500 / dz);
      for (let y = elevOriginMin; y <= muSearchMax; y++) {
        if (!isFluidAt(y)) continue;
        const pp = computeParcelProfileForColumn(envTempsC[y], envDewC[y], y, simResY, dz);
        const m = computeCAPEForColumn(envTempsC, envDewC, pp, y, columnIsFluid, simResY, dz, sfcAltM, envDewC[y]);
        if (m.cape > elevatedCape) elevatedCape = m.cape;
      }
      let cape3km = 0;
      const max3kmLevel = surfaceLevel + Math.round(3000 / dz);
      for (let y = surfaceLevel; y < Math.min(max3kmLevel, simResY); y++) {
        if (!isFluidAt(y)) continue;
        const pp = computeParcelProfileForColumn(envTempsC[y], envDewC[y], y, simResY, dz);
        const m = computeCAPEForColumn(envTempsC, envDewC, pp, y, columnIsFluid, simResY, dz, sfcAltM, envDewC[y]);
        if (m.cape3km > cape3km) cape3km = m.cape3km;
      }
      return { muCape, muCinh, muLcl, muLfc, muEl, muParcelLevel, elevatedCape, cape3km };
    }
  `;
  vm.runInContext(referenceSource, current);
  let fusedCases = 0;
  for (const mode of modes) {
    for (const depthM of [ 1000, 3000, 5000 ]) {
      for (const seed of [ 3, 9 ]) {
        const rng = makeRng(seed * 104729 + depthM);
        const surfaceLevel = 5 + Math.floor(rng() * 40);
        const col = makeColumn(rng, geo.simResY, surfaceLevel, dz, mode);
        const muSearchMax = Math.min(geo.simResY - 1, surfaceLevel + Math.round(depthM / dz));
        const byArray = (y) => !!col.isFluid[y];
        // the graph can pass a predicate instead of the fluid array for the level filter
        const byPredicate = (y) => !!col.isFluid[y] && y < geo.simResY - 12;
        const thermo = current.buildColumnThermoCache(col.envTempsC, col.envDewC, geo.simResY, dz);
        for (const isFluidAt of [ byArray, byPredicate ]) {
          const want = current.__referenceSearches(col.envTempsC, col.envDewC, col.isFluid, isFluidAt,
            geo.simResY, dz, surfaceLevel * dz, surfaceLevel, muSearchMax);
          const got = current.computeColumnParcelSearches(col.envTempsC, col.envDewC, col.isFluid, isFluidAt,
            geo.simResY, dz, surfaceLevel * dz, surfaceLevel, muSearchMax, thermo);
          nanEqual(got, want, 'fused search ' + mode + '/' + depthM + 'm/' + seed);
          fusedCases++;
          const plain = current.computeColumnParcelSearches(col.envTempsC, col.envDewC, col.isFluid, isFluidAt,
            geo.simResY, dz, surfaceLevel * dz, surfaceLevel, muSearchMax);
          nanEqual(plain, want, 'fused search (no thermo) ' + mode + '/' + depthM + 'm/' + seed);
        }
      }
    }
  }
  console.log('  fused MU / elevated / 0-3 km search identical to three separate searches (' + fusedCases + ' cases)');
}

// --- the skew-T analysis refresh policy ------------------------------------
// The graph's CAPE/hodograph analysis is inherently expensive, so it is refreshed at a
// bounded rate (the column readback is held with it so curves and numbers stay in step).
// The policy must always refresh for a new column eventually and always follow a balloon.
{
  const now = 100000;
  const key = 'x|y';
  const refresh = (cached, analysisKey, nowMs, light) =>
    current.shouldRefreshSoundingAnalysis(cached, analysisKey, nowMs, light);
  assert.strictEqual(refresh(null, key, now, false), true, 'no cached analysis must compute one');
  assert.strictEqual(refresh({ key, timeMs : now - 10 }, key, now, false), false,
    'a same-column analysis younger than the idle interval is reused');
  assert.strictEqual(refresh({ key, timeMs : now - 111 }, key, now, false), true,
    'a same-column analysis must refresh once the idle interval elapses');
  assert.strictEqual(refresh({ key : 'other', timeMs : now - 10 }, key, now, false), false,
    'a very fresh analysis is held even when the column changed');
  assert.strictEqual(refresh({ key : 'other', timeMs : now - 41 }, key, now, false), true,
    'a changed column must be picked up within the follow interval');
  assert.strictEqual(refresh({ key, timeMs : now - 1 }, key, now, true), true,
    'a balloon sounding always refreshes');
  // Top-level consts live in the script scope, not on the vm's global object.
  const intervals = vm.runInContext('SOUNDING_ANALYSIS_MIN_INTERVAL_MS', current);
  const maxInterval = vm.runInContext('SOUNDING_ANALYSIS_MAX_INTERVAL_MS', current);
  assert.ok(intervals > 0 && intervals < maxInterval,
    'the follow interval must be shorter than the idle refresh interval');
  console.log('  analysis refresh policy: follows a new column within '
    + intervals + ' ms, refreshes a held column every ' + maxInterval + ' ms');
}

console.log('Sounding metrics parity regression test passed (baseline ' + baselineRev + ')');
