/**
 * 省名 / 省会光点 / 岛礁名称标注的主图渲染层（TASK-016）。
 *
 * 角色与依赖方向：
 * - 本组件属于渲染层（src/three），只负责「把领域层已准备好的省名标签 / 省会光点 / 岛礁名称标签的世界坐标
 *   （PreparedPlaceLabels）装配成 drei Billboard + Text（troika，始终面向相机）+ 球体发光光点」。它**只**依赖：
 *   配置层（PLACE_LABELS_CONFIG —— 颜色 / 字号 / 光点半径 / 字体 URL 的唯一源）、领域层（PreparedPlaceLabels
 *   类型）、three / R3F / drei（Billboard / Text）。**禁止**自行读取地点 / 政治资产、复制投影 / 高程逻辑、
 *   或在组件内补写省名 / 岛礁坐标（TASK-016 实现约束「视图层只消费准备好的标签数据」「不得在组件内补写坐标
 *   或中文名称副本」）。
 * - 本组件不接收任何运行时交互状态（hover / 遮挡透明度由后续 TASK 交付）：它只消费领域层产物，纯静态呈现。
 *   地形遮挡透明度处理由 TASK-017 交付、hover 放大置顶由 TASK-018 交付，本组件不复制其状态逻辑
 *   （TASK-016 实现约束「不在此处复制状态逻辑」）。
 *
 * 始终面向相机（SPEC §3.7「Billboard 广告牌始终面向相机，避免被自身山脉遮挡时也能读到」、TASK-016 验证方式 4
 * 「省名和岛礁文字始终面向相机」）：
 * - 每个省名 / 岛礁名称标签用 drei <Billboard> 包裹 troika <Text>。Billboard 每帧把其子树的朝向同步为相机
 *   朝向，使文本恒面向相机——旋转视角时省名 / 岛礁名始终可读（不被自身朝向遮挡）。省会光点为球体（各向同性，
 *   无需 Billboard）。
 *
 * 字体离线加载（SPEC §3.7、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载」、验证方式 3「无在线
 * 字体请求」）：
 * - troika <Text> 的 font prop 取自 PLACE_LABELS_CONFIG.fontPath（本地 /fonts/ 路径，非 https:// CDN），运行时
 *   只从同源取字体。字体覆盖校验在场景层（ChinaMapScreen）渲染本组件之前完成（缺字即不渲染标签 + 错误状态），
 *   本组件只在「覆盖校验通过」后挂载，故 font prop 指向的字体已保证覆盖所有将渲染的字符。
 *
 * 与省界 / 十段线 / 岛礁点位的视觉分工（SPEC §3.6 / §3.7 / §5.3、TASK-016 输出约束）：
 * - 省名标签：浅青白偏亮（PLACE_LABELS_CONFIG.provinceLabelColorHex），Billboard Text，浮于锚点地形之上。
 * - 省会光点：暖琥珀（PLACE_LABELS_CONFIG.capitalPointColorHex），球体 + additive 发光，贴地。
 * - 岛礁名称标签：暖琥珀（PLACE_LABELS_CONFIG.islandLabelColorHex），Billboard Text，浮于岛礁点位之上，
 *   与岛礁点位（TASK-015）同色暗示关联。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-016 实现约束「本 TASK 不宣称取得审图号」）：
 * - 本组件只呈现省名 / 省会光点 / 岛礁名称文本与光点，不添加审图号角标、不通过任何视觉手段宣称已审图。
 */

import type { ReactNode } from 'react'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PLACE_LABELS_CONFIG } from '../config/place-labels'
import type {
  PreparedCapitalPoint,
  PreparedIslandNameLabel,
  PreparedPlaceLabels,
  PreparedProvinceNameLabel,
} from '../lib/place-labels'

/**
 * 单个省名 Billboard 标签（始终面向相机，浮于锚点地形之上）。
 *
 * troika <Text> 包裹在 drei <Billboard> 内，文本恒面向相机。font 取本地子集路径（场景层已校验覆盖）。
 */
