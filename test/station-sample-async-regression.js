// Regression test for batched weather-station sampling in app.js.
//
// A station measurement used to issue nine blocking readPixels. The reads are now
// enqueued into pixel-pack buffers and served from the collected columns once the
// fence signals. This test drives that machinery against a fake GL and asserts the
// served bytes are exactly what the blocking read of the same range returns, plus
// the fallback rules (unknown column, out-of-range row, dead fence).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');

function extractFunction(source, name)
{
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'could not find ' + name + ' in app.js');
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0)
        return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
}

function extractBlock(source, marker)
{
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'could not find ' + marker + ' in app.js');
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0)
        return source.slice(start, i + 1) + ';';
    }
  }
  throw new Error('unbalanced braces after ' + marker);
}

const FUNCTIONS = [
  'stationSampleReader',
  'stationSampleColumnFor',
  'stationSampleRead',
  'beginStationSampleBatch',
  'pollStationSampleBatch',
  'createAsyncPixelReader',
  'asyncPixelReaderBusy',
  'beginAsyncReadPixels',
  'cancelAsyncReadPixels',
  'pollAsyncReadPixels',
];

const GL = {
  RGBA : 8000, RGBA_INTEGER : 8001, RED : 8004, FLOAT : 8002, BYTE : 8003,
  FRAMEBUFFER : 3000, COLOR_ATTACHMENT0 : 4000, COLOR_ATTACHMENT1 : 4001,
  COLOR_ATTACHMENT2 : 4002, COLOR_ATTACHMENT3 : 4003,
  PIXEL_PACK_BUFFER : 7000, STREAM_READ : 7001,
  SYNC_GPU_COMMANDS_COMPLETE : 9000, SYNC_STATUS : 9001, SIGNALED : 9002, UNSIGNALED : 9003,
};

// Fake GL where attachments hold deterministic bytes, and both the pixel-pack and the
// client-memory readPixels paths copy the very same bytes for a given range.
function makeFakeGl(simResX, simResY)
{
  const attachments = new Map();
  let nextBuffer = 1;
  let nextSync = 1;
  const state = {
    readsIntoPbo : 0,
    readsIntoClient : 0,
    signaled : true,
    boundPbo : null,
    boundFramebuffer : null,
    readBuffer : null,
    pbos : new Map(),
    syncs : new Map(),
    frameBuffers : { frameBuff_0 : 11, lightFrameBuff_0 : 12 },
  };

  function attachmentBytes(fbo, attachment)
  {
    let byAttachment = attachments.get(fbo);
    if (!byAttachment) { byAttachment = new Map(); attachments.set(fbo, byAttachment); }
    let bytes = byAttachment.get(attachment);
    if (!bytes) {
      bytes = new Uint8Array(simResX * simResY * 16);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = (fbo * 37 + attachment * 61 + i * 7) & 0xff;
      byAttachment.set(attachment, bytes);
    }
    return bytes;
  }

  function bytesPerPixel(format, type)
  {
    if (format === GL.RED) return 4;
    if (format === GL.RGBA_INTEGER && type === GL.BYTE) return 4;
    return 16;
  }

  // Copies the exact range a real readPixels would return into `out` (a Uint8Array).
  function copyRange(out, x, y, w, h, format, type)
  {
    const src = attachmentBytes(state.boundFramebuffer, state.readBuffer);
    const bpp = bytesPerPixel(format, type);
    const srcRow = simResX * 16;
    const outRow = w * bpp;
    for (let row = 0; row < h; row++) {
      for (let px = 0; px < w; px++) {
        const s = (y + row) * srcRow + (x + px) * 16;
        const d = row * outRow + px * bpp;
        for (let b = 0; b < bpp; b++)
          out[d + b] = src[s + b];
      }
    }
  }

  const gl = Object.assign({}, GL, {
    bindFramebuffer : (target, fbo) => { state.boundFramebuffer = fbo; },
    readBuffer : (attachment) => { state.readBuffer = attachment; },
    createBuffer : () => nextBuffer++,
    bindBuffer : (target, buffer) => { state.boundPbo = target === GL.PIXEL_PACK_BUFFER ? buffer : null; },
    bufferData : (target, byteSize) => { state.pbos.set(state.boundPbo, new Uint8Array(byteSize)); },
    readPixels : (x, y, w, h, format, type, dst) => {
      if (state.boundPbo) {
        const pbo = state.pbos.get(state.boundPbo);
        assert.ok(pbo, 'readPixels into an unallocated pixel-pack buffer');
        copyRange(pbo, x, y, w, h, format, type);
        state.readsIntoPbo++;
      } else {
        assert.ok(dst && dst.byteLength >= w * h * bytesPerPixel(format, type),
          'client-memory readPixels needs a large enough destination');
        copyRange(new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength), x, y, w, h, format, type);
        state.readsIntoClient++;
      }
    },
    fenceSync : () => { const sync = nextSync++; state.syncs.set(sync, state.signaled); return sync; },
    deleteSync : (sync) => { state.syncs.delete(sync); },
    getSyncParameter : (sync) => (state.syncs.get(sync) ? GL.SIGNALED : GL.UNSIGNALED),
    getBufferSubData : (target, offset, dst) => {
      const pbo = state.pbos.get(state.boundPbo);
      assert.ok(pbo, 'getBufferSubData on an unallocated buffer');
      new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(pbo.subarray(0, dst.byteLength));
    },
  });
  return { gl, state };
}

