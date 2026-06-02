// ── Three.js 在 GLSL3 模式下自动注入 ───────────────────
//   #version 300 es / precision highp float
//   in vec3 position; in vec2 uv;
//   uniform mat4 projectionMatrix / modelViewMatrix;

// ── 传递给片段着色器 ──────────────────────────────────
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
