// 节点：一团黑亮、光滑的共生体胶质球。
// 形状只有缓慢流动的低频起伏；呼吸（智能体运行中）、吞咽（数据到达）、塌陷（掉线）、
// 果冻式的晃动（受力后顶部摇摆、底部粘在地上）和被脉冲扫过时的光环都在这里表现。

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE, BUMP, patchMaterial } from './glsl.js';
import { PALETTE } from '../config.js';

let blobGeo = null;
function blobGeometry(detail) {
  if (!blobGeo) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('uv');
    blobGeo = mergeVertices(g, 1e-4);
  }
  return blobGeo;
}

// 球心离地高度占自身高度的比例：球有三分之一多陷在地面的胶质里
const SINK = 0.62;

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uBreath;
uniform float uVital;
uniform float uGulp;
uniform float uServer;
uniform vec2 uLean;
varying vec3 vDir;
varying float vGroove;
${NOISE}
vec3 yNodeP(vec3 n, out float groove) {
  // 两层缓慢流动的起伏，像一团还没定型的液体
  float w1 = yNoise(n * 1.25 + uSeed + vec3(0.0, uTime * 0.11, uTime * 0.05)) - 0.5;
  float w2 = yNoise(n * 2.5 + uSeed * 1.7 - vec3(uTime * 0.08, 0.0, uTime * 0.06)) - 0.5;
  float h = w1 * 0.17 + w2 * 0.06;
  h += uBreath * 0.09 + uGulp * 0.1;
  // 公网中继：几道水平的浅槽，槽里有微光
  groove = uServer * exp(-pow(sin(n.y * 5.6 + 0.5) / 0.17, 2.0)) * smoothstep(-0.5, -0.15, n.y);
  h -= groove * 0.05;
  vec3 p = n * (1.0 + h);
  p.xz *= 1.0 - uServer * 0.2 * smoothstep(-0.2, 1.0, n.y);
  // 掉线：塌成一滩
  float dead = 1.0 - uVital;
  p.y *= 1.0 - 0.52 * dead;
  p.xz *= 1.0 + 0.1 * dead;
  // 底部向外摊开，和地面的胶质连成一体
  p.xz *= 1.0 + smoothstep(-0.05, -0.85, n.y) * 0.5;
  // 果冻晃动：越高摆得越多，贴地处不动
  float up = n.y < 0.0 ? max((n.y + ${SINK}) / ${SINK}, 0.0) : 1.0 + 0.8 * n.y;
  p.xz += uLean * up;
  return p;
}
`;

const VERT_NORMAL = /* glsl */ `
vec3 yN0 = normalize(position);
float yGr0;
float yGrT;
vec3 yP0 = yNodeP(yN0, yGr0);
vec3 yAx = abs(yN0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
vec3 yT1 = normalize(cross(yAx, yN0));
vec3 yT2 = cross(yN0, yT1);
vec3 yP1 = yNodeP(normalize(yN0 + yT1 * 0.03), yGrT);
vec3 yP2 = yNodeP(normalize(yN0 + yT2 * 0.03), yGrT);
vec3 objectNormal = normalize(cross(yP1 - yP0, yP2 - yP0));
vDir = yN0;
vGroove = yGr0;
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uBreath;
uniform float uVital;
uniform float uGulp;
uniform float uAgent;
uniform float uCore;
uniform float uBeat;
uniform float uElect;
uniform vec3 uColBody;
uniform vec3 uColGlow;
uniform vec3 uColRelay;
uniform vec3 uColData;
uniform vec3 uFlashDir[2];
uniform float uFlashT[2];
uniform vec3 uFlashCol[2];
varying vec3 vDir;
varying float vGroove;
${NOISE}
${BUMP}
`;

const FRAG_COLOR = /* glsl */ `
float yFlow = yNoise(vDir * 3.2 + uSeed + vec3(0.0, uTime * 0.1, 0.0));
vec3 yBase = uColBody * (0.75 + 0.5 * yFlow);
diffuseColor.rgb = mix(vec3(0.045, 0.045, 0.048), yBase, uVital);
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(0.85, 0.14 + 0.08 * yFlow, uVital);
`;

const FRAG_NORMAL = /* glsl */ `
// 很浅的流动波纹，让高光像在液面上滑
normal = yBump(normal, -vViewPosition, yFlow, 0.012);
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  vec3 yE = vec3(0.0);
  vec3 yD = normalize(vDir);
  float yIn = 0.5 + 0.5 * uBreath;
  float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.6);
  // 一点冷色轮廓光，保证黑球在黑背景上有形
  yE += vec3(0.55, 0.7, 1.0) * yRim * 0.02;
  // 智能体运行：轮廓随呼吸泛青
  yE += uColGlow * uAgent * yRim * (0.03 + 0.2 * yIn);
  // 公网中继的槽光
  yE += uColRelay * vGroove * (0.1 + 0.08 * yIn);
  // 控制核心寄宿：越靠近头顶越红，随心跳起伏
  float yNear = smoothstep(-0.3, 1.0, yD.y);
  yE += vec3(1.0, 0.05, 0.03) * uCore * (yRim * (0.06 + 0.3 * uBeat) + yNear * yNear * 0.03 * (0.4 + uBeat));
  // 选举中：红色闪烁
  float yFl = step(0.45, yHash12(vec2(floor(uTime * 13.0), uSeed)));
  yE += vec3(1.0, 0.09, 0.04) * uElect * yRim * (0.1 + 0.4 * yFl);
  // 探测脉冲：一圈光从接入的一侧扫过整个球
  for (int i = 0; i < 2; i++) {
    float tt = uFlashT[i];
    float d = acos(clamp(dot(yD, uFlashDir[i]), -1.0, 1.0)) / PI;
    float band = exp(-pow((d - tt) / 0.1, 2.0)) * step(0.0, tt) * (1.0 - smoothstep(0.85, 1.25, tt));
    yE += uFlashCol[i] * band * (0.09 + 0.7 * yRim);
  }
  yE += uColData * uGulp * yRim * 0.3;
  totalEmissiveRadiance += yE * uVital;
}
`;

const HUES = [new THREE.Vector3(...PALETTE.probe), new THREE.Vector3(...PALETTE.vote), new THREE.Vector3(...PALETTE.warn)];
const damp = (v, t, k, dt) => v + (t - v) * (1 - Math.exp(-k * dt));

export class NodeView {
  constructor(node, q, shared) {
    this.node = node;
    const server = node.kind === 'server';
    const r = node.radius;
    const hy = server ? 1.25 : 0.95;
    this.r = r;
    this.height = r * hy;
    this.centerY = r * hy * SINK;
    this.base = new THREE.Vector3(node.pos[0], 0, node.pos[1]);
    this.pos = this.base.clone(); // 底部（贴地）位置
    this.body = this.base.clone(); // 球心水平位置 = 底部 + 晃动
    this.group = new THREE.Group();
    this.group.position.copy(this.pos);

    // 果冻晃动的状态：球心相对底部的水平偏移及其速度
    this.lean = new THREE.Vector2();
    this.leanVel = new THREE.Vector2();

    const u = (this.uniforms = {
      uTime: shared.uTime,
      uBeat: shared.uBeat,
      uSeed: { value: node.seed },
      uBreath: { value: 0 },
      uVital: { value: 1 },
      uGulp: { value: 0 },
      uServer: { value: server ? 1 : 0 },
      uLean: { value: new THREE.Vector2() },
      uAgent: { value: 0 },
      uCore: { value: 0 },
      uElect: { value: 0 },
      uColBody: { value: new THREE.Color(0.011, 0.012, 0.016) },
      uColGlow: { value: new THREE.Color(...PALETTE.probe) },
      uColRelay: { value: new THREE.Color(...PALETTE.relay) },
      uColData: { value: new THREE.Color(...PALETTE.data) },
      uFlashDir: { value: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)] },
      uFlashT: { value: [-1, -1] },
      uFlashCol: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    });

    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({
        roughness: 0.16,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.12,
        iridescence: q.low ? 0 : 0.18,
        iridescenceIOR: 1.3,
        iridescenceThicknessMinimum: 180,
        iridescenceThicknessMaximum: 420,
      }),
      {
        key: 'yog-node',
        uniforms: u,
        vertexPars: VERT_PARS,
        vertexNormal: VERT_NORMAL,
        vertexPosition: 'vec3 transformed = yP0;',
        fragmentPars: FRAG_PARS,
        fragmentColor: FRAG_COLOR,
        fragmentRoughness: FRAG_ROUGH,
        fragmentNormal: FRAG_NORMAL,
        fragmentEmissive: FRAG_EMISSIVE,
      },
    );

    this.mesh = new THREE.Mesh(blobGeometry(q.blobDetail), this.material);
    this.mesh.scale.set(r, r * hy, r);
    this.mesh.position.y = this.centerY;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.anchor = new THREE.Vector3(); // 连接接入点的参考高度（球心）
    this.top = new THREE.Vector3(); // 核心 / 标签的位置
    this._refresh();
  }

  /** 给球一个水平方向的速度冲量（数据到达、连接扯断……） */
  kick(dx, dz, power) {
    this.leanVel.x += dx * power;
    this.leanVel.y += dz * power;
  }

  _refresh() {
    this.body.set(this.pos.x + this.lean.x, 0, this.pos.z + this.lean.y);
    this.anchor.set(this.body.x, this.centerY, this.body.z);
    const breath = this.uniforms.uBreath.value;
    const vital = this.uniforms.uVital.value;
    const topLean = 1.8;
    this.top.set(
      this.pos.x + this.lean.x * topLean,
      this.centerY + this.height * (1.0 + 0.09 * breath) * (1 - 0.52 * (1 - vital)),
      this.pos.z + this.lean.y * topLean,
    );
  }

  /** 晃动的弹簧积分；pullX / pullZ 是相邻节点通过连接传过来的拉力 */
  integrate(dt, pullX, pullZ) {
    const k = 38;
    const c = 3.2;
    const L = this.lean;
    const V = this.leanVel;
    V.x += (-k * L.x - c * V.x + pullX) * dt;
    V.y += (-k * L.y - c * V.y + pullZ) * dt;
    L.x += V.x * dt;
    L.y += V.y * dt;
    const m = L.length();
    if (m > 0.6) L.multiplyScalar(0.6 / m);
  }

  update(dt, time, core) {
    const n = this.node;
    const u = this.uniforms;
    // 缓慢漂移：整张网一直在微微游动
    this.pos.x = this.base.x + Math.sin(time * 0.19 + n.seed) * 0.12;
    this.pos.z = this.base.z + Math.cos(time * 0.16 + n.seed * 1.7) * 0.12;
    this.group.position.copy(this.pos);

    u.uBreath.value = n.agent.breath;
    u.uVital.value = n.vital;
    u.uGulp.value = n.gulp;
    u.uAgent.value = n.agent.level;
    u.uElect.value = n.elect;
    u.uLean.value.set(this.lean.x / this.r, this.lean.y / this.r);
    const hosting = core.host === n.index ? core.emerge : 0;
    u.uCore.value = damp(u.uCore.value, hosting, 2.5, dt);
    this.material.clearcoat = 0.15 + 0.85 * n.vital;

    for (let i = 0; i < 2; i++) {
      const f = n.flashes[n.flashes.length - 1 - i];
      if (f) {
        if (f.radial) u.uFlashDir.value[i].set(0, 1, 0);
        else u.uFlashDir.value[i].set(f.dx, 0.12, f.dz).normalize();
        u.uFlashT.value[i] = f.t;
        u.uFlashCol.value[i].copy(HUES[f.hue] || HUES[0]);
      } else {
        u.uFlashT.value[i] = -1;
      }
    }
    this._refresh();
  }
}
