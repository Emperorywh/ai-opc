/**
 * 手势光标视觉组件（阶段 14）
 *
 * 设计规格 §7.5 手势光标：
 * - 从手掌中心投射半透明光线到地球表面
 * - 光标落点处产生冰蓝色涟漪效果
 * - 手离开时光标淡出（~0.3s 过渡）
 *
 * 视觉组成：
 * 1. 光束（THREE.Line）：冰蓝色半透明线段，从表面法线上方投射到交点
 * 2. 涟漪（ShaderMaterial 平面）：交点处冰蓝色脉冲波纹，面向地球法线方向
 */
import { useRef, useMemo, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useGestureCursor } from '../../hooks/useGestureCursor'
import { COLOR_PRIMARY } from '../../utils/constants'

// ── 涟漪着色器 ──────────────────────────────────────────

/** 涟漪顶点着色器（GLSL 300 es） */
const RIPPLE_VERT = /* glsl */ `
// Three.js GLSL3 自动注入 position / uv / projectionMatrix / modelViewMatrix
out vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

/** 涟漪片段着色器（GLSL 300 es） */
const RIPPLE_FRAG = /* glsl */ `
in vec2 vUv;

uniform float uTime;
uniform float uOpacity;

// GLSL3 片段输出
layout(location = 0) out highp vec4 pc_fragColor;

void main() {
  vec2 center = vUv - 0.5;
  float dist = length(center) * 2.0; // 0 中心 → 1 边缘

  // ── 扩散涟漪环 ────────────────────────────────────
  float speed = 2.5;
  float wave = sin((dist * 12.0 - uTime * speed) * 3.14159);
  wave = wave * 0.5 + 0.5; // [0, 1]

  // ── 边缘和中心衰减 ──────────────────────────────────
  float fade = smoothstep(0.0, 0.15, dist) * (1.0 - smoothstep(0.35, 1.0, dist));

  // ── 冰蓝色（与大气层 Fresnel 一致）──────────────────
  vec3 color = vec3(0.3, 0.72, 1.0);

  // ── Additive Blending 输出 ─────────────────────────
  float alpha = wave * fade * uOpacity * 0.9;
  pc_fragColor = vec4(color, 1.0) * alpha;
}
`

/** 涟漪平面尺寸（Three.js 单位） */
const RIPPLE_SIZE = 0.2

/** 预分配法线对齐四元数 */
const _normalQuat = new THREE.Quaternion()
const _defaultUp = new THREE.Vector3(0, 0, 1)

export function GestureCursor() {
  const cursorState = useGestureCursor()
  const groupRef = useRef<THREE.Group>(null)

  // ── 创建 Three.js 对象（只创建一次）──────────────────
  const { beamLine, beamGeo, beamMat, rippleMesh, rippleMat } = useMemo(() => {
    // 光束
    const beamGeo = new THREE.BufferGeometry()
    beamGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(new Float32Array(6), 3),
    )
    const beamMat = new THREE.LineBasicMaterial({
      color: COLOR_PRIMARY,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const beamLine = new THREE.Line(beamGeo, beamMat)
    beamLine.visible = false
    beamLine.frustumCulled = false

    // 涟漪
    const rippleMat = new THREE.ShaderMaterial({
      vertexShader: RIPPLE_VERT,
      fragmentShader: RIPPLE_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      glslVersion: THREE.GLSL3,
    })
    const rippleGeo = new THREE.PlaneGeometry(RIPPLE_SIZE, RIPPLE_SIZE)
    const rippleMesh = new THREE.Mesh(rippleGeo, rippleMat)
    rippleMesh.visible = false
    rippleMesh.frustumCulled = false

    return { beamLine, beamGeo, beamMat, rippleMesh, rippleMat }
  }, [])

  // ── 挂载到场景 ──────────────────────────────────────
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.add(beamLine)
    group.add(rippleMesh)
    return () => {
      group.remove(beamLine)
      group.remove(rippleMesh)
      beamGeo.dispose()
      beamMat.dispose()
      rippleMat.dispose()
      rippleMesh.geometry.dispose()
    }
  }, [beamLine, beamGeo, beamMat, rippleMesh, rippleMat])

  // ── 每帧更新 ────────────────────────────────────────
  useFrame(() => {
    const s = cursorState.current
    const show = s.opacity > 0.01

    // 光束
    beamLine.visible = show
    if (show) {
      const pos = beamGeo.attributes.position.array as Float32Array
      pos[0] = s.beamStart.x
      pos[1] = s.beamStart.y
      pos[2] = s.beamStart.z
      pos[3] = s.beamEnd.x
      pos[4] = s.beamEnd.y
      pos[5] = s.beamEnd.z
      beamGeo.attributes.position.needsUpdate = true
      beamMat.opacity = s.opacity * 0.6
    }

    // 涟漪
    rippleMesh.visible = show
    if (show) {
      rippleMesh.position.copy(s.rippleCenter)
      // 面向地球法线方向（平面 +Z 轴对齐到法线）
      _normalQuat.setFromUnitVectors(_defaultUp, s.rippleNormal)
      rippleMesh.quaternion.copy(_normalQuat)
      // 涟漪平面微微浮出地球表面，避免 z-fighting
      rippleMesh.position.addScaledVector(s.rippleNormal, 0.005)
      rippleMat.uniforms.uTime.value = s.rippleTime
      rippleMat.uniforms.uOpacity.value = s.opacity
    }
  })

  return <group ref={groupRef} />
}
