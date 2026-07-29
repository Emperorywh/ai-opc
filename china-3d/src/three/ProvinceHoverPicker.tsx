/**
 * 省级悬停拾取控制器（交互层，TASK-009，SPEC §4.2）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），是「指针命中主图 → 经纬度反查 → 所属省份判定 → 写入共享焦点
 *   状态」的**唯一**交互入口。它只依赖：领域层（findProvinceAtLonLat——点在多边形内的唯一能力源）、
 *   坐标层（invertWorld——世界 (x,z) → 经纬度的唯一反查入口）、地形布局（TERRAIN_PLANE_LAYOUT——
 *   主图世界米制包围盒的渲染派生）、悬停状态 context（useProvinceHoverDispatch——唯一焦点写入端）、
 *   R3F（ThreeEvent 指针事件）。**禁止**在此复制点在多边形逻辑、复制投影公式、或在边界 / 标签视图
 *   里各自再做一次拾取——本组件是唯一拾取点，ProvinceBorders / TASK-010 标签模块只消费焦点状态。
 * - 本组件**不**持有焦点状态（状态由 ProvinceHoverProvider 保管，本组件只经 dispatch 写入）、不保存
 *   Three.js 对象引用作为焦点、不做中文名匹配、不做多组件布尔组合——焦点以稳定行政区标识（CN-
 *   前缀 adminId）表达，翻译结果（adminId 字符串或 null）即是唯一的焦点表达。
 *
 * 拾取流程（SPEC §4.2「raycast 命中地形后用屏幕坐标反查所属省」）：
 * 1. 一张覆盖主图世界包围盒的不可见 plane（与 ChinaTerrainMesh 同布局：相同米制宽高、相同 −90° X
 *    旋转、相同 centerZ 定位）作为拾取面。R3F 对该 mesh 的指针事件经 three Raycaster 求交，
 *    event.point 即指针命中点的世界坐标。该 plane 不可见（opacity 0、不写深度、不写颜色），仅为
 *    承载指针事件存在，不产生可见像素、不参与深度竞争——故不影响地形 / 海面 / 省界的既有渲染。
 *    （为什么用平面而非直接 raycast 地形 mesh：省份是 lon/lat 上的 2D 区域，归属判定只需要落点的
 *    (x,z)；地形 mesh 是 2048² 分段 ≈ 8.4M 三角形，CPU raycast 每次指针移动都需遍历全部三角形，
 *    成本不可接受，而平面求交是闭式运算微秒级。斜俯视下平面落点与地形表面落点的 (x,z) 差异随
 *    高程 / 俯角放大，但省级区域尺度达数百公里，该差异不改变「点在哪一省」的裁决结果。）
 * 2. 取 event.point 的世界 (x, z)（高程 y 不参与省份归属判定），经 projection.invertWorld 反算成
 *    (lon, lat)。反查只忠实还原坐标（见 src/lib/projection invertWorld 注释），不做范围 / 省份裁剪。
 * 3. 把 (lon, lat) 喂入领域纯函数 findProvinceAtLonLat → adminId | null。多多边形 / 岛屿 / 内环 /
 *    相邻边界 / 海域 / 地图外由该纯函数统一裁决（见 src/lib/province-picking）。
 * 4. 把结果经 dispatch（useProvinceHoverDispatch）原子写入共享焦点状态——边界与 TASK-010 标签
 *    视图只消费该状态，不再各自拾取。
 *
 * 单一焦点状态与恢复不变量（SPEC §4.2「移出后还原」；快速跨省不残留多个高亮）：
 * - onPointerMove：每次移动重新裁决所属省份并写入最新 adminId（或 null）。状态是单一字符串（非
 *   集合），新值原子替换旧值，故快速跨省（A→B）时焦点直接从 A 切到 B，至多一个焦点，不残留多高亮。
 * - onPointerOut / onPointerLeave（指针离开拾取面 = 移出地图）：写入 null，恢复无焦点。
 * - 海域 / 地图外 / 无命中（findProvinceAtLonLat 返回 null）：写入 null，恢复无焦点。
 * - 反查失败（invertWorld 返回失败——理论不发生，因 plane 覆盖主图范围、命中点必在境内；防御性
 *   兜底）：写入 null，不伪造归属。
 * - 组件卸载（如省界几何资产失效）：useEffect 清理写入 null——卸载后不再有移动回调，若焦点残留
 *   会指向已失效的几何，故在卸载时显式复位（恢复不变量的最后一块）。
 *
 * 无 click 行为（SPEC §4.2「无 click 行为（纯展示，不点击下钻 / 飞焦）」）：
 * - 本组件只注册 onPointerMove / onPointerOut / onPointerLeave，不注册 onClick / onPointerDown /
 *   onPointerUp。故任何点击只由 OrbitControls 处理（旋转 / 平移相机），不触发省份状态迁移、相机
 *   飞焦或数据加载——与 SPEC「不绑定业务数据」一致。
 *
 * 资产就绪门槛：features 由页面装配层保证就绪后才挂载本组件（几何未就绪时不渲染拾取面）——无
 * 几何无法裁决所属省份，不拾取、不写入，避免在几何缺失期产生无意义或错误的焦点。
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { findProvinceAtLonLat } from '../lib/province-picking'
import { invertWorld } from '../lib/projection'
import { useProvinceHoverDispatch } from './province-hover'
import { TERRAIN_PLANE_LAYOUT } from './terrain-layout'
import type { AdministrativeGeometryFeature } from '../geo-contracts'

/** ProvinceHoverPicker 的 props：只接收几何；焦点经共享 context dispatch 写入，不经回调 props。 */
export interface ProvinceHoverPickerProps {
  /** 34 省行政区几何（lon/lat），用于点在多边形内裁决所属省份。 */
  readonly features: readonly AdministrativeGeometryFeature[]
}

