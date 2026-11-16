// 氛围：深渊天穹、漂浮的孢子。

import * as THREE from 'three';
import { NOISE } from './glsl.js';
import { PALETTE } from '../config.js';

export function makeSky(shared) {
  const fog = new THREE.Color(PALETTE.fog);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uFog: { value: fog } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99995, p.w); // 贴着远裁剪面，但不恰好压在上面
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uFog;
      varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // 地平线上一圈微弱的瘴气，往上沉入纯黑
        vec3 col = mix(uFog, vec3(0.003, 0.004, 0.006), smoothstep(-0.02, 0.5, h));
        float haze = exp(-pow(max(h, 0.0) * 5.5, 1.3)) * smoothstep(0.0, 0.07, h);
        float n = yFbm(d * 2.6 + vec3(0.0, uTime * 0.012, uTime * 0.008));
        float n2 = yFbm(d * 5.0 - vec3(uTime * 0.01, 0.0, 0.0));
        col += vec3(0.012, 0.034, 0.032) * haze * (0.4 + 1.2 * n);
        float wisp = n * n2 * 1.9;
        col += vec3(0.03, 0.012, 0.045) * wisp * wisp * smoothstep(0.02, 0.5, h);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  mesh.scale.setScalar(200);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

export function makeSpores(count, shared) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = 3 + Math.sqrt(Math.random()) * 22;
    const a = Math.random() * Math.PI * 2;
    pos.set([Math.cos(a) * r, Math.random() * 10, Math.sin(a) * r], i * 3);
    seed.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const uniforms = { uTime: shared.uTime, uPx: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uPx;
      varying float vA;
      varying float vHue;
      void main() {
        vec3 p = position;
        float t = uTime * (0.12 + aSeed.x * 0.2);
        p.y = mod(p.y + t, 10.0) + 0.15;
        p.x += sin(t * 1.7 + aSeed.y * 6.28) * 0.7;
        p.z += cos(t * 1.3 + aSeed.z * 6.28) * 0.7;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.45 + 0.55 * sin(uTime * (0.6 + aSeed.w * 1.6) + aSeed.y * 40.0);
        float fade = smoothstep(0.15, 1.2, p.y) * (1.0 - smoothstep(7.5, 10.0, p.y));
        vA = tw * fade * exp(-length(mv.xyz) * 0.028);
        vHue = aSeed.z;
        gl_PointSize = (1.6 + aSeed.w * 3.2) * uPx * 14.0 / max(-mv.z, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      varying float vHue;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = dot(c, c) * 4.0;
        float a = exp(-d * 3.5) * vA;
        vec3 col = mix(vec3(0.16, 0.6, 0.5), vec3(0.5, 0.56, 0.24), step(0.8, vHue));
        gl_FragColor = vec4(col * a * 0.55, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.uniforms = uniforms;
  return points;
}
