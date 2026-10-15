#version 300 es
// Builds the Enhanced SDF lightning bolt polylines ONCE per frame into a tiny texture.
//
// The realistic display shader used to rebuild the whole bolt (random-walk trunk, side
// branches, cloud arms, two 80-step ground walk-downs) inside *every pixel* near the
// strike — hundreds of trig calls and ~160 texture fetches per pixel at full screen
// resolution. That per-pixel rebuild was the main cause of the frame-time spike whenever
// lightning flashed. The geometry only depends on the strike (position, start iteration),
// the quality setting and the terrain/cloud fields, so it is identical for every pixel:
// build it here in a 64x48 pass and let the display shader only measure distances.
//
// Layout (RGBA32F, 64 x 48, read with texelFetch):
//   row = variant base + polyline index, variant 0 = full detail, 1 = reduced (LOD)
//   CG     rows  0..11 (full) / 12..23 (reduced):
//            +0 trunk, +1..+4 side branches, +5..+6 cloud arms, +7..+10 arm subs (arm*2+sub)
//   Spider rows 24..35 (full) / 36..47 (reduced):
//            +0..+2 main bolts, +3..+11 sub branches (bolt*3+sub)
//   column 0..N : polyline vertices (x scaled by sim aspect, y in sim UV)
//   column 62   : header (segment count, enabled 0/1, 0, 0)
//   column 63   : bounding box (minX, minY, maxX, maxY) of the vertices
//
// The math below is a 1:1 transcription of the builder parts of displayCGLightning /
// displaySpiderLightning that used to live in realisticDisplayShader.frag, so bolts look
// exactly as before.
precision highp float;
precision highp sampler2D;
precision highp isampler2D;

in vec2 texCoord; // required by common.glsl helpers (unused here)

uniform sampler2D waterTex;
uniform isampler2D wallTex;
uniform sampler2D lightningDataTex;
uniform vec2 texelSize;    // simulation texel size
uniform vec2 resolution;   // simulation resolution (used by common.glsl helpers)
uniform vec2 aspectRatios; // [0] = simulation aspect
uniform float ltSdfQuality; // 0 Fast / 1 Balanced / 2 Full

layout(location = 0) out vec4 pathOut;

#include "common.glsl"

#define LT_PATH_HDR_COL 62
#define LT_PATH_BOX_COL 63

int gCol;
int gRowLocal;
bool gReduced;

// Writes the requested texel of one polyline (vertex, header or bounding box).
vec4 emitPolyline(vec2 verts[49], int segs, bool enabled)
{
  if (gCol == LT_PATH_HDR_COL)
    return vec4(float(segs), enabled ? 1.0 : 0.0, 0.0, 0.0);
  if (!enabled)
    return vec4(0.0);
  if (gCol == LT_PATH_BOX_COL) {
    vec2 mn = verts[0];
    vec2 mx = verts[0];
    for (int i = 1; i <= 48; i++) {
      if (i > segs) break;
      mn = min(mn, verts[i]);
      mx = max(mx, verts[i]);
    }
    return vec4(mn, mx);
  }
  if (gCol <= segs)
    return vec4(verts[gCol], 0.0, 0.0);
  return vec4(0.0);
}

