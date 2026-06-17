/**
 * 国家填充面 mesh（SPEC §6.3 / §4.3，Task 20）。
 *
 * 单合并 mesh（全局顶点池 + fillIndices 直接 setIndex）——Task 19 pipeline 烘焙的 GPU-ready
 * 数据：所有国家填充三角形共用一份投影顶点 BufferAttribute，一次 draw call。
 *
 * 材质为半透明低饱和 MeshBasicMaterial（SPEC §6.3「默认几乎不可见」），本 Task 仅作几何占位：
 *   - 拾取层（M7 Task 22）：同几何加 countryId 顶点属性 + 离屏 RT 纯 ID 颜色渲染。
 *   - 高亮层（M7 Task 23）：材质升级为 shader，按 uniform selectedId/hoveredId 提亮匹配国家。
 *   几何（顶点 + 索引）M6→M7 不变，故本 Task 直接建最终几何。
 *
 * 透明渲染顺序（SPEC §4.3）：transparent + depthWrite=false + depthTest=true（默认），
 *   renderOrder=2（Terrain=0 / Ocean=1 之后）→ 读 Terrain 深度，山体遮挡后方填充。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import type { BoundaryData, TerrainAssets } from '../../data/types'
import {
  buildBoundaryPositions,
  COUNTRY_FILL_COLOR,
  COUNTRY_FILL_OPACITY,
  COUNTRY_FILL_MATERIAL_OPTS,
  COUNTRY_FILL_RENDER_ORDER,
} from './boundaryGeometry'

export function CountryMeshes({
  assets,
  boundaries,
}: {
  assets: TerrainAssets
  boundaries: BoundaryData
}) {
  // 投影顶点（lon,lat → [x,y,z] 贴地）+ fillIndices → BufferGeometry（一次构建，load-time）。
  const geometry = useMemo(() => {
    const positions = buildBoundaryPositions(boundaries, assets.elevation, assets.meta)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // fillIndices 引用全局顶点池 [0, n)，与 position attribute 直接对应。
    g.setIndex(new THREE.BufferAttribute(boundaries.fillIndices, 1))
    g.computeBoundingSphere()
    return g
  }, [assets, boundaries])

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        ...COUNTRY_FILL_MATERIAL_OPTS,
        color: new THREE.Color(COUNTRY_FILL_COLOR),
        opacity: COUNTRY_FILL_OPACITY,
      }),
    [],
  )

  if (boundaries.fillIndices.length === 0) return null

  return <mesh geometry={geometry} material={material} renderOrder={COUNTRY_FILL_RENDER_ORDER} />
}
