// Measures the CPU cost of the per-frame sounding/overlay machinery in app.js, for the
// current working tree and for the previous implementation (git HEAD), so the reported
// speedups can be reproduced.
//
// app.js is loaded into a vm with auto-stub DOM/GL objects so the top-level function
// definitions exist; the functions under test are then called with synthetic data that
// matches what the running simulation produces. Each measurement resets the sub-call
// counters so the breakdown belongs to that measurement only.
//
//   node test/_profile-frame.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const SIM_RES_X = 3000;       // index.html default grid
const SIM_RES_Y = 300;
const SIM_HEIGHT = 12000;
const DZ = SIM_HEIGHT / SIM_RES_Y;   // 40 m cells
const SURFACE = 40;

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
    set() { return true; }, has() { return true; }, apply() { return stub; }, construct() { return stub; },
  });
  return stub;
}

function buildHarness(appSource) {
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
  vm.runInContext(`guiControls = Object.assign({}, guiControls_default);
    guiControls.simHeight = ${SIM_HEIGHT};
    sim_res_x = ${SIM_RES_X}; sim_res_y = ${SIM_RES_Y}; iterNum = 5000; even = true;`, sandbox);

  const subStats = new Map();
  function wrap(name) {
    const orig = sandbox[name];
    if (typeof orig !== 'function') return;
    const stat = { calls : 0, ns : 0n };
    subStats.set(name, stat);
    sandbox[name] = function(...args) {
      const t0 = process.hrtime.bigint();
      try { return orig.apply(this, args); }
      finally { stat.calls++; stat.ns += process.hrtime.bigint() - t0; }
    };
  }
  [ 'computeColumnSoundingMetricsBody', 'computeCAPEForColumn', 'computeParcelProfileForColumn', 'meanLayerParcelForColumn',
    'findLclAltFromParcel', 'skewHpaFromAltM', 'mixingRatioKgFromDewpoint', 'dewpointFromMixingRatioKg',
    'virtualTemperatureK', 'moistAdiabaticLapseRateKperM', 'beginPhysicalPressureColumn',
    'computeColumnHazardsAndFire', 'sampleColumnSurfaceHydrology', 'sampleColumnRainAccumMm', 'relativeHumd',
    'computeColumnParcelSearches' ].forEach(wrap);

  const fn = (name) => {
    if (typeof sandbox[name] !== 'function') throw new Error('missing ' + name);
    return sandbox[name];
  };

  function measure(label, iterations, body) {
    body(0);                       // warm up
    for (const s of subStats.values()) { s.calls = 0; s.ns = 0n; }
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) body(i);
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    const per = total / iterations;
    const rows = [ ...subStats.entries() ].map(([ n, s ]) => [ n, s.calls / iterations, Number(s.ns) / 1e6 / iterations ]);
    rows.sort((a, b) => b[2] - a[2]);
    console.log(label + ': ' + per.toFixed(2) + ' ms/call');
    for (const [ n, calls, ms ] of rows) {
      if (ms < 0.03) continue;
      console.log('      ' + n.padEnd(32) + calls.toFixed(1).padStart(8) + ' calls ' + ms.toFixed(3).padStart(8) + ' ms');
    }
    return per;
  }

  return { sandbox, fn, measure, wrap };
}

// ---- identical data for both implementations --------------------------------
const col = (() => {
  const envTempsC = new Float32Array(SIM_RES_Y);
  const envDewC = new Float32Array(SIM_RES_Y);
  const isFluid = new Array(SIM_RES_Y).fill(false);
  const vxRaw = new Float32Array(SIM_RES_Y);
  const vyRaw = new Float32Array(SIM_RES_Y);
  const waterArr = new Float32Array(SIM_RES_Y);
  const fluidPressure = new Float32Array(SIM_RES_Y);
  for (let y = SURFACE; y < SIM_RES_Y; y++) {
    const alt = (y - SURFACE) * DZ;
    envTempsC[y] = 30 - alt * 0.0065 + Math.sin(y * 0.1) * 2.5;
    envDewC[y] = 22 - alt * 0.004 + Math.cos(y * 0.07) * 3;
    isFluid[y] = true;
    vxRaw[y] = Math.sin(y * 0.05) * 40;
    vyRaw[y] = Math.cos(y * 0.03) * 5;
    waterArr[y] = y < SURFACE + 40 ? 8 : 3.5;
    fluidPressure[y] = 101300 * Math.exp(-alt / 8000);
  }
  return { envTempsC, envDewC, isFluid, vxRaw, vyRaw, waterArr, fluidPressure };
})();

