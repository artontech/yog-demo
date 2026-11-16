// 会蠕动的锥形触手：节点根部的短触须，以及远处雾里的巨型触手共用同一套形变。
// 触手完全在顶点着色器里弯曲，CPU 端只提供每根实例的参数。

import * as THREE from 'three';
import { patchMaterial } from './glsl.js';

const geoCache = new Map();

function tentacleGeometry(seg, rad) {
  const key = `${seg}:${rad}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const pos = [];
  const idx = [];
  for (let i = 0; i <= seg; i++) {
    const s = i / seg;
    for (let j = 0; j <= rad; j++) {
      const a = (j / rad) * Math.PI * 2;
      pos.push(Math.cos(a), s, Math.sin(a));
    }
  }
  const row = rad + 1;
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < rad; j++) {
      const p = i * row + j;
      idx.push(p, p + 1, p + row, p + 1, p + row + 1, p + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  geoCache.set(key, g);
  return g;
}

const VERT_PARS = /* glsl */ `
attribute vec4 aT0; // 根部方位角, 长度, 相位, 根部半径
attribute vec4 aT1; // 根部离中心距离, 抬升, 卷曲, 速度
uniform float uTime;
uniform float uVital;
uniform float uBreath;
varying float vS;
varying float vPh;
vec3 yTentC(float s) {
  float a = aT0.x;
  float L = aT0.y * (1.0 + 0.07 * uBreath);
  float ph = aT0.z;
  vec3 o = vec3(cos(a), 0.0, sin(a));
  vec3 sd = vec3(-sin(a), 0.0, cos(a));
  float t = uTime * aT1.w;
  float life = 0.2 + 0.8 * uVital;
  float wav = (sin(s * 5.0 - t * 1.3 + ph) * 0.22 + sin(s * 2.3 + t * 0.7 + ph * 1.7) * 0.3) * life;
  float th = 0.5 * aT1.z * s * s * (0.62 + 0.38 * sin(t * 0.6 + ph)) * life;
  return o * (aT1.x + L * s * cos(th)) + vec3(0.0, aT1.y + L * s * sin(th), 0.0) + sd * (wav * L * s * 0.35);
}
`;

const VERT_NORMAL = /* glsl */ `
float yS = position.y;
vec3 yC = yTentC(yS);
vec3 yTn = normalize(yTentC(yS + 0.02) - yTentC(yS - 0.02));
vec3 ySd = vec3(-sin(aT0.x), 0.0, cos(aT0.x));
vec3 yBn = normalize(cross(yTn, ySd));
vec3 yNn = cross(yBn, yTn);
float yR = aT0.w * (pow(max(1.0 - yS, 0.0), 0.7) * (1.0 + 0.1 * sin(yS * 24.0 + aT0.z)) + 0.035);
vec3 yRing = yNn * position.x + yBn * position.z;
vec3 objectNormal = yRing;
vS = yS;
vPh = aT0.z;
`;

const FRAG_PARS = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColGlow;
uniform float uAgent;
uniform float uBreath;
uniform float uVital;
varying float vS;
varying float vPh;
`;

export function tentacleMaterial(base, uniforms, key) {
  return patchMaterial(base, {
    key,
    uniforms,
    vertexPars: VERT_PARS,
    vertexNormal: VERT_NORMAL,
    vertexPosition: 'vec3 transformed = yC + yRing * yR;',
    fragmentPars: FRAG_PARS,
    fragmentColor: /* glsl */ `
      float yBand = 0.5 + 0.5 * sin(vS * 24.0 + vPh);
      diffuseColor.rgb = mix(uColA, uColB, smoothstep(0.15, 1.0, vS)) * (0.7 + 0.5 * yBand);
    `,
    fragmentRoughness: 'roughnessFactor = mix(0.42, 0.24, yBand);',
    fragmentEmissive: /* glsl */ `
      totalEmissiveRadiance += uColGlow * uAgent * uVital * smoothstep(0.8, 1.0, vS) * (0.02 + 0.1 * (0.5 + 0.5 * uBreath));
    `,
  });
}

/** 节点根部的一圈触须（位于节点局部坐标系内） */
export function makeCilia(count, radius, server, uniforms) {
  const geo = tentacleGeometry(18, 6).clone();
  const mat = tentacleMaterial(
    new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 }),
    uniforms,
    'yog-cilia',
  );
  const t0 = new Float32Array(count * 4);
  const t1 = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = ((i + Math.random() * 0.7) / count) * Math.PI * 2;
    const len = radius * (server ? 0.9 + Math.random() * 0.6 : 1.0 + Math.random() * 1.0);
    t0.set([a, len, Math.random() * 6.28, radius * (0.1 + Math.random() * 0.07)], i * 4);
    t1.set([radius * 0.8, 0.06, 1.2 + Math.random() * 3.2, 0.6 + Math.random() * 0.7], i * 4);
  }
  geo.setAttribute('aT0', new THREE.InstancedBufferAttribute(t0, 4));
  geo.setAttribute('aT1', new THREE.InstancedBufferAttribute(t1, 4));
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  return mesh;
}

/** 远处雾中的巨型触手：只为压迫感，不承载任何数据 */
export function makeGiants(count, shared) {
  const geo = tentacleGeometry(40, 9).clone();
  const uniforms = {
    uTime: shared.uTime,
    uVital: { value: 1 },
    uBreath: { value: 0 },
    uAgent: { value: 0 },
    uColA: { value: new THREE.Color(0.006, 0.01, 0.01) },
    uColB: { value: new THREE.Color(0.012, 0.016, 0.02) },
    uColGlow: { value: new THREE.Color(0, 0, 0) },
  };
  const mat = tentacleMaterial(new THREE.MeshStandardMaterial({ roughness: 0.4, envMapIntensity: 0.6 }), uniforms, 'yog-giant');
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const t0 = new Float32Array(count * 4);
  const t1 = new Float32Array(count * 4);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const yaw = new THREE.Quaternion();
  for (let i = 0; i < count; i++) {
    const ang = ((i + 0.2 + Math.random() * 0.6) / count) * Math.PI * 2;
    const dist = 30 + Math.random() * 16;
    const len = 20 + Math.random() * 16;
    t0.set([0, len, Math.random() * 6.28, 1.3 + Math.random() * 1.3], i * 4);
    t1.set([0, 0, 0.9 + Math.random() * 1.6, 0.16 + Math.random() * 0.14], i * 4);
    // 局部 +x 立起来朝上；卷曲方向（局部 +y → 世界 -x）转向场景中心，让触手向内俯身
    yaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang + (Math.random() - 0.5) * 0.9);
    q.copy(yaw).multiply(up);
    m.compose(new THREE.Vector3(Math.cos(ang) * dist, -1, Math.sin(ang) * dist), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
  }
  geo.setAttribute('aT0', new THREE.InstancedBufferAttribute(t0, 4));
  geo.setAttribute('aT1', new THREE.InstancedBufferAttribute(t1, 4));
  mesh.frustumCulled = false;
  return mesh;
}
