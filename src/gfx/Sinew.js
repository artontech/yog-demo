// 连接：共生体一样的粘性管道。
//   · 粗细 = 可用带宽
//   · P2P 是两端粗、中间细的对称肌腱；客户端→服务器是从客户端伸出、尖端吸附在服务器上的渐细触手
//   · 活的：中心线小幅蠕动、截面来回拧转、整根缓慢呼吸；与节点相连处是一段平滑的粗喇叭口，跟着节点一起涨缩
//   · 数据传输 = 沿管道移动的鼓包；探测 = 扫过的光脉冲
//   · 断开时从中间扯断，两截残肢垂落、蠕动，之后重新生长
// 整条管道是参数网格，位置在顶点着色器里沿三次贝塞尔曲线展开，所以端点可以随节点自由移动。

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
  for (let s = 0; s <= strands; s++) {
    const segs = s === 0 ? seg : Math.round(seg * 0.75);
    const rads = s === 0 ? rad : 5;
    grid(s, 0, segs, rads);
    grid(s, 1, segs, rads);
  }
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
uniform float uKind;
uniform float uHealth;
uniform float uSeed;
uniform float uTime;
uniform float uDroop;
uniform vec2 uBreathEnds; // 两端节点此刻的呼吸值（-1..1）
uniform vec4 uBulge[${MAX_BULGE}];
varying float vT;
varying float vAng;
varying float vStrand;
varying vec2 vBulge;
varying float vTipD;
${NOISE}
vec3 yBez(float t) {
  float k = 1.0 - t;
  return k * k * k * uP0 + 3.0 * k * k * t * uP1 + 3.0 * k * t * t * uP2 + t * t * t * uP3;
}
vec3 yBezD(float t) {
  float k = 1.0 - t;
  return 3.0 * k * k * (uP1 - uP0) + 6.0 * k * t * (uP2 - uP1) + 3.0 * t * t * (uP3 - uP2);
}
float yOpen() { return smoothstep(0.0, 0.02, uGap.y - uGap.x); }
// 活力：健康的管道动得舒展，劣化 / 断开的只剩一点抽动
float yLive() { return 0.3 + 0.7 * uHealth; }

// 蠕动：两组频率不同的波沿管道传播，让中心线小幅度地左右、上下游走；两端平滑收拢，接口不动
vec3 yWrithe(float t, vec3 N, vec3 B) {
  float s = t * uLen;
  float env = smoothstep(0.0, 0.3, t) * smoothstep(0.0, 0.3, 1.0 - t);
  float amp = (0.05 + 0.22 * uRadius) * yLive() * env;
  float a = sin(s * 1.6 - uTime * 1.15 + uSeed * 30.0) + 0.5 * sin(s * 0.7 + uTime * 0.6 + uSeed * 11.0);
  float b = sin(s * 1.2 + uTime * 0.9 + uSeed * 47.0) + 0.5 * sin(s * 2.3 - uTime * 1.4 + uSeed * 5.0);
  return (N * a + B * (b * 0.6)) * amp;
}

// 扭动：截面绕中心线来回拧转，拧的角度沿长度变化，所以看起来像一股被拧着的肉绳
float yTwist(float t) {
  float s = t * uLen;
  return yLive() * (0.75 * sin(s * 0.5 - uTime * 0.5 + uSeed * 20.0) + 0.45 * sin(s * 0.21 + uTime * 0.27 + uSeed * 9.0));
}

vec3 yCenter(float t, float hf, float strand) {
  vec3 c = yBez(t);
  vec3 T = normalize(yBezD(t) + vec3(1e-6, 0.0, 0.0));
  vec3 N = normalize(cross(vec3(0.0, 1.0, 0.0), T) + vec3(1e-5, 0.0, 0.0));
  vec3 B = cross(T, N);
  c += yWrithe(t, N, B);
  float open = yOpen();
  // 断开后：残肢越靠近断口越下垂、越扭动
  float k = hf < 0.5 ? t / max(uGap.x, 0.001) : (1.0 - t) / max(1.0 - uGap.y, 0.001);
  k = clamp(k, 0.0, 1.0);
  float w = k * k * open;
  c.y -= w * uDroop;
  c.x += w * sin(uTime * 2.1 + uSeed * 10.0 + t * 9.0) * 0.24;
  c.z += w * cos(uTime * 1.7 + uSeed * 7.0 + t * 8.0) * 0.24;
  c.y += w * sin(uTime * 2.6 + uSeed * 3.0 + t * 6.0) * 0.12;
  // 不健康时发抖
  float tr = 1.0 - uHealth;
  c += tr * tr * 0.035 * vec3(sin(uTime * 31.0 + t * 40.0), sin(uTime * 27.0 + t * 33.0 + 1.0), sin(uTime * 29.0 + t * 37.0 + 2.0));
  if (strand > 0.5) {
    // 缠绕在主干外的粘丝，跟着主干一起拧
    float a = strand * 2.4 + uSeed * 6.283 + t * (4.0 + strand * 1.3) + uTime * 0.12 + yTwist(t);
    float env = pow(max(sin(3.14159 * t), 0.0), 0.6);
    float off = (uRadius * 1.5 + 0.05 + 0.05 * strand) * env * (0.7 + 0.5 * sin(t * 7.0 + strand * 3.0 + uSeed * 5.0));
    c += (N * cos(a) + B * sin(a)) * off;
  }
  c.y = max(c.y, 0.03);
  return c;
}

