/**
 * 地表脉冲点组件
 * ~200 个地球表面随机位置周期性闪烁的冰蓝色光点
 *
 * 设计规格 §6.3：
 * - 冰蓝色光点，有径向扩散
 * - 亮起 → 衰减 → 消失，周期 0.5–2 秒
 * - BufferAttribute 动态更新位置和亮度
 * - 跟随地球倾斜和自转
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  SURFACE_PULSE_COUNT,
  EARTH_RADIUS,
  EARTH_TILT,
} from '../../utils/constants'
import { useSceneState } from '../../stores/useSceneState'

import pulseVertexShader from './shaders/pulse.vert?raw'
import pulseFragmentShader from './shaders/pulse.frag?raw'

/** 脉冲点在地球表面之上略微偏移，避免 Z-fighting */
const PULSE_RADIUS = EARTH_RADIUS * 1.005

/** 单个脉冲的生命周期数据 */
interface PulseData {
  /** 当前生命周期相位 [0, 1] */
  phase: number
  /** 生命周期速度（1/秒），控制 0.5–2 秒一个周期 */
  speed: number
  /** 最大亮度 [0.3, 1.0] */
  maxBrightness: number
}

/** 生命周期中"亮起"阶段占比 */
const BRIGHTEN_RATIO = 0.2

/**
 * 生成球面随机位置（归一化球坐标）
 */
function randomSpherePosition(): [number, number, number] {
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  return [
    PULSE_RADIUS * Math.sin(phi) * Math.cos(theta),
    PULSE_RADIUS * Math.cos(phi),
    PULSE_RADIUS * Math.sin(phi) * Math.sin(theta),
  ]
}

export function PulsePoints() {
  const groupRef = useRef<THREE.Group>(null)
  const sceneState = useSceneState()

  const { geometry, pulses, posAttr, alphaAttr, spreadAttr } = useMemo(() => {
    const count = SURFACE_PULSE_COUNT
    const geo = new THREE.BufferGeometry()

    const positions = new Float32Array(count * 3)
    const alphas = new Float32Array(count)
    const pointSizes = new Float32Array(count)
    const spreads = new Float32Array(count)

    const pulseArray: PulseData[] = []

    for (let i = 0; i < count; i++) {
      const [x, y, z] = randomSpherePosition()
      positions[i * 3] = x
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = z

      // 初始相位错开，避免所有脉冲同时亮
      const phase = Math.random()
      // 速度对应 0.5–2 秒一个周期
      const speed = 1.0 / (0.5 + Math.random() * 1.5)
      const maxBrightness = 0.3 + Math.random() * 0.7

      pulseArray.push({ phase, speed, maxBrightness })

      alphas[i] = 0
      // 基础大小 3–6 px
      pointSizes[i] = 3.0 + Math.random() * 3.0
      spreads[i] = 0.0
    }

    const posAttribute = new THREE.BufferAttribute(positions, 3)
    posAttribute.setUsage(THREE.DynamicDrawUsage)

    const alphaAttribute = new THREE.BufferAttribute(alphas, 1)
    alphaAttribute.setUsage(THREE.DynamicDrawUsage)

    const spreadAttribute = new THREE.BufferAttribute(spreads, 1)
    spreadAttribute.setUsage(THREE.DynamicDrawUsage)

    geo.setAttribute('position', posAttribute)
    geo.setAttribute('aAlpha', alphaAttribute)
    geo.setAttribute('aPointSize', new THREE.BufferAttribute(pointSizes, 1))
    geo.setAttribute('aSpread', spreadAttribute)

    return {
      geometry: geo,
      pulses: pulseArray,
      posAttr: posAttribute,
      alphaAttr: alphaAttribute,
      spreadAttr: spreadAttribute,
    }
  }, [])

  // 逐帧：更新脉冲生命周期 + 跟随地球自转
  useFrame((_, delta) => {
    // 跟随地球自转
    if (groupRef.current) {
      groupRef.current.rotation.y = sceneState.current.earthRotation
    }

    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i]
      p.phase += delta * p.speed

      if (p.phase >= 1.0) {
        // 周期结束，重生到新位置
        p.phase = 0
        p.speed = 1.0 / (0.5 + Math.random() * 1.5)
        p.maxBrightness = 0.3 + Math.random() * 0.7

        const [x, y, z] = randomSpherePosition()
        posAttr.setXYZ(i, x, y, z)
      }

      // 亮度曲线：快速亮起 → 缓慢衰减
      const brightness =
        p.phase < BRIGHTEN_RATIO
          ? p.phase / BRIGHTEN_RATIO
          : 1.0 - (p.phase - BRIGHTEN_RATIO) / (1.0 - BRIGHTEN_RATIO)

      alphaAttr.setX(i, brightness * p.maxBrightness)

      // 径向扩散：亮时扩散因子大（点变大），暗时收缩
      spreadAttr.setX(i, 0.5 + brightness * 1.0)
    }

    posAttr.needsUpdate = true
    alphaAttr.needsUpdate = true
    spreadAttr.needsUpdate = true
  })

  return (
    <group rotation={[0, 0, EARTH_TILT]}>
      <group ref={groupRef}>
        <points geometry={geometry} frustumCulled={false}>
          <shaderMaterial
            vertexShader={pulseVertexShader}
            fragmentShader={pulseFragmentShader}
            uniforms={{}}
            glslVersion={THREE.GLSL3}
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </points>
      </group>
    </group>
  )
}
