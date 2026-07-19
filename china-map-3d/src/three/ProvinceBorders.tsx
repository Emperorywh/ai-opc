/**
 * 省级贴地边界的渲染层（TASK-014）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的贴地线段（PreparedProvinceBorders）装配成
 *   drei Line（等价 Line2 / Line2Segments）并按行政区分组渲染」。它**只**依赖：配置层
 *   （PROVINCE_BORDERS_CONFIG —— 颜色 / 线宽 / NDC 深度偏移的唯一源）、领域层（PreparedProvinceBorders 类型）、
 *   three / R3F / drei。**禁止**自行读取 GeoJSON、复制 densify / 高程采样 / 投影逻辑、维护 hover 状态、
 *   或在组件内写个省魔法修补（TASK-014 实现约束「视图层只消费准备好的线数据」「densify、高程贴地和渲染
 *   数据准备属于领域/适配层」）。
 * - 本组件接收单一显式交互状态 hoveredAdminId（TASK-018 交付：场景层保管的唯一焦点标识，稳定 adminId 或
 *   null）：它只消费领域层产物 + 该焦点状态，按 adminId 分组渲染，并据 hoveredAdminId 确定性更新单一省份
 *   材质（改一个 Line 的 color / lineWidth 即可），不破坏其他省份。分组结构（每个行政区一个 Line）使 hover
 *   能确定性寻址单一省份（TASK-014 实现约束「后续 hover 仍须能确定性更新单一省份样式」）。本组件不做拾取
 *   （拾取由 src/three/ProvinceHoverPicker 单点承担，TASK-018 实现约束「边界和标签视图只能消费最终状态」）。
 *
 * 浅青白发光（SPEC §3.6「浅青白 #9fe8d8 左右，additive 轻发光」、TASK-014 输出约束「线条为浅青白、轻发光」）：
 * - 颜色取自 PROVINCE_BORDERS_CONFIG.colorHex（#9fe8d8），线宽取自 lineWidthPx（1.6 px 屏幕空间）。
 * - AdditiveBlending：省界片元在通过深度测试后把浅青白色加到帧缓冲，在深色科技风背景下呈轻发光。
 *   additive 不写深度（depthWrite=false），不参与陆地色阶，不随高程变化（纯地理展示）。
 *
 * 与海面共存（SPEC §3.5 / §3.6、TASK-014 验证方式 5「海面已启用场景下省界与海面交接处无透明排序错乱、
 * 线条闪烁或被海面完全吞没」）：
 * - transparent + depthWrite=false：省界在透明通道绘制、不写深度。水下地形（不透明、已写深度）与陆地
 *   （已写深度）决定深度缓冲；省界片元按 NDC 深度偏移后的深度做 depthTest——在陆地上方（更近）通过、
 *   在海岸线（y≈epsilon>0 高于海面 y=0）通过，故省界不会被半透明海面吞没（海面 depthWrite=false 不参与
 *   深度比较）。renderOrder=2 使省界在海面（renderOrder=0）之后绘制，避免海岸线处透明顺序错乱。
 *
 * 抗 z-fighting（结构性消除，TASK-014 输出约束「与海面共存时的 z-fighting 边界」）：
 * - 地图尺度下相机远、深度量化粗（默认视距下 24 位深度的一桶约数公里），单纯靠世界 epsilon 无法跨越一
 *   个深度桶，省界与同位置地表会 z-fighting（闪烁）。故在 LineMaterial 顶点着色器内注入一个 NDC 深度偏移
 *   （applyLineDepthBias）：从 gl_Position.z 减去 depthBiasNdc × clip.w，把省界片元在 NDC 空间整体推近约
 *   80 个深度 ULP——使其恒胜过同位置地表（消除闪烁），仍被真正更近的山体（NDC 差远大于偏移）正确遮挡。
 *   这是大屏尺度下「省界贴地又不闪烁」的关键，单靠领域层 epsilon 无法达成。
 */

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { PROVINCE_BORDERS_CONFIG } from '../config/province-borders'
import { PROVINCE_HOVER_CONFIG } from '../config/province-hover'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import { computeSceneLayerOpacity, type EntranceFrame } from '../lib/entrance-state'
import { applyLineDepthBias } from './line-depth-bias'
import type { PreparedProvinceBorder, PreparedProvinceBorders } from '../lib/province-borders'

/**
 * 把领域层的平铺 [x,y,z, x,y,z, ...] 端点转成 drei Line segments 模式所需的 [x,y,z] 三元组数组。
 *
 * segments 模式按「相邻三元组两两成对」解释：[a0,b0,a1,b1,...] 中每对 (a_k,b_k) 是一条线段。领域层平铺
 * 数组已按「子段起点+终点」组织（每 6 个数 = 一条子段），故直接每 3 个数切成一个三元组、保持顺序即可。
 * 转换在挂载期一次性完成（useMemo），不在渲染循环中重复。
 */
