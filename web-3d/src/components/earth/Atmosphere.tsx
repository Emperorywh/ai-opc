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
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { EARTH_RADIUS } from '../../utils/constants'

import atmosphereVertexShader from './shaders/atmosphere.vert?raw'
import atmosphereFragmentShader from './shaders/atmosphere.frag?raw'

/** 大气层球体半径 = 1.05 × 地球半径 */
const ATMOSPHERE_RADIUS = EARTH_RADIUS * 1.05
/** 大气层球体细分度（与地球一致） */
const ATMOSPHERE_SEGMENTS = 64

export function Atmosphere() {
  const uniforms = useMemo(
    () => ({
      uGlowColor: { value: new THREE.Color(0.3, 0.72, 1.0) },
      uIntensity: { value: 1.5 },
    }),
    [],
  )

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
