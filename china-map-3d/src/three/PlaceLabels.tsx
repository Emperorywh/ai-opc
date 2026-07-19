/**
 * 省名 / 省会光点 / 岛礁名称标注的主图渲染层（TASK-016 基础呈现 + TASK-017 地形遮挡淡化）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的省名标签 / 省会光点 / 岛礁名称标签的世界
 *   坐标（PreparedPlaceLabels）装配成 drei Billboard + Text（troika，始终面向相机）+ 球体发光光点，
 *   并按地形遮挡判定调制省名 / 岛礁名标签的透明度」。它**只**依赖：配置层（PLACE_LABELS_CONFIG ——
 *   颜色 / 字号 / 光点半径 / 字体 URL 的唯一源；LABEL_OCCLUSION_CONFIG —— 遮挡目标透明度 / 采样 / 降频 /
 *   阻尼的唯一源）、领域层（PreparedPlaceLabels 类型 + computeLabelVisibility 纯函数 + TerrainWorldYSampler
 *   闭包类型）、three / R3F / drei（Billboard / Text / useFrame）。**禁止**自行读取地点 / 政治资产、复制
 *   投影 / 高程逻辑、或在组件内补写省名 / 岛礁坐标（TASK-016 实现约束「视图层只消费准备好的标签数据」
 *   「不得在组件内补写坐标或中文名称副本」）。
 * - 本组件只消费领域层产物与一个抽象地形采样器，**不**持有 ElevationProvider 引用、不读取 hover 状态、
 *   不改 UI overlay（TASK-017 实现约束「遮挡判定层可依赖相机、地形查询和标签位置，不得修改资产数据、
 *   hover 状态或 UI overlay」）。
 *
 * 始终面向相机（SPEC §3.7「Billboard 广告牌始终面向相机」、TASK-016 验证方式 4「省名和岛礁文字始终面向
 *   相机」）：
 * - 每个省名 / 岛礁名称标签用 drei <Billboard> 包裹 troika <Text>。Billboard 每帧把其子树的朝向同步为相机
 *   朝向，使文本恒面向相机——旋转视角时省名 / 岛礁名始终可读（不被自身朝向遮挡）。省会光点为球体
 *   （各向同性，无需 Billboard）。
 *
 * 地形遮挡淡化（SPEC §3.7「当某标签被地形遮挡时降低其透明度，避免视觉穿透的违和感」、§7.5、TASK-017）：
 * - Billboard 朝向（恒面向相机）与地形遮挡（前方山体挡住视线）是两个独立概念：前者由 Billboard 解决，
 *   后者由本层的遮挡判定 + 透明度调制解决。二者正交——本层**不**关闭深度测试（约束明令禁止），标签
 *   仍由 GPU 深度测试与地形正确遮挡；遮挡判定只在此基础上为「被前方地形挡住视线的标签」降低 fillOpacity，
 *   使其以淡化（而非突兀整块消失）的方式呈现可信的遮挡关系。
 * - 判定委托领域层纯函数 computeLabelVisibility（src/lib/label-occlusion）：射线方向「标签→相机」，在高度
 *   场上均匀采样，距离比较「地形世界 y 高出射线 y 超过余量 → 遮挡」。命中点比标签更近相机即 occluded。
 * - 透明度只由遮挡状态驱动（visible → 完全可见、occluded → 降低、indeterminate → 保持当前），不改变
 *   地点数据、锚点或相机；状态恢复无残留（TASK-017 可验证结果）。
 *
 * 降频 / 无分配 / 生命周期（TASK-017 可验证结果「不会造成逐帧抖动或分配压力」「字体加载未完成、地形
 *   不可用或标签已卸载时有明确生命周期处理」、实现约束「降频必须由统一帧循环驱动，不建立新的计时器/
 *   Clock」「不为每次检查重复创建大对象」）：
 * - 降频：单一 useFrame（R3F 统一帧循环）内用帧计数器对 checkFrameInterval 取模——每 N 帧判定一次。
 *   无 setInterval / setTimeout / new THREE.Clock()，无随机抽样。
 * - 无分配：目标 / 当前透明度数组在挂载期一次性分配、长度对齐标签数，运行循环只读写元素、不重建数组、
 *   不 new 对象；computeLabelVisibility 本身也无分配（见该模块）。
 * - 生命周期：terrainQuery 为 null（字体未就绪 / 地形未就绪 / 已卸载）时 useFrame 直接 return——不发射线、
 *   不调制透明度，标签保持 troika 默认完全可见。各标签 troika 实例由 R3F ref 回调在挂载时登记、卸载时
 *   置 null；卸载后 useFrame 不再被调用（组件已卸载），无僵尸更新。
 *
 * 字体离线加载（SPEC §3.7、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载」、验证方式 3
 *   「无在线字体请求」）：
 * - troika <Text> 的 font prop 取自 PLACE_LABELS_CONFIG.fontPath（本地 /fonts/ 路径，非 https:// CDN），运行时
 *   只从同源取字体。字体覆盖校验在场景层（ChinaMapScreen）渲染本组件之前完成（缺字即不渲染标签 + 错误
 *   状态），本组件只在「覆盖校验通过」后挂载，故 font prop 指向的字体已保证覆盖所有将渲染的字符。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-016 实现约束「本 TASK 不宣称取得审图号」）：
 * - 本组件只呈现省名 / 省会光点 / 岛礁名称文本与光点，不添加审图号角标、不通过任何视觉手段宣称已审图。
 */

import { useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PLACE_LABELS_CONFIG } from '../config/place-labels'
import { PROVINCE_HOVER_CONFIG } from '../config/province-hover'
import { LABEL_OCCLUSION_CONFIG } from '../config/label-occlusion'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import {
  computeAncillaryLabelOpacity,
  computeProvinceLabelOpacity,
  type EntranceFrame,
} from '../lib/entrance-state'
import { computeLabelVisibility } from '../lib/label-occlusion'
import type { TerrainWorldYSampler } from '../lib/label-occlusion'
import type {
  PreparedCapitalPoint,
  PreparedPlaceLabels,
} from '../lib/place-labels'

/**
 * troika Text 实例上被遮挡层操纵的最小形状。
 *
 * troika 的 fillOpacity 是普通实例属性（不在 SYNCABLE_PROPS 内，赋值无副作用）；其 onBeforeRender →
 * _prepareForRender 每帧把 fillOpacity 读入 uTroikaFillOpacity uniform，故在 useFrame 中赋值后下一帧
 * 渲染即生效。drei <Text> 的 ref 指向该 troika 实例（ForwardRefComponent，ref 类型 any），本层以最小
 * 形状约束之，避免引入对 troika 内部的强类型耦合。
 */
interface TroikaTextLike {
  fillOpacity: number
}

/**
 * 单个参与遮挡判定的文本标签的渲染描述（省名 + 岛礁名统一结构）。
 *
 * 把 TASK-016 的两类 Billboard 文本标签（省名 / 岛礁名）统一成同一结构，使遮挡层可用单一数组、单一
 * useFrame 循环管理它们的 ref / 目标透明度 / 当前透明度（对齐下标），避免两套并行结构。省会光点不参与
 * 遮挡（球体各向同性 + depthTest 已与地形正确遮挡，无 Billboard 文本的遮挡淡化需求）。
 *
 * TASK-018 扩展：携带 kind（province / island）与（省名的）adminId，使遮挡层与渲染层可据 hoveredAdminId
 * 对省名标签施加焦点放大 / 置顶（岛礁名标签不参与 hover——只有省份可悬停）。baseFontSizeMeters /
 * baseColorHex 保留「无焦点基线态」的字号 / 颜色，焦点态字号 = baseFontSizeMeters × 放大倍率、颜色 =
 * 焦点提亮色，由渲染层据 hoveredAdminId 在 JSX 中响应式合成。
 */