float yRad(float t, float ang, float hf, float strand, out vec2 bulge) {
  float R = uRadius;
  // 与节点相连处：一段又长又平滑的喇叭口（起止两头坡度都是 0），明显比管身粗，像从节点里长出来的根
  float fl = 1.5 + R * 3.0;
  float f0 = 1.0 - smoothstep(0.0, fl, t * uLen);
  float f1 = 1.0 - smoothstep(0.0, fl, (1.0 - t) * uLen);
  f0 *= f0;
  f1 *= f1;
  // 根部跟着它所连的节点一起涨缩
  float root0 = f0 * (1.0 + 0.25 * uBreathEnds.x);
  float root1 = f1 * (1.0 + 0.25 * uBreathEnds.y);
  float r;
  if (uKind < 0.5) {
    r = R * (0.74 + 0.5 * pow(abs(2.0 * t - 1.0), 2.4));
    r += (R * 1.15 + 0.15) * (root0 + root1);
  } else {
    r = R * mix(1.35, 0.62, smoothstep(0.0, 0.92, t));
    r += (R * 1.0 + 0.15) * root0;
    r += (R * 1.3 + 0.13) * root1;
    r *= 1.0 + 0.06 * sin(t * uLen * 5.0 - uTime * 3.2) * uHealth;
  }
  // 缓慢的呼吸：整根管子一涨一缩，吸气慢、呼气快，相位沿长度略有先后；靠近节点的一段改为跟随节点的呼吸
  float ph = uTime * 0.95 + uSeed * 6.283 - t * uLen * 0.3;
  float breath = sin(ph - 0.4 * sin(ph));
  breath = mix(breath, uBreathEnds.x, f0);
  breath = mix(breath, uBreathEnds.y, f1);
  r *= 1.0 + 0.11 * yLive() * breath;
  float n = yNoise(vec3(t * uLen * 0.9 + uSeed * 17.0, cos(ang) * 0.8, sin(ang) * 0.8 + uTime * 0.05));
  r *= 0.8 + 0.42 * n;
  // 截面不是正圆而是略带三道棱，这样拧转的时候才看得出来
  if (strand < 0.5) r *= 1.0 + 0.09 * cos(3.0 * ang + uSeed * 6.283);
  bulge = vec2(0.0);
  for (int i = 0; i < ${MAX_BULGE}; i++) {
    vec4 b = uBulge[i];
    float d = (t - b.x) * uLen / max(b.z, 0.001);
    float g = exp(-d * d);
    r += g * b.y;
    float pres = g * min(1.0, b.y * 12.0);
    bulge += vec2(pres * (1.0 - b.w), pres * b.w);
  }
  if (strand > 0.5) r = (R * 0.15 + 0.014) * (0.55 + 0.9 * n);
  float open = yOpen();
  float dTip = (hf < 0.5 ? (uGap.x - t) : (t - uGap.y)) * uLen;
  float tl = 0.22 + r * 2.4;
  float tp = sqrt(clamp(dTip / tl, 0.0, 1.0));
  float dq = (dTip - 0.14 - r) / 0.17;
  float drop = exp(-dq * dq) * (0.5 * R + 0.02);
  r = mix(r, (r + drop) * tp, open);
  return r;
}
`;

const VERT_NORMAL = /* glsl */ `
float yAng = position.y * 6.28318530718;
float yStr = position.z;
float yT = aHalf < 0.5 ? position.x * uGap.x : mix(uGap.y, 1.0, position.x);
vec3 yC0 = yCenter(yT, aHalf, yStr);
vec3 yDd = yCenter(yT + 0.012, aHalf, yStr) - yCenter(yT - 0.012, aHalf, yStr);
float yDl = max(length(yDd), 1e-5);
vec3 yTan = yDd / yDl;
vec3 yNn = normalize(cross(vec3(0.0, 1.0, 0.0), yTan) + vec3(1e-5, 0.0, 0.0));
vec3 yBn = cross(yTan, yNn);
vec2 yBg;
vec2 yBgT;
float yR0 = yRad(yT, yAng, aHalf, yStr, yBg);
float yRa = yRad(yT - 0.012, yAng, aHalf, yStr, yBgT);
float yRb = yRad(yT + 0.012, yAng, aHalf, yStr, yBgT);
// 截面整体拧一个角度：表面的棱、纤维和纹路都跟着转
float ySa = yAng + (yStr < 0.5 ? yTwist(yT) : 0.0);
vec3 yRing = yNn * cos(ySa) + yBn * sin(ySa);
vec3 yTang = yBn * cos(ySa) - yNn * sin(ySa);
// 三道棱带来的周向坡度（解析求导），让棱上的高光是对的
float yLb = 3.0 * yAng + uSeed * 6.283;
float yLobe = yStr < 0.5 ? -0.27 * sin(yLb) / (1.0 + 0.09 * cos(yLb)) : 0.0;
vec3 objectNormal = normalize(yRing - yTang * yLobe - yTan * ((yRb - yRa) / yDl));
vT = yT;
vAng = yAng;
vStrand = yStr;
vBulge = yBg;
// 到断口的距离（世界单位）；管道完整时取一个很大的值
vTipD = mix(99.0, (aHalf < 0.5 ? (uGap.x - yT) : (yT - uGap.y)) * uLen, yOpen());
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
float yBandF(float x) { return smoothstep(0.0, 0.07, x) * (1.0 - smoothstep(0.07, 0.34, x)); }
`;

const FRAG_COLOR = /* glsl */ `
vec2 yBu = max(vBulge, vec2(0.0)); // 插值可能略微越界，钳到非负
vec2 yCs = vec2(cos(vAng), sin(vAng));
float yFib = yNoise(vec3(vT * uLen * 0.7 + uSeed * 9.0, yCs * 2.6));
float yFib2 = yNoise(vec3(vT * uLen * 2.4, yCs * 7.0 + uSeed));
vec3 yCol = uColBody * (0.55 + 0.95 * yFib);
// 鼓包把表皮撑薄
yCol = mix(yCol, vec3(0.085, 0.11, 0.04), clamp(yBu.x * 0.55, 0.0, 0.55));
yCol = mix(yCol, vec3(0.2, 0.012, 0.012), clamp(yBu.y * 0.9, 0.0, 0.9));
// 劣化：坏死的灰黄斑
float yBlot = smoothstep(0.3, 0.7, yNoise(vec3(vT * uLen * 1.6, yCs * 1.5 + uSeed * 3.0)));
yCol = mix(yCol, vec3(0.2, 0.17, 0.095), (1.0 - uHealth) * (0.25 + 0.75 * yBlot));
diffuseColor.rgb = yCol;
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(0.18, 0.42, yFib2) + (1.0 - uHealth) * 0.42 - (yBu.x + yBu.y) * 0.1;
roughnessFactor = clamp(roughnessFactor, 0.08, 1.0);
`;

const FRAG_NORMAL = /* glsl */ `
normal = yBump(normal, -vViewPosition, yFib2 * 0.7 + yFib * 0.5, 0.022);
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  vec3 yE = vec3(0.0);
  float yMain = 1.0 - step(0.5, vStrand);
  // 一点带色的轮廓光，让黑色的管道在黑色的背景上也能读出粗细
  float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
  yE += uColMark * yRim * 0.03 * (0.3 + 0.7 * uHealth);
  // 方向纹。P2P 是静止的对称菱形纹；
  // 客户端→服务器的人字纹不铺满整根触手，而是三三两两、明暗不一、时有时无地朝服务器游过去
  float yOff = (1.0 - yCs.y) * 0.5;
  float yPh = vT * uLen * 1.15;
  float yFlow = yPh + yOff * 0.6 - uTime * (0.45 + 0.3 * fract(uSeed * 7.3)); // 每根触手流速略有不同
  float yRing = floor(yFlow);                                                  // 每一道纹的编号，随它一起移动
  float yRnd = yHash12(vec2(yRing, uSeed * 91.7));                             // 这一道纹自己的随机数
  float yGroup = smoothstep(0.42, 0.58, yNoise(vec3(yRing * 0.31 + uSeed * 17.0, 0.0, 0.0))); // 成群出现，群与群之间留白
  float yAwake = smoothstep(0.22, 0.42, yNoise(vec3(uTime * 0.13 + uSeed * 31.0, 0.0, 0.0))); // 整根触手时亮时灭
  float yChev = yBandF(fract(yFlow)) * yGroup * step(0.35, yRnd) * (0.35 + 0.9 * yRnd) * yAwake;
  float yLat = max(yBandF(fract(yPh + yOff * 0.6)), yBandF(fract(yPh - yOff * 0.6))) * (0.55 + 0.45 * sin(uTime * 0.9 + vT * 6.0));
  yE += uColMark * mix(yLat * 0.047, yChev * 0.13, uKind) * uHealth * uHealth * yMain;
  for (int i = 0; i < ${MAX_PULSE}; i++) {
    vec4 p = uPulse[i];
    float d = (vT - p.x) * uLen / max(p.z, 0.001);
    yE += uPulseCol[i] * exp(-d * d) * p.y * (0.35 + 1.1 * yFib);
  }
  // 断口：撕裂的伤口泛着暗橙色；正在生长的触须尖端则是青色
  float yTip = exp(-max(vTipD, 0.0) * 2.2);
  vec3 yTipCol = mix(vec3(1.0, 0.22, 0.06), uColMark, smoothstep(0.35, 0.7, uHealth));
  yE += yTipCol * yTip * (0.35 + 0.25 * sin(uTime * 5.0 + uSeed * 20.0)) * (0.4 + 0.6 * yFib);
  yE += uColData * yBu.x * (0.15 + 0.85 * yFib) * 0.3;
  yE += vec3(1.0, 0.045, 0.03) * yBu.y * (0.5 + 1.3 * uBeat) * (0.4 + 0.6 * yFib);
  totalEmissiveRadiance += yE;
}
`;

const HUES = [new THREE.Vector3(...PALETTE.probe), new THREE.Vector3(...PALETTE.vote), new THREE.Vector3(...PALETTE.warn)];
const damp = (v, t, k, dt) => v + (t - v) * (1 - Math.exp(-k * dt));

export function radiusForBandwidth(bwNorm) {
  return 0.06 + 0.3 * Math.pow(bwNorm, 1.3);
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
      uDroop: { value: 0.5 },
      uBreathEnds: { value: new THREE.Vector2() },
      uColBody: { value: cs ? new THREE.Color(0.03, 0.02, 0.05) : new THREE.Color(0.016, 0.034, 0.032) },
      uColMark: { value: cs ? new THREE.Color(0.62, 0.38, 1.0) : new THREE.Color(0.2, 1.0, 0.75) },
      uColData: { value: new THREE.Color(...PALETTE.data) },
      uBulge: { value: Array.from({ length: MAX_BULGE }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uPulse: { value: Array.from({ length: MAX_PULSE }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uPulseCol: { value: Array.from({ length: MAX_PULSE }, () => new THREE.Vector3()) },
    });

    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12 }),
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

  /** 根据两端节点当前的位置重算贝塞尔控制点 */
  updateCurve(time) {
    const { link, viewA: A, viewB: B, p } = this;
    const dx = B.pos.x - A.pos.x;
    const dz = B.pos.z - A.pos.z;
    const d = Math.hypot(dx, dz);
    const ux = dx / d;
    const uz = dz / d;
    const sx = -uz;
    const sz = ux;
    p[0].set(A.pos.x + ux * A.r * 0.55, A.anchor.y, A.pos.z + uz * A.r * 0.55);
    p[3].set(B.pos.x - ux * B.r * 0.55, B.anchor.y, B.pos.z - uz * B.r * 0.55);
    const span = p[0].distanceTo(p[3]);
    // 中点高度：贴地的管道几乎躺在菌毯上，悬空的拉丝拱起来
    const midY = link.lift > 0 ? link.lift : this.radius + 0.07;
    const cy = (8 * midY - p[0].y - p[3].y) / 6;
    const s1 = link.bow * span + Math.sin(time * 0.23 + link.seed * 40) * 0.3;
    const s2 = link.bow * span + Math.cos(time * 0.19 + link.seed * 23) * 0.3;
    const bob = link.lift > 0 ? Math.sin(time * 0.31 + link.seed * 11) * 0.18 : 0;
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
      return;
    }
    const broken = link.state === 'down' || link.state === 'retracting';
    const target = radiusForBandwidth(link.bwNorm) * (broken ? 0.72 : 1);
    this.radius = damp(this.radius, target, 2.4, dt);
    this.updateCurve(time);
    u.uRadius.value = this.radius;
    u.uLen.value = this.length;
    u.uGap.value.set(link.gA, link.gB);
    u.uHealth.value = link.health;
    u.uBreathEnds.value.set(this.viewA.node.agent.breath, this.viewB.node.agent.breath);
    u.uDroop.value = Math.max(0.2, (this.p[0].y + this.p[3].y) * 0.5 + Math.max(link.lift, 0) * 0.9);
    for (let i = this.nBulge; i < MAX_BULGE; i++) u.uBulge.value[i].set(0, 0, 1, 0);
    for (let i = this.nPulse; i < MAX_PULSE; i++) u.uPulse.value[i].set(0, 0, 1, 0);
  }
}