function flatEndpointsToTriplets(
  flat: ReadonlyArray<number>,
): ReadonlyArray<readonly [number, number, number]> {
  const triplets: Array<readonly [number, number, number]> = []
  // 每 3 个数一个三元组 [x,y,z]；flat 长度恒为 6 的整数倍（每条子段贡献 6 个数）。
  for (let i = 0; i + 2 < flat.length; i += 3) {
    triplets.push([flat[i], flat[i + 1], flat[i + 2]] as readonly [number, number, number])
  }
  return triplets
}

/**
 * 单个行政区的贴地边界线（一个 LineSegments2 = 一个 draw call，按 adminId 寻址，据 hoveredAdminId 更新材质）。
 *
 * 样式派生（TASK-018 单一焦点状态 → 边界样式的唯一合成，SPEC §4.2「悬停省份边界加亮加粗，其余可轻微压暗」）：
 * - 焦点态（border.adminId === hoveredAdminId）：色取焦点加亮色（PROVINCE_HOVER_CONFIG.focusedBorderColorHex，
 *   比基线更亮）、线宽取焦点加粗值（focusedBorderLineWidthPx）。该省边界从一众基线中视觉跳出，标识当前焦点。
 * - 压暗态（hoveredAdminId 非空且未命中本省）：色取压暗色（dimmedBorderColorHex，比基线更暗），线宽基线。
 *   弱化非焦点以衬托焦点（可选视觉衬托，非识别焦点的必要条件——焦点本身已由加亮加粗标识）。
 * - 基线态（hoveredAdminId 为 null，无焦点）：色取基线色、线宽取基线值。移出 / 海域 / 无命中全部回到此态
 *   （恢复不变量）。
 * - color / lineWidth 通过 drei <Line> 的 prop 响应式更新（hoveredAdminId 变化触发 React 重渲染，drei 更新
 *   material.color / material.linewidth，不触发着色器重编译，故挂载期注入的 NDC 深度偏移持久生效）。
 *
 * 无线段（segmentCount=0，理论上不发生——契约保证每环 ≥3 顶点）时返回 null，不渲染空 Line。
 */
function ProvinceBorderLine({
  border,
  hoveredAdminId,
  materialSlot,
  materialsRef,
}: {
  readonly border: PreparedProvinceBorder
  readonly hoveredAdminId: string | null
  /** 本省线材质在父级 materialsRef 数组中的下标（入场淡入时由父级统一寻址写 opacity）。 */
  readonly materialSlot: number
  /** 父级维护的线材质数组 ref：本组件挂载时登记、卸载时清空对应槽位。 */
  readonly materialsRef: RefObject<(THREE.Material | null)[]>
}): null | ReactNode {
  // drei Line 实例引用，用于挂载后在其 material 上注入 NDC 深度偏移 + 登记到父级材质数组。
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  // 端点三元组化（挂载期一次，segments 模式按三元组两两成对解释为线段）。
  const points = useMemo(
    () => flatEndpointsToTriplets(border.segmentEndpointsFlat),
    [border.segmentEndpointsFlat],
  )
  // 挂载后注入深度偏移：drei 在 useState 内一次性创建 LineMaterial 并经 primitive attach，故此时
  // lineRef.current.material 已就绪；needsUpdate=true 强制重编译使注入在首帧生效。
  // 同时把该材质登记到父级 materialsRef[materialSlot]，供 ProvinceBorders 单一 useFrame 统一写入场淡入
  // opacity（避免 34 个省界各开一个 useFrame；TASK-020「不由组件私自计时」——透明度来自共享入场帧）。
  useLayoutEffect(() => {
    const line = lineRef.current as { material: THREE.Material } | null
    if (line === null) return
    const material = line.material as THREE.ShaderMaterial
    applyLineDepthBias(material, PROVINCE_BORDERS_CONFIG.depthBiasNdc)
    // 捕获稳定的材质数组引用 + 槽位下标，使 cleanup 写「同一数组的同一槽位」（materialsRef.current 由父级
    // useRef 一次创建、永不重新赋值，捕获安全；避免在 cleanup 直接读 ref.current 触发 exhaustive-deps 告警）。
    const slot = materialSlot
    const materials = materialsRef.current
    materials[slot] = material
    return () => {
      // 卸载 / 重渲染清空对应槽位，避免对已释放材质写 opacity（k 切换重建边界时确定性回收）。
      materials[slot] = null
    }
  }, [materialSlot, materialsRef])

  if (border.segmentCount === 0) return null

  // 单一焦点状态 → 本省边界样式的确定性合成（焦点 > 压暗 > 基线，三态互斥，无第二套样式路径）。
  const isFocused = hoveredAdminId !== null && hoveredAdminId === border.adminId
  const hasFocus = hoveredAdminId !== null
  const colorHex = isFocused
    ? PROVINCE_HOVER_CONFIG.focusedBorderColorHex
    : hasFocus
      ? PROVINCE_HOVER_CONFIG.dimmedBorderColorHex
      : PROVINCE_BORDERS_CONFIG.colorHex
  const lineWidthPx = isFocused
    ? PROVINCE_HOVER_CONFIG.focusedBorderLineWidthPx
    : PROVINCE_BORDERS_CONFIG.lineWidthPx

  return (
    <Line
      ref={lineRef}
      // segments 模式：points 按三元组两两成对解释为独立线段（每对 = 领域层一条 densify 子段）。
      segments
      points={points}
      color={colorHex}
      lineWidth={lineWidthPx}
      // 半透明 + 不写深度：省界在透明通道绘制、不竞争深度，水下地形 / 陆地已写深度决定可见性。
      transparent
      depthWrite={false}
      // AdditiveBlending：浅青白片元加到帧缓冲，深色背景下呈轻发光（SPEC §3.6）。
      blending={THREE.AdditiveBlending}
      // 海岸线处省界在海面（renderOrder=0）之后绘制，避免透明顺序错乱。
      renderOrder={2}
    />
  )
}

