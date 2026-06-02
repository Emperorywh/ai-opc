// ── 漂浮尘埃片段着色器 ─────────────────────────────────
// 设计规格 §6.2：极小极淡的点，透明度很低

in float vAlpha;

// ── GLSL3 片段输出 ────────────────────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  // ── 高斯发光轮廓（比轨道粒子更紧凑）──────────────────
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = exp(-dist * dist * 12.0);

  // ── 稍暖的淡蓝白色（比轨道粒子更暗淡）──────────────
  vec3 color = vec3(0.5, 0.7, 0.85);

  // ── 最终输出（Additive Blending）───────────────────
  float alpha = glow * vAlpha;
  pc_fragColor = vec4(color, 1.0) * alpha;
}
