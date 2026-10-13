// Regression test for the asynchronous overlay-scan readback in app.js.
//
// The scan used to call readPixels straight into client memory, draining the GPU
// pipeline at every scan start. It now enqueues the reads into pixel-pack buffers and
// starts walking columns only once the fence signals. This test drives that state
// machine against a fake GL and asserts:
//   * a scan request enqueues the reads and does NOT become active immediately
//   * ticking while the fence is unsignalled makes no progress
//   * once the fence signals the scan becomes active with the exact framebuffer bytes
//   * a fence that never signals falls back to the blocking path (no lost scan)
//   * shouldRestartOverlayScan() never re-requests while a readback is in flight

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
  'overlayScanReader',
  'beginOverlayScanReadback',
  'promoteOverlayScanFromReadback',
  'pollOverlayScanReadback',
  'ensureOverlayScanBuffers',
  'readOverlayScanTextures',
  'beginOverlayScan',
  'tickOverlayScan',
  'shouldRestartOverlayScan',
  'createAsyncPixelReader',
  'asyncPixelReaderBusy',
  'beginAsyncReadPixels',
  'cancelAsyncReadPixels',
  'pollAsyncReadPixels',
];

const GL = {
  TEXTURE_2D : 2001, FRAMEBUFFER : 3000, READ_FRAMEBUFFER : 3002,
  COLOR_ATTACHMENT0 : 4000, COLOR_ATTACHMENT1 : 4001, COLOR_ATTACHMENT2 : 4002,
  COLOR_ATTACHMENT3 : 4003, PIXEL_PACK_BUFFER : 7000, STREAM_READ : 7001,
  RGBA : 8000, RGBA_INTEGER : 8001, FLOAT : 8002, BYTE : 8003, SYNC_GPU_COMMANDS_COMPLETE : 9000,
  SYNC_STATUS : 9001, SIGNALED : 9002, UNSIGNALED : 9003,
};

// Fake GL: framebuffer attachments hold deterministic bytes; readPixels with a
// pixel-pack buffer bound snapshots the attachment into the buffer (as the real
// command stream does), readPixels without one fills a client array directly.
function makeFakeGl(simResX, simResY)
{
  const attachments = new Map(); // fbo -> Map(attachment -> Uint8Array)
  let nextFbo = 1;
  let nextBuffer = 1;
  let nextSync = 1;
  const state = {
    readsIntoPbo : 0,
    readsIntoClient : 0,
    deletedSyncs : 0,
    signaled : true,
    boundPbo : null,
    boundFramebuffer : null,
    readBuffer : null,
    pbos : new Map(),
    syncs : new Map(),
  };

  function attachmentBytes(fbo, attachment)
  {
    let byAttachment = attachments.get(fbo);
    if (!byAttachment) {
      byAttachment = new Map();
      attachments.set(fbo, byAttachment);
    }
    let bytes = byAttachment.get(attachment);
    if (!bytes) {
      bytes = new Uint8Array(simResX * simResY * 16);
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = (fbo * 37 + attachment * 61 + i * 7) & 0xff;
      byAttachment.set(attachment, bytes);
    }
    return bytes;
  }

  const gl = Object.assign({}, GL, {
    createFramebuffer: () => nextFbo++,
    bindFramebuffer: (target, fbo) => { state.boundFramebuffer = fbo; },
    readBuffer: (attachment) => { state.readBuffer = attachment; },
    createBuffer: () => nextBuffer++,
    bindBuffer: (target, buffer) => { state.boundPbo = target === GL.PIXEL_PACK_BUFFER ? buffer : null; },
    bufferData: (target, byteSize) => {
      state.pbos.set(state.boundPbo, new Uint8Array(byteSize));
    },
    readPixels: (x, y, w, h, format, type, dst) => {
      const src = attachmentBytes(state.boundFramebuffer, state.readBuffer);
      const rowBytes = simResX * 16;
      if (state.boundPbo) {
        const pbo = state.pbos.get(state.boundPbo);
        assert.ok(pbo, 'readPixels targeted a pixel-pack buffer that was never allocated');
        const copyBytes = Math.min(pbo.length, w * h * (type === GL.BYTE ? 4 : 16));
        for (let row = 0; row < h && row < simResY; row++) {
          const srcOffset = ((y + row) * rowBytes) + x * 16;
          pbo.set(src.subarray(srcOffset, srcOffset + Math.min(copyBytes / h, rowBytes)), row * (copyBytes / h));
        }
        state.readsIntoPbo++;
      } else {
        assert.ok(dst && dst.byteLength, 'readPixels without a pixel-pack buffer needs a destination');
        state.readsIntoClient++;
      }
    },
    fenceSync: () => {
      const sync = nextSync++;
      state.syncs.set(sync, state.signaled);
      return sync;
    },
    deleteSync: (sync) => { state.deletedSyncs++; state.syncs.delete(sync); },
    getSyncParameter: (sync, pname) => (state.syncs.get(sync) ? GL.SIGNALED : GL.UNSIGNALED),
    getBufferSubData: (target, offset, dst) => {
      const pbo = state.pbos.get(state.boundPbo);
      assert.ok(pbo, 'getBufferSubData on an unallocated buffer');
      new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength).set(pbo.subarray(0, dst.byteLength));
    },
  });
  return { gl, state, attachmentBytes };
}

