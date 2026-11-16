// 把仿真状态装配成场景：节点、管道、心脏、菌毯、屏障与氛围。

import * as THREE from 'three';
import { NodeView } from './NodeBlob.js';
import { Sinew } from './Sinew.js';
import { Heart } from './Heart.js';
import { Mat } from './Mat.js';
import { Barrier } from './Barrier.js';
import { makeSky, makeSpores } from './Atmosphere.js';

const _v = new THREE.Vector3();

export class World {
  constructor(stage, sim, q) {
    this.stage = stage;
    this.sim = sim;
    this.shared = { uTime: { value: 0 }, uBeat: { value: 0 } };
    const scene = stage.scene;
    const shared = this.shared;

    this.views = sim.nodes.map((n) => new NodeView(n, q, shared));
    for (const v of this.views) scene.add(v.group);

    this.sinews = sim.links.map((l) => new Sinew(l, this.views[l.a], this.views[l.b], q, shared));
    for (const s of this.sinews) scene.add(s.mesh);

    // 只有客户端→服务器的连接可能被 GFW 拦截
    this.barriers = new Map();
    for (const l of sim.links) {
      if (l.kind !== 'cs' || sim.nodes[l.a].region !== 'cn') continue;
      const b = new Barrier(shared);
      this.barriers.set(l.index, b);
      scene.add(b.group);
    }

    this.heart = new Heart(q, shared);
    scene.add(this.heart.group, this.heart.light);

    this.mat = new Mat(stage.renderer, q, shared);
    scene.add(this.mat.mesh);

    this.sky = makeSky(shared);
    scene.add(this.sky);
    this.spores = makeSpores(q.spores, shared);
    scene.add(this.spores);

    // 仿真里的“受力”事件 → 胶质球的晃动
    sim.on('kick', ({ node, dx, dz, power }) => this.views[node].kick(dx, dz, power));

    this.update(0.016);
    this.mat.prewarm(sim, this.views, this.sinews, this.heart);
  }

  update(dt) {
    const { sim, shared, views, sinews } = this;
    const time = sim.time;
    shared.uTime.value = time;

    // 果冻物理：每个球是一根弹簧，连通的连接把晃动传给邻居，整张网会一起颤
    for (const v of views) {
      v.pullX = 0;
      v.pullZ = 0;
    }
    for (const s of sinews) {
      const l = s.link;
      if (l.gB - l.gA > 0.004 || l.state === 'absent') continue;
      const a = views[l.a];
      const b = views[l.b];
      const k = 5 + 14 * s.radius; // 越粗的连接拉得越紧
      const fx = (b.lean.x - a.lean.x) * k;
      const fz = (b.lean.y - a.lean.y) * k;
      a.pullX += fx;
      a.pullZ += fz;
      b.pullX -= fx;
      b.pullZ -= fz;
    }
    const step = Math.min(dt, 0.033);
    for (const v of views) {
      v.integrate(step, v.pullX, v.pullZ);
      v.update(dt, time, sim.core);
    }

    // 把脉冲和传输分配到各条管道的 uniform 槽位里
    for (const s of sinews) s.resetSlots();
    for (const x of sim.transfers) {
      const seg = x.route[x.hop];
      const s = sinews[seg.link.index];
      const t = seg.from === seg.link.a ? x.pos : 1 - x.pos;
      // 两端渐入渐出，避免鼓包凭空出现
      const edge = Math.min(1, Math.min(x.pos, 1 - x.pos) * 9 + 0.25);
      if (x.kind === 'core') s.addBulge(t, (0.3 + s.radius * 0.5) * x.amp * edge, 0.7 + s.radius, 1);
      else s.addBulge(t, Math.min(0.3, 0.06 + 0.1 * x.size + s.radius * 0.45) * x.amp * edge, 0.3 + 0.25 * x.size + s.radius * 0.9, 0);
    }
    for (const p of sim.pulses) {
      if (p.pos < 0) continue;
      const l = p.link;
      const t = p.from === l.a ? p.pos : 1 - p.pos;
      const fade = Math.min(1, p.pos * 10 + 0.2);
      // 粗的连接发光面积大，亮度相应压低，免得辉光糊成一片
      const s = sinews[l.index];
      s.addPulse(t, ((p.hue === 1 ? 0.6 : 0.8) * fade) / (1 + 2.2 * s.radius), 0.36, p.hue);
    }
    for (const s of sinews) s.update(dt, time);

    for (const [index, b] of this.barriers) b.update(dt, time, sim.links[index], sinews[index]);

    this.heart.update(dt, time, sim.core, views, sinews, this.stage.camera);
    this.mat.update(dt, sim, views, sinews, this.heart);

    const cam = this.stage.camera;
    this.sky.position.copy(cam.position);
    this.spores.userData.uniforms.uPx.value = this.stage.pixelRatio * (this.stage.height / 900);
  }

  // ------------------------------------------------------------ HUD 用的查询
  /** 世界坐标 → 屏幕像素；返回 false 表示在相机背后 */
  project(world, out) {
    _v.copy(world).project(this.stage.camera);
    if (_v.z > 1) return false;
    out.x = (_v.x * 0.5 + 0.5) * this.stage.width;
    out.y = (-_v.y * 0.5 + 0.5) * this.stage.height;
    return true;
  }

  /** 屏幕坐标点选：返回 { type: 'node' | 'link', index } 或 null */
  pick(x, y, slop = 16) {
    const pt = { x: 0, y: 0 };
    const top = { x: 0, y: 0 };
    let best = null;
    let bestD = Infinity;
    for (const v of this.views) {
      _v.set(v.body.x, v.centerY, v.body.z);
      const c = _v.clone();
      if (!this.project(c, pt) || !this.project(v.top, top)) continue;
      const rad = Math.max(18, Math.hypot(top.x - pt.x, top.y - pt.y) * 1.25);
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d < rad + slop * 0.5 && d - rad < bestD) {
        bestD = d - rad;
        best = { type: 'node', index: v.node.index };
      }
    }
    if (best) return best;
    const w = new THREE.Vector3();
    for (const s of this.sinews) {
      const l = s.link;
      if (l.state === 'absent') continue;
      for (let i = 2; i <= 14; i++) {
        const t = i / 16;
        if (t > l.gA + 0.01 && t < l.gB - 0.01) continue;
        s.pointAt(t, w);
        if (!this.project(w, pt)) continue;
        const d = Math.hypot(pt.x - x, pt.y - y);
        if (d < slop && d < bestD) {
          bestD = d;
          best = { type: 'link', index: l.index };
        }
      }
    }
    return best;
  }
}
