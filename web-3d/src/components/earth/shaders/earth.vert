// ── Three.js 在 GLSL3 模式下自动注入 ───────────────────
//   #version 300 es / precision highp float
//   in vec3 position; in vec2 uv; in vec3 normal;
//   uniform mat4 projectionMatrix / modelViewMatrix / modelMatrix;
//   uniform mat3 normalMatrix;

// ── 传递给片段着色器 ──────────────────────────────────
out vec2 vUv;
out vec3 vNormal;       // 视图空间法线（Fresnel 用）
out vec3 vWorldNormal;  // 世界空间法线（日光方向用）
out vec3 vViewDir;      // 视图空间视线方向

void main() {
  vUv = uv;

  // 视图空间法线 + 视线方向（Fresnel 边缘发光计算）
  vNormal = normalize(normalMatrix * normal);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = -mvPosition.xyz;

  // 世界空间法线（日光方向 / 日夜混合计算）
  // 地球仅有旋转变换（无缩放），mat3(modelMatrix) 足够精确
  vWorldNormal = normalize(mat3(modelMatrix) * normal);

  gl_Position = projectionMatrix * mvPosition;
}
