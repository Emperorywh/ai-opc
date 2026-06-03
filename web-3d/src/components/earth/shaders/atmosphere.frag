// ── 从顶点着色器接收 ──────────────────────────────────
in vec3 vNormal;   // 视图空间法线
in vec3 vViewDir;  // 视图空间视线方向

// ── Uniform ────────────────────────────────────────────
uniform vec3 uGlowColor;    // 冰蓝发光颜色
uniform float uIntensity;   // 发光强度
uniform float uTime;        // 运行时间（阶段 17：呼吸脉冲）

// ── GLSL3 需要手动声明片段输出变量 ────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  vec3 viewDirNorm = normalize(vViewDir);
  vec3 normalNorm  = normalize(vNormal);

  // Fresnel 效果：边缘厚且明亮，正面完全透明
  float fresnel = pow(1.0 - max(0.0, dot(viewDirNorm, normalNorm)), 3.0);

  // ── 阶段 17：微弱呼吸脉冲 ────────────────────────────
  // ±3% 的强度波动，周期约 4 秒，几乎不可察觉但让场景感觉"活着"
  float breathe = 1.0 + 0.03 * sin(uTime * 1.57);

  // 冰蓝色发光，强度由 Fresnel 和 uniform 控制
  vec3 glow = uGlowColor * fresnel * uIntensity * breathe;
  float alpha = fresnel * uIntensity * breathe;

  pc_fragColor = vec4(glow, alpha);
}
