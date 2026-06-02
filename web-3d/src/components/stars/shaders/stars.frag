// ── 从顶点着色器接收 ──────────────────────────────────
in vec2 vUv;

// ── Uniform ────────────────────────────────────────────
uniform float uTime;         // 运行时间（秒）
uniform vec3 uCameraPos;     // 相机世界空间位置（视差偏移用）

// ── GLSL3 需要手动声明片段输出变量 ────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

// ── 常量 ──────────────────────────────────────────────
const float STAR_DENSITY = 12.0;  // 网格密度（值越大星星越多）
const float STAR_THRESHOLD = 0.92; // 稀疏化阈值（越高星星越少）
const float PARALLAX_STRENGTH = 0.02; // 视差强度

// ── 伪随机哈希函数 ────────────────────────────────────
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453);
}

float hash3(vec2 p) {
  return fract(sin(dot(p, vec2(419.2, 371.9))) * 43758.5453);
}

// ── 单颗星星渲染 ─────────────────────────────────────
// 返回 (亮度, 大小) — 光滑高斯亮点
vec2 renderStar(vec2 uv, vec2 cell, float seed) {
  // 星星在网格内的随机偏移
  vec2 starOffset = vec2(hash(cell), hash2(cell));
  vec2 starPos = cell + starOffset;

  // 距离该星星的 UV 距离
  vec2 diff = uv - starPos;
  float dist = length(diff);

  // 随机大小（0.5-2.0 像素范围映射到 UV 空间）
  float size = mix(0.0003, 0.0012, hash3(cell));

  // 高斯发光轮廓
  float brightness = exp(-dist * dist / (2.0 * size * size));

  return vec2(brightness, size);
}

void main() {
  // ── 视差偏移 ───────────────────────────────────────
  // 相机移动时星空轻微偏移，增加深度感
  vec2 parallaxOffset = uCameraPos.xz * PARALLAX_STRENGTH;

  // 将 UV 映射到覆盖球面的坐标空间，加上视差偏移
  vec2 uv = vUv * STAR_DENSITY + parallaxOffset;

  // ── 多层星星（两层不同密度，避免明显的网格感）──
  // 第一层：主星空
  vec2 cell1 = floor(uv);
  float seed1 = hash(cell1);

  // 稀疏化——只有 hash 值超过阈值的格子才有星星
  float starBrightness1 = 0.0;
  if (seed1 > STAR_THRESHOLD) {
    vec2 result = renderStar(uv, cell1, seed1);
    starBrightness1 = result.x;
  }

  // 第二层：更细小的暗星（增加密度和自然感）
  vec2 uv2 = vUv * STAR_DENSITY * 2.0 + parallaxOffset * 1.5;
  vec2 cell2 = floor(uv2);
  float seed2 = hash(cell2);

  float starBrightness2 = 0.0;
  if (seed2 > 0.95) {
    vec2 result = renderStar(uv2, cell2, seed2);
    // 暗星更小更暗
    starBrightness2 = result.x * 0.3;
  }

  float totalBrightness = starBrightness1 + starBrightness2;

  // ── 闪烁效果 ───────────────────────────────────────
  if (totalBrightness > 0.001) {
    // 每颗星星有独立的闪烁频率和相位
    vec2 twinkleCell = (totalBrightness == starBrightness1) ? cell1 : cell2;
    float twinkleSpeed = mix(1.0, 4.0, hash(twinkleCell + 0.1));
    float twinklePhase = mix(0.0, 6.283, hash2(twinkleCell + 0.2));

    // 正弦闪烁：范围 0.4-1.0（不会完全熄灭）
    float twinkle = 0.7 + 0.3 * sin(uTime * twinkleSpeed + twinklePhase);

    totalBrightness *= twinkle;
  }

  // ── 颜色 ───────────────────────────────────────────
  // 基础白色，带轻微色温变化
  vec3 warmWhite = vec3(1.0, 0.95, 0.9);
  vec3 coolWhite = vec3(0.9, 0.95, 1.0);

  // 较亮的星星偏暖，较暗的偏冷
  vec3 starColor = mix(coolWhite, warmWhite, smoothstep(0.0, 1.0, totalBrightness));

  vec3 color = starColor * totalBrightness;

  // ── 微弱的背景辉光（让夜空不完全漆黑）──────────
  float bgGlow = 0.003;
  color += vec3(0.1, 0.12, 0.18) * bgGlow;

  pc_fragColor = vec4(color, 1.0);
}
