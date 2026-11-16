// 节点：一团多结节、湿滑的肉瘤。形状完全由顶点着色器里的噪声决定，
// 呼吸（智能体运行中）、吞咽（数据到达）、萎缩（掉线）、被脉冲扫过时的光环都在这里表现。

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE, BUMP, patchMaterial } from './glsl.js';
import { PALETTE } from '../config.js';
import { makeCilia } from './Tentacles.js';

let blobGeo = null;
function blobGeometry(detail) {
  if (!blobGeo) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('uv');
    blobGeo = mergeVertices(g, 1e-4);
  }
  return blobGeo;
}

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uBreath;
uniform float uVital;
uniform float uGulp;
uniform float uServer;
varying vec3 vDir;
varying float vNod;
${NOISE}
vec3 yNodeP(vec3 n, out float nod) {
  float lob = yFbm(n * 1.5 + uSeed + vec3(0.0, uTime * 0.045, 0.0)) - 0.45;
  float w = yWorley(n * mix(2.7, 3.5, uServer) + uSeed * 1.37 + vec3(0.0, uTime * 0.02, 0.0));
  float bumps = smoothstep(0.62, 0.06, w);   // 结节 / 脓疱
  float pits = smoothstep(0.34, 0.03, w);    // 公网中继：孔穴
  float h = lob * 0.52;
  h += mix(bumps * (0.25 + 0.06 * uBreath), 0.07 - pits * 0.24, uServer);
  h += uBreath * 0.085 + uGulp * 0.11;
  float wr = yNoise(n * 9.0 + uSeed) - 0.5;
  h += (1.0 - uVital) * (wr * 0.24 - 0.22);  // 掉线：干瘪起皱
  nod = mix(bumps, 1.0 - pits, uServer);
  vec3 p = n * (1.0 + h);
  float skirt = smoothstep(0.05, -0.75, n.y); // 底部向外摊开，融进菌毯
  p.xz *= 1.0 + skirt * 0.55;
  return p;
}
`;

const VERT_NORMAL = /* glsl */ `
vec3 yN0 = normalize(position);
float yNod0;
float yNodT;
vec3 yP0 = yNodeP(yN0, yNod0);
vec3 yAx = abs(yN0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
vec3 yT1 = normalize(cross(yAx, yN0));
vec3 yT2 = cross(yN0, yT1);
vec3 yP1 = yNodeP(normalize(yN0 + yT1 * 0.025), yNodT);
vec3 yP2 = yNodeP(normalize(yN0 + yT2 * 0.025), yNodT);
vec3 objectNormal = normalize(cross(yP1 - yP0, yP2 - yP0));
vDir = yN0;
vNod = yNod0;
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uBreath;
uniform float uVital;
uniform float uGulp;
uniform float uServer;
uniform float uAgent;
uniform float uCore;
uniform float uBeat;
uniform float uElect;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColTip;
uniform vec3 uColGlow;
uniform vec3 uColData;
uniform vec3 uFlashDir[2];
uniform float uFlashT[2];
uniform vec3 uFlashCol[2];
varying vec3 vDir;
varying float vNod;
${NOISE}
${BUMP}
`;

const FRAG_COLOR = /* glsl */ `
float yM = yFbm(vDir * 2.3 + uSeed * 2.0);
float yVein = yVeins(vDir * 3.3 + uSeed * 3.1 + vec3(0.0, uTime * 0.015, 0.0), 8.0);
float yFine = yNoise(vDir * 24.0 + uSeed);
float yMid = yNoise(vDir * 10.0 + uSeed * 0.7);
vec3 yBase = mix(uColA, uColB, smoothstep(0.3, 0.7, yM));
yBase = mix(yBase, uColTip, pow(vNod, 2.4) * mix(0.8, 0.55, uServer));
yBase *= 0.7 + 0.6 * yFine;
yBase *= 1.0 - 0.5 * yVein;
float yGrey = dot(yBase, vec3(0.3333));
yBase = mix(vec3(yGrey) * 0.8 + vec3(0.012, 0.011, 0.009), yBase, uVital);
diffuseColor.rgb = yBase;
`;

const FRAG_ROUGH = /* glsl */ `
roughnessFactor = mix(0.26, 0.6, yM) - vNod * 0.12 * (1.0 - uServer);
roughnessFactor = mix(0.9, roughnessFactor, uVital);
`;

const FRAG_NORMAL = /* glsl */ `
normal = yBump(normal, -vViewPosition, yFine * 0.35 + yMid * 0.9 - yVein * 0.7, 0.05);
`;

const FRAG_EMISSIVE = /* glsl */ `
{
  vec3 yE = vec3(0.0);
  vec3 yD = normalize(vDir);
  float yIn = 0.5 + 0.5 * uBreath;
  float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
  // 智能体运行：血管随呼吸发出青色荧光
  yE += uColGlow * uAgent * mix(1.0, 0.55, uServer) * (yVein * (0.03 + 0.2 * yIn) + yRim * 0.02 * yIn);
  // 控制核心寄宿：血管随心跳泛红
  float yNear = smoothstep(-0.2, 0.9, yD.y); // 越靠近头顶的心脏越红
  yE += vec3(1.0, 0.05, 0.03) * uCore * yNear * (yVein * (0.1 + 0.6 * uBeat) + yRim * 0.03 * uBeat);
  // 选举中：红色抽搐
  float yFl = step(0.45, yHash12(vec2(floor(uTime * 13.0), uSeed)));
  yE += vec3(1.0, 0.09, 0.04) * uElect * yVein * (0.12 + 0.45 * yFl);
  // 探测脉冲从接入的一侧扫过整个节点
  for (int i = 0; i < 2; i++) {
    float tt = uFlashT[i];
    float d = acos(clamp(dot(yD, uFlashDir[i]), -1.0, 1.0)) / PI;
    float band = exp(-pow((d - tt) / 0.13, 2.0)) * step(0.0, tt) * (1.0 - smoothstep(0.85, 1.25, tt));
    yE += uFlashCol[i] * band * (0.03 + 0.7 * yVein + 0.05 * vNod);
  }
  yE += uColData * uGulp * (0.03 + 0.25 * yVein);
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
    const hy = server ? 1.3 : 0.9;
    this.r = r;
    this.height = r * hy;
    this.centerY = r * hy * 0.42;
    this.base = new THREE.Vector3(node.pos[0], 0, node.pos[1]);
    this.pos = this.base.clone();
    this.group = new THREE.Group();
    this.group.position.copy(this.pos);

    // 每个节点一点点色相偏移，避免完全一样
    const mixv = (Math.sin(node.seed * 12.9898) * 0.5 + 0.5) * 0.6;
    const colA = server ? new THREE.Color(0.032, 0.03, 0.036) : new THREE.Color(0.018, 0.04, 0.034).lerp(new THREE.Color(0.03, 0.034, 0.02), mixv);
    const colB = server ? new THREE.Color(0.012, 0.012, 0.018) : new THREE.Color(0.042, 0.02, 0.058).lerp(new THREE.Color(0.02, 0.022, 0.05), mixv);
    const colTip = server ? new THREE.Color(0.12, 0.11, 0.105) : new THREE.Color(0.17, 0.2, 0.09).lerp(new THREE.Color(0.2, 0.15, 0.12), mixv);

    const u = (this.uniforms = {
      uTime: shared.uTime,
      uBeat: shared.uBeat,
      uSeed: { value: node.seed },
      uBreath: { value: 0 },
      uVital: { value: 1 },
      uGulp: { value: 0 },
      uServer: { value: server ? 1 : 0 },
      uAgent: { value: 0 },
      uCore: { value: 0 },
      uElect: { value: 0 },
      uColA: { value: colA },
      uColB: { value: colB },
      uColTip: { value: colTip },
      uColGlow: { value: new THREE.Color(...PALETTE.probe) },
      uColData: { value: new THREE.Color(...PALETTE.data) },
      uFlashDir: { value: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)] },
      uFlashT: { value: [-1, -1] },
      uFlashCol: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    });

    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({
        roughness: 0.4,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.16,
        iridescence: q.low ? 0 : 0.3,
        iridescenceIOR: 1.33,
        iridescenceThicknessMinimum: 140,
        iridescenceThicknessMaximum: 460,
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

    this.ciliaUniforms = {
      uTime: shared.uTime,
      uVital: u.uVital,
      uBreath: u.uBreath,
      uAgent: u.uAgent,
      uColA: { value: colA.clone().multiplyScalar(0.8) },
      uColB: { value: colTip.clone().multiplyScalar(0.22) },
      uColGlow: u.uColGlow,
    };
    this.cilia = makeCilia(server ? q.cilia + 3 : q.cilia, r, server, this.ciliaUniforms);
    this.group.add(this.cilia);

    this.anchor = new THREE.Vector3(); // 管道接入高度的参考点
    this.top = new THREE.Vector3(); // 心脏 / 标签的位置
    this._refresh();
  }

  _refresh() {
    this.anchor.set(this.pos.x, this.centerY * 1.05, this.pos.z);
    const breath = this.uniforms.uBreath.value;
    const shrink = 1 - 0.22 * (1 - this.uniforms.uVital.value);
    this.top.set(this.pos.x, this.centerY + this.height * (0.92 + 0.07 * breath) * shrink, this.pos.z);
  }

  update(dt, time, core) {
    const n = this.node;
    const u = this.uniforms;
    // 缓慢漂移：整张网一直在微微蠕动
    this.pos.x = this.base.x + Math.sin(time * 0.19 + n.seed) * 0.14;
    this.pos.z = this.base.z + Math.cos(time * 0.16 + n.seed * 1.7) * 0.14;
    this.group.position.copy(this.pos);

    u.uBreath.value = n.agent.breath;
    u.uVital.value = n.vital;
    u.uGulp.value = n.gulp;
    u.uAgent.value = n.agent.level;
    u.uElect.value = n.elect;
    const hosting = core.host === n.index ? core.emerge : 0;
    u.uCore.value = damp(u.uCore.value, hosting, 2.5, dt);
    this.material.clearcoat = 0.2 + 0.8 * n.vital;

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
