// 连接：两团胶质之间拉出来的一根弹性黑丝。
//   · 粗细 = 可用带宽（整根均匀，只在两端和球体融合处鼓起一圈）
//   · 客户端→服务器：表面有朝服务器流动的人字纹；点对点：光滑无纹
//   · 数据传输 = 沿丝移动的鼓包；探测 = 扫过的光脉冲
//   · 断开时从中间扯断，断口之间拉出几根粘丝然后崩断；重连时粘丝先搭上，再长回一根
// 整根丝是参数网格，位置在顶点着色器里沿三次贝塞尔曲线展开，端点可以随节点自由晃动。

import * as THREE from 'three';
import { NOISE, BUMP, patchMaterial } from './glsl.js';
import { PALETTE } from '../config.js';

export const MAX_BULGE = 6;
export const MAX_PULSE = 4;

const geoCache = new Map();

function sinewGeometry(seg, rad, strands) {
  const key = `${seg}:${rad}:${strands}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const pos = [];
  const half = [];
  const idx = [];
  let base = 0;
  const grid = (strand, h, segs, rads) => {
    const row = rads + 1;
    for (let i = 0; i <= segs; i++) {
      for (let j = 0; j <= rads; j++) {
        pos.push(i / segs, j / rads, strand);
        half.push(h);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < rads; j++) {
        const p = base + i * row + j;
        idx.push(p, p + 1, p + row, p + 1, p + row + 1, p + row);
      }
    }
    base += (segs + 1) * row;
  };
  // 主干分成两半：[0, gA] 从 a 端长出，[gB, 1] 从 b 端长出
  grid(0, 0, seg, rad);
  grid(0, 1, seg, rad);
  // 粘丝：只在断口之间出现
  for (let s = 1; s <= strands; s++) grid(s, 0, 20, 5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aHalf', new THREE.Float32BufferAttribute(half, 1));
  g.setIndex(idx);
  geoCache.set(key, g);
  return g;
}

const VERT_PARS = /* glsl */ `
attribute float aHalf;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec3 uP3;
uniform vec2 uGap;
uniform float uRadius;
uniform float uLen;
uniform float uHealth;
uniform float uSeed;
uniform float uTime;
uniform float uDroop;
uniform float uWeb;
uniform vec4 uBulge[${MAX_BULGE}];
varying float vT;
varying float vAng;
varying float vStrand;
varying vec2 vBulge;
varying float vTipD;
vec3 yBez(float t) {
  float k = 1.0 - t;
  return k * k * k * uP0 + 3.0 * k * k * t * uP1 + 3.0 * k * t * t * uP2 + t * t * t * uP3;
}
float yOpen() { return smoothstep(0.0, 0.02, uGap.y - uGap.x); }

// 主干中心线。断开后，残段越靠近断口越下垂、越晃
vec3 yCenter(float t, float hf) {
  vec3 c = yBez(t);
  float open = yOpen();
  float k = hf < 0.5 ? t / max(uGap.x, 0.001) : (1.0 - t) / max(1.0 - uGap.y, 0.001);
  k = clamp(k, 0.0, 1.0);
  float w = k * k * open;
  c.y -= w * uDroop;
  c.x += w * sin(uTime * 2.1 + uSeed * 10.0 + t * 7.0) * 0.14;
  c.z += w * cos(uTime * 1.7 + uSeed * 7.0 + t * 6.0) * 0.14;
  // 不健康时发抖
  float tr = 1.0 - uHealth;
  c += tr * tr * 0.035 * vec3(sin(uTime * 31.0 + t * 40.0), sin(uTime * 27.0 + t * 33.0 + 1.0), sin(uTime * 29.0 + t * 37.0 + 2.0));
  c.y = max(c.y, 0.04);
  return c;
}

// 粘丝：连在两个断口之间，中间下垂
vec3 yStrandC(float u, float k) {
  float back = 0.18 / max(uLen, 0.01);
  vec3 a = yCenter(max(uGap.x - back, 0.0), 0.0);
  vec3 b = yCenter(min(uGap.y + back, 1.0), 1.0);
  vec3 d = b - a;
  float span = length(d);
  float s = sin(3.14159 * u);
  vec3 c = mix(a, b, u);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), d + vec3(1e-4, 0.0, 1e-4)));
  c.y -= s * span * (0.05 + 0.06 * k);
  c += side * s * (k - 2.0) * (0.05 + 0.03 * span);
  c.y = max(c.y, 0.03);
  return c;
}

