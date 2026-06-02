// ── 地表脉冲点顶点着色器 ──────────────────────────────
// 设计规格 §6.3：
//   地球表面随机位置周期性闪烁，冰蓝色光点，有径向扩散
//
// Three.js GLSL3 模式自动注入：
//   in vec3 position; uniform mat4 projectionMatrix / modelViewMatrix

// ── 逐粒子属性（CPU 动态更新）──────────────────────────
in float aAlpha;      // 当前亮度（0 = 不可见，由 JS 动态更新）
in float aPointSize;  // 基础点大小
in float aSpread;     // 径向扩散因子（亮时大，暗时小，由 JS 计算）

// ── 传递给片段着色器 ───────────────────────────────────
out float vAlpha;

void main() {
  // ── 变换到裁剪空间 ─────────────────────────────────
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // ── 点大小：基础 × 径向扩散 × 透视缩放 ─────────────
  float dist = -mvPosition.z;
  gl_PointSize = clamp(
    aPointSize * aSpread * (120.0 / max(dist, 0.1)),
    0.0,
    48.0
  );

  // ── 传递给片段着色器 ───────────────────────────────
  vAlpha = aAlpha;
}
