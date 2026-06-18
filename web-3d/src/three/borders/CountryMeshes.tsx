/**
 * 国家填充面 mesh（SPEC §6.3 / §4.3，Task 20）+ GPU 颜色拾取编排（SPEC §6.3 D9，Task 22）。
 *
 * ─── 可见填充层（Task 20，不变）─────────────────────────────────────────────────────
 * 单合并 mesh（全局顶点池 + fillIndices 直接 setIndex）——Task 19 pipeline 烘焙的 GPU-ready
 * 数据：所有国家填充三角形共用一份投影顶点 BufferAttribute，一次 draw call。
 *
 * 材质为半透明低饱和 MeshBasicMaterial（SPEC §6.3「默认几乎不可见」），Task 20 几何占位：
 * 高亮层（M7 Task 23）：材质升级为 shader，按 uniform selectedId/hoveredId 提亮匹配国家。
 *
 * 透明渲染顺序（SPEC §4.3）：transparent + depthWrite=false + depthTest=true（默认），
 *   renderOrder=2（Terrain=0 / Ocean=1 之后）→ 读 Terrain 深度，山体遮挡后方填充。
 *
 * ─── 拾取编排层（Task 22，新）─────────────────────────────────────────────────────
 * 独立 picking THREE.Scene + picking Mesh（buildPickingGeometry：同 position + 每顶点国家色 +
 * fillIndices，createPickingMaterial vertexColors 不透明纯 ID 输出）+ 离屏 RT（createPickingTarget
 * NearestFilter）。不在主画布渲染（仅 pickingScene 内），由 pickAt 按需渲染到 RT + 读 1×1。
 *
 * CountryMeshes 挂载时把 `pick(ndcX,ndcY)` 注册到 picking.ts module 寄存器（setPickingApi），
 * Task 23 `usePointerPick.ts` 经 getPickingApi() 调用 → store.setHovered/setSelected 流转。
 * 卸载清理几何/材质/RT + 注销 api。Task 22 不绑指针事件、不动 store 流转（留 Task 23）。
 */
import { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import type { BoundaryData, TerrainAssets } from '../../data/types'
import {
  buildBoundaryPositions,
  COUNTRY_FILL_COLOR,
  COUNTRY_FILL_OPACITY,
  COUNTRY_FILL_MATERIAL_OPTS,
  COUNTRY_FILL_RENDER_ORDER,
} from './boundaryGeometry'
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

  // 注册 pickAt 能力（Task 23 hook 经 getPickingApi 读取）。pickAt 即时渲染 RT + 读 1px（按需，
  // 非每帧）。camera 为稳定实例引用（SandboxControls mutate position/quaternion，pickAt 读当前矩阵）。
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

  // 清理：boundaries 变化重建 picking 几何/材质、size 变化重建 RT 时，dispose 旧资源（防泄漏）。
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
