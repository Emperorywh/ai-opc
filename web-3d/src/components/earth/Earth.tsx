/**
 * 地球主体组件
 * 球体几何体 + 自定义 ShaderMaterial（GLSL 300 es）
 * 阶段 3：完整日夜混合 Shader（白天纹理 + 夜景灯光 + Fresnel + 大气散射）
 * 阶段 4：包含大气层光晕子组件
 * 阶段 16：纹理显现过渡动画——uTextureReveal 0→1 驱动 shader 混合
 * 阶段 17：uTime 传入 shader（Fresnel 脉冲 + 夜景呼吸）
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
  LOADING_TEXTURE_REVEAL_DURATION,
} from '../../utils/constants'
import { useSceneState } from '../../stores/useSceneState'
import { store } from '../../stores/store'
import { setLoadingPhase } from '../../stores/loadingSlice'

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
  const sceneState = useSceneState()
  const revealStartRef = useRef<number | null>(null)
  const revealDoneRef = useRef(false)

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
  const uniforms = useMemo(
    () => ({
      uDayMap: { value: dayMap },
      uNightMap: { value: nightMap },
      uSunDirection: { value: SUN_DIRECTION },
      uTextureReveal: { value: 0 }, // 阶段 16：初始无纹理
      uTime: { value: 0 },          // 阶段 17：Fresnel 脉冲 + 夜景呼吸
    }),
    [dayMap, nightMap],
  )

  // 地球自转 + 纹理显现动画 + uTime 更新
  useFrame(({ clock }) => {
    // ── 自转 ──────────────────────────────────────────
    if (meshRef.current) {
      meshRef.current.rotation.y = sceneState.current.earthRotation
    }

    // ── uTime 持续更新（视觉动态效果）──────────────────
    uniforms.uTime.value = clock.getElapsedTime()

    // ── 纹理显现过渡（阶段 16）─────────────────────────
    // 组件挂载时纹理已就绪（Suspense 保证），立即开始显现动画
    const phase = store.getState().loading.phase
    if (phase === 'texture' || phase === 'activate' || phase === 'done') {
      if (revealStartRef.current === null) {
        revealStartRef.current = clock.getElapsedTime()
      }

      const elapsed = clock.getElapsedTime() - revealStartRef.current
      const reveal = Math.min(elapsed / LOADING_TEXTURE_REVEAL_DURATION, 1.0)
      uniforms.uTextureReveal.value = reveal

      // 显现完成 → 推进到 activate 阶段
      if (reveal >= 1.0 && !revealDoneRef.current && phase === 'texture') {
        revealDoneRef.current = true
        store.dispatch(setLoadingPhase('activate'))
      }
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
      {/* 大气层光晕（阶段 4，阶段 16 增加 fadeIn，阶段 17 增加呼吸脉冲） */}
      <Atmosphere />
    </group>
  )
}
