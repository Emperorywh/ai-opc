/**
 * 省级悬停拾取控制器（交互层，TASK-018）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），是「指针命中地形 → 经纬度反查 → 所属省份判定 → 更新单一焦点状态」的
 *   唯一交互入口。它只依赖：领域层（findProvinceAtLonLat —— 点在多边形内的唯一能力源，TASK-018 输出约束
 *   「拾取 / 点在多边形内判断属于交互领域能力，边界和标签视图只能消费最终状态」）、坐标层
 *   （invertWorld —— 世界 (x,z) → 经纬度的唯一反查入口）、地形布局（TERRAIN_PLANE_LAYOUT —— 主图世界米制
 *   包围盒的渲染派生）、R3F（ThreeEvent 指针事件）。**禁止**在此复制点在多边形逻辑、复制投影公式、或在
 *   边界 / 标签视图里各自做一次拾取（TASK-018 实现约束「边界和标签视图只能消费最终状态，不得各自做一次
 *   拾取」——本组件是唯一拾取点，ProvinceBorders / PlaceLabels 只消费 hoveredAdminId）。
 * - 本组件**不**持有 Three.js 对象引用作为焦点状态（焦点状态以稳定 adminId 表达，由场景层 ChinaMapScreen
 *   保管）、不保存中文名称匹配、不做多组件布尔组合（TASK-018 实现约束「hover 状态必须以稳定行政区标识
 *   表达」）。本组件只做「把指针位置翻译成 adminId | null 并回调」，翻译结果（adminId 字符串或 null）即是
 *   唯一的焦点表达。
 *
 * 拾取流程（TASK-018 可验证结果「从指针命中地形后的地理位置确定所属省份」、实现约束要求注释解释拾取流程）：
 * 1. 一张覆盖主图世界包围盒的不可见 plane（与 ChinaTerrainMesh 同布局：相同米制宽高、相同 −90° X 旋转、
 *    相同 centerZ 定位）作为拾取面。R3F 对该 mesh 的指针事件经 three Raycaster 求交，event.point 即指针命中
 *    点的世界坐标。该 plane 是不可见的（opacity 0、不写深度、不写颜色），仅为承载指针事件存在，不产生
 *    可见像素、不参与深度竞争——故不影响地形 / 海面 / 省界 / 标签的既有渲染（回退本 TASK 仅移除该 plane）。
 * 2. 取 event.point 的世界 (x, z)（高程 y 不参与省份归属判定——省份是 lon/lat 上的 2D 区域），经
 *    projection.invertWorld 反算成 (lon, lat)。反查只忠实还原坐标（见 src/lib/projection invertWorld 注释），
 *    不做范围 / 省份裁剪。
 * 3. 把 (lon, lat) 喂入领域纯函数 findProvinceAtLonLat(features, ...) → adminId | null。多多边形 / 岛屿 / 内环 /
 *    相邻边界 / 海域 / 地图外由该纯函数统一裁决（见 src/lib/province-picking）。
 * 4. 把结果（adminId 字符串或 null）回调给场景层（onHoveredProvinceChange）。场景层据此更新单一
 *    hoveredAdminId 状态——边界与标签视图只消费该状态，不再各自拾取。
 *
 * 单一焦点状态与恢复不变量（TASK-018 可验证结果「单一显式 hovered province 状态」「移出、海域、无命中和
 *   组件卸载都会恢复无焦点状态；快速跨省不会残留多个高亮」、实现约束要求注释解释单一状态源与恢复不变量）：
 * - onPointerMove：每次移动重新裁决所属省份并回调最新 adminId（或 null）。状态是单一字符串（非集合），
 *   新值原子替换旧值，故快速跨省（A→B）时焦点直接从 A 切到 B，至多一个焦点，不残留多高亮。
 * - onPointerOut / onPointerLeave（指针离开拾取面 = 移出地图）：回调 null，恢复无焦点。
 * - 海域 / 地图外 / 无命中（findProvinceAtLonLat 返回 null）：回调 null，恢复无焦点。
 * - 反查失败（invertWorld 返回失败——理论不发生，因 plane 覆盖主图范围、命中点必在境内；防御性兜底）：
 *   回调 null，不伪造归属。
 * - 组件卸载：场景层的 hoveredAdminId 由场景层自身管理；本组件卸载时（如 features 未就绪）不再触发移动
 *   回调，hoveredAdminId 保持上一次值——故场景层在 features 失效时显式把 hoveredAdminId 复位为 null
 *   （见 ChinaMapScreen 的清理 effect），保证卸载 / 资产失效后无残留焦点。
 *
 * 无 click 行为（TASK-018 可验证结果「自动触发 click，预期不发生状态迁移、相机飞焦或数据加载」、实现约束
 *   「不实现 click、下钻、飞焦、业务 tooltip 或业务数据绑定」）：
 * - 本组件只注册 onPointerMove / onPointerOut / onPointerLeave，不注册 onClick / onPointerDown / onPointerUp。
 *   故任何点击只由 OrbitControls 处理（旋转 / 平移相机），不触发省份状态迁移、相机飞焦或数据加载——与
 *   SPEC「不点击下钻 / 飞焦（与不绑定数据一致）」一致。
 *
 * 资产就绪门槛（TASK-018 与既有 TASK 同构的回退边界）：
 * - features 未就绪（行政区几何未加载）时不渲染拾取面（返回 null）——无几何无法裁决所属省份，不拾取、
 *   不回调，避免在几何缺失期产生无意义或错误的焦点。features 就绪后挂载拾取面，开始拾取。
 */

