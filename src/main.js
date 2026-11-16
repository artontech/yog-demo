import './style.css';
import { NODES, LINKS, CORE_HOST, pickQuality } from './config.js';
import { Simulation } from './sim/Simulation.js';
import { Stage } from './gfx/Stage.js';
import { World } from './gfx/World.js';
import { Hud } from './ui/Hud.js';

const veil = document.getElementById('veil');

function boot() {
  const canvas = document.getElementById('stage');
  const q = pickQuality();
  const sim = new Simulation({ nodes: NODES, links: LINKS, coreHost: CORE_HOST });
  const stage = new Stage(canvas, q);
  const world = new World(stage, sim, q);
  const hud = new Hud(document.getElementById('hud'), sim, world, stage);

  let last = performance.now();
  let first = true;
  const frame = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    sim.update(dt);
    world.update(dt);
    stage.render(dt, sim.time, world.shared.uBeat.value);
    hud.update(dt);
    if (first) {
      first = false;
      veil.classList.add('gone');
    }
  };
  stage.renderer.setAnimationLoop(frame);

  // 调试 / 截图用：暂停主循环后可以手动快进仿真，再渲染单帧
  window.__yog = {
    sim,
    stage,
    world,
    hud,
    q,
    pause: () => stage.renderer.setAnimationLoop(null),
    resume: () => stage.renderer.setAnimationLoop(frame),
    advance(seconds, step = 1 / 30) {
      for (let t = 0; t < seconds; t += step) {
        sim.update(step);
        world.update(step);
      }
    },
    renderOnce() {
      stage.render(0.016, sim.time, world.shared.uBeat.value);
      hud.slow = 0;
      hud.update(0.016);
    },
  };
}

try {
  boot();
} catch (err) {
  console.error(err);
  veil.classList.add('failed');
  veil.querySelector('span').textContent = '无法初始化 WebGL —— 请换用支持 WebGL2 的浏览器';
}
