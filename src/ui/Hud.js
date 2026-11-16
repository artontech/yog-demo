// 叠在画面上的 DOM 层：节点标签、事件日志、图例、手动触发按钮、点选详情。
// 所有元素都是普通 DOM，鼠标和触摸走同一套 pointer 事件。

import { fmtBw } from '../sim/Simulation.js';

const LINK_STATE = {
  up: ['已连通', 'good'],
  degraded: ['劣化 · 丢包', 'warn'],
  down: ['已断开', 'bad'],
  growing: ['生长中', 'info'],
  blocked: ['GFW 拦截', 'gfw'],
  retracting: ['回收中', 'dim'],
  absent: ['未建立', 'dim'],
};

const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

export class Hud {
  constructor(root, sim, world, stage) {
    this.sim = sim;
    this.world = world;
    this.stage = stage;
    this.el = {
      labels: root.querySelector('#labels'),
      stats: root.querySelector('#stats'),
      log: root.querySelector('#log'),
      inspector: root.querySelector('#inspector'),
      legend: root.querySelector('#legend'),
      actions: root.querySelector('#actions'),
    };
    this.selected = null;
    this.hovered = null;
    this.slow = 0;
    this.pt = { x: 0, y: 0 };

    // ---- 节点标签
    this.tags = sim.nodes.map((n) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `tag${n.kind === 'server' ? ' tag-relay' : ''}`;
      el.innerHTML = `<i class="dot"></i><span><b>${n.name}</b><small>${n.sub}</small></span><u>♥</u>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select({ type: 'node', index: n.index });
      });
      this.el.labels.appendChild(el);
      return el;
    });

    // ---- GFW 标记（跟随晶格）
    this.wallTags = new Map();
    for (const [index] of world.barriers) {
      const el = document.createElement('div');
      el.className = 'chip chip-gfw';
      el.textContent = 'GFW 拦截';
      this.el.labels.appendChild(el);
      this.wallTags.set(index, el);
    }

    // ---- 连接悬浮提示
    this.linkChip = document.createElement('div');
    this.linkChip.className = 'chip chip-link';
    this.el.labels.appendChild(this.linkChip);

    sim.on('log', (e) => this.pushLog(e));

    // ---- 按钮
    const acts = {
      probe: () => sim.startProbe(),
      elect: () => {
        if (!sim.startElection(false)) sim.log('核心正在迁移途中，稍后再发起选举', 'dim');
      },
      burst: () => sim.burst(),
      snap: () => sim.flapRandom(true),
      gfw: () => {
        if (!sim.gfwStrike(Math.random() < 0.35)) sim.log('当前没有可被拦截的境内直连', 'dim');
      },
      node: () => sim.dropRandomNode(true),
      legend: () => this.toggleLegend(),
    };
    this.el.actions.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      acts[btn.dataset.act]?.();
      btn.classList.remove('fired');
      void btn.offsetWidth; // 重启一次按下动画
      btn.classList.add('fired');
    });
    this.el.legend.addEventListener('click', () => this.toggleLegend(false));
    this.el.inspector.addEventListener('click', (e) => {
      if (e.target.closest('.close')) this.select(null);
    });

    // ---- 点选：轻点（没有拖动）才算选中，避免和旋转视角冲突
    const canvas = stage.canvas;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 8 || !quick) return;
      const touch = e.pointerType !== 'mouse';
      this.select(world.pick(e.clientX, e.clientY, touch ? 30 : 14));
      if (!this.el.legend.hidden) this.toggleLegend(false);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      this.hovered = world.pick(e.clientX, e.clientY, 12);
      canvas.style.cursor = this.hovered ? 'pointer' : 'grab';
    });
    canvas.addEventListener('pointerleave', () => {
      this.hovered = null;
    });

    this._slowUpdate();
  }

  toggleLegend(force) {
    const show = force ?? this.el.legend.hidden;
    this.el.legend.hidden = !show;
    this.el.actions.querySelector('[data-act="legend"]').classList.toggle('on', show);
  }

  pushLog({ text, tone, time }) {
    const p = document.createElement('p');
    p.className = `tone-${tone}`;
    p.innerHTML = `<time>${fmtTime(time)}</time>${text}`;
    this.el.log.appendChild(p);
    while (this.el.log.children.length > 7) this.el.log.firstChild.remove();
  }

  select(sel) {
    this.selected = sel;
    this.tags.forEach((t, i) => t.classList.toggle('sel', !!sel && sel.type === 'node' && sel.index === i));
    this.el.inspector.hidden = !sel;
    if (sel) this._renderInspector();
  }

  _renderInspector() {
    const sel = this.selected;
    if (!sel) return;
    const sim = this.sim;
    let html = '';
    if (sel.type === 'node') {
      const n = sim.nodes[sel.index];
      const links = n.links.map((i) => sim.links[i]).filter((l) => sim.usable(l));
      const bw = links.reduce((s, l) => s + l.bw, 0);
      const isHost = sim.core.host === n.index && sim.core.emerge > 0.5;
      const status = !n.online ? ['离线', 'bad'] : !n.reachable ? ['在线 · 探测不可达', 'warn'] : ['在线', 'good'];
      const agent =
        n.kind === 'server'
          ? `常驻「${n.agent.task}」`
          : !n.online
            ? '—'
            : n.agent.running
              ? `运行中「${n.agent.task}」`
              : '休眠';
      const role = isHost ? `<b class="tone-core">♥ 控制核心 · 任期 #${sim.core.term}</b>` : n.kind === 'server' ? '公网中继' : '受控节点';
      const load = n.online && n.agent.running ? Math.round((0.25 + 0.7 * n.agent.load) * (0.85 + 0.15 * n.agent.breath) * 100) : 2;
      html = `
        <button class="close" aria-label="关闭">×</button>
        <h3>${n.name}<small>${n.sub}</small></h3>
        <dl>
          <dt>状态</dt><dd class="tone-${status[1]}">${status[0]}</dd>
          <dt>角色</dt><dd>${role}</dd>
          <dt>智能体</dt><dd>${agent}</dd>
          <dt>负载</dt><dd><span class="bar"><i style="width:${load}%"></i></span>${load}%</dd>
          <dt>区域</dt><dd>${n.region === 'cn' ? '境内 · 受 GFW 影响' : '境外'}</dd>
          <dt>连接</dt><dd>${links.length} 条可用 · ${fmtBw(bw)}</dd>
        </dl>`;
    } else {
      const l = sim.links[sel.index];
      const [label, tone] = LINK_STATE[l.state];
      const ok = sim.usable(l);
      const pct = Math.round(l.bwNorm * 100);
      html = `
        <button class="close" aria-label="关闭">×</button>
        <h3>${sim.linkName(l)}<small>${l.kind === 'cs' ? '客户端 → 服务器' : '点对点 · 双向'}</small></h3>
        <dl>
          <dt>状态</dt><dd class="tone-${tone}">${label}</dd>
          <dt>带宽</dt><dd><span class="bar"><i style="width:${ok ? pct : 0}%"></i></span>${ok ? fmtBw(l.bw) : '—'}</dd>
          <dt>延迟</dt><dd>${ok ? `${l.latency.toFixed(0)} ms` : '—'}</dd>
          <dt>丢包</dt><dd>${ok ? `${l.loss.toFixed(1)} %` : '—'}</dd>
          <dt>标称</dt><dd>${fmtBw(l.bwBase)}</dd>
        </dl>`;
    }
    this.el.inspector.innerHTML = html;
  }