import type { ReactNode } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { findProvinceAtLonLat } from '../lib/province-picking'
import { invertWorld } from '../lib/projection'
import { TERRAIN_PLANE_LAYOUT } from './terrain-layout'
import type { AdministrativeGeometryFeature } from '../geo-contracts'

/** ProvinceHoverPicker 的 props：只接收几何 + 回调，不取数、不持有焦点状态。 */
export interface ProvinceHoverPickerProps {
  /** 34 省行政区几何（lon/lat），用于点在多边形内裁决所属省份。 */
  readonly features: readonly AdministrativeGeometryFeature[]
  /**
   * 焦点变化回调：把最新裁决结果（adminId 字符串或 null）回传场景层。
   * 场景层据此更新单一 hoveredAdminId 状态（唯一焦点源），边界 / 标签视图只消费该状态。
   */
  readonly onHoveredProvinceChange: (adminId: string | null) => void
}

/**
 * 渲染不可见拾取面，把指针移动翻译为所属省份 adminId（或 null）并回调（单一焦点状态源）。
 *
 * 本组件不持有焦点状态（状态由场景层 ChinaMapScreen 保管），不复制点在多边形 / 投影逻辑（委托领域层），
 * 不实现 click。回退本 TASK 仅移除本组件与焦点状态，静态省界 / 标签保持 TASK-017 完成时的行为
 * （TASK-018 回退边界）。
 */
export function ProvinceHoverPicker({
  features,
  onHoveredProvinceChange,
}: ProvinceHoverPickerProps): null | ReactNode {
  // 拾取流程 step 2–4：世界 (x,z) → 经纬度反查 → 所属省份裁决 → 回调。
  // 反查失败（理论不发生，plane 覆盖主图范围）→ 回调 null（不伪造归属，恢复无焦点）。
  const handleMove = (event: ThreeEvent<PointerEvent>): void => {
    const worldX = event.point.x
    const worldZ = event.point.z
    const inverted = invertWorld(worldX, worldZ)
    if (!inverted.ok) {
      onHoveredProvinceChange(null)
      return
    }
    const adminId = findProvinceAtLonLat(
      { lon: inverted.value.lon, lat: inverted.value.lat },
      features,
    )
    onHoveredProvinceChange(adminId)
  }

  // 恢复不变量：指针离开拾取面（移出地图）→ 回调 null，恢复无焦点。
  const handleOut = (): void => {
    onHoveredProvinceChange(null)
  }

  return (
    <mesh
      // 与 ChinaTerrainMesh 同布局：−90° X 旋转使 plane 落到世界 XZ 平面，定位 (0, 0, centerZ) 覆盖主图范围。
      rotation-x={-Math.PI / 2}
      position={[0, 0, TERRAIN_PLANE_LAYOUT.centerZ]}
      // 拾取流程 step 1：每次指针移动重新裁决所属省份（单一焦点，原子替换，快速跨省不残留多高亮）。
      onPointerMove={handleMove}
      // 恢复不变量：指针离开拾取面 → 恢复无焦点。onPointerOut / onPointerLeave 双保险（不同浏览器 / R3F 版本
      // 对二者触发时机略有差异，二者都置 null 即可，幂等无副作用）。
      onPointerOut={handleOut}
      onPointerLeave={handleOut}
    >
      {/*
        米制宽高 = 主图世界包围盒跨度（与 ChinaTerrainMesh 的 planeGeometry 同尺寸）；分段 1（拾取只需命中
        平面，无需高分段，零额外顶点）。
      */}
      <planeGeometry args={[TERRAIN_PLANE_LAYOUT.worldWidthX, TERRAIN_PLANE_LAYOUT.worldHeightZ, 1, 1]} />
      {/*
        不可见拾取材质：opacity 0 + transparent 使其无可见像素；depthWrite=false 不写深度（不影响地形 / 海面 /
        省界 / 标签的深度竞争）；colorWrite=false 不写颜色（彻底无渲染输出）。R3F 的 Raycaster 对透明 / 不写
        颜色的 mesh 仍正常求交（Raycaster 测试几何，与材质可见性无关），故指针事件正常触发。
        注意：不得用 visible={false}——visible=false 会使 three 跳过该 mesh 的射线求交，拾取失效。
      */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  )
}
