// 控制核心：一颗暗红色、带血管的心脏，寄生在当选节点的顶部。
// 选举后它会沉入宿主，化作一个红色鼓包沿管道游到新宿主，再重新长出来。

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE, BUMP, patchMaterial } from './glsl.js';

const VERT_PARS = /* glsl */ `
attribute float aPart; // 0 = 心肌主体, 1 = 血管
uniform float uTime;
uniform float uBeat;   // 心室收缩 0..1
uniform float uBeat2;  // 心房收缩（略早）
uniform float uPanic;
varying vec3 vDir;
varying float vPart;
varying float vGroove;
${NOISE}
float yDot2(vec3 v) { return dot(v, v); }
vec3 yHeartP(vec3 n, out float groove) {
  float y = n.y;
  vec3 p = n;
  float taper = mix(0.26, 1.0, smoothstep(-1.05, 0.35, y)); // 向心尖收窄
  p.xz *= taper;
  p.y *= 1.22;
  p.x += 0.24 * (1.0 - smoothstep(-1.0, 0.25, y));                // 心尖偏向一侧
  float a1 = exp(-yDot2(n - normalize(vec3(0.55, 0.72, -0.25))) * 5.5);
  float a2 = exp(-yDot2(n - normalize(vec3(-0.62, 0.68, 0.15))) * 5.5);
  float disp = 0.24 * a1 + 0.2 * a2;                      // 两个心房
  float g1 = n.x * 0.75 + n.z * 0.66 + 0.16 * sin(y * 3.0);
  float gv = exp(-g1 * g1 * 55.0) * (1.0 - smoothstep(-0.25, 0.55, y));
  float g2 = (y - 0.36) * 6.5;
  float gh = exp(-g2 * g2);
  groove = max(gv, gh * 0.8);
  disp -= 0.075 * gv + 0.05 * gh;                         // 室间沟、房室沟
  disp += (yFbm(n * 2.3 + 3.1) - 0.45) * 0.2;             // 肌肉隆起
  float vent = 1.0 - smoothstep(-0.25, 0.42, y);
  disp -= uBeat * 0.115 * vent;
  disp += uBeat * 0.035 * (1.0 - vent) - uBeat2 * 0.07 * (1.0 - vent);
  disp += uPanic * 0.03 * sin(uTime * 37.0 + y * 9.0);
  return p * (1.0 + disp);
}
`;

const VERT_NORMAL = /* glsl */ `
vec3 objectNormal;
vec3 yPos;
float yGr = 0.0;
if (aPart < 0.5) {
  vec3 yN0 = normalize(position);
  float yGt;
  yPos = yHeartP(yN0, yGr);
  vec3 yAx = abs(yN0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 yT1 = normalize(cross(yAx, yN0));
  vec3 yT2 = cross(yN0, yT1);
  vec3 yP1 = yHeartP(normalize(yN0 + yT1 * 0.03), yGt);
  vec3 yP2 = yHeartP(normalize(yN0 + yT2 * 0.03), yGt);
  objectNormal = normalize(cross(yP1 - yPos, yP2 - yPos));
  vDir = yN0;
} else {
  // 血管：收缩的血液让它滞后一拍地鼓胀
  objectNormal = normal;
  yPos = position + normal * (uBeat * 0.035 - 0.01);
  vDir = position;
}
vPart = aPart;
vGroove = yGr;
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uFade;
varying vec3 vDir;
varying float vPart;
varying float vGroove;
${NOISE}
${BUMP}
`;

function buildGeometry(detail) {
  const body = mergeVertices(new THREE.IcosahedronGeometry(1, detail).deleteAttribute('uv'), 1e-4);
  const parts = [body];
  const partIds = [new Float32Array(body.attributes.position.count)];
  // 从心底伸出、弓起后扎进宿主体内的大血管
  const vessels = [
    // 主动脉：从心底拱起，绕到背后扎下去
    { r: 0.17, pts: [[0.02, 0.8, 0.0], [0.05, 1.42, -0.05], [-0.4, 1.5, -0.42], [-0.7, 0.8, -0.82], [-0.72, -1.9, -0.95]] },
    // 肺动脉：短一些，向另一侧分出
    { r: 0.12, pts: [[0.3, 0.8, 0.2], [0.55, 1.26, 0.25], [0.98, 0.95, 0.1], [1.05, -0.2, 0.0], [1.02, -1.9, -0.05]] },
    // 腔静脉：贴着右心房的短管
    { r: 0.1, pts: [[0.45, 0.75, -0.4], [0.62, 1.2, -0.62], [0.6, 1.5, -0.7]] },
    // 从心尖和侧面垂下的细根
    { r: 0.07, pts: [[-0.45, -0.2, 0.55], [-0.75, -0.7, 0.85], [-0.8, -1.9, 0.95]] },
    { r: 0.08, pts: [[0.24, -0.95, -0.2], [0.4, -1.5, -0.45], [0.4, -2.2, -0.55]] },
  ];
  for (const v of vessels) {
    const curve = new THREE.CatmullRomCurve3(v.pts.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.5);
    const tube = new THREE.TubeGeometry(curve, 28, v.r, 7, false).deleteAttribute('uv');
    parts.push(tube);
    partIds.push(new Float32Array(tube.attributes.position.count).fill(1));
  }
  const geo = mergeGeometries(parts, false);
  const ids = new Float32Array(geo.attributes.position.count);
  let o = 0;
  for (const a of partIds) {
    ids.set(a, o);
    o += a.length;
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(ids, 1));
  return geo;
}