/** ProvinceBorders 的 props：接收领域层准备好的贴地线段 + 单一焦点状态 + 共享入场帧，不取数、不计算、不持有 hover 状态。 */
export interface ProvinceBordersProps {
  /** 领域层 prepareProvinceBorders 的产物（已 densify + 贴地 + 按行政区分组）。 */
  readonly borders: PreparedProvinceBorders
  /**
   * 当前悬停焦点行政区的稳定标识（CN- 前缀）或 null（无焦点）。由场景层（ChinaMapScreen）保管的唯一焦点源，
   * 本组件据此派生每省边界样式（焦点加亮加粗 / 非焦点压暗 / 无焦点基线）。null 时全部省份回到基线态
   * （恢复不变量）。本组件不做拾取——拾取由 ProvinceHoverPicker 单点承担，本组件只消费该状态。
   */
  readonly hoveredAdminId?: string | null
  /**
   * 共享入场帧（TASK-020 单一时间源）。注入时每帧由本组件单一 useFrame 把 computeSceneLayerOpacity(elapsed)
   * 写入全部省界材质的 opacity，使省界在省名标签淡入后随水面 / 边界阶段平滑淡入（SPEC §4.3「水面、边界线
   * 随后淡入」）。未注入（回退 TASK-020）时不写 opacity（材质 opacity 默认 1，省界加载完成即直接可见）。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 渲染全部省级贴地边界（按行政区分组，浅青白发光，NDC 深度偏移抗 z-fighting，与海面透明共存；据 hoveredAdminId
 * 加亮加粗焦点省界、压暗非焦点省界；据共享入场帧统一淡入）。
 *
 * 本组件不承担 densify / 高程采样 / 投影（领域层职责），不读取 GeoJSON / heightmap——它只是
 * PreparedProvinceBorders + 单一焦点状态 + 共享入场帧的纯渲染边界。回退本 TASK（TASK-018）仅移除 hoveredAdminId
 * 透传与焦点样式派生：把 hoveredAdminId 恒置 null 即恢复 TASK-014 的基线态（全部省份浅青白基线色 / 基线线宽），
 * 贴地描边、NDC 深度偏移、与海面透明共存全部无回归（TASK-018 回退边界）。回退 TASK-020 仅移除 entranceFrame
 * 透传与淡入 useFrame：省界加载完成即直接可见。
 */
export function ProvinceBorders({ borders, hoveredAdminId = null, entranceFrame = null }: ProvinceBordersProps): ReactNode {
  // 全部省界线材质的登记数组（ProvinceBorderLine 挂载时按 materialSlot 登记、卸载时清空）。
  // 单一 useFrame 据共享入场帧统一写 opacity，避免 34 个省界各开 useFrame（TASK-020「不由组件私自计时」）。
  const materialsRef = useRef<(THREE.Material | null)[]>([])

  // 入场淡入（TASK-020）：注入共享入场帧时，每帧把全部省界材质 opacity 设为 computeSceneLayerOpacity。
  // LineMaterial 的 opacity getter/setter 写入其 uniforms.opacity.value，片元着色器按之缩放 alpha；
  // AdditiveBlending 下 alpha 缩放加贡献，故 opacity 0→1 即省界从不可见到完全发光淡入。
  // 与 SeaSurface / PoliticalFeatures 共用同一 computeSceneLayerOpacity（同一 elapsed、同一函数），故
  // 水面 / 省界 / 十段线同阶段同步淡入。entranceFrame 未注入时本回调直接 return（opacity 默认 1，回退）。
  useFrame(() => {
    if (entranceFrame === null || entranceFrame === undefined) return
    const frame = entranceFrame.current
    if (frame === null || frame === undefined) return
    const opacity = computeSceneLayerOpacity(frame.elapsedSeconds, ENTRANCE_DURATIONS)
    for (const material of materialsRef.current) {
      if (material !== null && material !== undefined) {
        material.opacity = opacity
      }
    }
  })

  return (
    <group>
      {borders.borders.map((border, index) => (
        <ProvinceBorderLine
          key={border.adminId}
          border={border}
          hoveredAdminId={hoveredAdminId}
          materialSlot={index}
          materialsRef={materialsRef}
        />
      ))}
    </group>
  )
}
