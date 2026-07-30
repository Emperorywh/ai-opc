/**
 * 省名 Billboard 标签 / 省会光点 / 省会名小字的主图渲染层（TASK-010，SPEC §3.7 / §7.5 / §4.2）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的省名标签 / 省会光点 / 省会名小字
 *   的世界坐标（PreparedPlaceLabels）装配成 drei Billboard + Text（troika，始终面向相机）+
 *   球体发光光点，并按地形遮挡判定调制省名标签的透明度」。它**只**依赖：配置层
 *   （PLACE_LABELS_CONFIG——浮高以外的颜色 / 字号 / 光点半径 / 字体 URL 的唯一源；
 *   LABEL_OCCLUSION_CONFIG——遮挡目标透明度 / 采样 / 降频 / 阻尼的唯一源；
 *   PROVINCE_HOVER_CONFIG——焦点标签放大倍率 / 置顶透明度 / 提亮色的唯一源）、领域层
 *   （PreparedPlaceLabels 类型 + computeLabelVisibility 纯函数 + TerrainWorldYSampler 闭包类型）、
 *   悬停状态 context（useHoveredProvince——唯一焦点源）、three / R3F / drei（Billboard / Text /
 *   useFrame）。**禁止**自行读取地点资产、复制投影 / 高程逻辑、或在组件内补写省名 / 省会坐标
 *   （视图层只消费准备好的标签数据）。
 * - 本组件只消费领域层产物与一个抽象地形采样器，**不**持有 ElevationProvider 引用、不做拾取
 *   （拾取由 ProvinceHoverPicker 单点承担，hover 焦点经共享 context 只读获得）、不改 UI overlay。
 *
 * 始终面向相机（SPEC §3.7「Billboard 广告牌始终面向相机」）：
 * - 每个省名 / 省会名标签用 drei <Billboard> 包裹 troika <Text>。Billboard 每帧把其子树的朝向
 *   同步为相机朝向，使文本恒面向相机——旋转视角时省名 / 省会名始终可读（不被自身朝向遮挡）。
 *   省会光点为球体（各向同性，无需 Billboard）。
 *
 * 地形遮挡淡化（SPEC §3.7「当某标签被地形遮挡时降低其透明度，避免视觉穿透的违和感」、§7.5
 * 「对每个标签做一次 raycast，标签位置→相机，命中地形且命中点更近则降低透明度；可降频到
 * 每 N 帧一次」）：
 * - Billboard 朝向（恒面向相机）与地形遮挡（前方山体挡住视线）是两个独立概念：前者由
 *   Billboard 解决，后者由本层的遮挡判定 + 透明度调制解决。二者正交——本层**不**关闭深度
 *   测试，标签仍由 GPU 深度测试与地形正确遮挡；遮挡判定只在此基础上为「被前方地形挡住视线
 *   的标签」降低 fillOpacity，使其以淡化（而非突兀整块消失）的方式呈现可信的遮挡关系。
 * - 判定委托领域层纯函数 computeLabelVisibility（src/lib/label-occlusion）：射线方向
 *   「标签→相机」，在高度场上均匀采样，距离比较「地形世界 y 高出射线 y 超过余量 → 遮挡」。
 * - 透明度只由遮挡状态与 hover 焦点驱动（visible → 完全可见、occluded → 降低、indeterminate
 *   → 保持当前、焦点 → 置顶），不改变地点数据、锚点或相机；状态恢复无残留。
 *
 * hover 焦点放大置顶（SPEC §4.2「该省标签放大并置顶」「移出后还原」）：
 * - 焦点省名标签（adminId 命中共享 hover 焦点）：字号 = 基线 ×
 *   PROVINCE_HOVER_CONFIG.focusedLabelScale、颜色 = focusedLabelColorHex（提亮）、透明度目标
 *   恒 = focusedLabelOpacity（1.0 完全可见，覆盖遮挡判定结果——「被悬停的省名标签即使位于
 *   山后也保持完全可见（置顶）」）。这是确定性的单一合成公式（焦点 ? 置顶 : 遮挡目标），每帧
 *   在阻尼前合成，焦点态与遮挡态不会互相覆盖造成闪烁。
 * - 字号 / 颜色经 troika Text 的 prop 响应式更新（hoveredAdminId 变化触发 React 重渲染），
 *   troika 仅对该标签重排一次（非逐帧），性能可控；hoveredAdminId 为 null 时全部回到基线
 *   （移出还原不变量）。
 * - 省会名小字：仅 hoveredAdminId 命中时挂载该省的省会名小字标签（Billboard + Text，小字号
 *   / 暖色系，浮于光点正上方）——SPEC §3.7「省会名以小字 / hover 呈现」的落点：默认画面仅
 *   省名 + 光点，hover 时该省省会名以小字呈现；移出即卸载还原。字体已被省名标签加载并缓存
 *   （troika 按字体 URL 全局缓存），hover 挂载的增量成本是一次小文本重排。小字标签不参与
 *   遮挡淡化（仅 hover 呈现期间可见，hover 语义即「置顶」）；深度测试保持开启，物理遮挡
 *   关系仍正确。
 *
 * 降频 / 无分配 / 生命周期（不造成逐帧抖动或分配压力；字体加载未完成、地形不可用或标签已
 * 卸载时有明确生命周期处理）：
 * - 降频：单一 useFrame（R3F 统一帧循环）内用帧计数器对 checkFrameInterval 取模——每 N 帧
 *   判定一次。无 setInterval / setTimeout / new THREE.Clock()，无随机抽样。
 * - 无分配：目标 / 当前透明度数组在挂载期一次性分配、长度对齐标签数，运行循环只读写元素、
 *   不重建数组、不 new 对象；computeLabelVisibility 本身也无分配（见该模块）。
 * - 生命周期：terrainQuery 为 null（地形未就绪 / 已卸载）时遮挡判定不发射线、遮挡目标取
 *   可见（不暗化），标签保持 troika 默认完全可见。各标签 troika 实例由 R3F ref 回调在挂载时
 *   登记、卸载时置 null；卸载后 useFrame 不再被调用（组件已卸载），无僵尸更新。
 *
 * 字体离线加载（SPEC §3.7「字体子集必须离线加载」「无在线字体请求」）：
 * - troika <Text> 的 font prop 取自 PLACE_LABELS_CONFIG.fontPath（本地 /fonts/ 路径，非
 *   https:// CDN），运行时只从同源取字体。字体覆盖校验在 App 装配层渲染本组件之前完成
 *   （缺字即不渲染标签 + 整页错误状态），本组件只在「覆盖校验通过」后挂载，故 font prop
 *   指向的字体已保证覆盖所有将渲染的字符（省名 + 省会名）。
 *
 * 入场错峰淡入（TASK-013，SPEC §4.3「省名标签依次淡入，按地理顺序错峰，如自西向东」）：
 * - 注入共享入场帧（entranceFrame）时，本组件单一 useFrame 每帧把「省名标签按自西向东（世界 x
 *   升序，+X = 东）错峰的入场透明度（computeProvinceLabelOpacity）」与「遮挡 / 焦点目标」**乘法
 *   合成**为阻尼目标写入 troika fillOpacity——西部省名先亮、东部后亮；省会光点与省会名小字随省名
 *   淡入阶段整体淡入（computeAncillaryLabelOpacity，非错峰）。入场完成后入场透明度恒 1，合成退化
 *   为纯遮挡 / 焦点目标（TASK-010 行为无回归）。未注入入场帧时不施加入场透明度（=1，直接可见）。
 *
 * 非官方审图限制（SPEC §6 / §8）：
 * - 本组件只呈现省名 / 省会光点 / 省会名文本与光点，不添加审图号角标、不通过任何视觉手段
 *   宣称已审图。
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
import type { PreparedPlaceLabels } from '../lib/place-labels'
import { useHoveredProvince } from './province-hover'

/**
 * troika Text 实例上被遮挡层操纵的最小形状。
 *
 * troika 的 fillOpacity 是普通实例属性（不在 SYNCABLE_PROPS 内，赋值无副作用）；其
 * onBeforeRender → _prepareForRender 每帧把 fillOpacity 读入 uTroikaFillOpacity uniform，
 * 故在 useFrame 中赋值后下一帧渲染即生效。drei <Text> 的 ref 指向该 troika 实例
 * （ForwardRefComponent，ref 类型 any），本层以最小形状约束之，避免引入对 troika 内部的
 * 强类型耦合。
 */
