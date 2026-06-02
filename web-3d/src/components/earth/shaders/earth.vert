precision highp float;

// ── Three.js 内置属性 ──────────────────────────────────
attribute vec3 position;
attribute vec2 uv;
attribute vec3 normal;

// ── Three.js 内置 Uniform ─────────────────────────────
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat3 normalMatrix;

// ── 传递给片段着色器 ──────────────────────────────────
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewDir;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDir = -mvPosition.xyz;

  gl_Position = projectionMatrix * mvPosition;
}
