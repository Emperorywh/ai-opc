/**
 * 政治边界补充要素（十段线 + 岛礁点位）的主图渲染层（TASK-015）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的十段线 densify 海平面贴合子段
 *   （PreparedPoliticalLine[]）+ 岛礁点位世界坐标（PreparedPoliticalPoint[]）装配成 drei Line（每段一条
 *   暖琥珀虚线）+ 球体光点（每个岛礁一个发光标记）」。它**只**依赖：配置层（POLITICAL_FEATURES_CONFIG ——
 *   颜色 / 线宽 / 虚线节拍 / 点位半径 / NDC 深度偏移的唯一源）、领域层（PreparedPoliticalFeatures 类型）、
 *   three / R3F / drei、本层 line-depth-bias（applyLineDepthBias —— 与省界共用同一注入函数）。
 *   **禁止**自行读取政治边界资产、复制 densify / 海平面贴合 / 投影逻辑、或在组件内补写十段线 / 岛礁坐标
 *   （TASK-015 实现约束「唯一事实源来自 TASK-006」「不得在组件内补写坐标」）。
 * - 本组件不接收任何运行时交互状态（hover / click 由后续 TASK 交付）：它只消费领域层产物，纯静态呈现。
 *   十段线按段（segmentIndex）各一个 Line（不合并为单条连续折线），使每段可独立审计、台湾东侧段
 *   （segmentIndex=10）可独立定位，满足 TASK-015 实现约束「不把十段线合并为不可核查的单条连续折线」。
 *
 * 与省界视觉可区分（SPEC §5.3「样式与省界区分（如更亮的发光虚线）」、TASK-015 输出约束「以比省界更明确的
 * 发光虚线或等价样式区分」）：
 * - 颜色：十段线取暖琥珀 #ffd180（POLITICAL_FEATURES_CONFIG.lineColorHex），与省界浅青白 #9fe8d8 冷暖相对、
 *   色相分明——这是最主干的区分手段，即便虚线因平台差异失效，颜色仍使二者明确可辨。
 * - 线宽：2.0 px（略粗于省界 1.6 px），更突出。
 * - 虚线：drei Line dashed 模式（dashSize / gapSize 来自配置），沿弧长呈实线 + 空白节拍，与省界实线区分。
 * - AdditiveBlending：暖琥珀片元加到帧缓冲，深色科技风背景下呈明亮暖光发光。
 *
 * 海平面贴合高度（由领域层准备，本层只消费）：十段线 / 点位 y = max(h·k, seaLevelYMeters) + epsilon，
 * 陆地贴合地形、海域钳制到海平面之上 epsilon。本层据此放置 Line 顶点与球体光点——线 / 点恒位于半透明
 * 海面（y=0，depthWrite=false）之上、不被吞没（TASK-015 输出约束「不被海面完全吞没」）。
 *
 * 抗 z-fighting（与省界共用同一结构性手段）：LineMaterial 顶点着色器注入 NDC 深度偏移（applyLineDepthBias，
 *   POLITICAL_FEATURES_CONFIG.depthBiasNdc），使十段线片元在深度测试中恒胜过同位置的贴合面（地表 / 海面），
 *   仍被前方山体正确遮挡。与省界同值、同函数、同一类问题在同一地图尺度下的同一解。
 *
 * 与海面 / 省界透明共存（SPEC §3.5 / §3.6、TASK-015 输出约束「省界与海面无回归」）：
 * - 十段线：transparent + depthWrite=false + renderOrder=3（海面 0、省界 2、十段线 3），使十段线在海面与
 *   省界之后绘制，暖琥珀片元加到帧缓冲，不被半透明海面吞没、不与省界透明排序错乱。
 * - 岛礁光点：球体 + MeshBasicMaterial（不参与光照，恒亮暖色）+ AdditiveBlending + depthWrite=false +
 *   renderOrder=3，depthTest 保持开启使其被前方山体正确遮挡（光点在山后不可见、在海面 / 地表之上可见）。
 *
 * 非官方审图限制（TASK-015 实现约束「本 TASK 不宣称取得审图号；只能在内部展示状态下验收」）：
 * - 本组件只呈现十段线与岛礁点位的可见标记，不添加审图号角标、不通过任何视觉手段宣称已审图。
 *   规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙等）的文本标注由 TASK-016 的统一标签系统呈现。
 */

