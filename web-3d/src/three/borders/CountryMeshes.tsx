/**
 * 国家填充面 mesh（SPEC §6.3 / §4.3，Task 20）+ GPU 颜色拾取编排（SPEC §6.3 D9，Task 22）
 *   + hover/selected 高亮（SPEC §6.3「高亮层」，Task 23）。
 *
 * ─── 可见填充层（Task 20）─────────────────────────────────────────────────────────
 * 单合并 mesh（全局顶点池 + fillIndices 直接 setIndex）——Task 19 pipeline 烘焙的 GPU-ready
 * 数据：所有国家填充三角形共用一份投影顶点 BufferAttribute，一次 draw call。
 *
 * 透明渲染顺序（SPEC §4.3）：transparent + depthWrite=false + depthTest=true（默认），
 *   renderOrder=2（Terrain=0 / Ocean=1 之后）→ 读 Terrain 深度，山体遮挡后方填充。
 *
 * ─── Task 23 高亮层（升级可见材质）────────────────────────────────────────────────
 * Task 20 MeshBasicMaterial 占位 → 高亮 ShaderMaterial（highlight.ts）：
 *   - geometry 加每顶点 `countryId` attribute（buildCountryIdAttribute，与 picking 同源 0-based id）；
 *   - 材质按 uniform uHoveredId/uSelectedId 提亮匹配国家 + selected 边缘发光（fwidth(vCountryId)）。
 * 订阅 store hoveredId/selectedId → useEffect 同步这两个 uniform value（material 引用稳定，
 * 仅改 uniform，不重建 —— 同 Ocean matRef 同步 uniform 模式）。null → HIGHLIGHT_NONE_ID(-1) 哨兵。
 *
 * ─── 拾取编排层（Task 22）─────────────────────────────────────────────────────────
 * 独立 picking THREE.Scene + picking Mesh（buildPickingGeometry：同 position + 每顶点国家色 +
 * fillIndices，createPickingMaterial vertexColors 不透明纯 ID 输出）+ 离屏 RT（createPickingTarget
 * NearestFilter）。不在主画布渲染（仅 pickingScene 内），由 pickAt 按需渲染到 RT + 读 1×1。
 *
 * CountryMeshes 挂载时把 `pick(ndcX,ndcY)` 注册到 picking.ts module 寄存器（setPickingApi），
 * Task 23 usePointerPick.ts 经 getPickingApi() 调用 → store.setHovered/setSelected 流转 → 本组件
 * 订阅 → 高亮。卸载清理几何/材质/RT + 注销 api。
 */
import { useMemo, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { BoundaryData, TerrainAssets } from '../../data/types'
import { useStore } from '../../state/store'
import { buildBoundaryPositions, COUNTRY_FILL_RENDER_ORDER } from './boundaryGeometry'
import {
  buildCountryIdAttribute,
  createHighlightMaterial,
  HIGHLIGHT_NONE_ID,
} from './highlight'
import {
  buildPickingGeometry,
  createPickingMaterial,
  createPickingTarget,
  pickAt,
  setPickingApi,
} from './picking'

export function CountryMeshes({
  assets,
  boundaries,
}: {
  assets: TerrainAssets
  boundaries: BoundaryData
}) {
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)

  // 投影顶点（lon,lat → [x,y,z] 贴地）+ countryId 顶点属性 + fillIndices → BufferGeometry。
  // Task 23：加 countryId attribute（高亮 shader 据此匹配 hover/selected + fwidth 检测国家边界）。
  const geometry = useMemo(() => {
    const positions = buildBoundaryPositions(boundaries, assets.elevation, assets.meta)
    const countryIds = buildCountryIdAttribute(boundaries)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // fillIndices 引用全局顶点池 [0, n)，与 position attribute 直接对应。
    g.setIndex(new THREE.BufferAttribute(boundaries.fillIndices, 1))
    // countryId：每顶点国家 id（0-based），shader fwidth(countryId) 检测国家边界。
    g.setAttribute('countryId', new THREE.BufferAttribute(countryIds, 1))
    g.computeBoundingSphere()
    return g
  }, [assets, boundaries])

  // Task 23：高亮 ShaderMaterial（hover/selected 提亮 + selected 边缘发光）。引用稳定（useMemo []），
  // store 变化仅同步 uniform value，不重建材质（three 复用已编译 program）。
  const material = useMemo(() => createHighlightMaterial(), [])
  // 经 ref 持有 material 供 useEffect 更新 uniform（避开 react-hooks/immutability 规则对 useMemo
  // 返回值直接 mutate 的误报，同 Ocean matRef 模式）。
  const matRef = useRef(material)
  useEffect(() => {
    matRef.current = material
  }, [material])

  // Task 23：订阅 store hovered/selected → 同步 shader uniform（null → -1 哨兵）。命中变化才触发
  // store 更新（usePointerPick 守），故 re-render 频率受控。
  const hoveredId = useStore((s) => s.hoveredId)
  const selectedId = useStore((s) => s.selectedId)
  useEffect(() => {
    matRef.current.uniforms.uHoveredId.value = hoveredId == null ? HIGHLIGHT_NONE_ID : hoveredId
  }, [hoveredId])
  useEffect(() => {
    matRef.current.uniforms.uSelectedId.value = selectedId == null ? HIGHLIGHT_NONE_ID : selectedId
  }, [selectedId])

  // Task 22：拾取编排——独立 picking scene + mesh（同几何 + 每顶点国家色）。
  // 不加入主画布；由 pickAt 按需渲染到 RT。geometry/material 随 boundaries 重建时 dispose（见下 effect）。
  const picking = useMemo(() => {
    const pickGeometry = buildPickingGeometry(boundaries, assets.elevation, assets.meta)
    const pickMaterial = createPickingMaterial()
    const pickMesh = new THREE.Mesh(pickGeometry, pickMaterial)
    const pickingScene = new THREE.Scene()
    pickingScene.add(pickMesh)
    return { pickingScene, pickGeometry, pickMaterial }
  }, [assets, boundaries])

  // 拾取 RT 跟随 canvas 渲染尺寸（指针 NDC→像素映射精确，小国家不丢亚像素）。
  const target = useMemo(
    () => createPickingTarget(size.width, size.height),
    [size.width, size.height],
  )

  // 注册 pickAt 能力（Task 23 usePointerPick 经 getPickingApi 读取）。pickAt 即时渲染 RT + 读 1px
  // （按需，非每帧）。camera 为稳定实例引用（SandboxControls mutate position/quaternion，pickAt 读当前矩阵）。
  useEffect(() => {
    const api = {
      pick: (ndcX: number, ndcY: number) =>
        pickAt(gl, target, picking.pickingScene, camera, ndcX, ndcY),
    }
    setPickingApi(api)
    return () => {
      setPickingApi(null)
    }
  }, [gl, target, picking, camera])

  // 清理：可见 geometry / 高亮 material / picking 几何材质 / RT 重建或卸载时 dispose（防泄漏）。
  useEffect(() => {
    return () => {
      geometry.dispose()
    }
  }, [geometry])

  useEffect(() => {
    return () => {
      material.dispose()
    }
  }, [material])

  useEffect(() => {
    return () => {
      picking.pickGeometry.dispose()
      picking.pickMaterial.dispose()
    }
  }, [picking])

  useEffect(() => {
    return () => {
      target.dispose()
    }
  }, [target])

  if (boundaries.fillIndices.length === 0) return null

  return <mesh geometry={geometry} material={material} renderOrder={COUNTRY_FILL_RENDER_ORDER} />
}
