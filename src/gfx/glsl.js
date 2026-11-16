// 各材质共用的 GLSL 片段，以及把自定义形变 / 着色注入 three 内置 PBR 材质的小工具。

export const NOISE = /* glsl */ `
// 哈希函数取自 Dave Hoskins 的 "Hash without Sine"（MIT）
float yHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 yHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float yHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 yHash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float yNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = yHash13(i);
  float b = yHash13(i + vec3(1.0, 0.0, 0.0));
  float c = yHash13(i + vec3(0.0, 1.0, 0.0));
  float d = yHash13(i + vec3(1.0, 1.0, 0.0));
  float e = yHash13(i + vec3(0.0, 0.0, 1.0));
  float g = yHash13(i + vec3(1.0, 0.0, 1.0));
  float h = yHash13(i + vec3(0.0, 1.0, 1.0));
  float k = yHash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
// 梯度噪声：用于叶脉 / 血管，避免值噪声那种沿网格的方块感。范围约 [-0.6, 0.6]
float yGDot(vec3 i, vec3 f, vec3 o) { return dot(yHash33(i + o) * 2.0 - 1.0, f - o); }
float yGNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(
    mix(mix(yGDot(i, f, vec3(0.0, 0.0, 0.0)), yGDot(i, f, vec3(1.0, 0.0, 0.0)), u.x),
        mix(yGDot(i, f, vec3(0.0, 1.0, 0.0)), yGDot(i, f, vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(yGDot(i, f, vec3(0.0, 0.0, 1.0)), yGDot(i, f, vec3(1.0, 0.0, 1.0)), u.x),
        mix(yGDot(i, f, vec3(0.0, 1.0, 1.0)), yGDot(i, f, vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
// 噪声零值线构成的细脉网络
float yVeins(vec3 p, float sharp) {
  float g = yGNoise(p) + 0.45 * yGNoise(p * 2.13 + vec3(7.1, 1.3, 4.2));
  return pow(clamp(1.0 - abs(g) * 2.4, 0.0, 1.0), sharp);
}
float yFbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * yNoise(p);
    p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    a *= 0.5;
  }
  return s / 0.875;
}
// 细胞噪声：返回到最近特征点的距离
float yWorley(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float d = 1.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + yHash33(i + g) - f;
        d = min(d, dot(r, r));
      }
    }
  }
  return sqrt(d);
}
float yWorley2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d = 1.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 g = vec2(float(x), float(y));
      vec2 r = g + yHash22(i + g) - f;
      d = min(d, dot(r, r));
    }
  }
  return sqrt(d);
}
`;

// 用屏幕空间导数把一个标量高度场变成法线扰动（Mikkelsen 的做法）
export const BUMP = /* glsl */ `
vec3 yBump(vec3 N, vec3 P, float h, float k) {
  vec3 dpx = dFdx(P);
  vec3 dpy = dFdy(P);
  float hx = dFdx(h);
  float hy = dFdy(h);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (hx * r1 + hy * r2);
  vec3 v = abs(det) * N - k * g;
  float l = dot(v, v);
  return l > 1e-24 ? v * inversesqrt(l) : N; // 导数退化时退回原法线，避免 normalize(0)
}
`;

/**
 * 给 MeshStandard / MeshPhysicalMaterial 打补丁。
 *   vertexPars      顶点着色器的全局声明
 *   vertexNormal    替换 <beginnormal_vertex>，必须声明 `vec3 objectNormal`
 *   vertexPosition  替换 <begin_vertex>，必须声明 `vec3 transformed`
 *   fragmentPars    片元着色器的全局声明
 *   fragmentColor / fragmentRoughness / fragmentNormal / fragmentEmissive
 *                   依次追加在对应内置片段之后，可读写 diffuseColor / roughnessFactor / normal / totalEmissiveRadiance
 */
export function patchMaterial(material, spec) {
  material.userData.uniforms = spec.uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, spec.uniforms);
    const defs = (spec.defines || []).map((d) => `#define ${d}\n`).join('');
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${defs}${spec.vertexPars || ''}`);
    if (spec.vertexNormal) vs = vs.replace('#include <beginnormal_vertex>', spec.vertexNormal);
    if (spec.vertexPosition) vs = vs.replace('#include <begin_vertex>', spec.vertexPosition);
    shader.vertexShader = vs;

    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${defs}${spec.fragmentPars || ''}`);
    const after = (chunk, code) => {
      if (code) fs = fs.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);
    };
    after('color_fragment', spec.fragmentColor);
    after('roughnessmap_fragment', spec.fragmentRoughness);
    after('normal_fragment_maps', spec.fragmentNormal);
    after('emissivemap_fragment', spec.fragmentEmissive);
    // 兜底：输出钳到有限的非负范围。哪怕某处算出 NaN / 极大值，也只坏一个像素，不会被辉光扩散成整片黑
    after('fog_fragment', 'gl_FragColor.rgb = min(max(vec3(0.0), gl_FragColor.rgb), vec3(64.0));');
    shader.fragmentShader = fs;
  };
  material.customProgramCacheKey = () => spec.key;
  return material;
}
