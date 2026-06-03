/**
 * 大气层光晕组件
 * 纯 Fresnel shader —— 边缘冰蓝发光、正面透明、双面渲染
 *
 * 设计规格：
 * - 球体半径 = 1.05 × 地球半径
 * - 双面渲染：背面创造"内发光"，正面创造"外光晕"
 * - side: THREE.DoubleSide
 * - blending: AdditiveBlending（发光叠加）
 * - depthWrite: false（避免遮挡地球）
 *
 * 阶段 16：uFadeIn 控制 activate 阶段光晕亮起动画
 * 阶段 17：uTime 驱动微弱呼吸脉冲（±3% 强度波动）
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { EARTH_RADIUS, LOADING_ACTIVATE_DURATION } from '../../utils/constants'
import { store } from '../../stores/store'

import atmosphereVertexShader from './shaders/atmosphere.vert?raw'
import atmosphereFragmentShader from './shaders/atmosphere.frag?raw'

/** 大气层球体半径 = 1.05 × 地球半径 */
const ATMOSPHERE_RADIUS = EARTH_RADIUS * 1.05
/** 大气层球体细分度（与地球一致） */
const ATMOSPHERE_SEGMENTS = 64
/** 最终发光强度 */
const TARGET_INTENSITY = 1.5

export function Atmosphere() {
  const fadeInStartRef = useRef<number | null>(null)
  const activatedRef = useRef(false)

  const uniforms = useMemo(
    () => ({
      uGlowColor: { value: new THREE.Color(0.3, 0.72, 1.0) },
      uIntensity: { value: 0 }, // 阶段 16：初始不可见
      uTime: { value: 0 },      // 阶段 17：呼吸脉冲
    }),
    [],
  )

  // 阶段 16：activate 阶段光晕亮起动画
  // 阶段 17：持续更新 uTime（驱动呼吸脉冲）
  useFrame(({ clock }) => {
    const phase = store.getState().loading.phase

    // 持续更新时间（呼吸动画在所有可见阶段都运行）
    uniforms.uTime.value = clock.getElapsedTime()

    if (phase === 'activate') {
      if (fadeInStartRef.current === null) {
        fadeInStartRef.current = clock.getElapsedTime()
      }
      const elapsed = clock.getElapsedTime() - fadeInStartRef.current
      const t = Math.min(elapsed / LOADING_ACTIVATE_DURATION, 1.0)
      // smoothstep 缓动让亮起更自然
      const fadeIn = t * t * (3.0 - 2.0 * t)
      uniforms.uIntensity.value = fadeIn * TARGET_INTENSITY

      // 淡入完成 → 由 PostProcessing 负责推进到 done
    } else if (phase === 'done') {
      uniforms.uIntensity.value = TARGET_INTENSITY
      if (!activatedRef.current) {
        activatedRef.current = true
      }
    }
  })

  return (
    <mesh>
      <sphereGeometry args={[ATMOSPHERE_RADIUS, ATMOSPHERE_SEGMENTS, ATMOSPHERE_SEGMENTS]} />
      <shaderMaterial
        vertexShader={atmosphereVertexShader}
        fragmentShader={atmosphereFragmentShader}
        uniforms={uniforms}
        glslVersion={THREE.GLSL3}
        side={THREE.DoubleSide}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  )
}