interface TroikaTextLike {
  fillOpacity: number
}

/**
 * PlaceLabels 的 props：接收领域层准备好的标签 / 光点 + 可选的地形采样器，不取数、不做拾取、
 * 不持有交互状态（hover 焦点经共享 context 只读获得）。
 */
export interface PlaceLabelsProps {
  /** 领域层 preparePlaceLabels 的产物（省名标签 + 省会光点 + 省会名小字，已贴地 + 浮高）。 */
  readonly labels: PreparedPlaceLabels
  /**
   * 地形世界 y 采样器（标签遮挡判定用），由装配层从共享 ElevationProvider + 夸张系数 k 构造。
   * null / undefined 表示地形不可用（地形未就绪 / 已卸载）——此时遮挡层不发射线、标签保持
   * troika 默认完全可见（生命周期处理）。
   */
  readonly terrainQuery?: TerrainWorldYSampler | null
  /**
   * 共享入场帧（TASK-013 单一时间源，SPEC §4.3「省名标签按地理顺序错峰，如自西向东」）。注入时
   * 每帧由本组件单一 useFrame 把「省名标签按自西向东错峰淡入（computeProvinceLabelOpacity）」与
   * 「省会光点 / 省会名小字随省名阶段整体淡入（computeAncillaryLabelOpacity）」的入场透明度与遮挡 /
   * 焦点目标**乘法合成**后写入 troika fillOpacity / 光点材质 opacity。未注入时不施加入场透明度
   * （=1），标签 / 光点加载完成即直接可见。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 单个省会光点（球体 + additive 发光，贴地，位置真实）。
 *
 * 球体放在领域层准备的贴地世界坐标（y = h·k + epsilon）。MeshBasicMaterial 不参与光照（恒亮
 * 暖色）、AdditiveBlending 呈发光。depthTest 保持开启使光点被前方山体正确遮挡；
 * depthWrite=false 不影响其他透明层。renderOrder=3 使光点在省界（renderOrder=2）之后绘制。
 * 光点不参与遮挡淡化与 hover 样式（球体各向同性，depthTest 已与地形正确遮挡）；其透明度只由
 * 入场整体淡入决定（材质登记到父级数组 ref，父级单一 useFrame 统一写 opacity）。
 */
function CapitalPoint({
  position,
  initialOpacity,
  materialSlot,
  materialsRef,
}: {
  readonly position: readonly [number, number, number]
  /** 挂载期初始透明度（入场接管时 0 = 不可见，未接管时 1；逐帧由父级统一 useFrame 接管）。 */
  readonly initialOpacity: number
  /** 本光点材质在父级 materialsRef 数组中的下标（入场淡入时由父级统一寻址写 opacity）。 */
  readonly materialSlot: number
  /** 父级维护的省会光点材质数组 ref：本组件挂载时登记、卸载时清空对应槽位。 */
  readonly materialsRef: RefObject<(THREE.MeshBasicMaterial | null)[]>
}): ReactNode {
  return (
    <mesh position={[position[0], position[1], position[2]]} renderOrder={3}>
      <sphereGeometry args={[PLACE_LABELS_CONFIG.capitalPointRadiusMeters, 8, 8]} />
      {/*
        ref 回调把材质登记到父级 materialsRef[materialSlot]（卸载时以 null 清空槽位），供父级单一
        useFrame 统一写入场整体淡入 opacity（computeAncillaryLabelOpacity，与省会名小字同包）。
        opacity 初值使首个绘制帧即与入场阶段一致（不依赖帧订阅时序）。
      */}
      <meshBasicMaterial
        ref={(material: THREE.MeshBasicMaterial | null) => {
          materialsRef.current[materialSlot] = material
        }}
        color={PLACE_LABELS_CONFIG.capitalPointColorHex}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
        opacity={initialOpacity}
      />
    </mesh>
  )
}

/**
 * 渲染全部省名标签 / 省会光点（Billboard Text + 发光光点，始终面向相机），并对省名标签按
 * 地形遮挡判定调制透明度（§7.5）、按共享 hover 焦点放大置顶（§4.2）；hover 时该省省会名
 * 以小字呈现于光点上方，移出还原。
 *
 * 本组件不承担投影 / 高程 / 浮高计算（领域层职责），不读取地点 / heightmap 资产，不做拾取
 * ——它只是 PreparedPlaceLabels + 共享 hover 焦点状态的纯渲染边界 + 一个由统一帧循环驱动的
 * 遮挡淡化控制器。
 */
export function PlaceLabels({ labels, terrainQuery = null, entranceFrame = null }: PlaceLabelsProps): ReactNode {
  // 唯一焦点源：共享 hover context（ProvinceHoverPicker 写入；省界同源消费）。
  const hoveredAdminId = useHoveredProvince()

  // 各省名标签的 troika 实例引用（下标与 labels.provinceLabels 对齐；挂载 / 卸载由 R3F ref
  // 回调自动维护）。
  const textRefs = useRef<(TroikaTextLike | null)[]>([])
  // 各标签的遮挡目标透明度（遮挡判定结果；indeterminate 时保持上一次目标，不抖动）。
  const targetOpacities = useRef<number[]>([])
  // 各标签当前透明度（指数阻尼的当前值；初始 = 入场接管时 0（从不可见淡入）/ 未接管时可见）。
  const currentOpacities = useRef<number[]>([])
  // 帧计数（降频用）：由 R3F 统一帧循环递增，无独立计时器 / Clock。
  const frameCounter = useRef(0)
  // 省会光点材质引用数组（入场淡入时由本组件单一 useFrame 统一写 opacity；与遮挡文本共用同一
  // useFrame、同一共享 clock，无第二套计时器）。
  const capitalMaterialsRef = useRef<(THREE.MeshBasicMaterial | null)[]>([])
  // hover 呈现的省会名小字 troika 实例引用（至多一个；入场淡入时由同一 useFrame 写 fillOpacity）。
  const capitalNameRef = useRef<TroikaTextLike | null>(null)

  // 是否激活入场淡入（entranceFrame 注入即激活）。激活时省名标签 / 省会光点 / 省会名小字初始
  // 透明度为 0（从不可见淡入）；未激活时初始为可见，加载完成即直接可见。
  const entranceActive = entranceFrame !== null && entranceFrame !== undefined
  // 挂载期初始透明度（troika fillOpacity prop 与 currentOpacities 同源取值）：入场接管时 0 = 首个
  // 绘制帧即不可见（不依赖帧订阅时序），未接管时取遮挡配置的可见值（1.0）。
  const initialOpacity = entranceActive ? 0 : LABEL_OCCLUSION_CONFIG.visibleOpacity

  // 省名标签的「自西向东」错峰排序（TASK-013，SPEC §4.3「按地理顺序错峰，如自西向东」）。
  // 按世界 x（+X = 东，见 src/lib/projection）升序排省名标签下标：西部（x 小）staggerIndex 小 →
  // delay 小 → 先淡入。挂载期一次排序、确定性（同 x 时按原序稳定，Array.prototype.sort 为稳定排序）。
  const staggerInfo = useMemo(() => {
    const entries = labels.provinceLabels.map((desc, i) => ({ i, x: desc.position[0] }))
    entries.sort((a, b) => a.x - b.x)
    const indexToStagger = new Array<number>(labels.provinceLabels.length).fill(0)
    entries.forEach((entry, rank) => {
      indexToStagger[entry.i] = rank
    })
    return { indexToStagger, provinceCount: entries.length }
  }, [labels])

  // 标签数变化时同步数组长度（k 切换 / 资产重载导致 labels 变化时）；挂载期一次性分配，
  // 运行循环只读写元素、不重建数组（无分配约束）。新槽位初始化：遮挡目标恒为可见；当前透明度按
  // 入场接管与否取 0（接管：从不可见淡入）或可见（未接管：直接可见）。
  const labelCount = labels.provinceLabels.length
  if (targetOpacities.current.length !== labelCount) {
    targetOpacities.current = new Array<number>(labelCount).fill(LABEL_OCCLUSION_CONFIG.visibleOpacity)
    currentOpacities.current = new Array<number>(labelCount).fill(initialOpacity)
  }

  // hover 命中的省会名小字（至多一个；无焦点 / 未匹配时为 null）。挂载期一次查找，随焦点
  // 变化由 React 重渲染更新——小字标签只在焦点存续期间挂载，移出即卸载还原。
  const focusedCapitalLabel = useMemo(
    () =>
      hoveredAdminId === null
        ? null
        : (labels.capitalLabels.find((label) => label.adminId === hoveredAdminId) ?? null),
    [labels, hoveredAdminId],
  )

  useFrame((state, delta) => {
    const sampler = terrainQuery ?? null
    // 入场 elapsed（TASK-013 单一时间源）：entranceFrame 注入时取共享入场帧的 elapsed（与海面 /
    // 省界 / 地形共用同一 R3F clock 派生的入场帧）；未注入时为 0 且 entranceOn=false（入场透明度
    // 恒 1，等价于不施加入场淡入——回退边界）。
    const entranceOn = entranceFrame !== null && entranceFrame !== undefined
    const entranceElapsed = entranceOn ? entranceFrame.current.elapsedSeconds : 0

    // 降频：由统一帧循环驱动的确定性帧间隔（帧计数器对 checkFrameInterval 取模），非计时器 /
    // 非随机抽样。每 N 帧判定一次遮挡；未判定帧仍逐帧阻尼透明度（过渡平滑）。
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
    const provinceLabels = labels.provinceLabels

    // 省会光点 / 省会名小字透明度（TASK-013）：= 入场整体淡入透明度（computeAncillaryLabelOpacity，
    // 随省名淡入阶段 0→1，非错峰）。光点 / 小字不参与遮挡淡化（球体各向同性，depthTest 已正确遮挡；
    // 小字 hover 语义即置顶），故透明度只由入场淡入决定；入场完成后恒 1。entranceOn=false 时不写
    // opacity（材质 / troika 默认 1，回退边界：直接可见）。
    if (entranceOn) {
      const ancillaryOpacity = computeAncillaryLabelOpacity(entranceElapsed, ENTRANCE_DURATIONS)
      for (const material of capitalMaterialsRef.current) {
        if (material !== null && material !== undefined) {
          material.opacity = ancillaryOpacity
        }
      }
      const capitalName = capitalNameRef.current
      if (capitalName !== null) {
        capitalName.fillOpacity = ancillaryOpacity
      }
    }

    for (let i = 0; i < labelCount; i++) {
      const handle = refs[i]
      if (handle === null || handle === undefined) {
        // 该标签的 troika 实例尚未挂载（troika 异步字体同步中）或已卸载——跳过，不产生错误
        // 射线 / 僵尸更新。
        continue
      }
      const desc = provinceLabels[i]
      // 生命周期守护：sampler 为 null（地形未就绪或标签已卸载）时不发射线、不调制遮挡目标
      // ——既不产生错误射线，也不在不可用期伪造遮挡淡化。
      if (sampler !== null && shouldCheck) {
        // 遮挡判定（委托领域层纯函数）：射线方向「标签→相机」，距离比较「地形世界 y 高出射线 y
        // 超过余量 → 命中点比标签更近相机 → occluded」，否则 visible；退化 / 全失败 →
        // indeterminate。仅在确定结论（visible / occluded）时更新目标；indeterminate 保持上一次
        // 目标（不抖动）。状态恢复无残留：遮挡消失（visible）即把目标拉回完全可见，阻尼逐帧恢复。
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
        if (visibility === 'occluded') {
          targets[i] = cfg.occludedOpacity
        } else if (visibility === 'visible') {
          targets[i] = cfg.visibleOpacity
        }
      }
      // 样式合成优先级（遮挡透明度与 hover 放大必须通过明确优先级合成，不能互相覆盖造成闪烁）：
      // 遮挡 / 焦点目标 = 焦点 ? 置顶透明度（1.0，完全可见）: 遮挡目标——「被悬停的省名标签即使位于
      // 山后也保持完全可见（置顶）」，符合 SPEC §4.2「置顶」语义。这是确定性的单一公式，每帧
      // 在阻尼前合成（hoveredAdminId 变化经 useFrame 最新闭包即帧即生效），焦点态与遮挡态不
      // 会互相覆盖造成闪烁。sampler 不可用时遮挡目标取可见（不暗化）。焦点态字号 / 颜色则在
      // JSX 中据 hoveredAdminId 响应式合成（hoveredAdminId 变化立即生效），与透明度共同表达
      // 「放大置顶」。
      const isFocused = desc.adminId === hoveredAdminId
      const occlusionTarget = sampler !== null ? targets[i] : cfg.visibleOpacity
      const styleTarget = isFocused ? PROVINCE_HOVER_CONFIG.focusedLabelOpacity : occlusionTarget
      // 入场透明度合成（TASK-013）：最终目标 = 入场透明度 × 遮挡 / 焦点目标。省名标签按自西向东
      // 错峰淡入（staggerInfo 按世界 x 升序 → computeProvinceLabelOpacity）。入场完成后入场透明度
      // 恒 1，合成退化为纯遮挡 / 焦点目标——与 TASK-010 行为一致（无回归）。焦点置顶 × 入场透明度：
      // 入场期间相机锁定（SPEC §4.3），hover 虽可发生但焦点标签同样随入场淡入（乘法合成，不冲突）；
      // 入场后入场透明度=1，焦点置顶正常生效。
      const entranceOpacity = entranceOn
        ? computeProvinceLabelOpacity(
            entranceElapsed,
            ENTRANCE_DURATIONS,
            staggerInfo.indexToStagger[i],
            staggerInfo.provinceCount,
          )
        : 1
      const composedTarget = entranceOpacity * styleTarget
      // 每帧指数阻尼当前透明度 → 合成目标（THREE.MathUtils.damp = lerp(current, target,
      // 1 − exp(−λ·dt))）。过渡帧率无关（dt 来自统一时钟）、状态确定可恢复。阻尼结果赋给
      // troika fillOpacity，其 onBeforeRender 下一帧读入 uniform 即生效（深度测试保持开启，
      // 标签不永久穿透地形）。
      const next = THREE.MathUtils.damp(currents[i], composedTarget, cfg.dampLambda, dt)
      currents[i] = next
      handle.fillOpacity = next
    }
  })

  return (
    <group>
      {labels.provinceLabels.map((desc, i) => {
        // 焦点态字号 / 颜色合成（SPEC §4.2「标签放大」）：省名标签在 hoveredAdminId 命中时字号
        // × 放大倍率、颜色取焦点提亮色（从地形中跳出）；非焦点省名标签用基线字号 / 基线色。
        // fontSize / color 通过 troika Text 的 prop 响应式更新（hoveredAdminId 变化触发 React
        // 重渲染），troika 仅对该标签重排一次（非逐帧），性能可控。hoveredAdminId 为 null（无
        // 焦点）时全部回到基线（恢复不变量）。
        const isFocused = desc.adminId === hoveredAdminId
        const fontSizeMeters = isFocused
          ? PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters * PROVINCE_HOVER_CONFIG.focusedLabelScale
          : PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters
        const colorHex = isFocused
          ? PROVINCE_HOVER_CONFIG.focusedLabelColorHex
          : PLACE_LABELS_CONFIG.provinceLabelColorHex
        return (
          <Billboard
            key={`province-name-${desc.adminId}`}
            position={[desc.position[0], desc.position[1], desc.position[2]]}
          >
            {/*
              ref 回调按 provinceLabels 下标登记 troika 实例；卸载时 R3F 以 null 回调清空对应槽位
              （生命周期自动）。fillOpacity 初值 = initialOpacity（入场接管时 0 = 首个绘制帧即不可见，
              不依赖帧订阅时序）；prop 恒定，React 重渲染不会回写（R3F 仅应用变化项），逐帧值由上方
              useFrame 接管。font 取本地子集路径（装配层已校验覆盖）。
            */}
            <Text
              ref={(el: TroikaTextLike | null) => {
                textRefs.current[i] = el
              }}
              font={PLACE_LABELS_CONFIG.fontPath}
              fontSize={fontSizeMeters}
              color={colorHex}
              fillOpacity={initialOpacity}
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
          position={point.position}
          initialOpacity={initialOpacity}
          materialSlot={index}
          materialsRef={capitalMaterialsRef}
        />
      ))}
      {/*
        省会名小字（SPEC §3.7「省会名以小字 / hover 呈现」）：仅焦点存续期间挂载，浮于该省
        省会光点正上方，小字号 / 暖色系（与光点同族），Billboard 始终面向相机。不参与遮挡
        淡化（hover 语义即置顶）；深度测试保持开启。移出即卸载还原。入场淡入随省会光点同包
        （computeAncillaryLabelOpacity 整体淡入，由上方 useFrame 逐帧写 fillOpacity）。
      */}
      {focusedCapitalLabel !== null && (
        <Billboard
          key={`capital-name-${focusedCapitalLabel.adminId}`}
          position={[
            focusedCapitalLabel.position[0],
            focusedCapitalLabel.position[1],
            focusedCapitalLabel.position[2],
          ]}
        >
          <Text
            ref={(el: TroikaTextLike | null) => {
              capitalNameRef.current = el
            }}
            font={PLACE_LABELS_CONFIG.fontPath}
            fontSize={PLACE_LABELS_CONFIG.capitalLabelFontSizeMeters}
            color={PLACE_LABELS_CONFIG.capitalLabelColorHex}
            fillOpacity={initialOpacity}
            anchorX="center"
            anchorY="middle"
          >
            {focusedCapitalLabel.name}
          </Text>
        </Billboard>
      )}
    </group>
  )
}
