// 菌毯：铺在地面上的黏菌薄膜。
// 做法：每秒十来次把“此刻哪里应该有生物质”画进一张 2D canvas（R = 菌毯、G = 脉冲余辉、B = 核心的血），
// 再用一个乒乓缓冲在 GPU 上做时间平滑和扩散 —— 于是菌毯会沿着新连接慢慢爬过去，断开后又慢慢干涸。
// 地面着色器采样这张场，叠加噪声得到不规则的边缘、叶脉和脓疱。

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { NOISE, BUMP, patchMaterial } from './glsl.js';
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
    const floatOk = renderer.capabilities.isWebGL2 !== false && (gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'));
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
      uGlow: { value: new THREE.Color(...PALETTE.probe) },
    };
    const material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 }), {
      key: `yog-mat-${q.tier}`,
      uniforms: this.uniforms,
      defines: q.low ? ['YOG_LITE'] : [],
      vertexPars: 'varying vec2 vGp;',
      vertexPosition: 'vec3 transformed = vec3(position);\nvGp = (modelMatrix * vec4(position, 1.0)).xz;',
      fragmentPars: /* glsl */ `
        uniform float uTime;
        uniform float uBeat;
        uniform sampler2D uField;
        uniform vec2 uFieldC;
        uniform float uFieldS;
        uniform vec3 uGlow;
        varying vec2 vGp;
        ${NOISE}
        ${BUMP}
      `,
      fragmentColor: /* glsl */ `
        vec2 yG = vGp;
        float yDist = length(vViewPosition);
        vec2 yWarp = vec2(yNoise(vec3(yG * 0.33, uTime * 0.03)), yNoise(vec3(yG * 0.33 + 5.2, uTime * 0.03 + 9.1))) - 0.5;
        vec2 yFuv = (yG + yWarp * 1.5 - uFieldC) / uFieldS + 0.5;
        vec3 yFld = texture2D(uField, yFuv).rgb;
        float yN1 = yFbm(vec3(yG * 0.8, uTime * 0.02));
        float yN2 = yNoise(vec3(yG * 3.7, 1.3));
        float yBio = smoothstep(0.14, 0.46, yFld.r + (yN1 - 0.5) * 0.3);
        // 叶脉：粗脉 + 毛细
        float yVein = yVeins(vec3(yG * 0.62 + yWarp * 1.2, uTime * 0.012 + 4.0), 6.0) * yBio;
        float yPust = 0.0;
        #ifndef YOG_LITE
          float yW = yWorley2(yG * 1.2 + yWarp);
          yPust = (1.0 - smoothstep(0.06, 0.42, yW)) * smoothstep(0.3, 0.75, yFld.r + yN1 * 0.25);
        #endif
        float yHt = yBio * (0.3 + 0.5 * yN1) + yVein * 0.45 + yPust * 0.9 + (1.0 - yBio) * yN2 * 0.1;
        vec3 yRock = vec3(0.011, 0.014, 0.015) * (0.55 + 0.9 * yN2);
        vec3 ySlime = mix(vec3(0.02, 0.042, 0.034), vec3(0.04, 0.024, 0.052), smoothstep(0.35, 0.7, yN1));
        ySlime = mix(ySlime, vec3(0.1, 0.115, 0.055), yPust * 0.55);
        ySlime = mix(ySlime, vec3(0.085, 0.009, 0.012), clamp(yFld.b * 1.3, 0.0, 0.85));
        ySlime *= 1.0 - 0.5 * yVein;
        diffuseColor.rgb = mix(yRock, ySlime, yBio);
      `,
      fragmentRoughness: /* glsl */ `
        roughnessFactor = mix(0.62, mix(0.4, 0.2, yN1), yBio) - yPust * 0.04;
      `,
      fragmentNormal: /* glsl */ `
        normal = yBump(normal, -vViewPosition, yHt, 0.15 / (1.0 + yDist * 0.05));
      `,
      fragmentEmissive: /* glsl */ `
        {
          vec3 yE = uGlow * (yVein * (0.012 + yFld.g * 0.75) + yFld.g * yBio * 0.035);
          yE += vec3(1.0, 0.05, 0.03) * yFld.b * (yVein * (0.12 + 0.6 * uBeat) + 0.012 * uBeat);
          totalEmissiveRadiance += yE;
        }
      `,
    });
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
      const life = 0.35 + 0.65 * n.vital;
      this._blob(v.pos.x, v.pos.z, v.r * (2.9 + 0.5 * n.agent.level) * life, '255,0,0', 0.95);
      for (const f of n.flashes) {
        if (f.hue === 0 && f.t < 0.9) this._blob(v.pos.x, v.pos.z, v.r * 3.0, '0,255,0', 0.3 * (1 - f.t));
      }
    }
    for (const s of sinews) {
      const l = s.link;
      if (l.state === 'absent') continue;
      const w = s.radius * 3.2 + 0.85;
      const a = 0.55 + 0.45 * l.health;
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
    // 核心的血：浸透宿主周围，迁移途中沿管道留下一道红痕
    const core = sim.core;
    if (core.emerge > 0.02) {
      const host = views[core.host];
      this._blob(host.pos.x, host.pos.z, host.r * 3.4 + 1.6, '0,0,255', 0.9 * core.emerge);
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
    // 菌毯长得慢、退得更慢；脉冲余辉来得快去得也快；血迹居中
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

  /** 开场时直接让菌毯处于“已经长好”的状态 */
  prewarm(sim, views, sinews, heart) {
    this._draw(sim, views, sinews, heart);
    for (let i = 0; i < 24; i++) this.update(0.6, sim, views, sinews, heart);
  }
}
