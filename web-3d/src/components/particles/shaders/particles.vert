// ── Three.js GLSL3 模式自动注入 ─────────────────────────
//   #version 300 es / precision highp float
//   in vec3 position; uniform mat4 projectionMatrix / modelViewMatrix;

// ── 逐粒子属性（GPU 端轨道参数）──────────────────────
in float aInitialAngle;       // 初始相位角
in float aOrbitRadius;        // 轨道半径
in float aOrbitInclination;   // 轨道倾角
in float aOrbitAscension;     // 升交点经度
in float aEccentricity;       // 离心率（轻微椭圆）
in float aSpeed;              // 公转角速度 (rad/s)
in float aSize;               // 点大小因子
in float aBrightness;         // 亮度因子

// ── Uniform ────────────────────────────────────────────
uniform float uTime;          // 运行时间（秒）

// ── 传递给片段着色器 ──────────────────────────────────
out float vBrightness;
out float vAlpha;

void main() {
  // ── 当前轨道角度 ─────────────────────────────────────
  float angle = aInitialAngle + uTime * aSpeed;

  // ── 椭圆轨道（局部 XZ 平面）──────────────────────────
  // 开普勒椭圆：r = a(1-e²) / (1 + e·cos θ)
  float r = aOrbitRadius * (1.0 - aEccentricity * aEccentricity)
            / (1.0 + aEccentricity * cos(angle));
  float localX = r * cos(angle);
  float localZ = r * sin(angle);

  // ── 旋转到 3D 空间 ──────────────────────────────────
  // 绕 X 轴旋转（轨道倾角）
  float y1 = localZ * sin(aOrbitInclination);
  float z1 = localZ * cos(aOrbitInclination);
  float x1 = localX;

  // 绕 Y 轴旋转（升交点经度，打散轨道面朝向）
  float x2 = x1 * cos(aOrbitAscension) - z1 * sin(aOrbitAscension);
  float z2 = x1 * sin(aOrbitAscension) + z1 * cos(aOrbitAscension);

  vec3 worldPos = vec3(x2, y1, z2);

  // ── 变换到裁剪空间 ──────────────────────────────────
  vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // ── 点大小：透视缩放 ────────────────────────────────
  float dist = -mvPosition.z;
  gl_PointSize = clamp(aSize * (100.0 / max(dist, 0.1)), 1.0, 64.0);

  // ── 传递给片段着色器 ────────────────────────────────
  vBrightness = aBrightness;
  // 远处粒子适当淡出
  vAlpha = smoothstep(10.0, 2.0, dist);
}
