// 演示用的静态拓扑：1 个公网中继 + 5 个智能体节点。
// 坐标是菌毯平面上的 (x, z)；带宽单位 Mbps。

export const NODES = [
  { id: 'relay', name: '公网中继', sub: 'VPS · 新加坡', kind: 'server', region: 'global', pos: [0.4, -5.4], radius: 1.7, seed: 3.7 },
  { id: 'a', name: '节点 A', sub: '家用工作站 · 上海', kind: 'agent', region: 'cn', pos: [-8.3, -1.4], radius: 1.25, seed: 11.3 },
  { id: 'b', name: '节点 B', sub: '办公笔记本 · 北京', kind: 'agent', region: 'cn', pos: [-5.3, 5.5], radius: 1.05, seed: 23.9 },
  { id: 'c', name: '节点 C', sub: '云主机 · 东京', kind: 'agent', region: 'global', pos: [1.5, 7.3], radius: 1.3, seed: 37.1 },
  { id: 'd', name: '节点 D', sub: '树莓派 · 深圳', kind: 'agent', region: 'cn', pos: [7.5, 3.5], radius: 0.92, seed: 48.6 },
  { id: 'e', name: '节点 E', sub: '移动笔记本 · 柏林', kind: 'agent', region: 'global', pos: [8.7, -3.1], radius: 1.1, seed: 59.2 },
];

// kind: 'cs' 时 a = 客户端、b = 服务器；'p2p' 为对等连接。
// lift: 0 = 贴着菌毯生长；>0 = 悬空拉丝的拱高。bow: 侧向弯曲（相对长度）。
// up: 开场时是否已连通。
export const LINKS = [
  { a: 'a', b: 'relay', kind: 'cs', bw: 180, lat: 62, lift: 0, bow: 0.06, up: true },
  { a: 'b', b: 'relay', kind: 'cs', bw: 55, lat: 78, lift: 0, bow: -0.05, up: true },
  { a: 'c', b: 'relay', kind: 'cs', bw: 820, lat: 68, lift: 0, bow: 0.04, up: true },
  { a: 'd', b: 'relay', kind: 'cs', bw: 11, lat: 54, lift: 0, bow: 0.05, up: true },
  { a: 'e', b: 'relay', kind: 'cs', bw: 95, lat: 176, lift: 0, bow: -0.06, up: true },

  { a: 'a', b: 'b', kind: 'p2p', bw: 300, lat: 28, lift: 0, bow: -0.1, up: true },
  { a: 'b', b: 'c', kind: 'p2p', bw: 48, lat: 85, lift: 0, bow: -0.09, up: true },
  { a: 'c', b: 'd', kind: 'p2p', bw: 22, lat: 71, lift: 0, bow: -0.1, up: true },
  { a: 'd', b: 'e', kind: 'p2p', bw: 7, lat: 240, lift: 0, bow: -0.09, up: true },
  { a: 'a', b: 'c', kind: 'p2p', bw: 130, lat: 49, lift: 1.7, bow: 0.05, up: true },
  { a: 'b', b: 'd', kind: 'p2p', bw: 30, lat: 36, lift: 2.5, bow: 0.04, up: false },
  { a: 'c', b: 'e', kind: 'p2p', bw: 160, lat: 232, lift: 1.5, bow: -0.06, up: false },
  { a: 'a', b: 'd', kind: 'p2p', bw: 14, lat: 31, lift: 3.2, bow: 0.03, up: false },
  { a: 'b', b: 'e', kind: 'p2p', bw: 18, lat: 251, lift: 2.9, bow: -0.03, up: false },
  { a: 'a', b: 'e', kind: 'p2p', bw: 64, lat: 228, lift: 2.1, bow: 0.14, up: false },
];

export const CORE_HOST = 'c';

export const TASKS = [
  '推理 · 规划子任务',
  '编译内核模块',
  '爬取并索引文档',
  '代码审查 #4821',
  '向量检索',
  '同步记忆分片',
  '运行测试套件',
  '重构认证模块',
  '总结会议纪要',
  '生成补丁并自检',
  '蒸馏对话上下文',
  '巡检日志异常',
];

// 调色板：主体全是黑亮的胶质，颜色只出现在轮廓光和自发光上
export const PALETTE = {
  fog: 0x040809,
  probe: [0.18, 1.0, 0.78], // 探测脉冲 / 智能体运行：青
  vote: [1.0, 0.08, 0.04], // 选举 / 核心：暗红
  data: [0.5, 0.74, 1.0], // 数据鼓包：冷白蓝
  gfw: [1.0, 0.36, 0.08], // GFW：火橙
  warn: [1.0, 0.62, 0.12],
  p2p: [0.2, 1.0, 0.78], // 点对点连接的轮廓色
  cs: [0.66, 0.42, 1.0], // 客户端→服务器连接的轮廓色
  relay: [0.6, 0.4, 1.0], // 公网中继的槽光
};

export function pickQuality() {
  const params = new URLSearchParams(location.search);
  const forced = params.get('quality');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 720;
  const weak = (navigator.hardwareConcurrency || 4) <= 4;
  let tier = coarse || (small && weak) ? 'low' : 'high';
  if (forced === 'low' || forced === 'high') tier = forced;
  const low = tier === 'low';
  return {
    tier,
    low,
    maxDpr: low ? 1.6 : 2,
    msaa: low ? 0 : 4,
    blobDetail: low ? 14 : 24,
    sinewSeg: low ? 30 : 48,
    sinewRad: low ? 10 : 14,
    strands: low ? 2 : 3,
    spores: low ? 140 : 360,
    field: low ? 256 : 512,
  };
}
