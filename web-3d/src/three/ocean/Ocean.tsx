/**
 * 海洋 mesh（SPEC §6.2 / §4.3）。
 *
 * Task 06：透明平面 + §4.3 透明渲染顺序（Terrain 先绘写深度、Ocean 后绘关深度写入）。
 * Task 07：oceanMaterial 升级为 Gerstner 海洋 shader（波 + 菲涅尔 + 深浅渐变 + 流动）。
 *
 * 平面与地形同尺寸（PLANE_WIDTH×PLANE_HEIGHT），铺海平面 y=seaLevelWorldY(assets)；
 * rotation[-90° X] 同 Terrain。uTime 每帧累加驱动 Gerstner 波相位流动（§6.2.4）。
 *
 * 材质/几何常量与 seaLevelWorldY 见 ./oceanMaterial（非组件模块，满足 react-refresh 规则）。
 */
import { useMemo, useEffect, useRef } from 'react'
import type { ShaderMaterial } from 'three'
import { useFrame } from '@react-three/fiber'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../../config/projection'
import { qualityConfigs } from '../../config/quality'
import { useStore } from '../../state/store'
import type { TerrainAssets } from '../../data/types'
import {
  OCEAN_SEGMENTS,
  OCEAN_RENDER_ORDER,
  seaLevelWorldY,
  createOceanMaterial,
} from './oceanMaterial'

export function Ocean({ assets }: { assets: TerrainAssets }) {
  const seaY = useMemo(() => seaLevelWorldY(assets), [assets])
  // Task 11：波数随质量档（AdaptiveQuality 写 store qualityTier）；材质重建同源 shader、
  // 仅 uniform 值变（three 复用已编译 program），不动 GLSL（M2 预留 uWaveCount 钩子）。
  const qualityTier = useStore((s) => s.qualityTier)
  const material = useMemo(
    () => createOceanMaterial(assets, { waveCount: qualityConfigs[qualityTier].oceanWaves }),
    [assets, qualityTier],
  )
  // 经 ref 持有 material 供 useFrame 每帧更新 uniform（避开 react-hooks/immutability 规则
  // 对 useMemo 返回值直接 mutate 的误报，同 Task 04 camera 处理思路）。
  const matRef = useRef<ShaderMaterial>(material)
  useEffect(() => {
    matRef.current = material
  }, [material])
  // SPEC §6.2.4：时间驱动流动（Gerstner 波相位随 uTime 滚动）
  useFrame((_, delta) => {
    matRef.current.uniforms.uTime.value += delta
  })
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, seaY, 0]}
      material={material}
      renderOrder={OCEAN_RENDER_ORDER}
    >
      <planeGeometry args={[PLANE_WIDTH, PLANE_HEIGHT, OCEAN_SEGMENTS.x, OCEAN_SEGMENTS.y]} />
    </mesh>
  )
}
