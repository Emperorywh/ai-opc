/**
 * 政治边界补充要素（十段线 + 岛礁点位）的主图渲染层（TASK-011，SPEC §5.3/§6）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的十段线 densify 海平面贴合子段
 *   （PreparedPoliticalLine[]）+ 岛礁点位世界坐标（PreparedPoliticalPoint[]）装配成 drei Line（每段一条
 *   暖琥珀虚线）+ 球体光点（每个岛礁一个发光标记）」。它**只**依赖：配置层（POLITICAL_FEATURES_CONFIG——
 *   颜色 / 线宽 / 虚线节拍 / 点位半径 / NDC 深度偏移的唯一源）、领域层（PreparedPoliticalFeatures 类型）、
 *   three / R3F / drei、本层 line-depth-bias（applyLineDepthBias——与省界共用同一注入函数）。
 *   **禁止**自行读取政治边界资产、复制 densify / 海平面贴合 / 投影逻辑、或在组件内补写十段线 / 岛礁坐标
 *   （坐标唯一事实源是 TASK-004 的政治边界补充资产）。
 * - 本组件不接收任何运行时交互状态（hover / click 与政治要素无关，SPEC §4.2 的 hover 仅针对省份）：
 *   它只消费领域层产物，纯静态呈现。十段线按段（segmentIndex）各一个 Line（不合并为单条连续折线），
 *   使每段可独立审计、台湾东侧段（segmentIndex=10）可独立定位（SPEC §6 红线可核查性）。
 *
 * 与省界视觉可区分（SPEC §5.3「样式与省界区分（如更亮的发光虚线）」）：
 * - 颜色：十段线取暖琥珀 #ffd180（POLITICAL_FEATURES_CONFIG.lineColorHex），与省界浅青白 #9fe8d8 冷暖
 *   相对、色相分明——这是最主干的区分手段，即便虚线因平台差异失效，颜色仍使二者明确可辨。
 * - 线宽：2.0 px（略粗于省界 1.6 px），更突出。
 * - 虚线：drei Line dashed 模式（dashSize / gapSize 来自配置），沿弧长呈实线 + 空白节拍，与省界实线区分。
 * - AdditiveBlending：暖琥珀片元加到帧缓冲，深色科技风背景下呈明亮暖光发光。
 *
 * 海平面贴合高度（由领域层准备，本层只消费）：十段线 / 点位 y = max(h·k, seaLevelYMeters) + epsilon，
 * 陆地贴合地形、海域钳制到海平面之上 epsilon。本层据此放置 Line 顶点与球体光点——线 / 点恒位于半透明
 * 海面（y=0，depthWrite=false）之上、不被吞没。
 *
 * 抗 z-fighting（与省界共用同一结构性手段）：LineMaterial 顶点着色器注入 NDC 深度偏移（applyLineDepthBias，
 *   POLITICAL_FEATURES_CONFIG.depthBiasNdc），使十段线片元在深度测试中恒胜过同位置的贴合面（地表 / 海面），
 *   仍被前方山体正确遮挡。与省界同值、同函数、同一类问题在同一地图尺度下的同一解。
 *
 * 与海面 / 省界透明共存（SPEC §3.5 / §3.6）：
 * - 十段线：transparent + depthWrite=false + renderOrder=3（海面 0、省界 2、十段线 3），使十段线在海面与
 *   省界之后绘制，暖琥珀片元加到帧缓冲，不被半透明海面吞没、不与省界透明排序错乱。
 * - 岛礁光点：球体 + MeshBasicMaterial（不参与光照，恒亮暖色）+ AdditiveBlending + depthWrite=false +
 *   renderOrder=3，depthTest 保持开启使其被前方山体正确遮挡（光点在山后不可见、在海面 / 地表之上可见）。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13）：
 * - 本组件只呈现十段线与岛礁点位的可见标记，不添加审图号角标、不通过任何视觉手段宣称已审图。
 *   规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙等）的文本标注由后续统一标签任务呈现。
 */

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { POLITICAL_FEATURES_CONFIG } from '../config/political-features'
import { applyLineDepthBias } from './line-depth-bias'
import type {
  PreparedPoliticalFeatures,
  PreparedPoliticalLine,
  PreparedPoliticalPoint,
} from '../lib/political-features'

/**
 * 把领域层的平铺 [x,y,z, x,y,z, ...] 端点转成 drei Line segments 模式所需的 [x,y,z] 三元组数组。
 *
 * 与省界 flatEndpointsToTriplets 同构：segments 模式按「相邻三元组两两成对」解释为独立线段。
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
 * 单段十段线的渲染（一个 LineSegments2 = 一个 draw call）。
 *
 * 无线段（segmentCount=0，理论上不发生——契约保证每段 ≥ 2 顶点）时返回 null，不渲染空 Line。
 * 暖琥珀 + 虚线 + AdditiveBlending + NDC 深度偏移，与省界（浅青白实线）视觉明确区分。
 */
