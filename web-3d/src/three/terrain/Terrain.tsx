/**
 * 地形 mesh（SPEC §6.1：GPU 顶点位移平面，Task 04）。
 *
 * PlaneGeometry 平铺 XZ（rotation[-90° X]），细分密度按 TERRAIN_SEGMENTS；
 * 顶点位移 + 基础分层着色由 terrainMaterial 的自定义 ShaderMaterial 完成。
 */
import { useMemo } from 'react'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../../config/projection'
import { qualityConfigs } from '../../config/quality'
import { useStore } from '../../state/store'
import type { TerrainAssets } from '../../data/types'
import { createTerrainMaterial, TERRAIN_SEGMENTS } from './terrainMaterial'

export function Terrain({ assets }: { assets: TerrainAssets }) {
  // Task 11：水彩效果开关随质量档（AdaptiveQuality 写 store qualityTier）；材质重建同源
  // shader、仅 uniform 值变，不动 GLSL（M2 预留 5 个 effect uniform 钩子）。
  const qualityTier = useStore((s) => s.qualityTier)
  const material = useMemo(
    () => createTerrainMaterial(assets, qualityConfigs[qualityTier].terrainEffects),
    [assets, qualityTier],
  )
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <planeGeometry
        args={[PLANE_WIDTH, PLANE_HEIGHT, TERRAIN_SEGMENTS.x, TERRAIN_SEGMENTS.y]}
      />
    </mesh>
  )
}
