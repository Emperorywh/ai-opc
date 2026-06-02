// ── 从顶点着色器接收 ──────────────────────────────────
in float vBrightness;
in float vAlpha;

// ── GLSL3 片段输出 ────────────────────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  // ── 高斯发光轮廓 ─────────────────────────────────────
  // 设计规格 §6.4
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = exp(-dist * dist * 8.0);

  // ── 冰蓝色到白色渐变（基于亮度）──────────────────────
  vec3 color = mix(vec3(0.3, 0.7, 1.0), vec3(1.0), vBrightness);

  // ── 最终输出（Additive Blending：srcAlpha * one）────
  float alpha = glow * vAlpha;
  pc_fragColor = vec4(color, 1.0) * alpha;
}
