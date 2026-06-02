// ── 地表脉冲点片段着色器 ──────────────────────────────
// 设计规格 §6.3：冰蓝色光点，径向扩散发光

in float vAlpha;

// ── GLSL3 片段输出 ────────────────────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  // ── 柔和的径向发光（比轨道粒子更宽更扩散）───────────
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = exp(-dist * dist * 4.0);

  // ── 冰蓝色（与大气层 Fresnel 发光一致）──────────────
  vec3 color = vec3(0.3, 0.72, 1.0);

  // ── 最终输出（Additive Blending）────────────────────
  float alpha = glow * vAlpha;
  pc_fragColor = vec4(color, 1.0) * alpha;
}
