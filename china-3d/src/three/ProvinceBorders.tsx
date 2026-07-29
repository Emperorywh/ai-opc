/**
 * 省级贴地边界的渲染层（TASK-009，SPEC §3.6 / §4.2）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的贴地线段（PreparedProvinceBorders）
 *   装配成 drei Line（Line2/LineSegments2，SPEC §3.6 指定）并按行政区分组渲染」。它**只**依赖：
 *   配置层（PROVINCE_BORDERS_CONFIG——基线色 / 基线线宽 / NDC 深度偏移的唯一源；
 *   PROVINCE_HOVER_CONFIG——焦点 / 压暗派生样式的唯一源）、领域层（PreparedProvinceBorders 类型）、
 *   悬停状态 context（useHoveredProvince——唯一焦点源）、three / R3F / drei。**禁止**自行读取
 *   GeoJSON、复制 densify / 高程采样 / 投影逻辑、自行拾取 hover、或在组件内写个省魔法修补。
 * - 本组件不做拾取（拾取由 src/three/ProvinceHoverPicker 单点承担）：hoveredAdminId 经
 *   useHoveredProvince 从共享 context 只读获得，按 adminId 确定性寻址单一省份并更新其材质
 *   （改一个 Line 的 color / lineWidth 即可），不破坏其他省份。分组结构（每个行政区一个 Line）
 *   使 hover 能确定性寻址单一省份。
 *
 * draw call 预算（SPEC §3.6「合并为尽量少的 draw call（按省分组或整体合并）」）：
 * - 每个行政区的全部环（外环 + 内环 + 岛屿）已合并为一条 segments 折线（领域层平铺端点数组），
 *   渲染层每省一个 drei Line = 一个 draw call，34 省共 34 个 draw call——这是「尽量少」在「保留
 *   按省寻址以支持 hover（SPEC §4.2）」前提下的落点：整体合并为一条 LineSegments 虽只剩 1 个
 *   draw call，但 hover 时无法只加亮单一省份，故按省分组。
 *
 * 浅青白发光（SPEC §3.6「浅青白 #9fe8d8 左右，additive 轻发光」）：
 * - 基线色取自 PROVINCE_BORDERS_CONFIG.colorHex（#9fe8d8），基线线宽取自 lineWidthPx（1.6 px
 *   屏幕空间）。
 * - AdditiveBlending：省界片元在通过深度测试后把浅青白色加到帧缓冲，在深色科技风背景下呈轻
 *   发光。additive 不写深度（depthWrite=false），不参与陆地色阶，不随高程变化（纯地理展示）。
 *
 * 与海面共存（SPEC §3.5 / §3.6：省界与海面交接处无透明排序错乱、线条闪烁或被海面吞没）：
 * - transparent + depthWrite=false：省界在透明通道绘制、不写深度。水下地形与陆地（不透明、已写
 *   深度）决定深度缓冲；省界片元按 NDC 深度偏移后的深度做 depthTest——在陆地上方（更近）通过、
 *   在海岸线（y≈epsilon>0 高于海面 y=0）通过，故省界不会被半透明海面吞没（海面 depthWrite=false
 *   不参与深度竞争）。renderOrder=2 使省界在海面（renderOrder=0）之后绘制，避免海岸线处透明
 *   顺序错乱。
 *
 * 抗 z-fighting（结构性消除）：
 * - 地图尺度下相机远、深度量化粗（默认视距下 24 位深度的一桶约数公里），单纯靠世界 epsilon 无法
 *   跨越一个深度桶，省界与同位置地表会 z-fighting（闪烁）。故在 LineMaterial 顶点着色器内注入
 *   NDC 深度偏移（applyLineDepthBias）：把省界片元在 NDC 空间整体推近约 80 个深度 ULP——使其恒
 *   胜过同位置地表（消除闪烁），仍被真正更近的山体（NDC 差远大于偏移）正确遮挡。这是大屏尺度下
 *   「省界贴地又不闪烁」的主防线，领域层 epsilon 是浮点对齐的辅助防线。
 */

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { PROVINCE_BORDERS_CONFIG } from '../config/province-borders'
import { PROVINCE_HOVER_CONFIG } from '../config/province-hover'
import { useHoveredProvince } from './province-hover'
import { applyLineDepthBias } from './line-depth-bias'
import type { PreparedProvinceBorder, PreparedProvinceBorders } from '../lib/province-borders'

