// ── 从顶点着色器接收 ──────────────────────────────────
in vec3 vNormal;   // 视图空间法线
in vec3 vViewDir;  // 视图空间视线方向

// ── Uniform ────────────────────────────────────────────
uniform vec3 uGlowColor;    // 冰蓝发光颜色
uniform float uIntensity;   // 发光强度

// ── GLSL3 需要手动声明片段输出变量 ────────────────────
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  vec3 viewDirNorm = normalize(vViewDir);
  vec3 normalNorm  = normalize(vNormal);

  // Fresnel 效果：边缘厚且明亮，正面完全透明
  float fresnel = pow(1.0 - max(0.0, dot(viewDirNorm, normalNorm)), 3.0);

  // 冰蓝色发光，强度由 Fresnel 和 uniform 控制
  vec3 glow = uGlowColor * fresnel * uIntensity;
  float alpha = fresnel * uIntensity;

  pc_fragColor = vec4(glow, alpha);
}
