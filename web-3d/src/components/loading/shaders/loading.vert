// ── Three.js GLSL3 模式自动注入 ─────────────────────────
//   #version 300 es / precision highp float
//   in vec3 position; uniform mat4 projectionMatrix / modelViewMatrix;

// ── 逐粒子属性 ────────────────────────────────────────
in vec3 aStartPos;      // 起始位置（远离中心的散布点）
in vec3 aTargetPos;     // 目标位置（单位球面上的点）
in float aDelay;        // 交错延迟（0.0 ~ 0.4），创造"流动汇聚"感
in float aSize;         // 点大小因子
in float aBrightness;   // 亮度因子

// ── Uniform ────────────────────────────────────────────
uniform float uProgress;   // 动画进度 0.0 ~ 1.0

// ── 传递给片段着色器 ──────────────────────────────────
out float vBrightness;
out float vAlpha;

// ── 工具函数 ──────────────────────────────────────────

/** 三次缓入缓出：加速 → 减速，聚合动画丝滑无突变 */
float easeInOutCubic(float t) {
  return t < 0.5
    ? 4.0 * t * t * t
    : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
}

void main() {
  // ── 逐粒子进度（带交错延迟）─────────────────────────
  // 每个粒子延迟 aDelay 后开始运动
  float adjustedDuration = 1.0 - aDelay;
  float t = clamp((uProgress - aDelay) / max(adjustedDuration, 0.01), 0.0, 1.0);
  t = easeInOutCubic(t);

  // ── 位置插值 ──────────────────────────────────────
  vec3 pos = mix(aStartPos, aTargetPos, t);

  // ── 飞行中添加轻微螺旋效果 ──────────────────────────
  // 越接近目标，螺旋越小，增加"汇聚"的动态感
  float spiralAngle = (1.0 - t) * 3.14159;
  float spiralRadius = (1.0 - t) * 0.2;
  pos.x += cos(spiralAngle + aDelay * 25.0) * spiralRadius;
  pos.z += sin(spiralAngle + aDelay * 25.0) * spiralRadius;

  // ── 变换到裁剪空间 ──────────────────────────────────
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // ── 点大小：透视缩放（比轨道粒子稍大，确保聚合时可见）──
  float dist = -mvPosition.z;
  gl_PointSize = clamp(aSize * (150.0 / max(dist, 0.1)), 1.0, 64.0);

  // ── 传递给片段着色器 ────────────────────────────────
  vBrightness = aBrightness;
  // 淡入（前 10% 进度）：粒子从不可见渐现
  float fadeIn = smoothstep(0.0, 0.1, uProgress);
  // 远处粒子适当淡出
  float distFade = smoothstep(12.0, 2.0, dist);
  vAlpha = fadeIn * distFade;
}