const cells = SIM_RES_X * SIM_RES_Y;
const baseAll = new Float32Array(cells * 4);
const waterAll = new Float32Array(cells * 4);
const wallAll = new Int8Array(cells * 4);
for (let x = 0; x < SIM_RES_X; x++) {
  for (let y = 0; y < SIM_RES_Y; y++) {
    const i = (y * SIM_RES_X + x) * 4;
    wallAll[i + 1] = y >= SURFACE ? 1 : 0;
    baseAll[i + 3] = 300 + Math.sin(x * 0.01 + y * 0.05) * 8;
    baseAll[i + 0] = 20;
    baseAll[i + 1] = 2;
    baseAll[i + 2] = 90000 + y * 30;
    waterAll[i] = 6 + Math.sin(x * 0.02) * 2;
    waterAll[i + 1] = y < SURFACE + 80 ? 1.5 : 0;
    waterAll[i + 2] = (x % 37 === 0 && y < SURFACE + 6) ? 0.4 : 0.01;
    waterAll[i + 3] = 0.02;
  }
}

// The skew-T graph's own analysis sequence (surface parcel, mean-layer parcel, then the
// MU / elevated / 0-3 km searches). `after` uses the shared column thermo cache and the
// single fused search pass; `before` does what the graph did per frame before.
function graphAnalysis(before) {
  return (i) => {
    const ctx = before.harness.sandbox;
    const surfaceLevel = SURFACE;
    const sfcAltM = surfaceLevel * DZ;
    const columnIsFluid = col.isFluid;
    const isFluidAt = (y) => !!col.isFluid[y];
    const muSearchMax = Math.min(SIM_RES_Y - 1, surfaceLevel + Math.round(3000 / DZ));
    const sandboxFns = before.harness.sandbox;
    const thermo = typeof sandboxFns.buildColumnThermoCache === 'function'
      ? sandboxFns.buildColumnThermoCache(col.envTempsC, col.envDewC, SIM_RES_Y, DZ)
      : undefined;
    const scratch = typeof sandboxFns.columnThermoScratchView === 'function'
      ? sandboxFns.columnThermoScratchView
      : null;
    const surfaceProfile = before.harness.fn('computeParcelProfileForColumn')(
      col.envTempsC[surfaceLevel], col.envDewC[surfaceLevel], surfaceLevel, SIM_RES_Y, DZ,
      scratch ? scratch('profSurface', Float32Array, SIM_RES_Y) : undefined, thermo);
    const sb = before.harness.fn('computeCAPEForColumn')(col.envTempsC, col.envDewC, surfaceProfile, surfaceLevel,
      columnIsFluid, SIM_RES_Y, DZ, sfcAltM, col.envDewC[surfaceLevel], thermo);
    const mlProfile = before.harness.fn('meanLayerParcelForColumn')(col.envTempsC, col.envDewC, surfaceLevel, SIM_RES_Y, DZ,
      scratch ? scratch('profMl', Float32Array, SIM_RES_Y) : undefined, thermo);
    const ml = before.harness.fn('computeCAPEForColumn')(col.envTempsC, col.envDewC, mlProfile, surfaceLevel,
      columnIsFluid, SIM_RES_Y, DZ, sfcAltM, mlProfile._parcelTd, thermo);
    const fused = typeof before.harness.sandbox.computeColumnParcelSearches === 'function'
      ? before.harness.sandbox.computeColumnParcelSearches
      : null;
    if (fused) {
      const s = fused(col.envTempsC, col.envDewC, columnIsFluid, isFluidAt, SIM_RES_Y, DZ, sfcAltM, surfaceLevel, muSearchMax, thermo);
      return { sb : sb.cape, ml : ml.cape, mu : s.muCape, elev : s.elevatedCape, c3 : s.cape3km, lvl : s.muParcelLevel };
    }
    // pre-fusion: three separate searches, each recomputing parcel profile and CAPE
    let muCape = 0, muParcelLevel = -1;
    for (let y = surfaceLevel; y <= muSearchMax; y++) {
      if (!isFluidAt(y)) continue;
      const pp = before.harness.fn('computeParcelProfileForColumn')(col.envTempsC[y], col.envDewC[y], y, SIM_RES_Y, DZ);
      const m = before.harness.fn('computeCAPEForColumn')(col.envTempsC, col.envDewC, pp, y, columnIsFluid, SIM_RES_Y, DZ, sfcAltM, col.envDewC[y]);
      if (m.cape > muCape) { muCape = m.cape; muParcelLevel = y; }
    }
    let elevatedCape = 0;
    const elevOriginMin = surfaceLevel + Math.round(1500 / DZ);
    for (let y = elevOriginMin; y <= muSearchMax; y++) {
      if (!isFluidAt(y)) continue;
      const pp = before.harness.fn('computeParcelProfileForColumn')(col.envTempsC[y], col.envDewC[y], y, SIM_RES_Y, DZ);
      const m = before.harness.fn('computeCAPEForColumn')(col.envTempsC, col.envDewC, pp, y, columnIsFluid, SIM_RES_Y, DZ, sfcAltM, col.envDewC[y]);
      if (m.cape > elevatedCape) elevatedCape = m.cape;
    }
    let cape3km = 0;
    const max3kmLevel = Math.min(surfaceLevel + Math.round(3000 / DZ), SIM_RES_Y);
    for (let y = surfaceLevel; y < max3kmLevel; y++) {
      if (!isFluidAt(y)) continue;
      const pp = before.harness.fn('computeParcelProfileForColumn')(col.envTempsC[y], col.envDewC[y], y, SIM_RES_Y, DZ);
      const m = before.harness.fn('computeCAPEForColumn')(col.envTempsC, col.envDewC, pp, y, columnIsFluid, SIM_RES_Y, DZ, sfcAltM, col.envDewC[y]);
      if (m.cape3km > cape3km) cape3km = m.cape3km;
    }
    return { sb : sb.cape, ml : ml.cape, mu : muCape, elev : elevatedCape, c3 : cape3km, lvl : muParcelLevel };
  };
}

