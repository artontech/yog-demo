// 纯前端的“活体网络”仿真：不连任何后端，只负责让拓扑像活物一样自己变化。
// 渲染层每帧读取这里的状态（节点 / 连接 / 脉冲 / 传输 / 控制核心）。

import { TASKS } from '../config.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
const damp = (v, target, k, dt) => v + (target - v) * (1 - Math.exp(-k * dt));

// 各状态下连接的“健康度”目标值（影响颜色、颤抖、粗细）
const HEALTH = { absent: 0, growing: 0.8, up: 1, degraded: 0.3, down: 0.4, blocked: 0.6, retracting: 0.35 };

export const HUE_PROBE = 0;
export const HUE_VOTE = 1;
export const HUE_WARN = 2;

export class Simulation {
  constructor({ nodes, links, coreHost }) {
    this.time = 0;
    this.handlers = {};
    this.waveSeq = 0;

    this.nodes = nodes.map((n, index) => ({
      ...n,
      index,
      online: true,
      vital: 1,
      reachable: true,
      gulp: 0,
      elect: 0,
      flashes: [],
      links: [],
      downTimer: 0,
      agent: {
        running: n.kind === 'server',
        task: n.kind === 'server' ? '中继 / 会合服务' : '',
        timer: rand(0.4, 5),
        load: n.kind === 'server' ? 0.15 : rand(0.3, 1),
        level: 0,
        phase: rand(0, 6.28),
        breath: 0,
      },
    }));
    const byId = Object.fromEntries(this.nodes.map((n) => [n.id, n]));

    this.links = links.map((l, index) => {
      const a = byId[l.a];
      const b = byId[l.b];
      const dx = b.pos[0] - a.pos[0];
      const dz = b.pos[1] - a.pos[1];
      const len = Math.hypot(dx, dz);
      const link = {
        index,
        id: `${l.a}-${l.b}`,
        kind: l.kind,
        a: a.index,
        b: b.index,
        lift: l.lift,
        bow: l.bow,
        bwBase: l.bw,
        bw: l.bw,
        bwNorm: 0,
        latencyBase: l.lat,
        latency: l.lat,
        loss: 0,
        surge: 1,
        surgeTarget: 1,
        surgeTimer: rand(2, 9),
        ph1: rand(0, 6.28),
        ph2: rand(0, 6.28),
        state: l.up ? 'up' : 'absent',
        reason: '',
        timer: 0,
        failing: false,
        health: l.up ? 1 : 0,
        // [0, gA] 由 a 端长出，[gB, 1] 由 b 端长出；gA == gB 时管道完整
        gA: l.up ? 0.5 : 0,
        gB: l.up ? 0.5 : 1,
        tA: l.up ? 0.5 : 0,
        tB: l.up ? 0.5 : 1,
        rate: 1,
        cut: 0.5,
        barrier: 0,
        barrierHit: 0,
        length: len * 1.06,
        dir: [dx / len, dz / len],
        seed: Math.random(),
      };
      a.links.push(index);
      b.links.push(index);
      return link;
    });

    // 开场：大部分智能体已在运行
    this.nodes.forEach((n, i) => {
      if (n.kind === 'server') return;
      if (i % 4 !== 3) this._startAgent(n);
    });

    this.core = {
      host: byId[coreHost].index,
      term: 1,
      phase: 'steady', // steady | election | sinking | transit | rising | withering | forming
      timer: 0,
      emerge: 1,
      winner: -1,
      transfer: null,
      forced: false,
    };

    this.pulses = [];
    this.transfers = [];
    this.waves = new Map();

    this.clock = {
      flap: rand(11, 15),
      churn: rand(6, 9),
      gfw: rand(15, 20),
      node: rand(48, 70),
      probe: 2.2,
      elect: rand(30, 42),
      xfer: 1,
    };
  }

  // ---------------------------------------------------------------- events
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  emit(type, payload) {
    for (const fn of this.handlers[type] || []) fn(payload);
  }
  log(text, tone = 'info') {
    this.emit('log', { text, tone, time: this.time });
  }
  /** 沿连接方向推一下节点（渲染层据此让胶质球晃动）。toward = true 表示朝连接另一端 */
  kick(link, nodeIndex, power, toward = true) {
    const sign = (nodeIndex === link.a ? 1 : -1) * (toward ? 1 : -1);
    this.emit('kick', { node: nodeIndex, dx: link.dir[0] * sign, dz: link.dir[1] * sign, power });
  }