vec4 buildCG(vec2 lightningPos, float boltSeed)
{
  const int MAIN_MAX = 48;
  const int SIDE_MAX = 24;
  const int ARM_MAX  = 40;
  const int ASUB_MAX = 16;

  bool reduced  = gReduced;
  bool drawArms = ltSdfQuality > 1.5;
  int mainSegs = reduced ? 24 : 48;
  int sideSegs = reduced ? 12 : 24;
  int armSegs  = reduced ? 20 : 40;
  int asubSegs = reduced ? 8 : 16;
  int nSides   = reduced ? 3 : 4;
  int nArms    = drawArms ? (reduced ? 1 : 2) : 0;
  int nAsubs   = drawArms ? (reduced ? 1 : 2) : 0;

  vec2 origin = vec2(lightningPos.x * aspectRatios[0], lightningPos.y);

  float tipY = 0.0;
  {
    float xUV = clamp(lightningPos.x, 0.001, 0.999);
    float yWalk = lightningPos.y;
    float step = max(texelSize.y * 2.0, lightningPos.y / 64.0);
    tipY = 0.0;
    bool hit = false;
    for (int k = 0; k < 80; k++) {
      yWalk -= step;
      if (yWalk <= 0.0) { tipY = 0.0; hit = true; break; }
      ivec4 w = texture(wallTex, vec2(xUV, clamp(yWalk, 0.001, 0.999)));
      if (w[DISTANCE] == 0) {
        tipY = max(yWalk + texelSize.y, 0.0);
        hit = true;
        break;
      }
    }
    if (!hit) {
      ivec4 wallAtOrigin = texture(wallTex, clamp(lightningPos, vec2(0.001), vec2(0.999)));
      int vd = wallAtOrigin[VERT_DISTANCE];
      if (wallAtOrigin[DISTANCE] == 0)
        tipY = max(lightningPos.y, 0.0);
      else if (vd > 0)
        tipY = max(lightningPos.y - float(vd) * texelSize.y + texelSize.y, 0.0);
    }
  }
  float reach = max(origin.y - tipY, 0.02);
  float stepLen = (reach / float(mainSegs)) / 0.72;

  vec2 cgVerts[49];
  for (int i = 0; i < 49; i++)
    cgVerts[i] = origin;
  float cgAng = -PI * 0.5;

  for (int i = 0; i < MAIN_MAX; i++) {
    if (i >= mainSegs) break;
    float r1 = random2d(vec2(boltSeed * 0.00371 + float(i) * 0.0937, boltSeed * 0.00591 + float(i) * 0.0517));
    cgAng += (r1 - 0.5) * 1.45;
    cgAng -= (cgAng + PI * 0.5) * 0.38;
    cgAng = mix(cgAng, -PI * 0.5, 0.22);
    cgVerts[i + 1] = cgVerts[i] + vec2(cos(cgAng), sin(cgAng)) * stepLen;
  }

  {
    cgVerts[mainSegs].x = mix(cgVerts[mainSegs].x, origin.x, 0.40);
    float tipXUV = clamp(cgVerts[mainSegs].x / max(aspectRatios[0], 1e-4), 0.001, 0.999);
    float yWalk = max(cgVerts[mainSegs].y, lightningPos.y);
    float step = max(texelSize.y * 2.0, yWalk / 64.0);
    float tipAtCol = tipY;
    bool hit = false;
    for (int k = 0; k < 80; k++) {
      yWalk -= step;
      if (yWalk <= 0.0) { tipAtCol = 0.0; hit = true; break; }
      ivec4 w = texture(wallTex, vec2(tipXUV, clamp(yWalk, 0.001, 0.999)));
      if (w[DISTANCE] == 0) {
        tipAtCol = max(yWalk + texelSize.y, 0.0);
        hit = true;
        break;
      }
    }
    if (hit)
      tipY = tipAtCol;

    float tipBuilt = cgVerts[mainSegs].y;
    float spanOrig = max(origin.y - tipBuilt, 1e-4);
    float spanNeed = max(origin.y - tipY, 1e-4);
    float yScale = spanNeed / spanOrig;
    for (int i = 1; i <= MAIN_MAX; i++) {
      if (i > mainSegs) break;
      cgVerts[i].y = origin.y - (origin.y - cgVerts[i].y) * yScale;
    }
    cgVerts[mainSegs].y = tipY;
  }

  if (gRowLocal == 0)
    return emitPolyline(cgVerts, mainSegs, true);

  vec2 verts[49];
  for (int i = 0; i < 49; i++)
    verts[i] = origin;

  if (gRowLocal >= 1 && gRowLocal <= 4) {
    int sb = gRowLocal - 1;
    if (sb >= nSides)
      return emitPolyline(verts, sideSegs, false);
    float sbs     = boltSeed + float(sb) * 137.51 + 500.0;
    int   fromIdx = min(int(random2d(vec2(sbs * 0.00113, sbs * 0.00173)) * float(mainSegs - 4)) + 2, mainSegs - 2);

    float branchLen = random2d(vec2(sbs * 0.00217, sbs * 0.00319)) * 0.20 + 0.05;
    float sbStep    = reach * branchLen / float(sideSegs);
    float sbAng     = -PI * 0.5 + (random2d(vec2(sbs * 0.00411, sbs * 0.00591)) - 0.5) * PI * 1.6;
    verts[0]        = cgVerts[fromIdx];

    for (int i = 0; i < SIDE_MAX; i++) {
      if (i >= sideSegs) break;
      float r1 = random2d(vec2(sbs * 0.00511 + float(i) * 0.0937, sbs * 0.00391 + float(i) * 0.0711));
      sbAng += (r1 - 0.5) * 1.6;
      sbAng -= (sbAng + PI * 0.5) * 0.30;
      verts[i + 1] = verts[i] + vec2(cos(sbAng), sin(sbAng)) * sbStep;
      if (verts[i + 1].y < tipY)
        verts[i + 1].y = tipY;
    }
    return emitPolyline(verts, sideSegs, true);
  }

  // Cloud arms (+5..+6) and their sub branches (+7..+10).
  int ca = gRowLocal <= 6 ? gRowLocal - 5 : (gRowLocal - 7) / 2;
  int as = gRowLocal <= 6 ? -1 : (gRowLocal - 7) - ca * 2;
  if (gRowLocal > 10 || ca >= nArms || (as >= 0 && as >= nAsubs))
    return emitPolyline(verts, gRowLocal <= 6 ? armSegs : asubSegs, false);

  float cas   = boltSeed + float(ca) * 137.51 + 1000.0;
  int   caIdx = min(int(random2d(vec2(cas * 0.00113, cas * 0.00173)) * 6.0), min(5, mainSegs - 1));

  float goRight = random2d(vec2(cas * 0.00317, cas * 0.00419)) > 0.5 ? 1.0 : -1.0;
  float ccAng   = goRight > 0.0 ? 0.0 : PI;
  ccAng += (random2d(vec2(cas * 0.00513, cas * 0.00217)) - 0.5) * 0.4;

  float armAng = ccAng;
  vec2 armVerts[49];
  for (int i = 0; i < 49; i++)
    armVerts[i] = origin;
  armVerts[0]  = cgVerts[caIdx];
  float armStep = 0.013 * (40.0 / float(armSegs));

  for (int i = 0; i < ARM_MAX; i++) {
    if (i >= armSegs) break;
    float r1 = random2d(vec2(cas * 0.00371 + float(i) * 0.0937, cas * 0.00591 + float(i) * 0.0517));
    armAng += (r1 - 0.5) * 2.5;
    armAng -= (armAng - ccAng) * 0.12;
    armAng -= sin(armAng) * 0.28;
    armVerts[i + 1] = armVerts[i] + vec2(cos(armAng), sin(armAng)) * armStep;
  }

  vec2  armTip     = armVerts[armSegs];
  vec2  armTipTC   = vec2(armTip.x / aspectRatios[0], clamp(armTip.y, 0.0, 1.0));
  float cloudAtArm = texture(waterTex, armTipTC)[CLOUD];
  bool armOn = cloudAtArm >= 0.008;

  if (as < 0)
    return emitPolyline(armVerts, armSegs, armOn);
  if (!armOn)
    return emitPolyline(verts, asubSegs, false);

  float ass       = cas + float(as) * 73.37;
  int   aspawnIdx = min(int(random2d(vec2(ass * 0.00413, ass * 0.00237)) * float(armSegs - 5)) + 2, armSegs - 1);
  float asubAng   = ccAng;
  verts[0]        = armVerts[aspawnIdx];

  for (int i = 0; i < ASUB_MAX; i++) {
    if (i >= asubSegs) break;
    float r1 = random2d(vec2(ass * 0.00511 + float(i) * 0.0937, ass * 0.00391 + float(i) * 0.0711));
    asubAng += (r1 - 0.5) * 2.5;
    asubAng -= (asubAng - ccAng) * 0.12;
    asubAng -= sin(asubAng) * 0.28;
    verts[i + 1] = verts[i] + vec2(cos(asubAng), sin(asubAng)) * armStep;
  }

  vec2  asubTip     = verts[asubSegs];
  vec2  asubTipTC   = vec2(asubTip.x / aspectRatios[0], clamp(asubTip.y, 0.0, 1.0));
  float cloudAtAsub = texture(waterTex, asubTipTC)[CLOUD];
  return emitPolyline(verts, asubSegs, cloudAtAsub >= 0.008);
}

