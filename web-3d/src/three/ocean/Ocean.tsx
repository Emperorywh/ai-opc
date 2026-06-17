/**
 * 海洋 mesh（SPEC §6.2 / §4.3，Task 06：透明几何 + 渲染顺序）。
 *
 * Task 06 范围：一张与地形同尺寸的透明平面，铺在海平面
 *   `y = metersToWorldY(seaLevelMeters)`，验证 SPEC §4.3 透明渲染顺序——
 *   Terrain 先绘写深度、Ocean 后绘关深度写入，使海洋不穿透陆地
 *   （陆地顶点 y>0 高于海面 → Ocean 片元 depth test 失败被丢弃；海床 y<0 区域 →
 *   Ocean 通过深度测试绘制半透明海洋）。
 *
 * ⚠️ 不包含（→ Task 07 oceanMaterial.ts）：Gerstner 波顶点位移、菲涅尔柔和反射、
 *    heightmap 水深深浅渐变、时间驱动流动。Task 06 用半透明纯色（oceanShallow）占位，
 *    半透明叠加在 terrainMaterial 的海床占色（y<0 分支）之上。
 *
 * 材质/几何常量与 seaLevelWorldY 见 ./oceanMaterial（非组件模块，满足 react-refresh 规则）。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { PLANE_WIDTH, PLANE_HEIGHT } from '../../config/projection'
import type { TerrainAssets } from '../../data/types'
import {
  OCEAN_SEGMENTS,
  OCEAN_MATERIAL_PROPS,
  OCEAN_RENDER_ORDER,
  seaLevelWorldY,
} from './oceanMaterial'

export function Ocean({ assets }: { assets: TerrainAssets }) {
  const seaY = useMemo(() => seaLevelWorldY(assets), [assets])
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ ...OCEAN_MATERIAL_PROPS }),
    [],
  )
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