function buildSandbox(simResX, simResY)
{
  const { gl, state, attachmentBytes } = makeFakeGl(simResX, simResY);
  const sandbox = {
    gl,
    fakeState : state,
    attachmentBytes,
    console,
    sim_res_x : simResX,
    sim_res_y : simResY,
    iterNum : 0,
    guiControls : {
      riskUpdateFrequency : 60, stormTrackOverlay : false, outflowOverlay : false,
      labelsOverlay : false, tornadoDetectionOverlay : false, warningsOverlay : false,
      easAlertsEnabled : false, simHeight : 12000,
    },
    riskData : [],
    soundingOverlayData : [],
    coldPoolDomainMeanSfcTempC : 0,
    stormTrackLastScanIter : -9999,
    outflowLastScanIter : -9999,
    labelsLastScanIter : -9999,
    tornadoLastScanIter : -9999,
    getSoundingOverlayBarWidth : () => 4,
    prepareOverlayColumnArrays : (simResY) => ({
      envTempsC : new Float32Array(simResY), envDewC : new Float32Array(simResY),
      isFluid : new Array(simResY).fill(false), vxRaw : new Float32Array(simResY),
      vyRaw : new Float32Array(simResY), waterArr : new Float32Array(simResY),
      chargeCol : new Float32Array(simResY), fluidPressure : new Float32Array(simResY),
    }),
    computeOverlayColumnBundle : () => null,
    convectiveRiskRgba : () => 'rgba(1,1,1,1)',
    updateColdPoolDomainMeanFromPending : () => {},
    refineInitiationWithConvergence : () => {},
    updateStormTracksFromPending : () => {},
    updateOutflowFrontsFromPending : () => {},
    updateWeatherLabelsFromPending : () => {},
    updateTornadoDetectionFromScan : () => {},
    runSilentTornadoScan : () => {},
    updateEasFromPending : () => {},
    frameBuff_1 : 11,
    chargeFrameBuff_0 : 21,
    chargeFrameBuff_1 : 22,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const code = []
    .concat('const OVERLAY_SCAN_COLS_PER_FRAME = 12;')
    .concat('const OVERLAY_SCAN_BUDGET_MS_DEFAULT = 2.0;')
    .concat('const TARGET_FRAME_MS = 28;')
    // Frame time is unknown in this harness, which makes the scan never yield to the frame.
    .concat('var lastFrameTimeMsForScheduling = undefined;')
    .concat('var performance = { now : () => Date.now() };')
    .concat('function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }')
    .concat(extractBlock(appSource, 'var overlayScan = {'))
    .concat(extractBlock(appSource, 'var overlayScanReaders = [];'))
    .concat(appSource.match(/const OVERLAY_SCAN_READBACK_MAX_FRAMES = \d+;/)[0])
    .concat(FUNCTIONS.concat([ 'overlayScanYieldsFrame', 'overlayScanBudgetMs' ])
      .map((name) => extractFunction(appSource, name)))
    .join('\n');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

function advanceFrames(sandbox, frames)
{
  for (let i = 0; i < frames; i++) {
    sandbox.iterNum++;
    vm.runInContext('tickOverlayScan();', sandbox);
  }
}

// 1. A request enqueues reads without blocking and is not active yet.
{
  const sandbox = buildSandbox(16, 8);
  sandbox.fakeState.signaled = false; // fence stays unsignalled for this scenario
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  assert.strictEqual(sandbox.fakeState.readsIntoClient, 0, 'the scan must not read into client memory up front');
  assert.strictEqual(sandbox.fakeState.readsIntoPbo, 3, 'expected one enqueued read per attachment');
  const scan = sandbox.overlayScan;
  assert.ok(scan.inFlight, 'a readback should be in flight');
  assert.strictEqual(scan.active, false, 'the scan must not be active before the data lands');
  vm.runInContext('tickOverlayScan();', sandbox);
  assert.strictEqual(scan.active, false, 'ticking an unsignalled readback makes no progress');
  assert.strictEqual(scan.nextIndex, 0, 'no columns may be processed before the data lands');
}

// 2. Once the fence signals, the scan activates with the framebuffer bytes.
{
  const sandbox = buildSandbox(64, 8);
  const scan = sandbox.overlayScan;
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  assert.ok(scan.inFlight.frames === 0, 'frame counter should start at zero');
  advanceFrames(sandbox, 1);
  assert.ok(scan.active, 'the scan should activate once the fence signals');
  assert.strictEqual(scan.nextIndex, 12, 'the first tick after landing should walk a column budget');
  assert.strictEqual(scan.kind, 'risk');
  assert.strictEqual(scan.step, 4);
  assert.strictEqual(scan.barW, 4);
  assert.strictEqual(scan.pending._barWidth, 4);

  const baseBytes = sandbox.attachmentBytes(11, GL.COLOR_ATTACHMENT0);
  const wallBytes = sandbox.attachmentBytes(11, GL.COLOR_ATTACHMENT2);
  for (let i = 0; i < 64 * 8 * 4; i++) {
    assert.strictEqual(scan.baseAll[i], new DataView(baseBytes.buffer).getFloat32(i * 4, true),
      'base attachment bytes must land in overlayScan.baseAll');
    assert.strictEqual(scan.wallAll[i], (wallBytes[i] << 24) >> 24,
      'wall attachment bytes must land in overlayScan.wallAll');
  }
  assert.strictEqual(scan.inFlight, null, 'the readback should be cleared once collected');
}

// 3. Charge reads are included when the scan asks for them.
{
  const sandbox = buildSandbox(64, 8);
  vm.runInContext("beginOverlayScan('sounding', true, false, frameBuff_1, chargeFrameBuff_0);", sandbox);
  assert.strictEqual(sandbox.fakeState.readsIntoPbo, 4, 'charge scans enqueue a fourth read');
  advanceFrames(sandbox, 1);
  assert.ok(sandbox.overlayScan.active, 'charge scan should activate');
  assert.strictEqual(sandbox.overlayScan.needCharge, true);
}

// 4. A fence that never signals falls back to the blocking read instead of dropping the scan.
{
  const sandbox = buildSandbox(64, 8);
  sandbox.fakeState.signaled = false;
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  const maxFrames = Number(appSource.match(/const OVERLAY_SCAN_READBACK_MAX_FRAMES = (\d+);/)[1]);
  advanceFrames(sandbox, maxFrames - 1);
  assert.strictEqual(sandbox.overlayScan.active, false, 'must keep waiting until the frame budget is spent');
  vm.runInContext('tickOverlayScan();', sandbox);
  assert.ok(sandbox.overlayScan.active, 'the fallback must still produce a scan');
  assert.strictEqual(sandbox.fakeState.readsIntoClient, 3, 'the fallback reads straight into client memory');
  assert.strictEqual(sandbox.fakeState.deletedSyncs, 3, 'pending fences must be released');
}

// 5. shouldRestartOverlayScan() must not re-request while a readback is in flight.
{
  const sandbox = buildSandbox(16, 8);
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  for (let i = 0; i < 5; i++) {
    const restart = vm.runInContext("shouldRestartOverlayScan('risk', 4);", sandbox);
    assert.strictEqual(restart, false, 'an in-flight readback must block restart requests');
  }
  assert.strictEqual(sandbox.fakeState.readsIntoPbo, 3, 'no extra reads may be enqueued');
}

// 6. After the scan has data, a matching restart request reports "running".
{
  const sandbox = buildSandbox(64, 8);
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  advanceFrames(sandbox, 1);
  const restart = vm.runInContext("shouldRestartOverlayScan('risk', 4);", sandbox);
  assert.strictEqual(restart, false, 'an active scan with the same bar width must not restart');
  const otherWidth = vm.runInContext("shouldRestartOverlayScan('risk', 9);", sandbox);
  assert.strictEqual(otherWidth, true, 'a bar width change must restart the scan');
  assert.strictEqual(sandbox.overlayScan.active, false, 'restarting clears the active scan');
}

// 7. Frame pacing: a column that costs more than the per-frame budget is spread over
//    several frames, and the columns visited (and their order) are unchanged.
{
  const sandbox = buildSandbox(64, 8);
  const seen = [];
  sandbox.computeOverlayColumnBundle = (baseAll, waterAll, wallAll, chargeAll, sx) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 3) { /* pretend a column costs ~3 ms */ }
    seen.push(sx);
    return null;
  };
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  advanceFrames(sandbox, 1);   // collect the readback, then walk within the budget
  assert.ok(seen.length >= 1, 'the tick that lands the readback must process at least one column');
  const firstTickColumns = seen.length;
  assert.ok(sandbox.overlayScan.active, 'the scan must still be running');
  let ticks = 0;
  while (sandbox.overlayScan.active && ticks < 400) { advanceFrames(sandbox, 1); ticks++; }
  assert.ok(!sandbox.overlayScan.active, 'the scan must finish');
  const step = sandbox.overlayScan.step;
  const expected = [];
  for (let i = 0; i * step < 64; i++) expected.push(i * step);
  assert.deepStrictEqual(seen, expected, 'paced scans must visit exactly the same columns in the same order');
  const remaining = expected.length - firstTickColumns;
  assert.ok(ticks >= remaining - 1 && ticks <= 2 * remaining + 4,
    'a ~3 ms column under a 2 ms budget must take about two ticks per column (took ' + ticks + ' for ' + remaining + ')');
  assert.ok(sandbox.overlayScan.pacedOut > 0, 'the scan must report the frames it gave up');
  assert.ok(sandbox.overlayScan.lastColumnMs >= 2,
    'the measured column cost should feed the pacing (' + sandbox.overlayScan.lastColumnMs + ' ms)');
}

