/**
 * 地球主体组件
 * 球体几何体 + MeshStandardMaterial（PBR 光照）
 * 使用单张白天纹理，依赖 Three.js 灯光系统
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { EARTH_RADIUS, EARTH_SEGMENTS, EARTH_TILT } from '../../utils/constants'
import { useSceneState } from '../../stores/useSceneState'

/** 白天纹理资源 URL（NASA 公共域影像） */
const TEXTURE_DAY_MAP =
  'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'

export function Earth() {
  const meshRef = useRef<THREE.Mesh>(null)
  const sceneState = useSceneState()
  const dayMap = useTexture(TEXTURE_DAY_MAP)

  // 纹理配置
  useMemo(() => {
    dayMap.colorSpace = THREE.SRGBColorSpace
    dayMap.minFilter = THREE.LinearMipmapLinearFilter
    dayMap.magFilter = THREE.LinearFilter
    dayMap.anisotropy = 4
  }, [dayMap])

  // 地球自转
  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y = sceneState.current.earthRotation
    }
  })

  return (
    <group rotation={[0, 0, EARTH_TILT]}>
      <mesh ref={meshRef}>
        <sphereGeometry args={[EARTH_RADIUS, EARTH_SEGMENTS, EARTH_SEGMENTS]} />
        <meshStandardMaterial
          map={dayMap}
          roughness={0.8}
          metalness={0.1}
        />
      </mesh>
    </group>
  )
}
