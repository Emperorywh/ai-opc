/**
 * 地球主体组件
 * 球体几何体 + 自定义 ShaderMaterial（GLSL 300 es）
 * 阶段 3：完整日夜混合 Shader（白天纹理 + 夜景灯光 + Fresnel + 大气散射）
 * 阶段 4：包含大气层光晕子组件
 *
 * 注：Atmosphere 放在 <group rotation={tilt}> 内、地球 <mesh> 外，
 *     因此跟随地球倾斜但不跟随自转——符合规格 §5.3 的视觉意图。
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
import { Atmosphere } from './Atmosphere'

/** 纹理资源 URL（NASA 公共域影像） */
const TEXTURE_DAY_MAP =
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'
const TEXTURE_NIGHT_MAP =
  'https://unpkg.com/three-globe/example/img/earth-night.jpg'

/** 日光方向（世界空间，归一化）：右前方偏上 45° */
const SUN_DIRECTION = new THREE.Vector3(1.0, 0.3, 0.5).normalize()

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
  // Suspense 保证 useTexture 返回时纹理已就绪，可直接写入 uniform
  const uniforms = useMemo(
    () => ({
      uDayMap: { value: dayMap },
      uNightMap: { value: nightMap },
      uSunDirection: { value: SUN_DIRECTION },
    }),
    [dayMap, nightMap],
  )

  // 地球自转（规格 §5.4：0.02 rad/s）
  useFrame((_, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += EARTH_ROTATION_SPEED * delta
    }
  })

  return (
    <group rotation={[0, 0, EARTH_TILT]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_RADIUS, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
        <shaderMaterial
          vertexShader={earthVertexShader}
          fragmentShader={earthFragmentShader}
          uniforms={uniforms}
          glslVersion={THREE.GLSL3}
        />
      </mesh>
      {/* 大气层光晕（阶段 4） */}
      <Atmosphere />
    </group>
  )
}
