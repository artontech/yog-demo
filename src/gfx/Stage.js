// 舞台：渲染器、相机与触控、灯光与反射环境、后期（辉光 / 暗角 / 颗粒）。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PALETTE } from '../config.js';

const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAspect: { value: 1 }, uPulse: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uPulse;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      // 边缘轻微色散
      vec2 off = c * r2 * 0.012;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      // 暗角：心跳时边缘微微泛红
      float v = 1.0 - smoothstep(0.2, 0.95, length(c * vec2(min(uAspect, 1.0) * 0.9 + 0.2, 1.0)) * 1.25);
      col *= mix(0.22, 1.0, v);
      col += vec3(0.022, 0.001, 0.0) * (1.0 - v) * uPulse;
      // 胶片颗粒
      float g = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
      col += g * 0.012 * (0.4 + col);
      gl_FragColor = vec4(max(vec3(0.0), col), 1.0);
    }
  `,
};

// 辉光之前先把画面钳到有限的非负范围：辉光的大半径模糊会把一个 NaN 像素扩散成一整块黑，
// 这一步保证即使某个材质在某块显卡上算出了 NaN，也只坏那一个像素
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      gl_FragColor = vec4(min(max(vec3(0.0), c), vec3(64.0)), 1.0);
    }
  `,
};

function buildEnvironment(renderer) {
  // 一个只为反射而存在的小场景：黑暗里悬着几团冷光，湿滑表面的高光就来自它们
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(60, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'varying vec3 vP; void main(){ float h = normalize(vP).y; vec3 c = mix(vec3(0.012,0.02,0.02), vec3(0.03,0.055,0.06), smoothstep(-0.2,0.9,h)); gl_FragColor = vec4(c,1.0); }',
    }),
  );
  scene.add(dome);
  const lamp = (color, power, pos, size) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), toneMapped: false }),
    );
    m.position.set(...pos);
    m.scale.setScalar(size);
    scene.add(m);
  };
  lamp(0xa8ffe6, 6, [8, 34, -14], 8);
  lamp(0x7a5cff, 6, [-34, 12, 18], 7);
  lamp(0xdfeee8, 5, [26, 16, 26], 4);
  lamp(0x2f7d6c, 3, [-14, 26, -34], 10);
  lamp(0x4a2a6a, 3, [30, 6, -30], 9);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.035).texture;
  pmrem.dispose();
  return tex;
}

