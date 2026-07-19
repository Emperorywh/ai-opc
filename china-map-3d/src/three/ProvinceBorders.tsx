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
 * - 本组件不接收任何运行时交互状态（hover 由 TASK-018 交付）：它只消费领域层产物，按 adminId 分组渲染。
 *   分组结构（每个行政区一个 Line）使后续 hover 能确定性更新单一省份材质（改一个 Line 的 color / lineWidth
 *   即可），不破坏其他省份（TASK-014 实现约束「后续 hover 仍须能确定性更新单一省份样式」）。
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
import type { ReactNode } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { PROVINCE_BORDERS_CONFIG } from '../config/province-borders'
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
 * 单个行政区的贴地边界线（一个 LineSegments2 = 一个 draw call，按 adminId 寻址，供后续 hover 更新材质）。
 *
 * 无线段（segmentCount=0，理论上不发生——契约保证每环 ≥3 顶点）时返回 null，不渲染空 Line。
 */
function ProvinceBorderLine({ border }: { readonly border: PreparedProvinceBorder }): null | ReactNode {
  // drei Line 实例引用，用于挂载后在其 material 上注入 NDC 深度偏移。
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  // 端点三元组化（挂载期一次，segments 模式按三元组两两成对解释为线段）。
  const points = useMemo(
    () => flatEndpointsToTriplets(border.segmentEndpointsFlat),
    [border.segmentEndpointsFlat],
  )
  // 挂载后注入深度偏移：drei 在 useState 内一次性创建 LineMaterial 并经 primitive attach，故此时
  // lineRef.current.material 已就绪；needsUpdate=true 强制重编译使注入在首帧生效。
  useLayoutEffect(() => {
    const line = lineRef.current as { material: THREE.Material } | null
    if (line === null) return
    const material = line.material as THREE.ShaderMaterial
    applyLineDepthBias(material, PROVINCE_BORDERS_CONFIG.depthBiasNdc)
  }, [])

  if (border.segmentCount === 0) return null

  return (
    <Line
      ref={lineRef}
      // segments 模式：points 按三元组两两成对解释为独立线段（每对 = 领域层一条 densify 子段）。
      segments
      points={points}
      color={PROVINCE_BORDERS_CONFIG.colorHex}
      lineWidth={PROVINCE_BORDERS_CONFIG.lineWidthPx}
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

/** ProvinceBorders 的 props：只接收领域层准备好的贴地线段，不取数、不计算、不持有 hover 状态。 */
export interface ProvinceBordersProps {
  /** 领域层 prepareProvinceBorders 的产物（已 densify + 贴地 + 按行政区分组）。 */
  readonly borders: PreparedProvinceBorders
}

/**
 * 渲染全部省级贴地边界（按行政区分组，浅青白发光，NDC 深度偏移抗 z-fighting，与海面透明共存）。
 *
 * 本组件不承担 densify / 高程采样 / 投影（领域层职责），不读取 GeoJSON / heightmap / hover 状态——
 * 它只是 PreparedProvinceBorders 的纯渲染边界。回退本 TASK 仅移除本组件与领域准备层，地形 / 海面 /
 * 静态行政区资产完整保留（TASK-014 回退边界）。
 */
export function ProvinceBorders({ borders }: ProvinceBordersProps): ReactNode {
  return (
    <group>
      {borders.borders.map((border) => (
        <ProvinceBorderLine key={border.adminId} border={border} />
      ))}
    </group>
  )
}
