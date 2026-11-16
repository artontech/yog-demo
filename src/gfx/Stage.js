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
      float v = smoothstep(0.95, 0.2, length(c * vec2(min(uAspect, 1.0) * 0.9 + 0.2, 1.0)) * 1.25);
      col *= mix(0.22, 1.0, v);
      col += vec3(0.022, 0.001, 0.0) * (1.0 - v) * uPulse;
      // 胶片颗粒
      float g = hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5;
      col += g * 0.012 * (0.4 + col);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
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
  lamp(0xdfe9ff, 7, [6, 40, -10], 11); // 头顶的大柔光：黑亮表面上那块主高光
  lamp(0x8fd8ff, 5, [-34, 14, 20], 6);
  lamp(0x7a5cff, 5, [30, 10, 28], 6);
  lamp(0x2f8f7c, 3, [-16, 22, -34], 9);
  lamp(0x3a3f6a, 3, [32, 6, -28], 9);
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

    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.FogExp2(PALETTE.fog, 0.021);
    scene.environment = buildEnvironment(renderer);
    scene.environmentIntensity = 0.75;

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
    scene.add(new THREE.HemisphereLight(0x1c2a36, 0x040404, 0.4));
    const key = new THREE.DirectionalLight(0xcfe0f5, 0.9);
    key.position.set(-6, 14, -9);
    scene.add(key);
    this.wisps = [
      { light: new THREE.PointLight(0x7fe9ff, 9, 40, 1.8), r: 13, h: 12, speed: 0.11, phase: 0 },
      { light: new THREE.PointLight(0x9a78ff, 9, 40, 1.8), r: 15, h: 11, speed: -0.083, phase: 2.4 },
      { light: new THREE.PointLight(0xf2f6ff, 9, 40, 1.8), r: 7, h: 15, speed: 0.05, phase: 4.1 },
    ];
    if (q.low) this.wisps.pop(); // 移动端少算一盏灯
    for (const w of this.wisps) scene.add(w.light);

    // ---- 后期
    const samples = q.msaa;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples });
    const composer = (this.composer = new EffectComposer(renderer, rt));
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.42, 0.5, 0.95);
    composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());

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
    this.composer.render(dt);
    this._adapt(dt);
  }
}