function PoliticalLineSegment({ line }: { readonly line: PreparedPoliticalLine }): null | ReactNode {
  // drei Line 实例引用，用于挂载后在其 material 上注入 NDC 深度偏移。
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  // 端点三元组化（挂载期一次，segments 模式按三元组两两成对解释为线段）。
  const points = useMemo(
    () => flatEndpointsToTriplets(line.segmentEndpointsFlat),
    [line.segmentEndpointsFlat],
  )
  // 挂载后注入深度偏移（与省界 applyLineDepthBias 同函数、同注入点；dashed 模式的片元丢弃在 fragment
  // shader，与 vertex shader 的深度偏移正交，故二者共存）。
  useLayoutEffect(() => {
    const lineObj = lineRef.current as { material: THREE.Material } | null
    if (lineObj === null) return
    applyLineDepthBias(lineObj.material as THREE.ShaderMaterial, POLITICAL_FEATURES_CONFIG.depthBiasNdc)
  }, [])

  if (line.segmentCount === 0) return null

  return (
    <Line
      ref={lineRef}
      // segments 模式：points 按三元组两两成对解释为独立线段（每对 = 领域层一条 densify 子段）。
      segments
      points={points}
      color={POLITICAL_FEATURES_CONFIG.lineColorHex}
      lineWidth={POLITICAL_FEATURES_CONFIG.lineWidthPx}
      // 虚线节拍（SPEC §5.3「发光虚线」）：drei Line dashed 模式按 dashSize 实线 + gapSize 空白沿弧长重复，
      // 与省界实线区分。虚线逻辑在 LineMaterial 的 fragment shader（按 lineDistance 丢弃片元），与 vertex
      // shader 的 NDC 深度偏移正交，二者共存。颜色（暖琥珀 vs 浅青白）是最主干的区分手段，即便虚线因平台
      // 差异失效，颜色仍使十段线与省界明确可辨。
      dashed
      dashSize={POLITICAL_FEATURES_CONFIG.lineDashSize}
      gapSize={POLITICAL_FEATURES_CONFIG.lineGapSize}
      // 半透明 + 不写深度：十段线在透明通道绘制、不竞争深度，水下地形 / 陆地 / 海面已写 / 未写深度决定可见性。
      transparent
      depthWrite={false}
      // AdditiveBlending：暖琥珀片元加到帧缓冲，深色背景下呈明亮暖光发光（SPEC §5.3「更亮的发光虚线」）。
      blending={THREE.AdditiveBlending}
      // renderOrder=3：十段线在海面（0）、省界（2）之后绘制，避免透明顺序错乱、不被半透明海面吞没。
      renderOrder={3}
    />
  )
}

/**
 * 单个岛礁 / 附属岛屿点位的光点渲染（球体 + AdditiveBlending 发光标记）。
 *
 * 球体放在领域层准备的世界坐标（海平面贴合 y），MeshBasicMaterial 不参与光照（恒亮暖色）、AdditiveBlending
 * 呈发光。depthTest 保持开启使光点被前方山体正确遮挡（山后不可见、地表 / 海面之上可见）；depthWrite=false
 * 不影响其他透明层。renderOrder=3 与十段线同层，在海面 / 省界之后绘制。
 *
 * 规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙等）的文本标注由后续统一标签任务呈现，本组件只画可见光点。
 */
function PoliticalIslandPoint({ point }: { readonly point: PreparedPoliticalPoint }): ReactNode {
  const { pointColorHex, pointRadiusMeters } = POLITICAL_FEATURES_CONFIG
  return (
    <mesh position={[point.position[0], point.position[1], point.position[2]]} renderOrder={3}>
      {/*
        球体几何：半径取自配置（派生自主图世界宽度，地图尺度下呈清晰可见的光点）。分段 8×8 足够圆润，
        无需高精（点位是小光点，非可审视几何）。
      */}
      <sphereGeometry args={[pointRadiusMeters, 8, 8]} />
      {/*
        MeshBasicMaterial：不参与光照（恒亮暖色，不受方向光 / 环境光影响），保证暗处仍可见。
        AdditiveBlending：暖琥珀加到帧缓冲呈发光；depthWrite=false 不写深度；transparent 配合 additive。
        depthTest 默认 true：光点被前方山体正确遮挡（山后不可见），在地表 / 海面之上可见。
      */}
      <meshBasicMaterial color={pointColorHex} blending={THREE.AdditiveBlending} transparent depthWrite={false} />
    </mesh>
  )
}

/** PoliticalFeatures 的 props：只接收领域层准备好的十段线 + 岛礁点位，不取数、不计算、不持有交互状态。 */
export interface PoliticalFeaturesProps {
  /** 领域层 preparePoliticalFeatures 的产物（已红线完整性校验 + densify + 海平面贴合）。 */
  readonly features: PreparedPoliticalFeatures
}

/**
 * 渲染全部政治边界补充要素（十段线各段 + 岛礁点位，暖琥珀虚线 + 发光光点，NDC 深度偏移抗 z-fighting，
 * 与海面 / 省界透明共存）。
 *
 * 本组件不承担红线完整性校验 / densify / 海平面贴合 / 投影（领域层职责），不读取政治边界资产 /
 * heightmap / hover 状态——它只是 PreparedPoliticalFeatures 的纯渲染边界。
 */
export function PoliticalFeatures({ features }: PoliticalFeaturesProps): ReactNode {
  return (
    <group>
      {features.lines.map((line) => (
        <PoliticalLineSegment key={`nine-dash-${line.segmentIndex}`} line={line} />
      ))}
      {features.points.map((point, index) => (
        <PoliticalIslandPoint key={`island-${index}-${point.name}`} point={point} />
      ))}
    </group>
  )
}