  // ---------------------------------------------------------------- helpers
  other(link, from) {
    return link.a === from ? link.b : link.a;
  }
  usable(link) {
    return (link.state === 'up' || link.state === 'degraded') && this.nodes[link.a].online && this.nodes[link.b].online;
  }
  present(link) {
    return link.state !== 'absent';
  }
  intact(link) {
    return link.gB - link.gA < 0.002 && link.state !== 'absent';
  }
  linkName(link) {
    const a = this.nodes[link.a].name;
    const b = this.nodes[link.b].name;
    return link.kind === 'cs' ? `${a} → ${b}` : `${a} ⇄ ${b}`;
  }

  findRoute(src, dst) {
    if (src === dst) return [];
    const prev = new Map([[src, null]]);
    const queue = [src];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === dst) break;
      // 带宽大的连接优先展开，路由看起来更合理
      const edges = this.nodes[cur].links
        .map((i) => this.links[i])
        .filter((l) => this.usable(l))
        .sort((p, q) => q.bw - p.bw);
      for (const l of edges) {
        const nxt = this.other(l, cur);
        if (prev.has(nxt)) continue;
        prev.set(nxt, { link: l, from: cur });
        queue.push(nxt);
      }
    }
    if (!prev.has(dst)) return null;
    const route = [];
    let cur = dst;
    while (cur !== src) {
      const step = prev.get(cur);
      route.unshift(step);
      cur = step.from;
    }
    return route;
  }

  stats() {
    const online = this.nodes.filter((n) => n.online).length;
    const up = this.links.filter((l) => this.usable(l));
    const p2p = up.filter((l) => l.kind === 'p2p').length;
    const bw = up.reduce((s, l) => s + l.bw, 0);
    return {
      online,
      total: this.nodes.length,
      links: up.length,
      p2p,
      cs: up.length - p2p,
      bw,
      host: this.nodes[this.core.host],
      term: this.core.term,
      phase: this.core.phase,
      running: this.nodes.filter((n) => n.online && n.agent.running && n.kind !== 'server').length,
    };
  }

  // ---------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    this._updateNodes(dt);
    this._updateLinks(dt);
    this._updatePulses(dt);
    this._updateTransfers(dt);
    this._updateCore(dt);
    this._schedule(dt);
  }

  // ---------------------------------------------------------------- nodes
  _startAgent(n) {
    const ag = n.agent;
    ag.running = true;
    ag.task = pick(TASKS);
    ag.load = rand(0.3, 1);
    ag.timer = rand(10, 28);
  }

  _updateNodes(dt) {
    for (const n of this.nodes) {
      n.vital = damp(n.vital, n.online ? 1 : 0, n.online ? 1.3 : 0.9, dt);
      const ag = n.agent;
      if (n.online && n.kind !== 'server') {
        ag.timer -= dt;
        if (ag.timer <= 0) {
          if (ag.running) {
            ag.running = false;
            ag.timer = rand(3, 8);
            this.log(`${n.name} 智能体完成「${ag.task}」，进入休眠`, 'dim');
          } else {
            this._startAgent(n);
            this.log(`${n.name} 智能体开始「${ag.task}」`, 'info');
          }
        }
      }
      if (!n.online) {
        n.downTimer -= dt;
        if (n.downTimer <= 0) this.setNodeOnline(n, true);
      }
      ag.level = damp(ag.level, ag.running && n.online ? 1 : 0, 1.4, dt);
      ag.phase += dt * (1.2 + 1.5 * ag.load);
      ag.breath = Math.sin(ag.phase - 0.45 * Math.sin(ag.phase)) * ag.level;
      n.gulp = Math.max(0, n.gulp - dt * 2.4);
      n.elect = damp(n.elect, this.core.phase === 'election' && n.online ? 1 : 0, 5, dt);
      for (const f of n.flashes) f.t += dt * 1.45;
      if (n.flashes.length && n.flashes[0].t > 1.3) n.flashes.shift();
    }
  }

  setNodeOnline(n, online, downtime = rand(12, 20)) {
    if (n.online === online) return;
    n.online = online;
    if (!online) {
      n.downTimer = downtime;
      n.agent.running = false;
      n.reachable = false;
      this.log(`${n.name}（${n.sub}）失去响应，塌成一滩`, 'bad');
      for (const i of n.links) {
        const l = this.links[i];
        if (l.state === 'absent') continue;
        if (this.intact(l)) l.gA = l.gB = 0.5;
        const aDead = !this.nodes[l.a].online;
        const bDead = !this.nodes[l.b].online;
        l.tA = aDead ? 0 : Math.min(l.gA, 0.3);
        l.tB = bDead ? 1 : Math.max(l.gB, 0.7);
        l.rate = 0.75;
        l.state = 'down';
        l.reason = 'node';
        l.failing = false;
      }
      if (this.core.host === n.index && this.core.phase === 'steady') this.startElection(true);
    } else {
      n.agent.timer = rand(1.5, 4);
      n.reachable = true;
      this.log(`${n.name} 重新苏醒，开始向网络伸出细丝`, 'good');
      for (const i of n.links) {
        const l = this.links[i];
        if (l.state === 'down' && l.reason === 'node') l.timer = rand(0.8, 3.2);
      }
    }
    this.emit('node', n);
  }

  // ---------------------------------------------------------------- links
  _regrow(l, duration = rand(2.4, 3.6)) {
    const fresh = l.gA < 0.02 && l.gB > 0.98;
    const mid = l.kind === 'cs' && fresh ? 1 : (l.gA + l.gB) / 2;
    l.tA = l.tB = mid;
    l.rate = Math.max(mid - l.gA, l.gB - mid, 0.05) / duration;
    l.state = 'growing';
  }

  _snap(l, reason, downtime) {
    if (this.intact(l)) l.gA = l.gB = rand(0.38, 0.62);
    l.tA = Math.max(0.1, l.gA - rand(0.16, 0.26));
    l.tB = Math.min(0.9, l.gB + rand(0.16, 0.26));
    l.rate = 1.9;
    l.state = 'down';
    l.reason = reason;
    l.timer = downtime;
    l.failing = false;
    // 绷紧的丝一断，两端各自弹开
    this.kick(l, l.a, 2.0, false);
    this.kick(l, l.b, 2.0, false);
  }

  _retract(l) {
    if (this.intact(l)) l.gA = l.gB = 0.5;
    l.tA = 0;
    l.tB = 1;
    l.rate = 0.3;
    l.state = 'retracting';
  }

  _block(l, duration) {
    l.cut = rand(0.5, 0.58);
    l.gA = l.gB = l.cut;
    l.tA = l.cut - 0.065;
    l.tB = l.cut + 0.065;
    l.rate = 0.4;
    l.state = 'blocked';
    l.timer = duration;
  }

  _updateLinks(dt) {
    const t = this.time;
    for (const l of this.links) {
      if (l.state === 'absent') {
        l.health = 0;
        continue;
      }
      // 带宽：慢波动 + 偶发拥塞
      l.surgeTimer -= dt;
      if (l.surgeTimer <= 0) {
        l.surgeTarget = Math.random() < 0.18 ? rand(0.12, 0.3) : rand(0.45, 1.5);
        l.surgeTimer = rand(5, 12);
      }
      l.surge = damp(l.surge, l.surgeTarget, 0.7, dt);
      const wobble = 1 + 0.2 * Math.sin(t * 0.37 + l.ph1) + 0.1 * Math.sin(t * 0.93 + l.ph2);
      const target = l.bwBase * l.surge * wobble * (l.state === 'degraded' ? 0.18 : 1);
      l.bw = damp(l.bw, target, 1.6, dt);
      l.bwNorm = clamp(Math.log10(Math.max(l.bw, 1)) / 3, 0, 1);
      l.health = damp(l.health, HEALTH[l.state], 2.6, dt);
      l.latency = l.latencyBase * (1 + (1 - l.health) * 4) * (1 + 0.07 * Math.sin(t * 3.1 + l.ph1));
      l.loss = Math.pow(1 - l.health, 2) * 38 + 0.05 + 0.05 * Math.sin(t * 1.7 + l.ph2);

      l.gA = approach(l.gA, l.tA, l.rate * dt);
      l.gB = approach(l.gB, l.tB, l.rate * dt);
      l.barrier = damp(l.barrier, l.state === 'blocked' ? 1 : 0, 3, dt);
      l.barrierHit = Math.max(0, l.barrierHit - dt * 2.2);
      const arrived = l.gA === l.tA && l.gB === l.tB;

      switch (l.state) {
        case 'growing':
          if (arrived) {
            if (l.failing) {
              l.failing = false;
              this.log(`${this.linkName(l)} 打洞失败，细丝缩回`, 'warn');
              this._retract(l);
            } else {
              l.state = 'up';
              l.reason = '';
              this.kick(l, l.a, 1.1, true);
              this.kick(l, l.b, 1.1, true);
              this.log(`${this.linkName(l)} 已接通 · ${fmtBw(l.bwBase)}`, 'good');
              this.emit('link', l);
            }
          }
          break;
        case 'retracting':
          if (arrived) {
            l.state = 'absent';
            this.emit('link', l);
          }
          break;
        case 'degraded':
          l.timer -= dt;
          if (l.timer <= 0) {
            if (Math.random() < 0.35) {
              this.log(`${this.linkName(l)} 持续丢包后断裂`, 'bad');
              this._snap(l, 'flap', rand(5, 10));
            } else {
              l.state = 'up';
              this.log(`${this.linkName(l)} 恢复稳定`, 'good');
            }
          }
          break;
        case 'down': {
          const both = this.nodes[l.a].online && this.nodes[l.b].online;
          if (!both) break;
          l.timer -= dt;
          if (l.timer <= 0) {
            if (l.kind === 'p2p' && l.reason === 'flap' && Math.random() < 0.12) {
              this.log(`${this.linkName(l)} 放弃重连，残丝被回收`, 'dim');
              this._retract(l);
            } else {
              this._regrow(l);
            }
          }
          break;
        }
        case 'blocked':
          l.timer -= dt;
          if (l.timer <= 0) {
            l.tA = l.tB = l.cut;
            l.rate = 0.05;
            l.state = 'growing';
            this.log(`GFW 对 ${this.nodes[l.a].name} 的封锁解除，连接重新愈合`, 'good');
          }
          break;
        default:
      }
    }
  }

  // ---------------------------------------------------------------- pulses
  _spawnPulse(link, from, wave, delay = 0) {
    if (link.state === 'absent') return;
    wave.active++;
    this.pulses.push({ link, from, pos: -delay * 7 / link.length, speed: 7, wave, hue: wave.hue, dead: false });
  }

  startProbe(origin = this.core.host) {
    const node = this.nodes[origin];
    if (!node.online) return;
    const wave = { id: ++this.waveSeq, kind: 'probe', hue: HUE_PROBE, visited: new Set([origin]), active: 0, origin };
    this.waves.set(wave.id, wave);
    node.reachable = true;
    node.flashes.push({ dx: 0, dz: 0, t: 0, hue: HUE_PROBE, radial: true });
    for (const i of node.links) this._spawnPulse(this.links[i], origin, wave);
    if (wave.active === 0) this._finishWave(wave);
    this.emit('probe', wave);
  }

  _finishWave(wave) {
    this.waves.delete(wave.id);
    if (wave.kind !== 'probe') return;
    const online = this.nodes.filter((n) => n.online);
    const lost = online.filter((n) => !wave.visited.has(n.index));
    for (const n of this.nodes) n.reachable = wave.visited.has(n.index);
    if (lost.length) this.log(`探测完成：${lost.map((n) => n.name).join('、')} 不可达`, 'warn');
    this.emit('wave', { wave, lost });
  }

  _updatePulses(dt) {
    for (const p of this.pulses) {
      const l = p.link;
      p.pos += (p.speed * dt) / l.length;
      if (p.pos < 0) continue;
      const tt = p.from === l.a ? p.pos : 1 - p.pos;
      const open = l.gB - l.gA > 0.004 || l.state === 'absent';
      if (open) {
        const hit = p.from === l.a ? tt >= l.gA - 0.012 : tt <= l.gB + 0.012;
        if (hit) {
          p.dead = true;
          if (l.state === 'blocked') l.barrierHit = 1;
          this.emit('fizzle', { link: l, t: tt, blocked: l.state === 'blocked' });
        }
      } else if (p.pos >= 1) {
        p.dead = true;
        this._pulseArrive(p);
      }
      if (p.dead) {
        p.wave.active--;
        if (p.wave.active <= 0) this._finishWave(p.wave);
      }
    }
    if (this.pulses.some((p) => p.dead)) this.pulses = this.pulses.filter((p) => !p.dead);
  }

  _pulseArrive(p) {
    const l = p.link;
    const idx = this.other(l, p.from);
    const node = this.nodes[idx];
    if (!node.online) return;
    // 光从连接进入的那一侧扫过整个节点
    const sign = idx === l.a ? 1 : -1;
    this.kick(l, idx, 0.22, false);
    node.flashes.push({ dx: l.dir[0] * sign, dz: l.dir[1] * sign, t: 0, hue: p.hue });
    if (node.flashes.length > 2) node.flashes.shift();
    const wave = p.wave;
    if (wave.kind !== 'probe' || wave.visited.has(idx)) return;
    wave.visited.add(idx);
    node.reachable = true;
    for (const i of node.links) {
      const nl = this.links[i];
      if (nl === l) continue;
      this._spawnPulse(nl, idx, wave, 0.1);
    }
  }

  // ---------------------------------------------------------------- transfers
  sendData(src, dst, size = rand(0.5, 1), opts = {}) {
    const route = this.findRoute(src, dst);
    if (!route || !route.length) return null;
    const x = { route, hop: 0, pos: 0, size, kind: opts.kind || 'data', amp: 0, dead: false, onDone: opts.onDone, onFail: opts.onFail };
    this.transfers.push(x);
    return x;
  }

  _updateTransfers(dt) {
    for (const x of this.transfers) {
      const seg = x.route[x.hop];
      const l = seg.link;
      if (!this.usable(l)) {
        x.amp -= dt * 2.5;
        if (x.amp <= 0) {
          x.dead = true;
          x.onFail?.();
        }
        continue;
      }
      x.amp = Math.min(1, x.amp + dt * 4);
      const v = x.kind === 'core' ? 4.4 : 2.0 + 3.6 * l.bwNorm;
      x.pos += (v * dt) / l.length;
      if (x.pos >= 1) {
        const node = this.nodes[this.other(l, seg.from)];
        node.gulp = Math.max(node.gulp, x.kind === 'core' ? 1.3 : 0.5 + 0.5 * x.size);
        // 鼓包撞进球里，把它往前推一下
        this.kick(l, node.index, x.kind === 'core' ? 2.6 : 0.5 + 0.7 * x.size, false);
        x.hop++;
        x.pos = 0;
        if (x.hop >= x.route.length) {
          x.dead = true;
          x.onDone?.();
        }
      }
    }
    if (this.transfers.some((x) => x.dead)) this.transfers = this.transfers.filter((x) => !x.dead);
  }

  _randomTransfer() {
    const sources = this.nodes.filter((n) => n.online && n.agent.running && n.kind !== 'server');
    if (!sources.length) return;
    const src = pick(sources);
    const relay = this.nodes.find((n) => n.kind === 'server');
    const peers = this.nodes.filter((n) => n.online && n !== src && n.kind !== 'server');
    const toRelay = Math.random() < 0.5 || !peers.length;
    const dst = toRelay ? relay : pick(peers);
    if (!dst.online) return;
    const route = this.findRoute(src.index, dst.index);
    if (!route) return;
    if (toRelay && route.length > 1 && Math.random() < 0.5) {
      const via = this.nodes[this.other(route[0].link, src.index)];
      this.log(`${src.name} 直连受阻，经 ${via.name} 中继访问公网`, 'warn');
    }
    this.sendData(src.index, dst.index, rand(0.35, 0.8), {
      // 请求到达后，回包是一个更大的鼓包
      onDone: () => {
        if (Math.random() < 0.75) this.sendData(dst.index, src.index, rand(0.6, 1));
      },
    });
  }

  // ---------------------------------------------------------------- core
  startElection(forced = false) {
    const c = this.core;
    if (c.phase !== 'steady') return false;
    c.phase = 'election';
    c.timer = forced ? 1.6 : 3.2;
    c.forced = forced;
    this.log(forced ? '控制核心的宿主失联，紧急重新选举' : `第 ${c.term + 1} 任期选举开始，各节点交换选票`, 'core');
    // 选票：红色脉冲在所有可用连接上对冲
    const wave = { id: ++this.waveSeq, kind: 'vote', hue: HUE_VOTE, visited: new Set(), active: 0 };
    this.waves.set(wave.id, wave);
    for (const l of this.links) {
      if (!this.usable(l)) continue;
      this._spawnPulse(l, l.a, wave, Math.random() * 0.5);
      this._spawnPulse(l, l.b, wave, Math.random() * 0.5);
    }
    if (wave.active === 0) this.waves.delete(wave.id);
    // 全网一颤
    for (const n of this.nodes) {
      if (!n.online) continue;
      const a = Math.random() * 6.283;
      this.emit('kick', { node: n.index, dx: Math.cos(a), dz: Math.sin(a), power: 0.9 });
    }
    this.emit('election', c);
    return true;
  }

  _pickWinner() {
    const c = this.core;
    let best = -1;
    let bestScore = -Infinity;
    for (const n of this.nodes) {
      if (!n.online || n.index === c.host) continue;
      let score = Math.random() * 0.9;
      for (const i of n.links) {
        const l = this.links[i];
        if (this.usable(l)) score += 0.4 + l.bwNorm;
      }
      if (n.kind === 'server') score *= 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = n.index;
      }
    }
    return best;
  }

  _updateCore(dt) {
    const c = this.core;
    c.timer -= dt;
    if (c.phase === 'steady' && !this.nodes[c.host].online) this.startElection(true);
    switch (c.phase) {
      case 'election':
        if (c.timer <= 0) {
          const winner = this._pickWinner();
          if (winner < 0) {
            c.phase = 'steady';
            break;
          }
          c.winner = winner;
          c.term++;
          const host = this.nodes[c.host];
          const route = host.online ? this.findRoute(c.host, winner) : null;
          const name = this.nodes[winner].name;
          if (route && route.length) {
            this.log(`${name} 赢得第 ${c.term} 任期，核心沿连接迁移（${route.length} 跳）`, 'core');
            c.phase = 'sinking';
            c.timer = 0.75;
            c.route = route;
          } else {
            this.log(`${name} 赢得第 ${c.term} 任期，旧核心消散，新核心就地凝结`, 'core');
            c.phase = 'withering';
            c.timer = 1.1;
          }
        }
        break;
      case 'sinking':
        c.emerge = clamp(c.timer / 0.75, 0, 1);
        if (c.timer <= 0) {
          c.emerge = 0;
          const x = this.sendData(c.host, c.winner, 1, {
            kind: 'core',
            onDone: () => {
              c.host = c.winner;
              c.phase = 'rising';
              c.timer = 1.0;
              c.transfer = null;
            },
            onFail: () => {
              this.log('迁移途中连接断裂，核心在新宿主体内重新凝结', 'core');
              c.host = c.winner;
              c.phase = 'forming';
              c.timer = 2.2;
              c.transfer = null;
            },
          });
          if (x) {
            c.phase = 'transit';
            c.transfer = x;
          } else {
            c.host = c.winner;
            c.phase = 'forming';
            c.timer = 2.2;
          }
        }
        break;
      case 'transit':
        break;
      case 'rising':
        c.emerge = 1 - clamp(c.timer / 1.0, 0, 1);
        if (c.timer <= 0) this._settle();
        break;
      case 'withering':
        c.emerge = clamp(c.timer / 1.1, 0, 1);
        if (c.timer <= 0) {
          c.host = c.winner;
          c.phase = 'forming';
          c.timer = 2.2;
        }
        break;
      case 'forming':
        c.emerge = 1 - clamp(c.timer / 2.2, 0, 1);
        if (c.timer <= 0) this._settle();
        break;
      default:
    }
  }

  _settle() {
    const c = this.core;
    c.phase = 'steady';
    c.emerge = 1;
    this.clock.elect = rand(34, 52);
    this.clock.probe = 0.9;
    this.emit('core', c);
    this.log(`控制核心已在 ${this.nodes[c.host].name} 扎根`, 'core');
  }

  // ---------------------------------------------------------------- scheduler
  _schedule(dt) {
    const k = this.clock;
    for (const key of Object.keys(k)) k[key] -= dt;

    if (k.probe <= 0) {
      k.probe = 7.5;
      if (this.core.phase === 'steady') this.startProbe();
    }
    if (k.xfer <= 0) {
      k.xfer = rand(0.6, 2.0);
      this._randomTransfer();
    }
    if (k.flap <= 0) {
      k.flap = rand(10, 17);
      this.flapRandom();
    }
    if (k.churn <= 0) {
      k.churn = rand(11, 18);
      this.churnP2P();
    }
    if (k.gfw <= 0) {
      k.gfw = rand(17, 28);
      this.gfwStrike(Math.random() < 0.2);
    }
    if (k.node <= 0) {
      k.node = rand(48, 75);
      this.dropRandomNode();
    }
    if (k.elect <= 0) {
      k.elect = rand(34, 52);
      this.startElection(false);
    }
  }

  // ---------------------------------------------------------------- incidents（也供 HUD 按钮手动触发）
  flapRandom(forceSnap = false) {
    const broken = this.links.filter((l) => l.state === 'down' || l.state === 'degraded').length;
    if (!forceSnap && broken >= 3) return;
    const pool = this.links.filter((l) => l.state === 'up');
    if (!pool.length) return;
    const l = pick(pool);
    if (forceSnap || Math.random() < 0.5) {
      this.log(`${this.linkName(l)} 物理链路中断，连接被扯断`, 'bad');
      this._snap(l, 'flap', rand(5, 11));
    } else {
      l.state = 'degraded';
      l.timer = rand(4, 9);
      this.log(`${this.linkName(l)} 抖动加剧，带宽骤降`, 'warn');
    }
    this.emit('link', l);
  }

  churnP2P() {
    const p2p = this.links.filter((l) => l.kind === 'p2p');
    const present = p2p.filter((l) => l.state !== 'absent');
    const absent = p2p.filter((l) => l.state === 'absent' && this.nodes[l.a].online && this.nodes[l.b].online);
    const grow = present.length <= 5 || (present.length < 8 && Math.random() < 0.6);
    if (grow && absent.length) {
      const l = pick(absent);
      l.gA = 0;
      l.gB = 1;
      l.failing = Math.random() < 0.22;
      l.health = 0.5;
      this._regrow(l, rand(3, 4.2));
      if (l.failing) {
        l.tA = rand(0.3, 0.4);
        l.tB = 1 - l.tA;
      }
      this.log(`${this.linkName(l)} 开始打洞，双方各伸出一根细丝`, 'info');
      this.emit('link', l);
    } else {
      const pool = present.filter((l) => l.state === 'up');
      if (pool.length <= 3) return;
      const l = pick(pool);
      this.log(`${this.linkName(l)} 长期空闲，连接被回收`, 'dim');
      this._retract(l);
      this.emit('link', l);
    }
  }

  gfwStrike(wide = false) {
    const pool = this.links.filter(
      (l) => l.kind === 'cs' && l.state === 'up' && this.nodes[l.a].region === 'cn' && this.nodes[l.a].online,
    );
    if (!pool.length) return false;
    const victims = wide ? pool : [pick(pool)];
    const dur = rand(9, 15);
    for (const l of victims) this._block(l, dur + rand(-2, 2));
    this.log(
      wide ? 'GFW 大范围封锁：境内节点到公网中继的直连全部被截断' : `GFW 拦截了 ${this.nodes[victims[0].a].name} → 公网中继`,
      'gfw',
    );
    this.emit('gfw', victims);
    return true;
  }

  dropRandomNode(manual = false) {
    const down = this.nodes.find((n) => !n.online);
    if (down) {
      // 手动触发时，再点一次就让它回来
      if (manual) down.downTimer = 0;
      return;
    }
    const pool = this.nodes.filter((n) => n.online && n.kind !== 'server');
    if (pool.length <= 2) return;
    this.setNodeOnline(pick(pool), false);
  }

  burst() {
    for (let i = 0; i < 7; i++) this._randomTransfer();
    this.clock.xfer = 0.3;
    this.log('数据洪流：多个智能体同时交换上下文', 'info');
  }
}

export function fmtBw(mbps) {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  if (mbps >= 10) return `${mbps.toFixed(0)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${(mbps * 1000).toFixed(0)} Kbps`;
}