function ProvinceNameLabel({ label }: { readonly label: PreparedProvinceNameLabel }): ReactNode {
  return (
    <Billboard position={[label.position[0], label.position[1], label.position[2]]}>
      <Text
        font={PLACE_LABELS_CONFIG.fontPath}
        fontSize={PLACE_LABELS_CONFIG.provinceLabelFontSizeMeters}
        color={PLACE_LABELS_CONFIG.provinceLabelColorHex}
        anchorX="center"
        anchorY="middle"
      >
        {label.text}
      </Text>
    </Billboard>
  )
}

/**
 * 单个省会光点（球体 + additive 发光，贴地，位置真实）。
 *
 * 球体放在领域层准备的贴地世界坐标（y = h·k + epsilon）。MeshBasicMaterial 不参与光照（恒亮暖色）、
 * AdditiveBlending 呈发光。depthTest 保持开启使光点被前方山体正确遮挡；depthWrite=false 不影响其他透明层。
 * 与岛礁点位（TASK-015）同构（颜色、半径、材质同源）。
 */
function CapitalPoint({ point }: { readonly point: PreparedCapitalPoint }): ReactNode {
  return (
    <mesh position={[point.position[0], point.position[1], point.position[2]]} renderOrder={3}>
      <sphereGeometry args={[PLACE_LABELS_CONFIG.capitalPointRadiusMeters, 8, 8]} />
      <meshBasicMaterial
        color={PLACE_LABELS_CONFIG.capitalPointColorHex}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

/**
 * 单个岛礁名称 Billboard 标签（始终面向相机，浮于岛礁点位之上）。
 *
 * 与省名标签同构（Billboard + Text），但字号更小（islandLabelFontSizeMeters）、色取岛礁暖琥珀，浮于岛礁
 * 点位上方（y = max(h·k, seaLevel) + epsilon + islandLabelHeightOffset），与 TASK-015 岛礁点位同色关联。
 */
function IslandNameLabel({ label }: { readonly label: PreparedIslandNameLabel }): ReactNode {
  return (
    <Billboard position={[label.position[0], label.position[1], label.position[2]]}>
      <Text
        font={PLACE_LABELS_CONFIG.fontPath}
        fontSize={PLACE_LABELS_CONFIG.islandLabelFontSizeMeters}
        color={PLACE_LABELS_CONFIG.islandLabelColorHex}
        anchorX="center"
        anchorY="middle"
      >
        {label.name}
      </Text>
    </Billboard>
  )
}

/** PlaceLabels 的 props：只接收领域层准备好的标签 / 光点 + 已校验覆盖的字体，不取数、不计算、不持有交互状态。 */
export interface PlaceLabelsProps {
  /** 领域层 preparePlaceLabels 的产物（省名标签 + 省会光点 + 岛礁名称标签，已贴地 + 浮高）。 */
  readonly labels: PreparedPlaceLabels
}

/**
 * 渲染全部省名 / 省会光点 / 岛礁名称标注（Billboard Text + 发光光点，始终面向相机）。
 *
 * 本组件不承担投影 / 高程 / 浮高计算（领域层职责），不读取地点 / 政治 / heightmap / hover 状态——它只是
 * PreparedPlaceLabels 的纯渲染边界。回退本 TASK 仅移除本组件与领域准备层 + 字体子集，地形 / 海面 / 省界 /
 * 十段线 / 岛礁点位完整保留（TASK-016 回退边界）。
 */
export function PlaceLabels({ labels }: PlaceLabelsProps): ReactNode {
  return (
    <group>
      {labels.provinceLabels.map((label) => (
        <ProvinceNameLabel key={`province-name-${label.adminId}`} label={label} />
      ))}
      {labels.capitalPoints.map((point) => (
        <CapitalPoint key={`capital-point-${point.adminId}`} point={point} />
      ))}
      {labels.islandLabels.map((label) => (
        <IslandNameLabel key={`island-name-${label.name}`} label={label} />
      ))}
    </group>
  )
}
