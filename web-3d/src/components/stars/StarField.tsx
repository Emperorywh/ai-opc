/**
 * 程序化星空组件
 * 使用 fragment shader 在球面内侧生成伪随机星空
 *
 * 设计规格：
 * - ~2000 颗星星，独立闪烁频率和相位
 * - 随机大小（0.5-2px）
 * - 相机视差偏移增加深度感
 * - 渲染为反转法线的大球面（从内部看）
 */
import { useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

import starsVertexShader from './shaders/stars.vert?raw'
import starsFragmentShader from './shaders/stars.frag?raw'

/** 星空球面半径——远大于地球，确保在背景层 */
const STAR_SPHERE_RADIUS = 500
/** 球面细分度（足够细腻即可，远处无需太高） */
const STAR_SPHERE_SEGMENTS = 32

export function StarField() {
  const { camera } = useThree()

  // Shader uniforms
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
    }),
    [],
  )

  // 逐帧更新时间和相机位置（视差用）
  useFrame(({ clock }) => {
    uniforms.uTime.value = clock.getElapsedTime()
    uniforms.uCameraPos.value.copy(camera.position)
  })

  return (
    <mesh>
      <sphereGeometry args={[STAR_SPHERE_RADIUS, STAR_SPHERE_SEGMENTS, STAR_SPHERE_SEGMENTS]} />
      <shaderMaterial
        vertexShader={starsVertexShader}
        fragmentShader={starsFragmentShader}
        uniforms={uniforms}
        glslVersion={THREE.GLSL3}
        side={THREE.BackSide}
        depthWrite={false}
      />
    </mesh>
  )
}
