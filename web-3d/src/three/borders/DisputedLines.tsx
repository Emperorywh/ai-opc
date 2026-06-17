/**
 * 争议边界虚线（SPEC §6.3 / §2.4 / D10，Task 21）。
 *
 * 单合并 lineSegments——Task 19 disputed.bin 烘焙的全局折线顶点池，经 buildDisputedSegments
 * 展开成成对独立顶点 + **手动 lineDistance attribute**（沿每条争议线累积弧长 → 虚线连续，不逐段
 * 断裂）。LineDashedMaterial 暖灰虚线（palette.disputed），柔和，教育中立表达争议区
 * （克什米尔 / 克里米亚 / 西撒哈拉等）。
 *
 * 数据源变体（D10）：MVP 固定 Natural Earth（config/boundaryVariant CURRENT_BOUNDARY_VARIANT=ne）；
 * 接口预留可切换中文版 / 国际版，渲染层不因变体改变（争议虚线表达统一，仅数据源可替换）。
 *
 * 透明渲染顺序（SPEC §4.3）：renderOrder=4（描边=3 之后，最上层边界表达；< AtmosphereRim=10）。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import type { DisputedData, TerrainAssets } from '../../data/types'
import {
  buildDisputedSegments,
  DISPUTED_LINE_COLOR,
  DISPUTED_LINE_OPACITY,
  DISPUTED_DASH_SIZE,
  DISPUTED_GAP_SIZE,
  DISPUTED_LINE_MATERIAL_OPTS,
  DISPUTED_RENDER_ORDER,
} from './boundaryGeometry'

export function DisputedLines({
  assets,
  disputed,
}: {
  assets: TerrainAssets
  disputed: DisputedData
}) {
  // 折线顶点（lon,lat）→ project + 贴地 + 展开成 lineSegments 顶点 + 手动 lineDistance（连续虚线）。
  const geometry = useMemo(() => {
    const { positions, lineDistances } = buildDisputedSegments(
      disputed,
      assets.elevation,
      assets.meta,
    )
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // LineDashedMaterial 读取 lineDistance attribute → vLineDistance → 虚线。手动累积（非
    // computeLineDistances：后者对 lineSegments 每段重置致虚线逐段断裂）。
    g.setAttribute('lineDistance', new THREE.BufferAttribute(lineDistances, 1))
    g.computeBoundingSphere()
    return g
  }, [assets, disputed])

  const material = useMemo(
    () =>
      new THREE.LineDashedMaterial({
        ...DISPUTED_LINE_MATERIAL_OPTS,
        color: new THREE.Color(DISPUTED_LINE_COLOR),
        opacity: DISPUTED_LINE_OPACITY,
        dashSize: DISPUTED_DASH_SIZE,
        gapSize: DISPUTED_GAP_SIZE,
      }),
    [],
  )

  // 无有效段（所有 line vertexCount<2）→ 不渲染（与 BorderLines 空 index 守卫同模式）。
  if (disputed.lines.every((l) => l.vertexCount < 2)) return null

  return (
    <lineSegments
      geometry={geometry}
      material={material}
      renderOrder={DISPUTED_RENDER_ORDER}
    />
  )
}
