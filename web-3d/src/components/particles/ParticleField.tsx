/**
 * 粒子系统主组件
 * 包含轨道粒子 + 漂浮尘埃两部分
 *
 * 设计规格 §6.1：~3000 轨道粒子，GPU Points + 自定义 Shader
 * 设计规格 §6.2：~3000 漂浮尘埃，布朗运动 / simplex noise
 */
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  ORBITAL_PARTICLE_COUNT,
  AMBIENT_DUST_COUNT,
} from '../../utils/constants'

import particlesVertexShader from './shaders/particles.vert?raw'
import particlesFragmentShader from './shaders/particles.frag?raw'
import dustVertexShader from './shaders/dust.vert?raw'
import dustFragmentShader from './shaders/dust.frag?raw'

// ── 轨道粒子常量 ──────────────────────────────────────
/** 轨道半径范围（地球半径 1.0，大气层 1.05，粒子须在更外侧） */
const ORBIT_RADIUS_MIN = 1.2
const ORBIT_RADIUS_MAX = 3.0

// ── 漂浮尘埃常量 ──────────────────────────────────────
/** 尘埃分布球壳内径 */
const DUST_RADIUS_MIN = 1.3
/** 尘埃分布球壳外径 */
const DUST_RADIUS_MAX = 4.0

// ──────────────────────────────────────────────────────
// 轨道粒子组件（阶段 8）
// ──────────────────────────────────────────────────────
export function ParticleField() {
  const { geometry, uniforms } = useMemo(() => {
    const count = ORBITAL_PARTICLE_COUNT
    const geo = new THREE.BufferGeometry()

    // 虚拟 position（Three.js 要求，实际位置在 vertex shader 中计算）
    const positions = new Float32Array(count * 3)

    // 逐粒子 GPU 属性
    const aInitialAngle = new Float32Array(count)
    const aOrbitRadius = new Float32Array(count)
    const aOrbitInclination = new Float32Array(count)
    const aOrbitAscension = new Float32Array(count)
    const aEccentricity = new Float32Array(count)
    const aSpeed = new Float32Array(count)
    const aSize = new Float32Array(count)
    const aBrightness = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // 初始相位角：均匀 0–2π
      aInitialAngle[i] = Math.random() * Math.PI * 2

      // 轨道半径：偏向内轨道的分布（二次映射）
      const t = Math.random()
      aOrbitRadius[i] =
        ORBIT_RADIUS_MIN + (ORBIT_RADIUS_MAX - ORBIT_RADIUS_MIN) * t * t

      // 轨道倾角：全范围 0–π（各类轨道面）
      aOrbitInclination[i] = Math.random() * Math.PI

      // 升交点经度：全范围 0–2π（打散轨道朝向）
      aOrbitAscension[i] = Math.random() * Math.PI * 2

      // 离心率：轻微椭圆，0–0.15
      aEccentricity[i] = Math.random() * 0.15

      // 公转速度：内快外慢（近似开普勒 T²∝r³ → ω∝r^(-1.5)）
      aSpeed[i] =
        0.4 / Math.pow(aOrbitRadius[i], 1.5) * (0.7 + Math.random() * 0.6)

      // 点大小：1–3 px
      aSize[i] = 1.0 + Math.random() * 2.0

      // 亮度：随机 0.2–1.0
      aBrightness[i] = 0.2 + Math.random() * 0.8
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aInitialAngle', new THREE.BufferAttribute(aInitialAngle, 1))
    geo.setAttribute('aOrbitRadius', new THREE.BufferAttribute(aOrbitRadius, 1))
    geo.setAttribute('aOrbitInclination', new THREE.BufferAttribute(aOrbitInclination, 1))
    geo.setAttribute('aOrbitAscension', new THREE.BufferAttribute(aOrbitAscension, 1))
    geo.setAttribute('aEccentricity', new THREE.BufferAttribute(aEccentricity, 1))
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(aSpeed, 1))
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
    geo.setAttribute('aBrightness', new THREE.BufferAttribute(aBrightness, 1))

    const uniforms = {
      uTime: { value: 0 },
    }

    return { geometry: geo, uniforms }
  }, [])

  // 逐帧更新时间 uniform（驱动 shader 内的轨道运动）
  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.getElapsedTime()
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={particlesVertexShader}
        fragmentShader={particlesFragmentShader}
        uniforms={uniforms}
        glslVersion={THREE.GLSL3}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}

// ──────────────────────────────────────────────────────
// 漂浮尘埃组件（阶段 9）
// ──────────────────────────────────────────────────────
export function AmbientDust() {
  const { geometry, uniforms } = useMemo(() => {
    const count = AMBIENT_DUST_COUNT
    const geo = new THREE.BufferGeometry()

    const positions = new Float32Array(count * 3)
    const aSize = new Float32Array(count)
    const aPhase = new Float32Array(count)
    const aDriftSpeed = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // 球壳内随机位置
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      const r =
        DUST_RADIUS_MIN +
        Math.random() * (DUST_RADIUS_MAX - DUST_RADIUS_MIN)

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.cos(phi)
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)

      // 点大小：0.5–1.5 px（比轨道粒子更小）
      aSize[i] = 0.5 + Math.random() * 1.0

      // 随机相位（让噪声轨迹各不相同）
      aPhase[i] = Math.random() * 1000.0

      // 漂移速度：0.05–0.2（很慢）
      aDriftSpeed[i] = 0.05 + Math.random() * 0.15
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1))
    geo.setAttribute('aDriftSpeed', new THREE.BufferAttribute(aDriftSpeed, 1))

    const uniforms = {
      uTime: { value: 0 },
    }

    return { geometry: geo, uniforms }
  }, [])

  // 逐帧更新时间 uniform（驱动 shader 内的噪声布朗运动）
  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.getElapsedTime()
  })

  return (
    <points geometry={geometry} frustumCulled={false}>
      <shaderMaterial
        vertexShader={dustVertexShader}
        fragmentShader={dustFragmentShader}
        uniforms={uniforms}
        glslVersion={THREE.GLSL3}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}
