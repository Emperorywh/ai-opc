/**
 * 地球主体组件
 * 球体几何体 + 自定义 ShaderMaterial（GLSL 300 es）
 * 阶段 2：占位 shader 仅显示白天纹理
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import {
  EARTH_RADIUS,
  EARTH_SEGMENTS,
  EARTH_TILT,
  EARTH_ROTATION_SPEED,
} from '../../utils/constants'

import earthVertexShader from './shaders/earth.vert?raw'
import earthFragmentShader from './shaders/earth.frag?raw'

/** 纹理资源 URL（NASA 公共域影像） */
const TEXTURE_DAY_MAP =
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'
const TEXTURE_NIGHT_MAP =
  'https://unpkg.com/three-globe/example/img/earth-night.jpg'

export function Earth() {
  const meshRef = useRef<THREE.Mesh>(null)

  // 加载白天和夜景纹理（drei useTexture 触发 Suspense）
  const [dayMap, nightMap] = useTexture([TEXTURE_DAY_MAP, TEXTURE_NIGHT_MAP])

  // 纹理配置
  useMemo(() => {
    for (const tex of [dayMap, nightMap]) {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.anisotropy = 4
    }
  }, [dayMap, nightMap])

  // Shader uniforms（useRef 避免 re-render）
  const uniforms = useRef({
    uDayMap: { value: dayMap },
    uNightMap: { value: nightMap },
  })

  // 纹理就绪后写入 uniform
  useFrame(() => {
    if (uniforms.current.uDayMap.value !== dayMap) {
      uniforms.current.uDayMap.value = dayMap
    }
    if (uniforms.current.uNightMap.value !== nightMap) {
      uniforms.current.uNightMap.value = nightMap
    }
  })

  // 地球自转
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += EARTH_ROTATION_SPEED * delta
    }
  })

  return (
    <group rotation={[0, 0, EARTH_TILT]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_RADIUS, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
        <rawShaderMaterial
          vertexShader={earthVertexShader}
          fragmentShader={earthFragmentShader}
          uniforms={uniforms.current}
        />
      </mesh>
    </group>
  )
}
