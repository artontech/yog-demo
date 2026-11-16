// 控制核心：一颗光滑的暗红色心形胶质，嵌在当选节点的头顶，随心跳收缩发光。
// 选举后它会沉入宿主，化作一个红色鼓包沿连接游到新宿主，再重新冒出来。

import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE, patchMaterial } from './glsl.js';

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uPanic;
varying vec3 vDir;
${NOISE}
vec3 yHeartP(vec3 n) {
  float y = n.y;
  vec3 p = n;
  p.xz *= mix(0.3, 1.0, smoothstep(-1.0, 0.3, y));          // 向下收成一个尖
  p.y *= 1.12;
  p.x *= 1.0 + 0.22 * smoothstep(-0.1, 0.8, y);             // 上半部分加宽
  p.z *= 0.8;
  float cleft = exp(-pow(n.x * 3.0, 2.0)) * smoothstep(0.3, 1.0, y);
  p.y -= cleft * 0.34;                                      // 顶部中间凹下去，分出两个圆瓣
  float disp = (yNoise(n * 1.7 + vec3(0.0, uTime * 0.25, 0.0)) - 0.5) * 0.07;
  disp -= uBeat * 0.11;                                     // 心跳：整体一缩
  disp += uPanic * 0.025 * sin(uTime * 37.0 + y * 9.0);
  return p * (1.0 + disp);
}
`;

const VERT_NORMAL = /* glsl */ `
vec3 yN0 = normalize(position);
vec3 yPos = yHeartP(yN0);
vec3 yAx = abs(yN0.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
vec3 yT1 = normalize(cross(yAx, yN0));
vec3 yT2 = cross(yN0, yT1);
vec3 objectNormal = normalize(cross(yHeartP(normalize(yN0 + yT1 * 0.03)) - yPos, yHeartP(normalize(yN0 + yT2 * 0.03)) - yPos));
vDir = yN0;
`;

const pulse = (phi, c, w) => Math.exp(-(((phi - c) / w) ** 2));
const damp = (v, t, k, dt) => v + (t - v) * (1 - Math.exp(-k * dt));
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);
const _yaw = new THREE.Quaternion();
const _wob = new THREE.Quaternion();

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
      uPanic: { value: 0 },
      uFade: { value: 1 },
    };
    this.material = patchMaterial(
      new THREE.MeshPhysicalMaterial({ roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1 }),
      {
        key: 'yog-heart',
        uniforms: this.uniforms,
        vertexPars: VERT_PARS,
        vertexNormal: VERT_NORMAL,
        vertexPosition: 'vec3 transformed = yPos;',
        fragmentPars: /* glsl */ `
          uniform float uBeat;
          uniform float uFade;
          varying vec3 vDir;
        `,
        fragmentColor: /* glsl */ `
          vec3 yCol = mix(vec3(0.13, 0.008, 0.014), vec3(0.05, 0.003, 0.01), smoothstep(-0.6, 0.9, vDir.y));
          diffuseColor.rgb = mix(vec3(0.03, 0.024, 0.024), yCol, uFade);
        `,
        fragmentRoughness: 'roughnessFactor = 0.2;',
        fragmentEmissive: /* glsl */ `
          {
            float yRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.2);
            // 里面像有一团红光，心跳时透出来
            vec3 yE = vec3(1.0, 0.04, 0.03) * (0.07 + 0.2 * uBeat) * (0.35 + 0.65 * (1.0 - yRim));
            yE += vec3(1.0, 0.1, 0.07) * yRim * (0.04 + 0.16 * uBeat);
            totalEmissiveRadiance += yE * uFade;
          }
        `,
      },
    );
    const geo = mergeVertices(new THREE.IcosahedronGeometry(1, q.low ? 10 : 18).deleteAttribute('uv'), 1e-4);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    // 心跳的红光会照亮宿主和周围的地面
    this.light = new THREE.PointLight(0xff2010, 0, 16, 1.8);
    this.lightPos = new THREE.Vector3();
  }

  /**
   * @param core   sim.core
   * @param views  NodeView[]
   * @param sinews Sinew[]（按 link.index 排列）
   * @param camera 用来让心形的正面始终大致朝向观众
   */
  update(dt, time, core, views, sinews, camera) {
    const electing = core.phase === 'election';
    const moving = core.phase !== 'steady';
    this.panic = damp(this.panic, electing ? 1 : 0, 4, dt);
    this.rate = damp(this.rate, electing ? 2.5 : moving ? 1.6 : 0.88, 3, dt);
    this.phase = (this.phase + dt * this.rate) % 1;
    const lub = pulse(this.phase, 0.12, 0.05);
    const dub = pulse(this.phase, 0.38, 0.06) * 0.65;
    const beat = Math.min(1, lub + dub);
    this.shared.uBeat.value = beat;
    this.uniforms.uPanic.value = this.panic;

    const host = views[core.host];
    const e = core.emerge;
    const ease = e * e * (3 - 2 * e);
    const s = (0.5 + host.r * 0.18) * (0.15 + 0.85 * ease);
    this.group.visible = e > 0.01;
    this.group.scale.setScalar(s);
    // 沉入 / 冒出宿主；平时心尖埋在宿主头顶里
    this.group.position.set(host.top.x, host.top.y + s * (0.62 - 1.6 * (1 - ease)), host.top.z);
    // 正面始终大致朝向镜头（俯视时会跟着后仰），这样从任何角度看都是一颗心
    _yaw.setFromAxisAngle(_up, Math.atan2(camera.position.x - this.group.position.x, camera.position.z - this.group.position.z));
    this.group.quaternion.slerpQuaternions(_yaw, camera.quaternion, 0.82);
    _wob.setFromAxisAngle(_fwd, Math.sin(time * 0.9) * 0.07 + this.panic * Math.sin(time * 23) * 0.06);
    this.group.quaternion.multiply(_wob);
    this.uniforms.uFade.value = core.phase === 'withering' ? ease : 1;

    // 光源跟着“核心此刻所在的位置”走：宿主头顶，或迁移途中的鼓包
    let strength = ease;
    this.lightPos.copy(this.group.position);
    this.lightPos.y += s * 1.3;
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
    this.light.intensity = strength * (2.5 + 11 * beat);
  }
}