// 8. A column budget larger than the column cost keeps the original every-frame cadence.
{
  const sandbox = buildSandbox(64, 8);
  sandbox.guiControls.overlayScanBudgetMs = 50;
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  advanceFrames(sandbox, 1);
  assert.strictEqual(sandbox.overlayScan.nextIndex, 12, 'cheap columns must not be paced');
  assert.strictEqual(sandbox.overlayScan.pacedOut, 0, 'nothing may be given up when there is headroom');
}

// 9. Heavy frames: the scan steps aside, but never long enough to leave the overlay stale.
{
  const sandbox = buildSandbox(64, 8);
  sandbox.computeOverlayColumnBundle = () => null;
  vm.runInContext("beginOverlayScan('risk', false, false, frameBuff_1, chargeFrameBuff_1);", sandbox);
  advanceFrames(sandbox, 1);
  const landedAt = sandbox.overlayScan.nextIndex;
  vm.runInContext('lastFrameTimeMsForScheduling = 60;', sandbox);   // well over target
  advanceFrames(sandbox, 89);
  assert.strictEqual(sandbox.overlayScan.nextIndex, landedAt, 'over-target frames must not spend time on the scan');
  advanceFrames(sandbox, 2);
  assert.ok(sandbox.overlayScan.nextIndex > landedAt,
    'the starvation guard must let a column through after 90 frames');
  vm.runInContext('lastFrameTimeMsForScheduling = 16;', sandbox);
  advanceFrames(sandbox, 1);
  assert.ok(sandbox.overlayScan.nextIndex > landedAt, 'comfortable frames resume the normal cadence');
}

console.log('Overlay scan async readback regression test passed (9 scenarios)');