vec4 buildSpider(vec2 lightningPos, float boltSeed)
{
  const int MSEGS_MAX = 40;
  const int SSEGS_MAX = 16;

  bool reduced = gReduced;
  int msegs = reduced ? 20 : 40;
  int ssegs = reduced ? 8 : 16;
  int nBolts = reduced ? 2 : 3;
  int nSubs = reduced ? 2 : 3;
  float spiderStep = 0.013 * (40.0 / float(msegs));

  vec2 origin = vec2(lightningPos.x * aspectRatios[0], lightningPos.y);

  int b = gRowLocal <= 2 ? gRowLocal : (gRowLocal - 3) / 3;
  int s = gRowLocal <= 2 ? -1 : (gRowLocal - 3) - b * 3;

  vec2 verts[49];
  for (int i = 0; i < 49; i++)
    verts[i] = origin;

  if (gRowLocal > 11 || b >= nBolts || (s >= 0 && s >= nSubs))
    return emitPolyline(verts, s < 0 ? msegs : ssegs, false);

  float bs = boltSeed + float(b) * 137.51;

  float goRight   = random2d(vec2(bs * 0.00113, bs * 0.00173 + 1.7)) > 0.5 ? 1.0 : -1.0;
  float mainAngle = goRight > 0.0 ? 0.0 : PI;
  mainAngle += (random2d(vec2(bs * 0.00217, bs * 0.00319)) - 0.5) * 0.4;

  float ang = mainAngle;
  vec2 mVerts[49];
  for (int i = 0; i < 49; i++)
    mVerts[i] = origin;

  for (int i = 0; i < MSEGS_MAX; i++) {
    if (i >= msegs) break;
    float r1 = random2d(vec2(bs * 0.00371 + float(i) * 0.0937, bs * 0.00591 + float(i) * 0.0517));
    ang += (r1 - 0.5) * 2.5;
    ang -= (ang - mainAngle) * 0.12;
    ang -= sin(ang) * 0.28;
    mVerts[i + 1] = mVerts[i] + vec2(cos(ang), sin(ang)) * spiderStep;
  }

  vec2  tip        = mVerts[msegs];
  vec2  tipTC      = vec2(tip.x / aspectRatios[0], clamp(tip.y, 0.0, 1.0));
  float cloudAtTip = texture(waterTex, tipTC)[CLOUD];
  bool boltOn = cloudAtTip >= 0.008;

  if (s < 0)
    return emitPolyline(mVerts, msegs, boltOn);
  if (!boltOn)
    return emitPolyline(verts, ssegs, false);

  float ss       = bs + float(s) * 73.37;
  int   spawnIdx = min(int(random2d(vec2(ss * 0.00413, ss * 0.00237)) * float(msegs - 5)) + 2, msegs - 1);
  float subAng   = mainAngle;
  verts[0]       = mVerts[spawnIdx];

  for (int i = 0; i < SSEGS_MAX; i++) {
    if (i >= ssegs) break;
    float r1 = random2d(vec2(ss * 0.00511 + float(i) * 0.0937, ss * 0.00391 + float(i) * 0.0711));
    subAng += (r1 - 0.5) * 2.5;
    subAng -= (subAng - mainAngle) * 0.12;
    subAng -= sin(subAng) * 0.28;
    verts[i + 1] = verts[i] + vec2(cos(subAng), sin(subAng)) * spiderStep;
  }

  vec2  sTip       = verts[ssegs];
  vec2  sTipTC     = vec2(sTip.x / aspectRatios[0], clamp(sTip.y, 0.0, 1.0));
  float cloudAtSub = texture(waterTex, sTipTC)[CLOUD];
  return emitPolyline(verts, ssegs, cloudAtSub >= 0.008);
}

void main()
{
  ivec2 px = ivec2(gl_FragCoord.xy);
  gCol = px.x;
  int row = px.y;

  pathOut = vec4(0.0);
  vec4 lightningData = texture(lightningDataTex, vec2(0.5));
  // No strike on the SDF path: everything stays disabled (header enabled = 0).
  if (lightningData[INTENSITY] <= 0.5 || row >= 48)
    return;

  bool isCg = lightningData[INTENSITY] > 1.0;
  bool cgRow = row < 24;
  // Only the polylines of the active bolt type are built.
  if (isCg != cgRow)
    return;

  int local = cgRow ? row : row - 24;
  gReduced = local >= 12;
  gRowLocal = gReduced ? local - 12 : local;

  vec2 lightningPos = lightningData.xy;
  float boltSeed = lightningData[START_ITERNUM];
  pathOut = isCg ? buildCG(lightningPos, boltSeed) : buildSpider(lightningPos, boltSeed);
}
