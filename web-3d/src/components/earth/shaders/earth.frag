// ── 从顶点着色器接收 ──────────────────────────────────
in vec2 vUv;
in vec3 vNormal;       // 视图空间法线
in vec3 vWorldNormal;  // 世界空间法线
in vec3 vViewDir;      // 视图空间视线方向

// ── 纹理 Uniform ──────────────────────────────────────
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;

// ── 光照 Uniform ──────────────────────────────────────
uniform vec3 uSunDirection; // 世界空间日光方向（归一化）

// ── 加载过渡 Uniform（阶段 16）─────────────────────────
uniform float uTextureReveal; // 0.0（冰蓝光球）~ 1.0（完整纹理）

// ── 视觉增强 Uniform（阶段 17）─────────────────────────
uniform float uTime;          // 运行时间（Fresnel 脉冲 + 夜景呼吸）

// ── GLSL3 需要手动声明片段输出变量 ────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

// ── 大气散射近似 ──────────────────────────────────────
vec3 atmosphereScattering(vec3 worldNormal, vec3 sunDir) {
  float sunDot = dot(worldNormal, sunDir);

  // 晨昏线附近：蓝色大气散射光晕
  float terminatorGlow = exp(-abs(sunDot) * 3.0) * 0.15;
  vec3 scatter = vec3(0.3, 0.6, 1.0) * terminatorGlow;

  // 向阳面：微弱的暖色调（模拟大气正向散射）
  float sunFacing = max(0.0, sunDot);
  scatter += vec3(0.2, 0.15, 0.05) * pow(sunFacing, 4.0) * 0.1;

  return scatter;
}

void main() {
  // ── 双纹理采样 ─────────────────────────────────────
  vec3 dayColor   = texture(uDayMap, vUv).rgb;
  vec3 nightColor = texture(uNightMap, vUv).rgb;

  // ── 日夜过渡 ───────────────────────────────────────
  // 基于世界空间法线与日光方向的点积
  vec3 sunDir = normalize(uSunDirection);
  float sunDot = dot(vWorldNormal, sunDir);

  // smoothstep 制造自然的晨昏线过渡
  float dayFactor = smoothstep(-0.1, 0.3, sunDot);

  // ── 混合 ───────────────────────────────────────────
  // 夜景面：城市灯光增强发光（×3.0）
  vec3 texturedSurface = mix(nightColor * 3.0, dayColor, dayFactor);

  // ── Fresnel 边缘发光（冰蓝色）───────────────────────
  vec3 viewDirNorm = normalize(vViewDir);
  float fresnel = pow(1.0 - max(0.0, dot(viewDirNorm, vNormal)), 3.0);

  // 阶段 17：Fresnel 脉冲增强——微弱的边缘光呼吸（±8%，周期 ~6 秒）
  float fresnelPulse = 1.0 + 0.08 * sin(uTime * 1.047);
  texturedSurface += vec3(0.3, 0.7, 1.0) * fresnel * 0.6 * fresnelPulse;

  // ── 程序化大气散射 ────────────────────────────────
  texturedSurface += atmosphereScattering(vWorldNormal, sunDir);

  // ── 阶段 17：夜景灯光微弱呼吸 ──────────────────────
  // 夜面城市灯光有 ±5% 的呼吸，模拟"活的"城市
  float nightPulse = 1.0 + 0.05 * sin(uTime * 0.8);
  // 仅在夜面应用（dayFactor < 0.5 时）
  texturedSurface *= mix(nightPulse, 1.0, smoothstep(0.2, 0.6, dayFactor));

  // ── 纹理显现过渡（阶段 16）────────────────────────
  // uTextureReveal: 0.0 = 纯冰蓝光球（粒子聚合后的视觉延续）
  //                 1.0 = 完整纹理表面
  vec3 baseGlow = vec3(0.2, 0.5, 0.85) * 0.7;
  // Fresnel 边缘光在过渡期间始终可见，保持轮廓感
  baseGlow += vec3(0.3, 0.7, 1.0) * fresnel * 0.8;

  vec3 surface = mix(baseGlow, texturedSurface, uTextureReveal);

  pc_fragColor = vec4(surface, 1.0);
}