const pulse = (phi, c, w) => Math.exp(-(((phi - c) / w) ** 2));
const damp = (v, t, k, dt) => v + (t - v) * (1 - Math.exp(-k * dt));
const _p = new THREE.Vector3();

export class Heart {
  constructor(q, shared) {
    this.shared = shared;
    this.phase = 0;
    this.rate = 0.9;
    this.panic = 0;
    this.group = new THREE.Group();
    this.uniforms = {
      uTime: shared.uTime,
      uBeat: shared.uBeat,
      uBeat2: { value: 0 },
      uPanic: { value: 0 },
      uFade: { value: 1 },
    };
    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({ roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1 }),
      {
        key: 'yog-heart',
        uniforms: this.uniforms,
        vertexPars: VERT_PARS,
        vertexNormal: VERT_NORMAL,
        vertexPosition: 'vec3 transformed = yPos;',
        fragmentPars: FRAG_PARS,
        fragmentColor: /* glsl */ `
          float yM = yFbm(vDir * 2.6 + 1.7);
          float yVein = yVeins(vDir * 2.4 + 8.3, 5.0) * (1.0 - vPart);
          float yFine = yNoise(vDir * 22.0);
          vec3 yCol = mix(vec3(0.16, 0.012, 0.016), vec3(0.05, 0.004, 0.012), smoothstep(0.3, 0.75, yM));
          yCol = mix(yCol, vec3(0.2, 0.03, 0.035), vPart * 0.6);
          yCol = mix(yCol, vec3(0.2, 0.13, 0.08), vGroove * 0.35);        // 沟里的脂肪
          yCol *= 0.7 + 0.6 * yFine;
          diffuseColor.rgb = mix(vec3(0.03, 0.022, 0.02), yCol, uFade);
        `,
        fragmentRoughness: 'roughnessFactor = mix(0.2, 0.5, yM);',
        fragmentNormal: 'normal = yBump(normal, -vViewPosition, yFine * 0.3 + yVein * 1.2 + yM, 0.03);',
        fragmentEmissive: /* glsl */ `
          {
            float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.5);
            vec3 yE = vec3(1.0, 0.05, 0.035) * (yVein * (0.12 + 0.95 * uBeat) + 0.012 + 0.12 * uBeat * (0.3 + yRim));
            yE += vec3(1.0, 0.06, 0.04) * vPart * (0.015 + 0.07 * uBeat);
            totalEmissiveRadiance += yE * uFade;
          }
        `,
      },
    );
    this.mesh = new THREE.Mesh(buildGeometry(q.low ? 10 : 18), this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // 心跳的红光会照亮周围的血肉和菌毯
    this.light = new THREE.PointLight(0xff2010, 0, 16, 1.8);
    this.lightPos = new THREE.Vector3();
    this.visiblePos = new THREE.Vector3();
  }

  /**
   * @param core   sim.core
   * @param views  NodeView[]
   * @param sinews Sinew[]（按 link.index 排列）
   */
  update(dt, time, core, views, sinews) {
    const electing = core.phase === 'election';
    const moving = core.phase !== 'steady';
    this.panic = damp(this.panic, electing ? 1 : 0, 4, dt);
    this.rate = damp(this.rate, electing ? 2.5 : moving ? 1.6 : 0.88, 3, dt);
    this.phase = (this.phase + dt * this.rate) % 1;
    const lub = pulse(this.phase, 0.12, 0.05);
    const dub = pulse(this.phase, 0.38, 0.06) * 0.65;
    const beat = Math.min(1, lub + dub);
    this.shared.uBeat.value = beat;
    this.uniforms.uBeat2.value = pulse(this.phase, 0.02, 0.05) + pulse(this.phase, 1.02, 0.05);
    this.uniforms.uPanic.value = this.panic;

    const host = views[core.host];
    const e = core.emerge;
    const ease = e * e * (3 - 2 * e);
    const s = (0.5 + host.r * 0.15) * (0.15 + 0.85 * ease);
    this.group.visible = e > 0.01;
    this.group.scale.setScalar(s);
    // 沉入 / 钻出宿主
    this.group.position.set(host.top.x, host.top.y + s * (1.0 - 1.9 * (1 - ease)), host.top.z);
    this.group.rotation.y = 0.6 + Math.sin(time * 0.3) * 0.15;
    this.group.rotation.z = 0.2 + Math.sin(time * 0.7) * 0.04 + this.panic * Math.sin(time * 23) * 0.03;
    this.uniforms.uFade.value = core.phase === 'withering' ? ease : 1;

    // 光源跟着“核心此刻所在的位置”走：宿主头顶，或迁移途中的鼓包
    let strength = ease;
    this.lightPos.copy(this.group.position);
    this.lightPos.y += s * 0.5;
    const x = core.transfer;
    if (core.phase === 'transit' && x && !x.dead) {
      const seg = x.route[x.hop];
      const sinew = sinews[seg.link.index];
      const t = seg.from === seg.link.a ? x.pos : 1 - x.pos;
      sinew.pointAt(t, _p);
      this.lightPos.set(_p.x, _p.y + 0.55, _p.z);
      strength = 0.8 * x.amp;
    }
    this.light.position.copy(this.lightPos);
    this.light.intensity = strength * (4 + 22 * beat);
  }
}
