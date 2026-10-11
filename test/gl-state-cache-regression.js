// Property test for installGlStateCache() in app.js: the wrappers may only SKIP calls that
// would re-set state that is already current. A random sequence of state calls is replayed
// twice — once through the cache wrappers, once against a plain reference model of what the
// app asked for — and the two models must agree at every step.

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

const consts = {
  TEXTURE0 : 1000, TEXTURE_CUBE_MAP : 2000, TEXTURE_2D : 2001,
  FRAMEBUFFER : 3000, DRAW_FRAMEBUFFER : 3001, READ_FRAMEBUFFER : 3002,
  COLOR_ATTACHMENT0 : 4000, COLOR_ATTACHMENT1 : 4001, NONE : 4002,
  BLEND : 5000, DEPTH_TEST : 5001, CULL_FACE : 5002,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS : 6000,
};

// Mock context: records every call that actually reaches "the GPU" and maintains the state
// that those calls produced.
function makeMockContext()
{
  const state = {
    program : null,
    activeUnit : consts.TEXTURE0,
    textures : new Map(),
    fbDraw : null,
    fbRead : null,
    readBufferByFbo : new Map(),
    drawBuffers : new Map(),
    vao : null,
    buffers : new Map(),
    viewport : null,
    caps : new Map(),
    blendFunc : null,
    blendEquation : null,
    uniforms : new Map(),
    deleted : [],
    applied : 0,
  };
  const key = (unit, target) => unit + ':' + target;
  const ctx = Object.assign({}, consts, {
    state,
    getParameter : (p) => (p === consts.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 32 : null),
    useProgram : (p) => { state.program = p; state.applied++; },
    activeTexture : (u) => { state.activeUnit = u; state.applied++; },
    bindTexture : (t, tex) => { state.textures.set(key(state.activeUnit, t), tex); state.applied++; },
    bindFramebuffer : (t, fb) => {
      if (t === consts.FRAMEBUFFER) { state.fbDraw = fb; state.fbRead = fb; }
      else if (t === consts.DRAW_FRAMEBUFFER) { state.fbDraw = fb; }
      else { state.fbRead = fb; }
      state.applied++;
    },
    drawBuffers : (arr) => { state.drawBuffers.set(state.fbDraw, arr.slice()); state.applied++; },
    readBuffer : (m) => { state.readBufferByFbo.set(state.fbRead, m); state.applied++; },
    bindRenderbuffer : () => { state.applied++; },
    bindVertexArray : (v) => { state.vao = v; state.applied++; },
    bindBuffer : (t, b) => { state.buffers.set(t, b); state.applied++; },
    bindTransformFeedback : () => { state.applied++; },
    viewport : (x, y, w, h) => { state.viewport = [x, y, w, h]; state.applied++; },
    enable : (c) => { state.caps.set(c, true); state.applied++; },
    disable : (c) => { state.caps.set(c, false); state.applied++; },
    blendFunc : (s, d) => { state.blendFunc = [s, d]; state.applied++; },
    blendEquation : (m) => { state.blendEquation = m; state.applied++; },
    deleteProgram : (p) => { state.deleted.push(['program', p]); state.applied++; },
    deleteTexture : (t) => {
      state.deleted.push(['texture', t]);
      for (const k of Array.from(state.textures.keys())) {
        if (state.textures.get(k) === t) state.textures.delete(k);
      }
      state.applied++;
    },
    deleteBuffer : (b) => { state.deleted.push(['buffer', b]); state.applied++; },
    deleteVertexArray : (v) => { state.deleted.push(['vao', v]); state.applied++; },
    deleteFramebuffer : (f) => { state.deleted.push(['fbo', f]); state.applied++; },
    linkProgram : () => { state.applied++; },
  });
  // Uniform setters: mirror real GL (values are per program via the location identity).
  for (const name of [ 'uniform1f', 'uniform1i', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv' ])
    ctx[name] = function(loc) { state.uniforms.set(loc, Array.prototype.slice.call(arguments, 1)); state.applied++; };
  return ctx;
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFunction(appSource, 'installGlStateCache'), sandbox);
vm.runInContext(`glStateStats = { calls: 0, skipped: 0, lastFrameCalls: 0, lastFrameSkipped: 0, skipping: true };`, sandbox);

function run(seedCount)
{
  for (let round = 0; round < seedCount; round++) {
    const mock = makeMockContext();
    const reference = makeMockContext(); // same mock, driven by the *requested* calls only
    sandbox.installGlStateCache(mock);
    sandbox.glStateStats.skipping = true;

    const programs = [ 'p1', 'p2', 'p3', null ];
    const textures = [ 't1', 't2', null ];
    const fbos = [ 'f1', 'f2', null ];
    const units = [ consts.TEXTURE0, consts.TEXTURE0 + 1, consts.TEXTURE0 + 2, consts.TEXTURE0 + 4 ];
    const locs = { l1 : { id : 1 }, l2 : { id : 2 }, l3 : { id : 3 } };
    const arrays = { a1 : new Float32Array([ 1, 2, 3, 4 ]), a2 : new Float32Array([ 0, 0, 0, 0 ]) };
    let rng = 12345 + round * 977;
    const rand = (n) => Math.floor((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 65536) % n;
    const pick = (arr) => arr[rand(arr.length)];

    const ops = [
      (c) => c.useProgram(pick(programs)),
      (c) => c.activeTexture(pick(units)),
      (c) => c.bindTexture(consts.TEXTURE_2D, pick(textures)),
      (c) => c.bindTexture(consts.TEXTURE_CUBE_MAP, pick(textures)),
      (c) => c.bindFramebuffer(consts.FRAMEBUFFER, pick(fbos)),
      (c) => c.bindFramebuffer(consts.DRAW_FRAMEBUFFER, pick(fbos)),
      (c) => c.bindFramebuffer(consts.READ_FRAMEBUFFER, pick(fbos)),
      (c) => c.drawBuffers([ consts.COLOR_ATTACHMENT0, consts.COLOR_ATTACHMENT0, consts.COLOR_ATTACHMENT0, consts.COLOR_ATTACHMENT0 ]),
      (c) => c.drawBuffers([ consts.COLOR_ATTACHMENT0, consts.NONE, consts.COLOR_ATTACHMENT1 ]),
      (c) => c.readBuffer(pick([ consts.COLOR_ATTACHMENT0, consts.COLOR_ATTACHMENT1 ])),
      (c) => c.bindVertexArray(pick([ 'v1', 'v2', null ])),
      (c) => c.bindBuffer(consts.FRAMEBUFFER, pick([ 'b1', 'b2', null ])),
      (c) => c.viewport(rand(4), 0, 100 + rand(3), 200),
      (c) => c.enable(pick([ consts.BLEND, consts.DEPTH_TEST ])),
      (c) => c.disable(pick([ consts.BLEND, consts.DEPTH_TEST ])),
      (c) => c.blendFunc(consts.COLOR_ATTACHMENT0, pick([ consts.NONE, consts.COLOR_ATTACHMENT1 ])),
      (c) => c.blendEquation(pick([ consts.BLEND, consts.DEPTH_TEST ])),
      (c) => c.uniform1f(pick([ locs.l1, locs.l2 ]), rand(5)),
      (c) => c.uniform1i(locs.l3, rand(5)),
      (c) => c.uniform4fv(locs.l1, pick([ arrays.a1, arrays.a2 ])),
      // Mutate a reused array in place, then upload: must never be skipped.
      (c) => { arrays.a1[0] = rand(10); c.uniform4fv(locs.l2, arrays.a1); },
      (c) => c.deleteTexture(pick(textures)),
      (c) => c.deleteFramebuffer(pick(fbos)),
      (c) => c.deleteVertexArray(pick([ 'v1', 'v2' ])),
      (c) => c.deleteBuffer(pick([ 'b1', 'b2' ])),
      (c) => c.deleteProgram(pick([ 'p1', 'p2' ])),
      (c) => c.linkProgram(pick([ 'p1', 'p2' ])),
    ];

    for (let step = 0; step < 400; step++)
      ops[rand(ops.length)](mock);

    // Replay the exact same sequence against a plain (uncached) context.
    rng = 12345 + round * 977;
    const rand2 = (n) => Math.floor((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 65536) % n;
    const pick2 = (arr) => arr[rand2(arr.length)];
    for (let step = 0; step < 400; step++) {
      const op = ops[rand2(ops.length)];
      op(reference);
    }

    // Compare the state that actually reached the mock against the requested state.
    const a = mock.state;
    const b = reference.state;
    const describe = {
      program : [ a.program, b.program ],
      activeUnit : [ a.activeUnit, b.activeUnit ],
      fbDraw : [ a.fbDraw, b.fbDraw ],
      fbRead : [ a.fbRead, b.fbRead ],
      vao : [ a.vao, b.vao ],
      viewport : [ JSON.stringify(a.viewport), JSON.stringify(b.viewport) ],
    };
    for (const k of Object.keys(describe)) {
      assert.deepStrictEqual(describe[k][0], describe[k][1], 'state "' + k + '" diverged');
    }
    assert.deepStrictEqual(Array.from(a.textures.entries()), Array.from(b.textures.entries()), 'texture bindings diverged');
    assert.deepStrictEqual(Array.from(a.buffers.entries()), Array.from(b.buffers.entries()), 'buffer bindings diverged');
    assert.deepStrictEqual(Array.from(a.caps.entries()), Array.from(b.caps.entries()), 'enable/disable state diverged');
    assert.deepStrictEqual(a.blendFunc, b.blendFunc, 'blendFunc diverged');
    assert.deepStrictEqual(a.blendEquation, b.blendEquation, 'blendEquation diverged');
    assert.deepStrictEqual(
      Array.from(a.readBufferByFbo.entries()),
      Array.from(b.readBufferByFbo.entries()),
      'readBuffer diverged');
    assert.deepStrictEqual(
      Array.from(a.drawBuffers.entries()).map(([ fbo, arr ]) => [ fbo, arr.join(',') ]),
      Array.from(b.drawBuffers.entries()).map(([ fbo, arr ]) => [ fbo, arr.join(',') ]),
      'drawBuffers diverged');
    assert.deepStrictEqual(
      Array.from(a.uniforms.entries()).map(([ loc, v ]) => [ loc.id, v.join(',') ]),
      Array.from(b.uniforms.entries()).map(([ loc, v ]) => [ loc.id, v.join(',') ]),
      'uniform values diverged');
    assert.ok(sandbox.glStateStats.skipped > 40, 'expected the cache to skip redundant calls (saw ' + sandbox.glStateStats.skipped + ')');
    sandbox.glStateStats.skipped = 0;
    sandbox.glStateStats.calls = 0;
  }
}

run(12);
console.log('GL state cache regression test passed (12 randomized rounds, state never diverged)');
