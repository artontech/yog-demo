// GFW 拦截：一枚卡在管道断口上的橙色晶格。
// 故意做成冰冷的几何体，和周围的血肉形成反差 —— 它不属于这个生物。

import * as THREE from 'three';
import { PALETTE } from '../config.js';

function crystalGeometry(radius) {
  const g = new THREE.IcosahedronGeometry(radius, 0); // 细分为 0 时本来就是非索引的
  const n = g.attributes.position.count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    bary.set([1, 0, 0, 0, 1, 0, 0, 0, 1], i * 3);
  }
  g.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
  return g;
}

const VERT = /* glsl */ `
attribute vec3 aBary;
varying vec3 vBary;
varying vec3 vN;
varying vec3 vV;
void main() {
  vBary = aBary;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uHit;
uniform float uTime;
varying vec3 vBary;
varying vec3 vN;
varying vec3 vV;
void main() {
  float e = min(vBary.x, min(vBary.y, vBary.z));
  float edge = 1.0 - smoothstep(0.0, 0.055, e);
  float inner = 1.0 - smoothstep(0.0, 0.3, e);
  float fb = max(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0);
  float fres = fb * fb;
  float flick = 0.8 + 0.2 * sin(uTime * 17.0) * sin(uTime * 5.3);
  float a = (edge * 1.5 + inner * 0.16 + fres * 0.3) * flick;
  vec3 col = uColor * a * (0.6 + 1.1 * uHit) + vec3(1.0, 0.85, 0.6) * edge * uHit * 0.3;
  gl_FragColor = vec4(col * uAlpha, 1.0);
}
`;

const _p = new THREE.Vector3();

export class Barrier {
  constructor(shared) {
    this.group = new THREE.Group();
    this.uniforms = {
      uColor: { value: new THREE.Color(...PALETTE.gfw) },
      uAlpha: { value: 0 },
      uHit: { value: 0 },
      uTime: shared.uTime,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.outer = new THREE.Mesh(crystalGeometry(1), mat);
    this.inner = new THREE.Mesh(crystalGeometry(0.55), mat);
    this.group.add(this.outer, this.inner);
    this.group.visible = false;
    this.pos = this.group.position;
  }

  update(dt, time, link, sinew) {
    const a = link.barrier;
    this.group.visible = a > 0.01;
    if (!this.group.visible) return;
    sinew.pointAt(link.cut, _p);
    this.group.position.set(_p.x, Math.max(_p.y, 0.5) + 0.12, _p.z);
    const s = (0.5 + sinew.radius * 1.2) * (0.3 + 0.7 * a) * (1 + 0.25 * link.barrierHit);
    this.group.scale.setScalar(s);
    this.outer.rotation.set(time * 0.31, time * 0.47, 0);
    this.inner.rotation.set(-time * 0.7, 0.4, time * 0.53);
    this.uniforms.uAlpha.value = a;
    this.uniforms.uHit.value = link.barrierHit;
  }
}