float yRad(float t, float hf, out vec2 bulge) {
  float R = uRadius;
  // 两端和球体融合处的弯月面
  float e = min(t, 1.0 - t) * uLen;
  float r = R * (1.0 + 0.85 * exp(-e / (R * 1.6 + 0.2)));
  // 中段比两头略细一点，再加一点液体的缓慢起伏
  r *= 1.0 - 0.1 * sin(3.14159 * t);
  r *= 1.0 + 0.035 * sin(t * uLen * 2.2 + uTime * 1.3 + uSeed * 9.0);
  bulge = vec2(0.0);
  for (int i = 0; i < ${MAX_BULGE}; i++) {
    vec4 b = uBulge[i];
    float d = (t - b.x) * uLen / max(b.z, 0.001);
    float g = exp(-d * d);
    r += g * b.y;
    float pres = g * min(1.0, b.y * 12.0);
    bulge += vec2(pres * (1.0 - b.w), pres * b.w);
  }
  // 断口：像被拉断的胶一样收成一个长长的尖，尖上挂一小滴
  float open = yOpen();
  float dTip = (hf < 0.5 ? (uGap.x - t) : (t - uGap.y)) * uLen;
  float tl = 0.55 + r * 3.4;
  float tp = pow(clamp(dTip / tl, 0.0, 1.0), 0.75);
  float drop = exp(-pow((dTip - 0.12) / 0.11, 2.0)) * (0.16 * R + 0.022);
  r = mix(r, r * tp + drop * sqrt(clamp(dTip / 0.05, 0.0, 1.0)), open);
  return r;
}
`;

const VERT_NORMAL = /* glsl */ `
float yAng = position.y * 6.28318530718;
float yStr = position.z;
vec3 yC0;
vec3 yDd;
float yR0;
float ySlope = 0.0;
float yT;
vec2 yBg = vec2(0.0);
float yTip = 99.0;
if (yStr < 0.5) {
  yT = aHalf < 0.5 ? position.x * uGap.x : mix(uGap.y, 1.0, position.x);
  yC0 = yCenter(yT, aHalf);
  yDd = yCenter(yT + 0.012, aHalf) - yCenter(yT - 0.012, aHalf);
  vec2 yBgT;
  yR0 = yRad(yT, aHalf, yBg);
  ySlope = (yRad(yT + 0.012, aHalf, yBgT) - yRad(yT - 0.012, aHalf, yBgT)) / max(length(yDd), 1e-5);
  yTip = mix(99.0, (aHalf < 0.5 ? (uGap.x - yT) : (yT - uGap.y)) * uLen, yOpen());
} else {
  float yU = position.x;
  yT = mix(uGap.x, uGap.y, yU);
  yC0 = yStrandC(yU, yStr);
  yDd = yStrandC(yU + 0.02, yStr) - yStrandC(yU - 0.02, yStr);
  // 越拉越细，中间最细
  yR0 = uWeb * yOpen() * (0.045 + 0.13 * uRadius) * (0.4 + 0.6 * pow(abs(2.0 * yU - 1.0), 1.5)) * (1.3 - 0.25 * yStr);
}
float yDl = max(length(yDd), 1e-5);
vec3 yTan = yDd / yDl;
vec3 yNn = normalize(cross(vec3(0.0, 1.0, 0.0), yTan));
vec3 yBn = cross(yTan, yNn);
vec3 yRing = yNn * cos(yAng) + yBn * sin(yAng);
vec3 objectNormal = normalize(yRing - yTan * ySlope);
vT = yT;
vAng = yAng;
vStrand = yStr;
vBulge = yBg;
vTipD = yTip;
`;

const FRAG_PARS = /* glsl */ `
uniform float uLen;
uniform float uKind;
uniform float uHealth;
uniform float uSeed;
uniform float uTime;
uniform float uBeat;
uniform vec3 uColBody;
uniform vec3 uColMark;
uniform vec3 uColData;
uniform vec4 uPulse[${MAX_PULSE}];
uniform vec3 uPulseCol[${MAX_PULSE}];
varying float vT;
varying float vAng;
varying float vStrand;
varying vec2 vBulge;
varying float vTipD;
${NOISE}
${BUMP}
float yBandF(float x) { return smoothstep(0.0, 0.05, x) * smoothstep(0.24, 0.05, x); }
`;

const FRAG_COLOR = /* glsl */ `
vec2 yCs = vec2(cos(vAng), sin(vAng));
float yFlow = yNoise(vec3(vT * uLen * 0.9 + uSeed * 9.0 - uTime * 0.15, yCs * 1.4));
vec3 yCol = uColBody * (0.75 + 0.5 * yFlow);
// 鼓包把表皮撑薄，透出一点里面的颜色
yCol = mix(yCol, vec3(0.03, 0.045, 0.07), clamp(vBulge.x * 0.6, 0.0, 0.6));
yCol = mix(yCol, vec3(0.2, 0.012, 0.012), clamp(vBulge.y * 0.9, 0.0, 0.9));
// 劣化 / 断开：失去光泽，发灰
yCol = mix(yCol, vec3(0.05, 0.048, 0.046), (1.0 - uHealth) * 0.8);
diffuseColor.rgb = yCol;
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = clamp(0.13 + 0.08 * yFlow + (1.0 - uHealth) * 0.5 - (vBulge.x + vBulge.y) * 0.05, 0.06, 1.0);
`;

const FRAG_NORMAL = /* glsl */ `
normal = yBump(normal, -vViewPosition, yFlow, 0.01);
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  vec3 yE = vec3(0.0);
  float yMain = 1.0 - step(0.5, vStrand);
  // 带色的轮廓光：点对点偏青，客户端→服务器偏紫，让黑丝在黑背景上也能读出粗细
  float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.4);
  yE += uColMark * yRim * 0.05 * (0.25 + 0.75 * uHealth);
  // 方向：朝服务器流动的人字纹（尖端在管道顶部，指向服务器）
  float yOff = (1.0 - yCs.y) * 0.5;
  float yChev = yBandF(fract(vT * uLen * 0.85 + yOff * 0.55 - uTime * 0.55));
  yE += uColMark * yChev * uKind * 0.16 * uHealth * uHealth * yMain;
  for (int i = 0; i < ${MAX_PULSE}; i++) {
    vec4 p = uPulse[i];
    float d = (vT - p.x) * uLen / max(p.z, 0.001);
    yE += uPulseCol[i] * exp(-d * d) * p.y * (0.5 + 0.9 * yRim);
  }
  // 断口：被扯断的一端泛暗橙；正在生长的尖端是连接自己的颜色
  float yTip = exp(-max(vTipD, 0.0) * 3.2);
  vec3 yTipCol = mix(vec3(1.0, 0.24, 0.06), uColMark, smoothstep(0.35, 0.7, uHealth));
  yE += yTipCol * yTip * (0.22 + 0.12 * sin(uTime * 5.0 + uSeed * 20.0)) * yMain;
  yE += uColData * vBulge.x * (0.1 + 0.5 * yRim);
  yE += vec3(1.0, 0.045, 0.03) * vBulge.y * (0.45 + 1.2 * uBeat) * (0.35 + 0.65 * yRim);
  totalEmissiveRadiance += yE;
}
`;

const HUES = [new THREE.Vector3(...PALETTE.probe), new THREE.Vector3(...PALETTE.vote), new THREE.Vector3(...PALETTE.warn)];
const damp = (v, t, k, dt) => v + (t - v) * (1 - Math.exp(-k * dt));

/** 带宽（已取对数归一化到 0..1）→ 半径。1 Mbps 细如发丝，1 Gbps 粗如手臂 */
export function radiusForBandwidth(bwNorm) {
  return 0.03 + 0.42 * Math.pow(bwNorm, 1.8);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _cur = new THREE.Vector3();

export class Sinew {
  constructor(link, viewA, viewB, q, shared) {
    this.link = link;
    this.viewA = viewA;
    this.viewB = viewB;
    this.p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.length = link.length;
    this.radius = radiusForBandwidth(link.bwNorm);
    this.nBulge = 0;
    this.nPulse = 0;
    this.web = 0;
    this.wasOpen = link.gB - link.gA > 0.004;
    const cs = link.kind === 'cs';

    const u = (this.uniforms = {
      uTime: shared.uTime,
      uBeat: shared.uBeat,
      uP0: { value: this.p[0] },
      uP1: { value: this.p[1] },
      uP2: { value: this.p[2] },
      uP3: { value: this.p[3] },
      uGap: { value: new THREE.Vector2(link.gA, link.gB) },
      uRadius: { value: this.radius },
      uLen: { value: this.length },
      uKind: { value: cs ? 1 : 0 },
      uHealth: { value: link.health },
      uSeed: { value: link.seed },
      uDroop: { value: 0.3 },
      uWeb: { value: 0 },
      uColBody: { value: new THREE.Color(0.011, 0.012, 0.016) },
      uColMark: { value: new THREE.Color(...(cs ? PALETTE.cs : PALETTE.p2p)) },
      uColData: { value: new THREE.Color(...PALETTE.data) },
      uBulge: { value: Array.from({ length: MAX_BULGE }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uPulse: { value: Array.from({ length: MAX_PULSE }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uPulseCol: { value: Array.from({ length: MAX_PULSE }, () => new THREE.Vector3()) },
    });

    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({ roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 }),
      {
        key: 'yog-sinew',
        uniforms: u,
        vertexPars: VERT_PARS,
        vertexNormal: VERT_NORMAL,
        vertexPosition: 'vec3 transformed = yC0 + yRing * yR0;',
        fragmentPars: FRAG_PARS,
        fragmentColor: FRAG_COLOR,
        fragmentRoughness: FRAG_ROUGH,
        fragmentNormal: FRAG_NORMAL,
        fragmentEmissive: FRAG_EMISSIVE,
      },
    );
    this.mesh = new THREE.Mesh(sinewGeometry(q.sinewSeg, q.sinewRad, q.strands), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = link.state !== 'absent';
    this.updateCurve(0);
  }

  /** 根据两端节点当前的位置（含晃动）重算贝塞尔控制点 */
  updateCurve(time) {
    const { link, viewA: A, viewB: B, p } = this;
    const dx = B.body.x - A.body.x;
    const dz = B.body.z - A.body.z;
    const d = Math.hypot(dx, dz);
    const ux = dx / d;
    const uz = dz / d;
    const sx = -uz;
    const sz = ux;
    p[0].set(A.body.x + ux * A.r * 0.5, A.anchor.y, A.body.z + uz * A.r * 0.5);
    p[3].set(B.body.x - ux * B.r * 0.5, B.anchor.y, B.body.z - uz * B.r * 0.5);
    const span = p[0].distanceTo(p[3]);
    const avgY = (p[0].y + p[3].y) * 0.5;
    // 贴近地面的丝几乎是绷直的，只有一点垂度；跨越别的连接的丝拱起来
    const midY = link.lift > 0 ? link.lift : Math.max(this.radius + 0.08, avgY - 0.035 * span);
    const cy = (8 * midY - p[0].y - p[3].y) / 6;
    const s1 = link.bow * span * 0.6 + Math.sin(time * 0.23 + link.seed * 40) * 0.14;
    const s2 = link.bow * span * 0.6 + Math.cos(time * 0.19 + link.seed * 23) * 0.14;
    const bob = link.lift > 0 ? Math.sin(time * 0.31 + link.seed * 11) * 0.12 : 0;
    p[1].set(p[0].x + ux * span * 0.3 + sx * s1, cy + bob, p[0].z + uz * span * 0.3 + sz * s1);
    p[2].set(p[3].x - ux * span * 0.3 + sx * s2, cy - bob, p[3].z - uz * span * 0.3 + sz * s2);
    // 近似弧长
    let len = 0;
    _prev.copy(p[0]);
    for (let i = 1; i <= 10; i++) {
      this.pointAt(i / 10, _cur);
      len += _cur.distanceTo(_prev);
      _prev.copy(_cur);
    }
    this.length = len;
    link.length = len;
    this.midY = midY;
  }

  pointAt(t, out) {
    const p = this.p;
    const k = 1 - t;
    _a.copy(p[0]).multiplyScalar(k * k * k);
    _b.copy(p[1]).multiplyScalar(3 * k * k * t);
    out.copy(_a).add(_b);
    _a.copy(p[2]).multiplyScalar(3 * k * t * t);
    _b.copy(p[3]).multiplyScalar(t * t * t);
    return out.add(_a).add(_b);
  }

  resetSlots() {
    this.nBulge = 0;
    this.nPulse = 0;
  }

  addBulge(t, amp, width, kind) {
    if (this.nBulge >= MAX_BULGE) return;
    this.uniforms.uBulge.value[this.nBulge++].set(t, amp, width, kind);
  }

  addPulse(t, intensity, width, hue) {
    if (this.nPulse >= MAX_PULSE) return;
    this.uniforms.uPulse.value[this.nPulse].set(t, intensity, width, 0);
    this.uniforms.uPulseCol.value[this.nPulse].copy(HUES[hue] || HUES[0]);
    this.nPulse++;
  }

  update(dt, time) {
    const { link, uniforms: u } = this;
    const present = link.state !== 'absent';
    this.mesh.visible = present;
    if (!present) {
      this.radius = radiusForBandwidth(link.bwNorm) * 0.5;
      this.web = 0;
      this.wasOpen = true;
      return;
    }
    const broken = link.state === 'down' || link.state === 'retracting';
    const target = radiusForBandwidth(link.bwNorm) * (broken ? 0.75 : 1);
    this.radius = damp(this.radius, target, 2.4, dt);
    this.updateCurve(time);

    // 粘丝：刚扯断的一瞬间拉出来然后变细消失；重连时在两端靠近后先搭上
    const open = link.gB - link.gA > 0.004;
    if (open && !this.wasOpen && link.state === 'down') this.web = 1;
    this.wasOpen = open;
    const gap = (link.gB - link.gA) * this.length;
    if (!open) this.web = 0;
    else if (link.state === 'growing' && !link.failing && gap < 3.4) this.web = damp(this.web, 1, 4, dt);
    else this.web = Math.max(0, this.web - dt * (link.state === 'down' ? 0.85 : 3));

    u.uRadius.value = this.radius;
    u.uLen.value = this.length;
    u.uGap.value.set(link.gA, link.gB);
    u.uHealth.value = link.health;
    u.uWeb.value = this.web;
    u.uDroop.value = link.lift > 0 ? 0.35 + link.lift * 0.55 : 0.22;
    for (let i = this.nBulge; i < MAX_BULGE; i++) u.uBulge.value[i].set(0, 0, 1, 0);
    for (let i = this.nPulse; i < MAX_PULSE; i++) u.uPulse.value[i].set(0, 0, 1, 0);
  }
}