import { useLayoutEffect, useMemo, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { POLITICAL_FEATURES_CONFIG } from '../config/political-features'
import { ENTRANCE_DURATIONS } from '../config/entrance'
import { computeSceneLayerOpacity, type EntranceFrame } from '../lib/entrance-state'
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
function PoliticalLineSegment({
  line,
  materialSlot,
  materialsRef,
}: {
  readonly line: PreparedPoliticalLine
  /** 本段线材质在父级 materialsRef 数组中的下标（入场淡入时由父级统一寻址写 opacity）。 */
  readonly materialSlot: number
  /** 父级维护的材质数组 ref：本组件挂载时登记、卸载时清空对应槽位。 */
  readonly materialsRef: RefObject<(THREE.Material | null)[]>
}): null | ReactNode {
  // drei Line 实例引用，用于挂载后在其 material 上注入 NDC 深度偏移 + 登记到父级材质数组。
  const lineRef = useRef<React.ComponentRef<typeof Line>>(null)
  // 端点三元组化（挂载期一次，segments 模式按三元组两两成对解释为线段）。
  const points = useMemo(
    () => flatEndpointsToTriplets(line.segmentEndpointsFlat),
    [line.segmentEndpointsFlat],
  )
  // 挂载后注入深度偏移（与省界 applyLineDepthBias 同函数、同注入点；dashed 模式的片元丢弃在 fragment
  // shader，与 vertex shader 的深度偏移正交，故二者共存）。同时登记材质到父级 materialsRef，供
  // PoliticalFeatures 单一 useFrame 统一写入场淡入 opacity（TASK-020「不由组件私自计时」）。
  useLayoutEffect(() => {
    const lineObj = lineRef.current as { material: THREE.Material } | null
    if (lineObj === null) return
    const material = lineObj.material as THREE.ShaderMaterial
    applyLineDepthBias(material, POLITICAL_FEATURES_CONFIG.depthBiasNdc)
    // 捕获稳定的材质数组引用 + 槽位下标，使 cleanup 写「同一数组的同一槽位」（materialsRef.current 由父级
    // useRef 一次创建、永不重新赋值，捕获安全；避免在 cleanup 直接读 ref.current 触发 exhaustive-deps 告警）。
    const slot = materialSlot
    const materials = materialsRef.current
    materials[slot] = material
    return () => {
      materials[slot] = null
    }
  }, [materialSlot, materialsRef])

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
      // 差异失效，颜色仍使十段线与省界明确可辨（TASK-015 输出约束「等价样式」兜底）。
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
 * 规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙等）的文本标注由 TASK-016 的统一标签系统呈现，本组件只画可见光点。
 */
function PoliticalIslandPoint({
  point,
  materialSlot,
  materialsRef,
}: {
  readonly point: PreparedPoliticalPoint
  /** 本光点材质在父级 materialsRef 数组中的下标（入场淡入时由父级统一寻址写 opacity）。 */
  readonly materialSlot: number
  /** 父级维护的材质数组 ref：本组件挂载时登记、卸载时清空对应槽位。 */
  readonly materialsRef: RefObject<(THREE.Material | null)[]>
}): ReactNode {
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
        ref 回调把材质登记到父级 materialsRef[materialSlot]，供 PoliticalFeatures 单一 useFrame 统一写
        入场淡入 opacity（卸载时以 null 清空槽位，避免对已释放材质写 opacity）。
      */}
      <meshBasicMaterial
        ref={(material: THREE.MeshBasicMaterial | null) => {
          materialsRef.current[materialSlot] = material
        }}
        color={pointColorHex}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/** PoliticalFeatures 的 props：只接收领域层准备好的十段线 + 岛礁点位 + 共享入场帧，不取数、不计算、不持有交互状态。 */
export interface PoliticalFeaturesProps {
  /** 领域层 preparePoliticalFeatures 的产物（已红线完整性校验 + densify + 海平面贴合）。 */
  readonly features: PreparedPoliticalFeatures
  /**
   * 共享入场帧（TASK-020 单一时间源）。注入时每帧由本组件单一 useFrame 把 computeSceneLayerOpacity(elapsed)
   * 写入全部十段线 / 岛礁光点材质的 opacity，使政治要素在省名标签淡入后随水面 / 边界阶段平滑淡入
   * （SPEC §4.3「水面、边界线随后淡入」）。未注入（回退 TASK-020）时不写 opacity（材质 opacity 默认 1，
   * 政治要素加载完成即直接可见）。
   */
  readonly entranceFrame?: RefObject<EntranceFrame> | null
}

/**
 * 渲染全部政治边界补充要素（十段线各段 + 岛礁点位，暖琥珀虚线 + 发光光点，NDC 深度偏移抗 z-fighting，
 * 与海面 / 省界透明共存；据共享入场帧统一淡入）。
 *
 * 本组件不承担红线完整性校验 / densify / 海平面贴合 / 投影（领域层职责），不读取政治边界资产 / heightmap /
 * hover 状态——它只是 PreparedPoliticalFeatures + 共享入场帧的纯渲染边界。回退本 TASK（TASK-015）仅移除
 * 本组件与领域准备层，地形 / 海面 / 省界 / 静态行政区资产完整保留。回退 TASK-020 仅移除 entranceFrame 透传
 * 与淡入 useFrame：政治要素加载完成即直接可见。
 */
export function PoliticalFeatures({ features, entranceFrame = null }: PoliticalFeaturesProps): ReactNode {
  // 全部政治要素材质（十段线 + 岛礁光点）的登记数组。线段材质由 PoliticalLineSegment 的 useLayoutEffect
  // 登记、光点材质由 PoliticalIslandPoint 的 ref 回调登记，均在卸载时清空对应槽位。
  // 单一 useFrame 据共享入场帧统一写 opacity，避免十段线 / 岛礁各开 useFrame（TASK-020「不由组件私自计时」）。
  const materialsRef = useRef<(THREE.Material | null)[]>([])

  // 入场淡入（TASK-020）：注入共享入场帧时，每帧把全部政治要素材质 opacity 设为 computeSceneLayerOpacity。
  // 与 SeaSurface / ProvinceBorders 共用同一 computeSceneLayerOpacity（同一 elapsed、同一函数），故水面 /
  // 省界 / 十段线 / 岛礁光点同阶段同步淡入。entranceFrame 未注入时本回调直接 return（opacity 默认 1，回退）。
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
      {features.lines.map((line, index) => (
        <PoliticalLineSegment
          key={`nine-dash-${line.segmentIndex}`}
          line={line}
          materialSlot={index}
          materialsRef={materialsRef}
        />
      ))}
      {features.points.map((point, index) => (
        <PoliticalIslandPoint
          key={`island-${index}-${point.name}`}
          point={point}
          materialSlot={features.lines.length + index}
          materialsRef={materialsRef}
        />
      ))}
    </group>
  )
}