export class Stage {
  constructor(canvas, q) {
    this.q = q;
    this.canvas = canvas;
    const renderer = (this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    }));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.setClearColor(PALETTE.fog, 1);

    // 出问题时要让人看得见：着色器在某块显卡上编译失败、上下文丢失，都报到页面上（onProblem 由外部接管）
    this.onProblem = null;
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n');
      console.error(`着色器编译 / 链接失败：\n${log}`);
      const first = log.split('\n').find((l) => l.trim()) || '未知错误';
      this.onProblem?.(`着色器在这块显卡上编译失败，部分模型无法显示：${first.slice(0, 200)}`);
    };
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.onProblem?.('WebGL 上下文丢失，等待浏览器恢复……');
    });
    canvas.addEventListener('webglcontextrestored', () => this.onProblem?.(''));

    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.FogExp2(PALETTE.fog, 0.021);
    scene.environment = buildEnvironment(renderer);
    scene.environmentIntensity = 0.45;

    const camera = (this.camera = new THREE.PerspectiveCamera(40, 1, 0.3, 500));
    this.target = new THREE.Vector3(0.3, 0.4, 1.6);
    camera.position.set(2, 15, 22);

    const controls = (this.controls = new OrbitControls(camera, canvas));
    controls.target.copy(this.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.8;
    controls.minPolarAngle = 0.25;
    controls.maxPolarAngle = 1.42;
    // 系统开启“减少动态效果”时不自动巡游
    this.autoTour = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = this.autoTour;
    controls.autoRotateSpeed = 0.32;
    // 交互时暂停自动巡游，松手几秒后恢复
    this.idle = 0;
    this.interacting = false;
    controls.addEventListener('start', () => {
      this.interacting = true;
      controls.autoRotate = false;
    });
    controls.addEventListener('end', () => {
      this.interacting = false;
      this.idle = 0;
    });

    // ---- 灯光
    scene.add(new THREE.HemisphereLight(0x1a302e, 0x040404, 0.45));
    const key = new THREE.DirectionalLight(0xb4dccf, 0.8);
    key.position.set(-6, 14, -9);
    scene.add(key);
    this.wisps = [
      { light: new THREE.PointLight(0x2affc4, 15, 34, 1.8), r: 12, h: 5.5, speed: 0.11, phase: 0 },
      { light: new THREE.PointLight(0x8a4bff, 16, 34, 1.8), r: 14, h: 4.2, speed: -0.083, phase: 2.4 },
      { light: new THREE.PointLight(0xfff0dc, 12, 30, 1.8), r: 6, h: 9, speed: 0.05, phase: 4.1 },
    ];
    if (q.low) this.wisps.pop(); // 移动端少算一盏灯
    for (const w of this.wisps) scene.add(w.light);

    // ---- 后期
    const samples = q.msaa;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    const composer = (this.composer = new EffectComposer(renderer, rt));
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.5, 0.5, 0.85);
    composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());

    // 黑屏看门狗的状态：0 = 完整后期，1 = 关闭辉光，2 = 关闭全部后期，3 = 仍然全黑
    this.safeLevel = 0;
    this.dogTimer = 1.5;
    this.dogAge = 0;
    this.dogHits = 0;
    const probe = document.createElement('canvas');
    probe.width = 24;
    probe.height = 14;
    this.dogCtx = probe.getContext('2d', { willReadFrequently: true });

    this.scale = 1; // 自适应分辨率系数
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.fps = 60;
    this.resize();
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    if (window.visualViewport) visualViewport.addEventListener('resize', () => this.resize());
  }

  get pixelRatio() {
    return Math.max(0.6, Math.min(devicePixelRatio || 1, this.q.maxDpr) * this.scale);
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.width = w;
    this.height = h;
    const aspect = w / h;
    const pr = this.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = aspect;

    // 竖屏：加大视角、拉远相机，让整张网落在屏幕里
    const cam = this.camera;
    const portrait = aspect < 1;
    cam.aspect = aspect;
    cam.fov = portrait ? 56 : 40;
    cam.updateProjectionMatrix();
    const hfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * aspect);
    const fit = (portrait ? 10.2 : 11.6) / Math.tan(hfov / 2);
    const dist = THREE.MathUtils.clamp(fit, 23.5, 46);
    const c = this.controls;
    c.minDistance = 7;
    c.maxDistance = Math.max(48, dist * 1.35);
    if (this.fitDist === undefined || Math.abs(this.fitDist - dist) > 0.5) {
      // 保持当前朝向，只调整距离与俯角
      const dir = cam.position.clone().sub(c.target);
      const az = Math.atan2(dir.x, dir.z);
      const polar = portrait ? 0.58 : 0.92;
      cam.position.set(
        c.target.x + Math.sin(az) * Math.sin(polar) * dist,
        c.target.y + Math.cos(polar) * dist,
        c.target.z + Math.cos(az) * Math.sin(polar) * dist,
      );
      this.fitDist = dist;
    }
    c.update();
  }

  /** 帧率长期偏低时逐级降低渲染分辨率（主要照顾移动端） */
  _adapt(dt) {
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc < 1.5) return;
    this.fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    if (this.settle > 0) {
      this.settle--;
      return;
    }
    let next = this.scale;
    if (this.fps < 26 && this.scale > 0.5) next = Math.max(0.5, this.scale * 0.82);
    else if (this.fps > 56 && this.scale < 1) next = Math.min(1, this.scale * 1.12);
    if (next !== this.scale) {
      this.scale = next;
      this.settle = 2;
      this.resize();
    }
  }

  render(dt, time, beat) {
    for (const w of this.wisps) {
      const a = time * w.speed + w.phase;
      w.light.position.set(Math.cos(a) * w.r, w.h + Math.sin(time * 0.3 + w.phase) * 1.2, Math.sin(a) * w.r);
    }
    if (!this.interacting && !this.controls.autoRotate) {
      this.idle += dt;
      if (this.idle > 5 && this.autoTour) this.controls.autoRotate = true;
    }
    this.controls.update(dt);
    this.grade.uniforms.uTime.value = time;
    this.grade.uniforms.uPulse.value = beat;
    if (this.safeLevel >= 2) this.renderer.render(this.scene, this.camera);
    else this.composer.render(dt);
    this._watchdog(dt);
    this._adapt(dt);
  }

  /**
   * 黑屏看门狗。正常画面里永远有胶片颗粒和地面的微光，不会出现“大面积纯黑”；
   * 如果采样到的像素几乎全是 (0,0,0)，说明这块显卡上有东西算坏了（典型情况是 NaN 被后期放大）。
   * 这时逐级关闭后期让模型先显示出来，并把情况报到页面上，而不是无声无息地黑着。
   */
  _watchdog(dt) {
    if (this.safeLevel >= 3) return;
    this.dogTimer -= dt;
    this.dogAge += dt;
    if (this.dogTimer > 0) return;
    // 开场密一些（问题通常一开始就出现），之后放慢
    this.dogTimer = this.dogHits > 0 ? 0.4 : this.dogAge < 20 ? 2.5 : 6;
    if (this.renderer.getContext().isContextLost()) return;
    // 把刚画完的这一帧缩印到一张很小的 2D canvas 上再读回来。
    // 不直接用 gl.readPixels：那会让驱动在控制台里刷“GPU stall”性能警告
    const ctx = this.dogCtx;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    let data;
    try {
      ctx.drawImage(this.canvas, 0, 0, W, H);
      data = ctx.getImageData(0, 0, W, H).data;
    } catch {
      return;
    }
    let black = 0;
    const total = W * H;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] === 0) black++;
    }
    if (black < total * 0.9) {
      this.dogHits = 0;
      return;
    }
    if (++this.dogHits < 2) return;
    this.dogHits = 0;
    this.safeLevel++;
    if (this.safeLevel === 1) {
      this.bloom.enabled = false;
      this.onProblem?.('检测到画面全黑，已自动关闭辉光（显卡兼容模式）。如果方便，请把浏览器和显卡型号反馈给开发者。');
    } else if (this.safeLevel === 2) {
      this.onProblem?.('检测到画面全黑，已自动关闭全部后期效果（显卡兼容模式）。如果方便，请把浏览器和显卡型号反馈给开发者。');
    } else {
      this.onProblem?.('画面仍然全黑：这块显卡或浏览器可能不兼容。请打开控制台查看报错，并把浏览器和显卡型号反馈给开发者。');
    }
    console.warn(`[yog] 黑屏看门狗触发，兼容级别 → ${this.safeLevel}`);
  }
}