function buildSandbox(simResX, simResY, stationXs)
{
  const { gl, state } = makeFakeGl(simResX, simResY);
  const sandbox = {
    gl,
    fakeState : state,
    console,
    sim_res_x : simResX,
    sim_res_y : simResY,
    frameBuff_0 : state.frameBuffers.frameBuff_0,
    lightFrameBuff_0 : state.frameBuffers.lightFrameBuff_0,
    weatherStations : stationXs.map((x) => ({ getXpos : () => x })),
  };
  sandbox.window = sandbox;
  const code = []
    .concat(extractBlock(appSource, 'var stationSampleCache = {'))
    .concat(extractBlock(appSource, 'var stationSamples = {'))
    .concat(appSource.match(/const STATION_SAMPLE_READBACK_MAX_FRAMES = \d+;/)[0])
    .concat(extractBlock(appSource, 'var stationSampleReaders = [];'))
    .concat(FUNCTIONS.map((name) => extractFunction(appSource, name)))
    .join('\n');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

// The reads measure() and #recordMeteogramSample perform, in order, per station.
// Ranges mirror the app code: a 1x3 base row and 1x2 water row one cell below the
// station, a 1500 m base+wall column from the station upward, 1x1 smoke/light at the
// station, and the meteogram base/water/wall column from the station to the top.
function stationReads(simResY, stationY)
{
  const depthCells = Math.max(2, Math.round(1500 / (12000 / simResY)));
  const colTop = Math.max(0, Math.min(simResY - 1, stationY));
  const mslpH = Math.max(1, Math.min(depthCells, simResY - colTop));
  const meteoH = Math.max(1, simResY - colTop);
  return [
    { kind : 'base', dy : -1, h : 3, type : 'float' },
    { kind : 'base', dy : 0, h : mslpH, type : 'float' },
    { kind : 'wall', dy : 0, h : mslpH, type : 'int8' },
    { kind : 'water', dy : -1, h : 2, type : 'float' },
    { kind : 'smoke', dy : 0, h : 1, type : 'float' },
    { kind : 'light', dy : 0, h : 1, type : 'float' },
    { kind : 'base', dy : 0, h : meteoH, type : 'float' },
    { kind : 'water', dy : 0, h : meteoH, type : 'float' },
    { kind : 'wall', dy : 0, h : meteoH, type : 'int8' },
  ];
}

function allocateFor(spec, simResY)
{
  if (spec.type === 'int8') return new Int8Array(spec.h * 4);
  if (spec.kind === 'smoke') return new Float32Array(spec.h);
  return new Float32Array(spec.h * 4);
}

const SIM_RES_X = 32, SIM_RES_Y = 16;
const STATION_XS = [4, 11, 20];
const STATION_Y = 6;

// 1. Kick-off enqueues five pixel-pack reads per station and touches no client memory.
{
  const sandbox = buildSandbox(SIM_RES_X, SIM_RES_Y, STATION_XS);
  const started = vm.runInContext('beginStationSampleBatch();', sandbox);
  assert.strictEqual(started, true, 'the batch should start');
  assert.strictEqual(sandbox.fakeState.readsIntoPbo, STATION_XS.length * 5,
    'expected five enqueued reads per station');
  assert.strictEqual(sandbox.fakeState.readsIntoClient, 0, 'kicking off must not block on client reads');
  assert.strictEqual(sandbox.stationSampleCache.valid, false, 'columns are not valid before collection');
  const again = vm.runInContext('beginStationSampleBatch();', sandbox);
  assert.strictEqual(again, false, 'a second batch must not start while one is pending');
}

// 2. Collected columns serve exactly the bytes a blocking read of the same range returns.
{
  const sandbox = buildSandbox(SIM_RES_X, SIM_RES_Y, STATION_XS);
  vm.runInContext('beginStationSampleBatch();', sandbox);
  const collected = vm.runInContext('pollStationSampleBatch();', sandbox);
  assert.strictEqual(collected, true, 'the poll should collect the batch');
  assert.strictEqual(sandbox.stationSampleCache.valid, true, 'columns should be valid once collected');

  const specs = stationReads(SIM_RES_Y, STATION_Y);
  const gl = sandbox.gl;
  for (const x of STATION_XS) {
    for (const spec of specs) {
      const y = STATION_Y + spec.dy;
      if (y < 0)
        continue;
      // what the shim serves
      const served = allocateFor(spec, SIM_RES_Y);
      const ok = vm.runInContext(
        `stationSampleRead(${JSON.stringify(spec.kind)}, ${x}, ${y}, 1, ${spec.h}, __dst);`, 
        Object.assign(sandbox, { __dst : served }));
      assert.strictEqual(ok, true, 'collected column should serve ' + spec.kind);

      // what a blocking read of the same framebuffer range returns
      const expected = allocateFor(spec, SIM_RES_Y);
      const fbo = spec.kind === 'light' ? sandbox.lightFrameBuff_0 : sandbox.frameBuff_0;
      const attachment = { base : GL.COLOR_ATTACHMENT0, water : GL.COLOR_ATTACHMENT1,
        wall : GL.COLOR_ATTACHMENT2, smoke : GL.COLOR_ATTACHMENT3, light : GL.COLOR_ATTACHMENT0 }[spec.kind];
      gl.bindFramebuffer(GL.FRAMEBUFFER, fbo);
      gl.readBuffer(attachment);
      gl.readPixels(x, y, 1, spec.h, spec.kind === 'wall' ? GL.RGBA_INTEGER : (spec.kind === 'smoke' ? GL.RED : GL.RGBA),
        spec.kind === 'wall' ? GL.BYTE : GL.FLOAT, expected);

      assert.deepStrictEqual(Array.from(served), Array.from(expected),
        'served bytes must match a blocking read for ' + spec.kind + ' at x=' + x + ' y=' + y + ' h=' + spec.h);
    }
  }
}

// 3. Reads the collected columns cannot serve fall through instead of guessing.
{
  const sandbox = buildSandbox(SIM_RES_X, SIM_RES_Y, STATION_XS);
  vm.runInContext('beginStationSampleBatch();', sandbox);
  vm.runInContext('pollStationSampleBatch();', sandbox);
  const probe = new Float32Array(4);
  const cases = [
    [ 'base', 5, STATION_Y, 1, 2 ],   // unknown column (no station there)
    [ 'base', 4, -1, 1, 2 ],          // row below the grid
    [ 'base', 4, SIM_RES_Y - 1, 1, 2 ], // range past the top row
    [ 'base', 4, STATION_Y, 2, 1 ],   // wider than one column
    [ 'light', SIM_RES_X, STATION_Y, 1, 1 ], // off-grid column
  ];
  for (const [ kind, x, y, w, h ] of cases) {
    const ok = vm.runInContext(
      `stationSampleRead(${JSON.stringify(kind)}, ${x}, ${y}, ${w}, ${h}, __dst);`,
      Object.assign(sandbox, { __dst : probe }));
    assert.strictEqual(ok, false, 'unservable read must fall back: ' + [ kind, x, y, w, h ].join(','));
  }
  // ...and without collected data nothing is served at all.
  sandbox.stationSampleCache.valid = false;
  const okNoCache = vm.runInContext(
    `stationSampleRead('base', 4, ${STATION_Y}, 1, 1, __dst);`,
    Object.assign(sandbox, { __dst : probe }));
  assert.strictEqual(okNoCache, false, 'an invalid cache must never serve a read');
}

// 4. A fence that never signals gives up (direct reads) instead of hanging.
{
  const sandbox = buildSandbox(SIM_RES_X, SIM_RES_Y, STATION_XS);
  sandbox.fakeState.signaled = false;
  vm.runInContext('beginStationSampleBatch();', sandbox);
  const maxFrames = Number(appSource.match(/const STATION_SAMPLE_READBACK_MAX_FRAMES = (\d+);/)[1]);
  for (let i = 0; i < maxFrames - 1; i++)
    assert.strictEqual(vm.runInContext('pollStationSampleBatch();', sandbox), false, 'must keep waiting');
  assert.strictEqual(vm.runInContext('pollStationSampleBatch();', sandbox), true, 'the wait must end');
  assert.strictEqual(sandbox.stationSampleCache.valid, false, 'a dead fence yields no columns');
  assert.strictEqual(sandbox.stationSamples.pending, false, 'the batch must be cleared');
}

// 5. Station wiring: every read in the station class is served (or falls back) through
//    the collected columns, so no blocking read can sneak back onto the hot path.
{
  const classStart = appSource.indexOf('class Weatherstation');
  const classEnd = appSource.indexOf('class WeatherBalloon');
  assert.ok(classStart > 0 && classEnd > classStart, 'could not locate the Weatherstation class');
  const classSource = appSource.slice(classStart, classEnd);
  const guarded = (classSource.match(/stationSampleRead\(/g) || []).length;
  const reads = (classSource.match(/gl\.readPixels\(/g) || []).length;
  assert.strictEqual(reads, 9, 'expected the nine known station reads, found ' + reads);
  assert.strictEqual(guarded, 9, 'every station read must try the collected columns first (found ' + guarded + ')');
  for (const kind of [ 'base', 'water', 'wall', 'smoke', 'light' ])
    assert.ok(classSource.includes("stationSampleRead('" + kind + "'"),
      'expected a collected-column read for ' + kind);
}

console.log('Station sample async readback regression test passed (5 scenarios)');
