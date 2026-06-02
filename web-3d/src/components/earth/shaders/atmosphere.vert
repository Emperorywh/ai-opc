// ── Three.js 在 GLSL3 模式下自动注入 ───────────────────
//   #version 300 es / precision highp float
//   in vec3 position; in vec3 normal;
//   uniform mat4 projectionMatrix / modelViewMatrix;
//   uniform mat3 normalMatrix;

// ── 传递给片段着色器 ──────────────────────────────────
out vec3 vNormal;   // 视图空间法线
out vec3 vViewDir;  // 视图空间视线方向

void main() {
  // 视图空间法线 + 视线方向（Fresnel 计算）
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = -mvPosition.xyz;

  gl_Position = projectionMatrix * mvPosition;
}
