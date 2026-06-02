// ── 漂浮尘埃顶点着色器 ─────────────────────────────────
// 设计规格 §6.2：
//   ~3000 漂浮尘埃，布朗运动（3D 梯度噪声驱动），增加空间深度感
//   极小极淡的点，透明度很低
//
// Three.js GLSL3 模式自动注入：
//   in vec3 position; uniform mat4 projectionMatrix / modelViewMatrix

// ── 逐粒子属性 ──────────────────────────────────────────
in float aSize;        // 点大小因子
in float aPhase;       // 随机相位偏移（让每个尘埃运动轨迹不同）
in float aDriftSpeed;  // 漂移速度

// ── Uniform ─────────────────────────────────────────────
uniform float uTime;

// ── 传递给片段着色器 ────────────────────────────────────
out float vAlpha;

// ── 3D 梯度噪声工具 ─────────────────────────────────────
// 用于生成平滑的布朗运动位移
vec3 hash33(vec3 p) {
  p = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(
      mix(dot(hash33(i + vec3(0,0,0)), f - vec3(0,0,0)),
          dot(hash33(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
      mix(dot(hash33(i + vec3(0,1,0)), f - vec3(0,1,0)),
          dot(hash33(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x),
      u.y),
    mix(
      mix(dot(hash33(i + vec3(0,0,1)), f - vec3(0,0,1)),
          dot(hash33(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
      mix(dot(hash33(i + vec3(0,1,1)), f - vec3(0,1,1)),
          dot(hash33(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x),
      u.y),
    u.z);
}

void main() {
  vec3 pos = position;

  // ── 布朗运动：三轴独立噪声驱动 ─────────────────────
  float t = uTime * aDriftSpeed;
  vec3 drift = vec3(
    gnoise(pos * 1.5 + vec3(t, 0.0, aPhase)),
    gnoise(pos * 1.5 + vec3(0.0, t, aPhase + 100.0)),
    gnoise(pos * 1.5 + vec3(aPhase, 0.0, t + 200.0))
  ) * 0.5;  // 位移幅度

  pos += drift;

  // ── 变换到裁剪空间 ─────────────────────────────────
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // ── 点大小：透视缩放，尘埃很小 ─────────────────────
  float dist = -mvPosition.z;
  gl_PointSize = clamp(aSize * (50.0 / max(dist, 0.1)), 0.5, 4.0);

  // ── 传递给片段着色器 ───────────────────────────────
  // 尘埃透明度极低（0.08–0.12），远处淡出
  vAlpha = 0.10 * smoothstep(12.0, 1.5, dist);
}
