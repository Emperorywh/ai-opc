precision highp float;

// ── 从顶点着色器接收 ──────────────────────────────────
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDir;

// ── 纹理 Uniform ──────────────────────────────────────
uniform sampler2D uDayMap;
uniform sampler2D uNightMap; // 阶段 3 启用

void main() {
  // 阶段 2 占位：仅显示白天纹理
  vec3 dayColor = texture2D(uDayMap, vUv).rgb;

  gl_FragColor = vec4(dayColor, 1.0);
}