const baselineSource = execFileSync('git', [ 'show', 'HEAD:app.js' ], { cwd : repoRoot, maxBuffer : 64 * 1024 * 1024 }).toString();
const currentSource = fs.readFileSync(path.join(repoRoot, 'app.js'), 'utf8');
const baseline = { harness : buildHarness(baselineSource) };
const current = { harness : buildHarness(currentSource) };

console.log('grid ' + SIM_RES_X + 'x' + SIM_RES_Y + ' (' + DZ + ' m cells), scan step 8 -> ' +
  Math.ceil(SIM_RES_X / 8) + ' columns per scan');
console.log('');

const colScratchOf = (h) => h.fn('prepareOverlayColumnArrays')(SIM_RES_Y);
const bundleArgs = (scratch, i) => [ baseAll, waterAll, wallAll, null, (i * 7) % (SIM_RES_X - 1), SIM_RES_X, SIM_RES_Y,
  DZ, scratch, { lite : true, needHazards : true, hazardsIfPrecip : true, needHotspot : true } ];
const liteArgs = (i) => [ col.envTempsC, col.envDewC, col.isFluid, col.vxRaw, col.vyRaw, col.waterArr,
  SIM_RES_Y, DZ, { lite : true, fluidPressure : col.fluidPressure, columnX : i } ];

const baseScratch = colScratchOf(baseline.harness);
const curScratch = colScratchOf(current.harness);
baseline.harness.measure('BASELINE (HEAD) - overlay/map scan column', 40, (i) =>
  baseline.harness.fn('computeOverlayColumnBundle')(...bundleArgs(baseScratch, i)));
const baseScanMs = baseline.harness.measure('BASELINE (HEAD) - lite sounding column', 40, (i) =>
  baseline.harness.fn('computeColumnSoundingMetrics')(...liteArgs(i)));
console.log('');
const curScanMs = current.harness.measure('CURRENT - overlay/map scan column', 40, (i) =>
  current.harness.fn('computeOverlayColumnBundle')(...bundleArgs(curScratch, i)));
console.log('');
const baseGraph = baseline.harness.measure('BASELINE (HEAD) - skew-T graph analysis', 8, graphAnalysis(baseline));
console.log('');
const curGraph = current.harness.measure('CURRENT - skew-T graph analysis', 8, graphAnalysis(current));
console.log('');
console.log('scan column: ' + baseScanMs.toFixed(2) + ' -> ' + curScanMs.toFixed(2) + ' ms (' +
  (baseScanMs / curScanMs).toFixed(1) + 'x faster)');
console.log('graph analysis: ' + baseGraph.toFixed(1) + ' -> ' + curGraph.toFixed(1) + ' ms (' +
  (baseGraph / curGraph).toFixed(1) + 'x faster)');
const ref = graphAnalysis(baseline)(0);
const now = graphAnalysis(current)(0);
let same = true;
for (const k of Object.keys(ref))
  if (!(Object.is(ref[k], now[k]) || (Number.isNaN(ref[k]) && Number.isNaN(now[k])))) { same = false; console.log('  MISMATCH ' + k + ': ' + ref[k] + ' vs ' + now[k]); }
console.log('graph analysis values identical: ' + same);
