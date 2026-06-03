// ── 从顶点着色器接收 ──────────────────────────────────
in float vBrightness;
in float vAlpha;

// ── Uniform ────────────────────────────────────────────
uniform float uFadeOut;    // 淡出因子 0.0（可见）~ 1.0（不可见）

// ── GLSL3 片段输出 ────────────────────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  // ── 高斯发光轮廓（与轨道粒子一致）──────────────────────
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = exp(-dist * dist * 8.0);

  // ── 冰蓝色到亮白色渐变（聚合动画偏亮，视觉冲击更强）────
  vec3 color = mix(vec3(0.3, 0.72, 1.0), vec3(0.85, 0.95, 1.0), vBrightness);

  // ── 最终输出（Additive Blending）──────────────────────
  // uFadeOut 在 texture 阶段从 0 → 1，实现粒子消散
  float alpha = glow * vAlpha * (1.0 - uFadeOut);
  pc_fragColor = vec4(color, 1.0) * alpha;
}