  _slowUpdate() {
    const sim = this.sim;
    const s = sim.stats();
    const phase =
      s.phase === 'election' ? '选举中…' : s.phase === 'steady' ? `@ ${s.host.name}` : `迁移 → ${sim.nodes[sim.core.winner]?.name ?? ''}`;
    this.el.stats.innerHTML =
      `<span>节点 <b>${s.online}/${s.total}</b></span>` +
      `<span>智能体 <b>${s.running}</b> 运行</span>` +
      `<span>连接 <b>${s.links}</b> <small>P2P ${s.p2p} · C/S ${s.cs}</small></span>` +
      `<span>带宽 <b>${fmtBw(s.bw)}</b></span>` +
      `<span class="tone-core">♥ 任期 #${s.term} ${phase}</span>`;

    sim.nodes.forEach((n, i) => {
      const t = this.tags[i];
      const state = !n.online ? 'off' : !n.reachable ? 'lost' : n.agent.running ? 'run' : 'idle';
      if (t.dataset.state !== state) t.dataset.state = state;
      t.classList.toggle('host', sim.core.host === i && sim.core.emerge > 0.5);
    });
    if (this.selected) this._renderInspector();
  }

  update(dt) {
    const { world, sim, pt } = this;
    this.slow -= dt;
    if (this.slow <= 0) {
      this.slow = 0.25;
      this._slowUpdate();
    }

    // 标签跟随节点
    const host = sim.core.host;
    world.views.forEach((v, i) => {
      const el = this.tags[i];
      const lift = host === i ? 1.9 * sim.core.emerge : 0;
      const p = v.top;
      const ok = world.project({ x: p.x, y: p.y + 0.35 + lift, z: p.z }, pt);
      el.style.display = ok ? '' : 'none';
      if (ok) el.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    });

    for (const [index, el] of this.wallTags) {
      const l = sim.links[index];
      const b = world.barriers.get(index);
      const show = l.barrier > 0.35 && world.project({ x: b.pos.x, y: b.pos.y + 1.0, z: b.pos.z }, pt);
      el.style.opacity = show ? Math.min(1, l.barrier * 1.4) : 0;
      if (show) el.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }

    // 悬停 / 选中的连接：在管道中点显示带宽
    const linkSel = this.hovered?.type === 'link' ? this.hovered : this.selected?.type === 'link' ? this.selected : null;
    let shown = false;
    if (linkSel) {
      const l = sim.links[linkSel.index];
      if (l.state !== 'absent') {
        const s = world.sinews[l.index];
        const t = l.gB - l.gA > 0.01 ? Math.max(0.12, l.gA * 0.6) : 0.5;
        const w = s.pointAt(t, this._tmp || (this._tmp = s.p[0].clone()));
        if (world.project({ x: w.x, y: w.y + 0.5, z: w.z }, pt)) {
          const [label, tone] = LINK_STATE[l.state];
          this.linkChip.className = `chip chip-link tone-${tone}`;
          this.linkChip.textContent = sim.usable(l) ? `${fmtBw(l.bw)} · ${l.latency.toFixed(0)} ms` : label;
          this.linkChip.style.transform = `translate3d(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
          shown = true;
        }
      }
    }
    this.linkChip.style.opacity = shown ? 1 : 0;
  }
}