/**
 * 把领域层的平铺 [x,y,z, x,y,z, ...] 端点转成 drei Line segments 模式所需的 [x,y,z] 三元组数组。
 *
 * segments 模式按「相邻三元组两两成对」解释：[a0,b0,a1,b1,...] 中每对 (a_k,b_k) 是一条线段。
 * 领域层平铺数组已按「子段起点+终点」组织（每 6 个数 = 一条子段），故直接每 3 个数切成一个
 * 三元组、保持顺序即可。转换在挂载期一次性完成（useMemo），不在渲染循环中重复。
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
 * 单个行政区的贴地边界线（一个 Line = 一个 draw call，按 adminId 寻址，据 hoveredAdminId 更新材质）。
 *
 * 样式派生（SPEC §4.2「悬停省份边界加亮加粗，其余省份边界可轻微压暗，移出后还原」）：
 * - 焦点态（border.adminId === hoveredAdminId）：色取焦点加亮色（PROVINCE_HOVER_CONFIG.
 *   focusedBorderColorHex，比基线更亮）、线宽取焦点加粗值（focusedBorderLineWidthPx）。该省边界
 *   从一众基线中视觉跳出，标识当前焦点。
 * - 压暗态（hoveredAdminId 非空且未命中本省）：色取压暗色（dimmedBorderColorHex，比基线更暗），
 *   线宽保持基线。弱化非焦点以衬托焦点（可选视觉衬托，非识别焦点的必要条件）。
 * - 基线态（hoveredAdminId 为 null，无焦点）：色取基线色、线宽取基线值。移出 / 海域 / 无命中全部
 *   回到此态（移出还原不变量）。
 * - color / lineWidth 通过 drei <Line> 的 prop 响应式更新（hoveredAdminId 变化触发 React 重渲染，
 *   drei 更新 material.color / material.linewidth，不触发着色器重编译，故挂载期注入的 NDC 深度
 *   偏移持久生效）。
 *
 * 无线段（segmentCount=0，理论上不发生——契约保证每环 ≥ 3 顶点）时返回 null，不渲染空 Line。
 */
function ProvinceBorderLine({
  border,
  hoveredAdminId,
}: {
  readonly border: PreparedProvinceBorder
  readonly hoveredAdminId: string | null
}): null | ReactNode {
  // drei Line 实例引用，用于挂载后在其 material 上注入 NDC 深度偏移。
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  // 端点三元组化（挂载期一次，segments 模式按三元组两两成对解释为线段）。
  const points = useMemo(
    () => flatEndpointsToTriplets(border.segmentEndpointsFlat),
    [border.segmentEndpointsFlat],
  )
  // 挂载后注入深度偏移：drei 在创建 LineMaterial 并经 primitive attach 后，lineRef.current.material
  // 已就绪；applyLineDepthBias 内置 needsUpdate=true 强制重编译使注入在首帧生效。
  useLayoutEffect(() => {
    const line = lineRef.current as { material: THREE.Material } | null
    if (line === null) return
    applyLineDepthBias(line.material as THREE.ShaderMaterial, PROVINCE_BORDERS_CONFIG.depthBiasNdc)
  }, [])

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

/** ProvinceBorders 的 props：只接收领域层准备好的贴地线段；hover 状态经 context 消费，不经 props。 */
export interface ProvinceBordersProps {
  /** 领域层 prepareProvinceBorders 的产物（已 densify + 贴地 + 按行政区分组）。 */
  readonly borders: PreparedProvinceBorders
}

/**
 * 渲染全部省级贴地边界（按行政区分组，浅青白 additive 发光，NDC 深度偏移抗 z-fighting，与海面
 * 透明共存；据共享 hover 焦点加亮加粗焦点省界、压暗非焦点省界、无焦点基线）。
 *
 * 本组件不承担 densify / 高程采样 / 投影（领域层职责），不读取 GeoJSON / heightmap，不做拾取——
 * 它只是 PreparedProvinceBorders + 共享 hover 焦点状态的纯渲染边界。
 */
export function ProvinceBorders({ borders }: ProvinceBordersProps): ReactNode {
  // 唯一焦点源：共享 hover context（ProvinceHoverPicker 写入；TASK-010 标签模块同源消费）。
  const hoveredAdminId = useHoveredProvince()
  return (
    <group>
      {borders.borders.map((border) => (
        <ProvinceBorderLine key={border.adminId} border={border} hoveredAdminId={hoveredAdminId} />
      ))}
    </group>
  )
}
