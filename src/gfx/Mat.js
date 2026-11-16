// 菌毯：铺在地面上的一层黑色胶质，把所有节点和连接垫在同一摊液体里。
// 做法：每秒十来次把“此刻哪里应该有胶质”画进一张 2D canvas（R = 胶质、G = 脉冲余辉、B = 核心的红光），
// 再用一个乒乓缓冲在 GPU 上做时间平滑和扩散 —— 于是胶质会沿着新连接慢慢漫过去，断开后又慢慢退走。
// 地面着色器对这张场取阈值，得到像液滴融合一样圆润的边缘，并直接从场的梯度算出液面法线。

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { NOISE, patchMaterial } from './glsl.js';
import { PALETTE } from '../config.js';

const SIZE = 48; // 场覆盖的世界范围（正方形边长）
const CENTER = [0.3, 1.0];

const FEEDBACK_FRAG = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tTarget;
uniform vec3 uUp;
uniform vec3 uDown;
uniform vec2 uTexel;
uniform float uDiffuse;
varying vec2 vUv;
void main() {
  vec3 p = texture2D(tPrev, vUv).rgb;
  vec3 b = texture2D(tPrev, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tPrev, vUv - vec2(uTexel.x, 0.0)).rgb
         + texture2D(tPrev, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tPrev, vUv - vec2(0.0, uTexel.y)).rgb;
  p = mix(p, b * 0.25, uDiffuse);
  vec3 t = texture2D(tTarget, vUv).rgb;
  vec3 d = t - p;
  gl_FragColor = vec4(p + d * mix(uDown, uUp, step(0.0, d)), 1.0);
}
`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const _pt = new THREE.Vector3();

export class Mat {
  constructor(renderer, q, shared) {
    this.renderer = renderer;
    this.res = q.field;
    this.timer = 0;

    // ---- 目标场：2D canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = this.res;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.target = new THREE.CanvasTexture(this.canvas);
    this.target.flipY = false;
    this.target.generateMipmaps = false;
    this.target.minFilter = this.target.magFilter = THREE.LinearFilter;
    this.target.colorSpace = THREE.NoColorSpace;

    // ---- 乒乓缓冲
    const gl = renderer.getContext();
    const floatOk = gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float');
    const opts = {
      type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(this.res, this.res, opts);
    this.rtB = new THREE.WebGLRenderTarget(this.res, this.res, opts);
    this.feedback = new THREE.ShaderMaterial({
      uniforms: {
        tPrev: { value: null },
        tTarget: { value: this.target },
        uUp: { value: new THREE.Vector3() },
        uDown: { value: new THREE.Vector3() },
        uTexel: { value: new THREE.Vector2(1 / this.res, 1 / this.res) },
        uDiffuse: { value: 0.12 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: FEEDBACK_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.feedback);

    // ---- 地面
    this.uniforms = {
      uTime: shared.uTime,
      uBeat: shared.uBeat,
      uField: { value: this.rtA.texture },
      uFieldC: { value: new THREE.Vector2(...CENTER) },
      uFieldS: { value: SIZE },
      uTexel: { value: 1.6 / this.res },
      uGlow: { value: new THREE.Color(...PALETTE.probe) },
    };
    const material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 }), {
      key: 'yog-mat',
      uniforms: this.uniforms,
      vertexPars: 'varying vec2 vGp;',
      vertexPosition: 'vec3 transformed = vec3(position);\nvGp = (modelMatrix * vec4(position, 1.0)).xz;',
      fragmentPars: /* glsl */ `
        uniform float uTime;
        uniform float uBeat;
        uniform sampler2D uField;
        uniform vec2 uFieldC;
        uniform float uFieldS;
        uniform float uTexel;
        uniform vec3 uGlow;
        varying vec2 vGp;
        ${NOISE}
        // 胶质的厚度：对场取阈值，边缘窄、往里渐渐鼓起
        float yThick(vec2 uv, float bias) {
          float v = texture2D(uField, uv).r + bias;
          return smoothstep(0.2, 0.3, v) * 0.45 + smoothstep(0.22, 0.85, v) * 0.55;
        }
      `,
      fragmentColor: /* glsl */ `
        vec2 yG = vGp;
        // 轻微的缓慢扰动，让边缘不是死板的等距线
        vec2 yWarp = vec2(yNoise(vec3(yG * 0.3, uTime * 0.03)), yNoise(vec3(yG * 0.3 + 5.2, uTime * 0.03 + 9.1))) - 0.5;
        vec2 yFuv = (yG + yWarp * 0.9 - uFieldC) / uFieldS + 0.5;
        vec3 yFld = texture2D(uField, yFuv).rgb;
        float yBias = (yNoise(vec3(yG * 0.55, uTime * 0.025 + 3.0)) - 0.5) * 0.1;
        float yH = yThick(yFuv, yBias);
        float yGoo = smoothstep(0.0, 0.12, yH);
        // 液面法线直接取厚度场的梯度：平滑，不依赖屏幕分辨率
        float yHx = yThick(yFuv + vec2(uTexel, 0.0), yBias) - yThick(yFuv - vec2(uTexel, 0.0), yBias);
        float yHz = yThick(yFuv + vec2(0.0, uTexel), yBias) - yThick(yFuv - vec2(0.0, uTexel), yBias);
        float yGrain = yNoise(vec3(yG * 3.1, 1.3));
        vec3 yFloor = vec3(0.012, 0.014, 0.016) * (0.6 + 0.8 * yGrain);
        diffuseColor.rgb = mix(yFloor, vec3(0.009, 0.01, 0.013), yGoo);
      `,
      fragmentRoughness: /* glsl */ `
        roughnessFactor = mix(0.72, 0.3, yGoo);
      `,
      fragmentNormal: /* glsl */ `
        {
          float yAmp = 0.11 / (uTexel * uFieldS);
          vec3 yNw = normalize(vec3(-yHx * yAmp, 1.0, -yHz * yAmp));
          normal = normalize((viewMatrix * vec4(yNw, 0.0)).xyz);
        }
      `,
      fragmentEmissive: /* glsl */ `
        {
          // 脉冲经过后留在液面上的余辉；核心周围一圈随心跳起伏的红晕
          vec3 yE = uGlow * yFld.g * yGoo * 0.07;
          yE += vec3(1.0, 0.05, 0.03) * yFld.b * yGoo * (0.012 + 0.05 * uBeat);
          totalEmissiveRadiance += yE;
        }
      `,
    });
    material.envMapIntensity = 0.55; // 地面太大，反射压一压，免得整片发灰
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(95, 48), material);
    this.mesh.rotation.x = -Math.PI / 2;

    this._clearTargets();
  }

  _clearTargets() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    for (const rt of [this.rtA, this.rtB]) {
      r.setRenderTarget(rt);
      r.setClearColor(0x000000, 1);
      r.clear();
    }
    r.setRenderTarget(prev);
    r.setClearColor(PALETTE.fog, 1);
  }

  _px(x) {
    return ((x - CENTER[0]) / SIZE + 0.5) * this.res;
  }
  _py(z) {
    return ((z - CENTER[1]) / SIZE + 0.5) * this.res;
  }

  _blob(x, z, radius, rgb, alpha) {
    const ctx = this.ctx;
    const px = this._px(x);
    const py = this._py(z);
    const pr = (radius / SIZE) * this.res;
    const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.45, `rgba(${rgb},${alpha * 0.55})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  }

  _stroke(sinew, t0, t1, width, alpha) {
    if (t1 - t0 < 0.01) return;
    const ctx = this.ctx;
    const n = 12;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      sinew.pointAt(t0 + ((t1 - t0) * i) / n, _pt);
      const x = this._px(_pt.x);
      const y = this._py(_pt.z);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const w = (width / SIZE) * this.res;
    // 三层由宽到窄，近似一个软边
    for (const [k, a] of [[1, 0.3], [0.6, 0.45], [0.28, 0.7]]) {
      ctx.lineWidth = w * k;
      ctx.strokeStyle = `rgba(255,0,0,${alpha * a})`;
      ctx.stroke();
    }
  }

  /** 画出目标场 */
  _draw(sim, views, sinews, heart) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.res, this.res);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const v of views) {
      const n = v.node;
      const life = 0.45 + 0.55 * n.vital;
      this._blob(v.pos.x, v.pos.z, v.r * (2.7 + 0.4 * n.agent.level) * life, '255,0,0', 0.95);
      for (const f of n.flashes) {
        if (f.hue === 0 && f.t < 0.9) this._blob(v.pos.x, v.pos.z, v.r * 2.8, '0,255,0', 0.3 * (1 - f.t));
      }
    }
    for (const s of sinews) {
      const l = s.link;
      if (l.state === 'absent') continue;
      // 越粗的连接，身下的胶质也越宽；细丝身下只有窄窄一道
      const w = s.radius * 4.6 + 0.3;
      const a = 0.5 + 0.5 * l.health;
      if (l.gB - l.gA < 0.004) this._stroke(s, 0, 1, w, a);
      else {
        this._stroke(s, 0, l.gA, w, a);
        this._stroke(s, l.gB, 1, w, a);
      }
    }
    for (const p of sim.pulses) {
      if (p.pos < 0) continue;
      const l = p.link;
      const t = p.from === l.a ? p.pos : 1 - p.pos;
      sinews[l.index].pointAt(t, _pt);
      if (p.hue === 1) this._blob(_pt.x, _pt.z, 0.9, '0,0,255', 0.5);
      else this._blob(_pt.x, _pt.z, 0.9, '0,255,0', 0.6);
    }
    // 核心的红晕：罩着宿主，迁移途中沿连接留下一道红痕
    const core = sim.core;
    if (core.emerge > 0.02) {
      const host = views[core.host];
      this._blob(host.pos.x, host.pos.z, host.r * 3.0 + 1.4, '0,0,255', 0.9 * core.emerge);
    }
    if (core.phase === 'transit') this._blob(heart.lightPos.x, heart.lightPos.z, 1.5, '0,0,255', 0.9);
    this.target.needsUpdate = true;
  }

  update(dt, sim, views, sinews, heart) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.09;
      this._draw(sim, views, sinews, heart);
    }
    // 胶质漫得慢、退得更慢；脉冲余辉来得快去得也快；红晕居中
    const k = (rate) => 1 - Math.exp(-rate * dt);
    const f = this.feedback.uniforms;
    f.uUp.value.set(k(0.55), k(14), k(1.2));
    f.uDown.value.set(k(0.2), k(1.5), k(0.28));
    f.tPrev.value = this.rtA.texture;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rtB);
    this.quad.render(r);
    r.setRenderTarget(prev);
    [this.rtA, this.rtB] = [this.rtB, this.rtA];
    this.uniforms.uField.value = this.rtA.texture;
  }

  /** 开场时直接让胶质处于“已经铺好”的状态 */
  prewarm(sim, views, sinews, heart) {
    this._draw(sim, views, sinews, heart);
    for (let i = 0; i < 24; i++) this.update(0.6, sim, views, sinews, heart);
  }
}
