// Usage: node scripts/validate_shader.js [shader.frag ...]
// Inlines the shared .glsl headers like loadShader() in app.js, then compiles with glslang.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const common = fs.readFileSync(path.join(root, 'shaders/common.glsl'), 'utf8');
const commonDisplay = fs.readFileSync(path.join(root, 'shaders/commonDisplay.glsl'), 'utf8');
const dropletSize = fs.readFileSync(path.join(root, 'shaders/dropletSize.glsl'), 'utf8');
const lightningV2 = fs.readFileSync(path.join(root, 'shaders/fragment/lightningV2.glsl'), 'utf8');

const DEFAULT_SHADERS = [
  'boundaryShader.frag',
  'velocityShader.frag',
  'pressureShader.frag',
  'advectionShader.frag',
  'pressureDisplayShader.frag',
  'pressureRowMeanShader.frag',
  'capeShader.frag',
];

function expandIncludes(src)
{
  if (src.includes('#include "common.glsl"')) {
    const before = src.split('#include "common.glsl"')[0];
    if (!/\bdryLapse\b/.test(before))
      src = src.replace('#include "common.glsl"', 'const float dryLapse = 0.;\n#include "common.glsl"');
    src = src.replace('#include "common.glsl"', common);
  }
  if (src.includes('#include "commonDisplay.glsl"'))
    src = src.replace('#include "commonDisplay.glsl"', commonDisplay);
  if (src.includes('#include "dropletSize.glsl"'))
    src = src.replace('#include "dropletSize.glsl"', dropletSize);
  if (src.includes('#include "lightningV2.glsl"'))
    src = src.replace('#include "lightningV2.glsl"', lightningV2);
  return src;
}

// glslang only targets SPIR-V, which rejects WebGL's GLSL ES 3.00. Rewrite to ES 3.10 with explicit
// locations, bindings and one uniform block per loose uniform; type rules stay the same.
function toSpirvCompatibleEs(src)
{
  src = src.replace(/^#version 300 es/m, '#version 310 es');
  let inLoc = 0, outLoc = 0, binding = 0, block = 0;
  return src.split(/\r?\n/).map((line) => {
    let m;
    if ((m = /^\s*uniform\s+(highp\s+|mediump\s+|lowp\s+)?(\w+)\s+([^;]+);(.*)$/.exec(line))) {
      const prec = m[1] || '';
      if (/sampler/.test(m[2]))
        return `layout(binding = ${binding++}) uniform ${prec}${m[2]} ${m[3]};${m[4]}`;
      return `layout(std140, binding = ${binding++}) uniform UB${block++} { ${prec}${m[2]} ${m[3]}; };${m[4]}`;
    }
    if ((m = /^\s*(flat\s+)?in\s+(\w+)\s+([^;]+);(.*)$/.exec(line)))
      return `layout(location = ${inLoc++}) ${m[1] || ''}in ${m[2]} ${m[3]};${m[4]}`;
    if ((m = /^\s*out\s+(\w+)\s+([^;]+);(.*)$/.exec(line)))
      return `layout(location = ${outLoc++}) out ${m[1]} ${m[2]};${m[3]}`;
    return line;
  }).join('\n');
}

// Uniform storage budget, which glslang cannot see: GLSL ES spends one "uniform vector" (vec4)
// slot per float/int/bool/vec2..vec4, two for mat2, three for mat3, four for mat4, times the
// array length; samplers are opaque and cost none. WebGL2 only guarantees 224 vectors
// (MAX_FRAGMENT_UNIFORM_VECTORS) and 256 is the common ANGLE/D3D11 cap, so a shader over that
// fails to link even though it compiles — exactly how the advection shader's four vec4[126]
// profile arrays broke.
const UNIFORM_VECTORS_FAIL_ABOVE = 256;
const UNIFORM_VECTORS_WARN_ABOVE = 224;
const UNIFORM_BASE_VECTORS = {
  float : 1, int : 1, uint : 1, bool : 1,
  vec2 : 1, vec3 : 1, vec4 : 1,
  ivec2 : 1, ivec3 : 1, ivec4 : 1,
  uvec2 : 1, uvec3 : 1, uvec4 : 1,
  bvec2 : 1, bvec3 : 1, bvec4 : 1,
  mat2 : 2, mat3 : 3, mat4 : 4,
};

function uniformVectorCost(src)
{
  let vectors = 0, samplers = 0;
  const re = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([^;]+);/;
  for (const line of src.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m)
      continue;
    if (/^sampler/.test(m[1])) {
      samplers++;
      continue;
    }
    const base = UNIFORM_BASE_VECTORS[m[1]];
    if (!base)
      continue; // opaque or struct type: not budgeted here
    const am = /\[(\d+)\]/.exec(m[2]);
    vectors += base * (am ? parseInt(am[1], 10) : 1);
  }
  return { vectors, samplers };
}

function validateShader(name)
{
  const stage = name.endsWith('.vert') ? 'vertex' : 'fragment';
  const expanded = expandIncludes(fs.readFileSync(path.join(root, 'shaders', stage, name), 'utf8'));
  const src = toSpirvCompatibleEs(expanded);
  const cost = uniformVectorCost(expanded);
  const glslang = require('@webgpu/glslang')();
  glslang.compileGLSL(src, stage, false);
  return cost;
}

module.exports = {
  expandIncludes, toSpirvCompatibleEs, uniformVectorCost, validateShader,
  DEFAULT_SHADERS, UNIFORM_VECTORS_FAIL_ABOVE, UNIFORM_VECTORS_WARN_ABOVE,
};

if (require.main === module) {
  const shaders = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SHADERS;
  let failed = 0;
  for (const name of shaders) {
    try {
      const cost = validateShader(name);
      let line = 'VALID  ' + name + '  (' + cost.vectors + ' uniform vectors, ' + cost.samplers + ' samplers)';
      if (cost.vectors > UNIFORM_VECTORS_FAIL_ABOVE) {
        failed++;
        console.error(line + '\nERROR  ' + name + ': ' + cost.vectors + ' uniform vectors exceeds the WebGL2 fragment limit of ' + UNIFORM_VECTORS_FAIL_ABOVE
          + ' — move large uniform arrays into a texture (see soundingProfileTex / refProfileTex).');
        continue;
      }
      if (cost.vectors > UNIFORM_VECTORS_WARN_ABOVE)
        line += '  WARNING: above the WebGL2 guaranteed minimum of ' + UNIFORM_VECTORS_WARN_ABOVE + ' vectors; low-end drivers may refuse to link';
      console.log(line);
    } catch (e) {
      failed++;
      console.error('ERROR  ' + name + ': ' + e.message);
    }
  }
  process.exitCode = failed ? 1 : 0;
}