/**
 * 渲染不可见拾取面，把指针移动翻译为所属省份 adminId（或 null）并写入共享焦点状态（唯一拾取点）。
 *
 * 本组件不持有焦点状态（状态由 ProvinceHoverProvider 保管），不复制点在多边形 / 投影逻辑（委托
 * 领域层），不实现 click。
 */
export function ProvinceHoverPicker({ features }: ProvinceHoverPickerProps): ReactNode {
  const setHoveredProvince = useProvinceHoverDispatch()

  // 恢复不变量（卸载兜底）：本组件卸载后不再有移动回调，若焦点残留会指向已失效的几何，
  // 故卸载时显式复位 null。dispatch 引用稳定（React setState），effect 只随挂载 / 卸载跑。
  useEffect(() => {
    return () => {
      setHoveredProvince(null)
    }
  }, [setHoveredProvince])

  // 拾取流程 step 2–4：世界 (x,z) → 经纬度反查 → 所属省份裁决 → 原子写入共享焦点。
  // 反查失败（理论不发生，plane 覆盖主图范围）→ 写 null（不伪造归属，恢复无焦点）。
  const handleMove = (event: ThreeEvent<PointerEvent>): void => {
    const worldX = event.point.x
    const worldZ = event.point.z
    const inverted = invertWorld(worldX, worldZ)
    if (!inverted.ok) {
      setHoveredProvince(null)
      return
    }
    const adminId = findProvinceAtLonLat(
      { lon: inverted.value.lon, lat: inverted.value.lat },
      features,
    )
    setHoveredProvince(adminId)
  }

  // 恢复不变量：指针离开拾取面（移出地图）→ 写 null，恢复无焦点。
  const handleOut = (): void => {
    setHoveredProvince(null)
  }

  return (
    <mesh
      // 与 ChinaTerrainMesh 同布局：−90° X 旋转使 plane 落到世界 XZ 平面，定位 (0, 0, centerZ)
      // 覆盖主图范围。
      rotation-x={-Math.PI / 2}
      position={[0, 0, TERRAIN_PLANE_LAYOUT.centerZ]}
      // 拾取流程 step 1：每次指针移动重新裁决所属省份（单一焦点，原子替换，快速跨省不残留多高亮）。
      onPointerMove={handleMove}
      // 恢复不变量：指针离开拾取面 → 恢复无焦点。onPointerOut / onPointerLeave 双保险（不同浏览器 /
      // R3F 版本对二者触发时机略有差异，二者都置 null 即可，幂等无副作用）。
      onPointerOut={handleOut}
      onPointerLeave={handleOut}
    >
      {/*
        米制宽高 = 主图世界包围盒跨度（与 ChinaTerrainMesh 的 planeGeometry 同尺寸）；分段 1（拾取
        只需命中平面，无需高分段，零额外顶点）。
      */}
      <planeGeometry args={[TERRAIN_PLANE_LAYOUT.worldWidthX, TERRAIN_PLANE_LAYOUT.worldHeightZ, 1, 1]} />
      {/*
        不可见拾取材质：opacity 0 + transparent 使其无可见像素；depthWrite=false 不写深度（不影响
        地形 / 海面 / 省界的深度竞争）；colorWrite=false 不写颜色（彻底无渲染输出）。R3F 的
        Raycaster 对透明 / 不写颜色的 mesh 仍正常求交（Raycaster 测试几何，与材质可见性无关），
        故指针事件正常触发。
        注意：不得用 visible={false}——visible=false 会使 three 跳过该 mesh 的射线求交，拾取失效。
      */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  )
}
