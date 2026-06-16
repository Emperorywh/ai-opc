/**
 * 地形 mesh（SPEC §6.1：GPU 顶点位移平面，Task 04）。
 *
 * PlaneGeometry 平铺 XZ（rotation[-90° X]），细分密度按 TERRAIN_SEGMENTS；
 * 顶点位移 + 基础分层着色由 terrainMaterial 的自定义 ShaderMaterial 完成。
 */
import { useMemo } from 'react'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../../config/projection'
import type { TerrainAssets } from '../../data/types'
import { createTerrainMaterial, TERRAIN_SEGMENTS } from './terrainMaterial'

export function Terrain({ assets }: { assets: TerrainAssets }) {
  const material = useMemo(() => createTerrainMaterial(assets), [assets])
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <planeGeometry
        args={[PLANE_WIDTH, PLANE_HEIGHT, TERRAIN_SEGMENTS.x, TERRAIN_SEGMENTS.y]}
      />
    </mesh>
  )
}
