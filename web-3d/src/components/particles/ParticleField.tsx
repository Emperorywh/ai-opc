/**
 * 轨道粒子系统
 * ~3000 轨道粒子沿不同倾角椭圆轨道围绕地球公转
 *
 * 设计规格 §6.1：
 * - GPU THREE.Points + 自定义 Shader，单次 draw call
 * - 发光小点，冰蓝色到白色渐变，大小随机（1-3px）
 * - 轨道粒子位置计算在 vertex shader 中完成（GPU 端）
 *
 * 阶段 9 将补全漂浮尘埃部分。
 */
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { ORBITAL_PARTICLE_COUNT } from '../../utils/constants'

import particlesVertexShader from './shaders/particles.vert?raw'
import particlesFragmentShader from './shaders/particles.frag?raw'

/** 轨道半径范围（地球半径 1.0，大气层 1.05，粒子须在更外侧） */
const ORBIT_RADIUS_MIN = 1.2
const ORBIT_RADIUS_MAX = 3.0

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
