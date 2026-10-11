const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { expandIncludes, uniformVectorCost, UNIFORM_VECTORS_FAIL_ABOVE } = require('../scripts/validate_shader.js');

// glslang cannot see MAX_FRAGMENT_UNIFORM_VECTORS, so shaders that compile can still fail to
// link. The advection shader hit exactly that: four vec4[126] sounding arrays = 504 uniform
// vectors, over the 256 (and even the guaranteed 224) WebGL2 limit. Big per-column data must
// live in a texture now.

const root = path.join(__dirname, '..');
let checked = 0;
for (const stage of ['fragment', 'vertex']) {
  const dir = path.join(root, 'shaders', stage);
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(frag|vert)$/.test(name))
      continue;
    const cost = uniformVectorCost(expandIncludes(fs.readFileSync(path.join(dir, name), 'utf8')));
    assert.ok(cost.vectors <= UNIFORM_VECTORS_FAIL_ABOVE,
      name + ' uses ' + cost.vectors + ' uniform vectors, above the ' + UNIFORM_VECTORS_FAIL_ABOVE +
      ' WebGL2 limit — move large uniform arrays into a texture (soundingProfileTex / refProfileTex)');
    checked++;
  }
}
assert.ok(checked >= 45, 'expected to check every shader, only saw ' + checked);

const advectionShader = fs.readFileSync(path.join(root, 'shaders', 'fragment', 'advectionShader.frag'), 'utf8');
assert.ok(!/uniform\s+vec4\s+initial_Tv/.test(advectionShader),
  'advection shader must not declare initial_Tv[126] again — it overflows the uniform limit');
assert.ok(!/uniform\s+vec4\s+realWorldSounding/.test(advectionShader),
  'advection shader must not declare the sounding profiles as uniform arrays again');
assert.ok(advectionShader.includes('soundingProfileTex'),
  'advection shader should sample the sounding profile texture');

const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
assert.ok(appSource.includes('function uploadSoundingProfileTexture'),
  'app.js should build/upload the sounding profile texture');
assert.ok(appSource.includes("'soundingProfileTex'"),
  'app.js should point the advection program at the sounding profile sampler');
assert.ok(appSource.includes('bindAdvectionTextures'),
  'app.js should bind the advection samplers on every advection pass');
assert.ok(appSource.includes('initialTProfileCpu = initial_T'),
  'app.js should publish the initial_T column used by the profile texture');

console.log('Shader uniform budget regression test passed (' + checked + ' shaders checked)');
