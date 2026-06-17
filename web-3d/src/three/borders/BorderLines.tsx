/**
 * 国家边界描边（SPEC §6.3 / §2.4，Task 20）。
 *
 * 单合并 lineSegments（全局顶点池 + borderIndices 成对 setIndex）——Task 19 烘焙的每环闭合
 * 折线段（n 顶点 n 段，含 MultiPolygon 多块 + 洞）。暖白半透明柔和轮廓线（palette.border）。
 *
 * 原生 three lineSegments + lineBasicMaterial（与代码库「无 examples/jsm」约定一致）。SPEC §2.4
 * 「宽度随缩放微调」：WebGL 对 lineBasicMaterial.linewidth 多数驱动仅支持 1，真正可变宽度需
 * fat-line（Line2/LineMaterial），属视觉增强——交 Review。争议虚线（DisputedLines）见 Task 21。
 *
 * 透明渲染顺序（SPEC §4.3）：renderOrder=3（填充=2 之后，线绘于填充之上；< AtmosphereRim=10）。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import type { BoundaryData, TerrainAssets } from '../../data/types'
import {
  buildBoundaryPositions,
  BORDER_LINE_COLOR,
  BORDER_LINE_OPACITY,
  BORDER_LINE_WIDTH,
  BORDER_LINE_MATERIAL_OPTS,
  BORDER_LINE_RENDER_ORDER,
} from './boundaryGeometry'

export function BorderLines({
  assets,
  boundaries,
}: {
  assets: TerrainAssets
  boundaries: BoundaryData
}) {
  // 投影顶点（与 CountryMeshes 同源 buildBoundaryPositions）+ borderIndices 成对 → lineSegments。
  const geometry = useMemo(() => {
    const positions = buildBoundaryPositions(boundaries, assets.elevation, assets.meta)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // borderIndices 成对 (a,b) 引用全局顶点池，lineSegments 以 gl.LINES 绘制。
    g.setIndex(new THREE.BufferAttribute(boundaries.borderIndices, 1))
    g.computeBoundingSphere()
    return g
  }, [assets, boundaries])

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        ...BORDER_LINE_MATERIAL_OPTS,
        color: new THREE.Color(BORDER_LINE_COLOR),
        opacity: BORDER_LINE_OPACITY,
        linewidth: BORDER_LINE_WIDTH,
      }),
    [],
  )

  if (boundaries.borderIndices.length === 0) return null

  return (
    <lineSegments
      geometry={geometry}
      material={material}
      renderOrder={BORDER_LINE_RENDER_ORDER}
    />
  )
}