interface OcclusionTextLabel {
  readonly key: string
  readonly text: string
  readonly position: readonly [number, number, number]
  /** 标签类别：province（省名，可被 hover 焦点放大）或 island（岛礁名，不参与 hover）。 */
  readonly kind: 'province' | 'island'
  /** 省名标签的行政区稳定标识（kind='province' 时有效）；岛礁名标签为 null（不参与 hover 寻址）。 */
  readonly adminId: string | null
  /** 基线字号（米，无焦点态）。焦点态字号 = 本值 × PROVINCE_HOVER_CONFIG.focusedLabelScale。 */
  readonly baseFontSizeMeters: number
  readonly baseColorHex: string
}

/** PlaceLabels 的 props：接收领域层准备好的标签 / 光点 + 可选的地形采样器 + 单一焦点状态 + 共享入场帧，不取数、不持有交互状态。 */
export interface PlaceLabelsProps {
  /** 领域层 preparePlaceLabels 的产物（省名标签 + 省会光点 + 岛礁名称标签，已贴地 + 浮高）。 */
  readonly labels: PreparedPlaceLabels
  /**
   * 地形世界 y 采样器（标签遮挡判定用），由场景层从共享 ElevationProvider + 夸张系数 k 构造。
   * null / undefined 表示地形不可用（字体未就绪 / 地形未就绪 / 已卸载）——此时遮挡层不发射线、标签
   * 保持 troika 默认完全可见（TASK-017 生命周期处理）。
   */
  readonly terrainQuery?: TerrainWorldYSampler | null
  /**
   * 当前悬停焦点行政区的稳定标识（CN- 前缀）或 null（无焦点）。由场景层（ChinaMapScreen）保管的唯一焦点源，
   * 本组件据此派生焦点省名标签的字号放大 / 置顶透明度 / 提亮色（SPEC §4.2「标签放大并置顶」）。岛礁名标签
   * 不参与 hover。null 时全部省名标签回到基线字号 / 遮挡透明度（恢复不变量）。本组件不做拾取——拾取由
   * ProvinceHoverPicker 单点承担，本组件只消费该状态。
   */
  readonly hoveredAdminId?: string | null
  /**
   * 共享入场帧（TASK-020 单一时间源）。注入时每帧由本组件单一 useFrame 把「省名标签按自西向东错峰淡入」
   * 与「省会光点 / 岛礁名称随省名阶段整体淡入」的透明度与遮挡透明度合成（乘法）写入 troika fillOpacity /
   * 光点材质 opacity（SPEC §4.3「省名标签依次淡入，按地理顺序错峰，如自西向东」）。未注入（回退 TASK-020）
   * 时不施加入场透明度（=1），标签 / 光点加载完成即直接可见。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 单个省会光点（球体 + additive 发光，贴地，位置真实）。
 *
 * 球体放在领域层准备的贴地世界坐标（y = h·k + epsilon）。MeshBasicMaterial 不参与光照（恒亮暖色）、
 * AdditiveBlending 呈发光。depthTest 保持开启使光点被前方山体正确遮挡；depthWrite=false 不影响其他透明层。
 * 省会光点不参与遮挡淡化（球体各向同性，depthTest 已与地形正确遮挡，无 Billboard 文本的遮挡需求）。
 */
function CapitalPoint({
  point,
  materialSlot,
  materialsRef,
}: {
  readonly point: PreparedCapitalPoint
  /** 本光点材质在父级 materialsRef 数组中的下标（入场淡入时由父级统一寻址写 opacity）。 */
  readonly materialSlot: number
  /** 父级维护的省会光点材质数组 ref：本组件挂载时登记、卸载时清空对应槽位。 */
  readonly materialsRef: RefObject<(THREE.MeshBasicMaterial | null)[]>
}): ReactNode {
  return (
    <mesh position={[point.position[0], point.position[1], point.position[2]]} renderOrder={3}>
      <sphereGeometry args={[PLACE_LABELS_CONFIG.capitalPointRadiusMeters, 8, 8]} />
      {/*
        ref 回调把材质登记到父级 materialsRef[materialSlot]，供 PlaceLabels 单一 useFrame 统一写入场淡入
        opacity（卸载时以 null 清空槽位）。省会光点的最终透明度 = 入场整体淡入透明度（computeAncillaryLabelOpacity，
        与岛礁名称同包），不参与遮挡淡化（球体各向同性，depthTest 已与地形正确遮挡）。
      */}
      <meshBasicMaterial
        ref={(material: THREE.MeshBasicMaterial | null) => {
          materialsRef.current[materialSlot] = material
        }}
        color={PLACE_LABELS_CONFIG.capitalPointColorHex}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * 渲染全部省名 / 省会光点 / 岛礁名称标注（Billboard Text + 发光光点，始终面向相机），并对省名 / 岛礁名
 * 标签按地形遮挡判定调制透明度（TASK-017）。
 *
 * 本组件不承担投影 / 高程 / 浮高计算（领域层职责），不读取地点 / 政治 / heightmap / hover 状态——它只是
 * PreparedPlaceLabels 的纯渲染边界 + 一个由统一帧循环驱动的遮挡淡化控制器。回退本 TASK（TASK-017）仅
 * 移除遮挡判定与透明度反馈：把 terrainQuery 置 null 即恢复 TASK-016 的默认完全可见状态，标签朝向与地点
 * 位置无回归（TASK-017 回退边界）。
 */
export function PlaceLabels({ labels, terrainQuery, hoveredAdminId = null, entranceFrame = null }: PlaceLabelsProps): ReactNode {
  // 合并省名 + 岛礁名为统一的「遮挡文本标签」列表（省会光点不参与遮挡，单独渲染）。
  // text 原样透传领域层 shortName / 岛礁规范名（本组件不复制中文名表）；基线字号 / 基线色取自唯一配置源。
  // 省名标签携带 adminId（供焦点放大 / 置顶寻址），岛礁名标签 adminId=null（不参与 hover）。
  const textLabels = useMemo<OcclusionTextLabel[]>(() => {
    const list: OcclusionTextLabel[] = []
    for (const label of labels.provinceLabels) {
      list.push({
        key: `province-name-${label.adminId}`,
        text: label.text,
        position: label.position,
        kind: 'province',
        adminId: label.adminId,
        baseFontSizeMeters: PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters,
        baseColorHex: PLACE_LABELS_CONFIG.provinceLabelColorHex,
      })
    }
    for (const label of labels.islandLabels) {
      list.push({
        key: `island-name-${label.name}`,
        text: label.name,
        position: label.position,
        kind: 'island',
        adminId: null,
        baseFontSizeMeters: PLACE_LABELS_CONFIG.islandLabelFontSizeMeters,
        baseColorHex: PLACE_LABELS_CONFIG.islandLabelColorHex,
      })
    }
    return list
  }, [labels])

  // 省名标签的「自西向东」错峰排序（TASK-020，SPEC §4.3「按地理顺序错峰，如自西向东」）。
  // 按世界 x（东增）升序排省名标签，西部（x 小）staggerIndex 小 → delay 小 → 先淡入。岛礁名标签不参与
  // 错峰（staggerIndex = -1 → 用整体淡入）。挂载期一次排序、确定性（同 x 时按原序稳定）。
  const staggerInfo = useMemo(() => {
    const indexToStagger = new Array<number>(textLabels.length).fill(-1)
    const provinceEntries: Array<{ readonly i: number; readonly x: number }> = []
    for (let i = 0; i < textLabels.length; i++) {
      if (textLabels[i].kind === 'province') {
        provinceEntries.push({ i, x: textLabels[i].position[0] })
      }
    }
    provinceEntries.sort((a, b) => a.x - b.x)
    provinceEntries.forEach((entry, rank) => {
      indexToStagger[entry.i] = rank
    })
    return { indexToStagger, provinceCount: provinceEntries.length }
  }, [textLabels])

  // 各文本标签的 troika 实例引用（下标与 textLabels 对齐；挂载 / 卸载由 R3F ref 回调自动维护）。
  const textRefs = useRef<(TroikaTextLike | null)[]>([])
  // 各标签的目标透明度（遮挡判定结果；indeterminate 时保持上一次目标，不抖动）。
  const targetOpacities = useRef<number[]>([])
  // 各标签当前透明度（指数阻尼的当前值；初始 = 入场激活时 0 / 未激活时可见，见下）。
  const currentOpacities = useRef<number[]>([])
  // 帧计数（降频用）：由 R3F 统一帧循环递增，无独立计时器 / Clock。
  const frameCounter = useRef(0)
  // 省会光点材质引用数组（入场淡入时由本组件单一 useFrame 统一写 opacity；与遮挡文本共用同一 useFrame、
  // 同一共享 clock，无第二套计时器）。
  const capitalMaterialsRef = useRef<(THREE.MeshBasicMaterial | null)[]>([])

  // 是否激活入场淡入（entranceFrame 注入即激活）。激活时省名 / 岛礁名标签与省会光点初始透明度为 0
  // （从不可见淡入）；未激活（回退 TASK-020）时初始为可见，加载完成即直接可见。捕获于数组长度同步处，
  // 使标签数变化（k 切换 / 资产重载）时按「当前是否激活」确定性初始化新槽位。
  const entranceActive = entranceFrame !== null && entranceFrame !== undefined

  // 标签数变化时同步数组长度（k 切换 / 资产重载导致 labels 变化时）；挂载期一次性分配，运行循环只
  // 读写元素、不重建数组（无分配约束）。新槽位初始化：遮挡目标恒为可见；当前透明度按入场激活与否
  // 取 0（激活：从不可见淡入）或可见（未激活：直接可见）。
  const labelCount = textLabels.length
  if (targetOpacities.current.length !== labelCount) {
    targetOpacities.current = new Array<number>(labelCount).fill(LABEL_OCCLUSION_CONFIG.visibleOpacity)
    const initialCurrent = entranceActive ? 0 : LABEL_OCCLUSION_CONFIG.visibleOpacity
    currentOpacities.current = new Array<number>(labelCount).fill(initialCurrent)
  }

  useFrame((state, delta) => {
    const sampler = terrainQuery ?? null
    // 入场 elapsed（TASK-020）：entranceFrame 注入时取共享入场帧的 elapsed（单一时间源，与海面 / 遮挡
    // 共用同一 R3F clock）；未注入时为 0（入场透明度恒为 1，等价于不施加入场淡入——回退边界）。
    const entranceElapsed =
      entranceFrame !== null && entranceFrame !== undefined && entranceFrame.current !== null
        ? entranceFrame.current.elapsedSeconds
        : 0
    const entranceOn = entranceFrame !== null && entranceFrame !== undefined

    // 降频：由统一帧循环驱动的确定性帧间隔（帧计数器对 checkFrameInterval 取模），非计时器 / 非随机
    // 抽样。每 N 帧判定一次遮挡；未判定帧仍逐帧阻尼透明度（过渡平滑）。
    frameCounter.current += 1
    const shouldCheck = frameCounter.current >= LABEL_OCCLUSION_CONFIG.checkFrameInterval
    if (shouldCheck) {
      frameCounter.current = 0
    }

    const camPos = state.camera.position
    const cfg = LABEL_OCCLUSION_CONFIG
    // dt 钳到 [0, 0.1]：标签页失焦复归时 useFrame 可能给出超大 delta，钳制避免阻尼一步跨过目标。
    const dt = Number.isFinite(delta) ? Math.min(Math.max(delta, 0), 0.1) : 0
    const refs = textRefs.current
    const targets = targetOpacities.current
    const currents = currentOpacities.current

    // 省会光点透明度（TASK-020）：= 入场整体淡入透明度（computeAncillaryLabelOpacity，与岛礁名同包）。
    // 省会光点不参与遮挡（球体各向同性，depthTest 已正确遮挡），故透明度只由入场淡入决定；入场完成后恒 1。
    // entranceOn=false 时不写 opacity（材质默认 1，回退边界：直接可见）。
    if (entranceOn) {
      const capitalOpacity = computeAncillaryLabelOpacity(entranceElapsed, ENTRANCE_DURATIONS)
      for (const material of capitalMaterialsRef.current) {
        if (material !== null && material !== undefined) {
          material.opacity = capitalOpacity
        }
      }
    }

    for (let i = 0; i < labelCount; i++) {
      const handle = refs[i]
      if (handle === null || handle === undefined) {
        // 该标签的 troika 实例尚未挂载（troika 异步字体同步中）或已卸载——跳过，不产生错误射线 / 僵尸更新。
        continue
      }
      const desc = textLabels[i]
      // 生命周期守护：sampler 为 null（字体 / 地形未就绪或标签已卸载）时不发射线、不调制遮挡目标——
      // 既不产生错误射线，也不在不可用期伪造遮挡淡化。此时遮挡目标取可见（不暗化），入场淡入仍按共享
      // elapsed 正常推进（入场与遮挡正交，sampler 不可用不应冻结入场淡入）。
      if (sampler !== null && shouldCheck) {
        // 遮挡判定（委托领域层纯函数）：射线方向「标签→相机」，距离比较「地形世界 y 高出射线 y 超过余量
        // → 命中点比标签更近相机 → occluded」，否则 visible；退化 / 全失败 → indeterminate。
        const visibility = computeLabelVisibility(
          {
            label: { x: desc.position[0], y: desc.position[1], z: desc.position[2] },
            camera: { x: camPos.x, y: camPos.y, z: camPos.z },
            sampler,
          },
          {
            maxSamples: cfg.maxSamples,
            nearMarginMeters: cfg.nearMarginMeters,
            farMarginMeters: cfg.farMarginMeters,
            verticalClearanceMeters: cfg.verticalClearanceMeters,
          },
        )
        // 仅在确定结论（visible / occluded）时更新目标；indeterminate 保持上一次目标（不抖动）。
        // 状态恢复无残留：遮挡消失（visible）即把目标拉回完全可见，阻尼逐帧恢复。
        if (visibility === 'occluded') {
          targets[i] = cfg.occludedOpacity
        } else if (visibility === 'visible') {
          targets[i] = cfg.visibleOpacity
        }
        // 样式合成优先级（TASK-018 实现约束「遮挡透明度与 hover 放大必须通过明确优先级合成，不能互相覆盖
        // 造成闪烁」）：焦点省名标签的透明度目标恒取置顶透明度（1.0，完全可见），覆盖遮挡判定结果——即
        // 「被悬停的省名标签即使位于山后也保持完全可见（置顶）」，符合 SPEC §4.2「置顶」语义。岛礁名标签
        // 与非焦点省名标签的透明度目标仍由遮挡判定决定。这是确定性的单一公式（焦点 ? 置顶 : 遮挡目标），
        // 焦点态与遮挡态不会互相覆盖造成闪烁——每 shouldCheck 帧（遮挡降频）先写遮挡目标，焦点省名标签
        // 随即被覆盖为置顶目标，下方 next 计算据此阻尼，无两套目标争抢。焦点态字号 / 颜色则在 JSX 中据
        // hoveredAdminId 响应式合成（hoveredAdminId 变化立即生效），与透明度共同表达「放大置顶」。
        if (desc.kind === 'province' && desc.adminId !== null && desc.adminId === hoveredAdminId) {
          targets[i] = PROVINCE_HOVER_CONFIG.focusedLabelOpacity
        }
      }
      // 入场透明度合成（TASK-020）：最终目标 = 入场透明度 × 遮挡目标。省名标签按自西向东错峰淡入
      // （staggerIndex ≥ 0 → computeProvinceLabelOpacity），省会 / 岛礁名标签随省名阶段整体淡入
      // （staggerIndex = -1 → computeAncillaryLabelOpacity）。入场完成后入场透明度恒 1，合成退化为纯遮挡
      // 目标——与 TASK-017 行为一致（无回归）。焦点置顶（targets[i]=1）× 入场透明度：入场期间 hover
      // 不激活（相机锁定），故不冲突；入场后入场透明度=1，焦点置顶正常生效。
      const staggerIndex = staggerInfo.indexToStagger[i]
      const entranceOpacity = entranceOn
        ? staggerIndex >= 0
          ? computeProvinceLabelOpacity(entranceElapsed, ENTRANCE_DURATIONS, staggerIndex, staggerInfo.provinceCount)
          : computeAncillaryLabelOpacity(entranceElapsed, ENTRANCE_DURATIONS)
        : 1
      const occlusionTarget = sampler !== null ? targets[i] : cfg.visibleOpacity
      const composedTarget = entranceOpacity * occlusionTarget
      // 每帧指数阻尼当前透明度 → 合成目标（THREE.MathUtils.damp = lerp(current, target, 1 − exp(−λ·dt))）。
      // 过渡帧率无关（dt 来自统一时钟）、状态确定可恢复。阻尼结果赋给 troika fillOpacity，其
      // onBeforeRender 下一帧读入 uniform 即生效（深度测试保持开启，标签不永久穿透地形）。
      const next = THREE.MathUtils.damp(currents[i], composedTarget, cfg.dampLambda, dt)
      currents[i] = next
      handle.fillOpacity = next
    }
  })

  return (
    <group>
      {textLabels.map((desc, i) => {
        // 焦点态字号 / 颜色合成（TASK-018 SPEC §4.2「标签放大」）：省名标签在 hoveredAdminId 命中时字号 × 放大
        // 倍率、颜色取焦点提亮色（比基线更亮，从地形中跳出）；岛礁名标签与非焦点省名标签用基线字号 / 基线色。
        // fontSize / color 通过 troika Text 的 prop 响应式更新（hoveredAdminId 变化触发 React 重渲染），troika
        // 仅对该标签重排一次（非逐帧），性能可控。hoveredAdminId 为 null（无焦点）时全部回到基线（恢复不变量）。
        const isFocusedProvince =
          desc.kind === 'province' && desc.adminId !== null && desc.adminId === hoveredAdminId
        const fontSizeMeters = isFocusedProvince
          ? desc.baseFontSizeMeters * PROVINCE_HOVER_CONFIG.focusedLabelScale
          : desc.baseFontSizeMeters
        const colorHex = isFocusedProvince
          ? PROVINCE_HOVER_CONFIG.focusedLabelColorHex
          : desc.baseColorHex
        return (
          <Billboard key={desc.key} position={[desc.position[0], desc.position[1], desc.position[2]]}>
            {/*
              ref 回调按 textLabels 下标登记 troika 实例；卸载时 R3F 以 null 回调清空对应槽位（生命周期自动）。
              fillOpacity 不作为 prop 传入——由上方 useFrame 从第 1 帧起接管（troika 默认 fillOpacity=1.0
              覆盖首帧，与可见目标一致，故接管无可见跳变）。font 取本地子集路径（场景层已校验覆盖）。
            */}
            <Text
              ref={(el: TroikaTextLike | null) => {
                textRefs.current[i] = el
              }}
              font={PLACE_LABELS_CONFIG.fontPath}
              fontSize={fontSizeMeters}
              color={colorHex}
              anchorX="center"
              anchorY="middle"
            >
              {desc.text}
            </Text>
          </Billboard>
        )
      })}
      {labels.capitalPoints.map((point, index) => (
        <CapitalPoint
          key={`capital-point-${point.adminId}`}
          point={point}
          materialSlot={index}
          materialsRef={capitalMaterialsRef}
        />
      ))}
    </group>
  )
}
