import type { RawNodeType } from '../domain/rawDto'

/**
 * 视觉主题集中配置（SPEC §8.2、§12）。
 *
 * 颜色、Emissive 与材质参数必须集中定义，禁止组件内散落色值（SPEC §8.2 末条）。
 * 本文件只承载纯数据（HSL 元组与标量），不依赖 Three.js、React 或任何浏览器对象，
 * 因此可在 Node 环境下直接验证色值与 SPEC §8.2 调色板一致；展示层负责把 HSL 元组
 * 转换为 THREE.Color（见 NodeLayer）。
 *
 * Emissive 目标（SPEC §8.2）：node 低于 Bloom 阈值、work 接近阈值、charge/park 高于阈值。
 * 当前 emissiveIntensity 为无后处理下的可见度初值，按该目标排序（node < work < park ≈ charge）；
 * TASK-013 将按 Bloom 亮度阈值（1.0）与色调映射最终精调，届时只需修改本表数值。
 */

/** HSL 颜色：H 为 0～360 度，S/L 为 0～1。 */
export interface HslColor {
  readonly h: number
  readonly s: number
  readonly l: number
}

/** 节点颜色主题：基础色与自发光强度。 */
export interface NodeColorTheme {
  /** 基础色（SPEC §8.2 基础色列）。 */
  readonly baseColor: HslColor
  /**
   * 自发光强度初值（SPEC §8.2 Emissive 目标）。
   * 表示该类节点相对 Bloom 阈值的发光倾向，非最终像素亮度。
   */
  readonly emissiveIntensity: number
}

/** 节点标准材质参数（SPEC §8.3：节点固定使用 MeshStandardMaterial）。 */
export interface NodeMaterialTheme {
  readonly metalness: number
  readonly roughness: number
}

/** 单类节点的完整视觉主题。 */
export interface NodeVisualTheme {
  readonly color: NodeColorTheme
  readonly material: NodeMaterialTheme
}

/** 按节点类型索引的视觉主题表。 */
export type NodeVisualThemeTable = Record<RawNodeType, NodeVisualTheme>

/**
 * 节点视觉主题初值（SPEC §8.2）。
 *
 * 基础色逐字对齐 SPEC §8.2 调色板；emissiveIntensity 按"低于/接近/高于 Bloom 阈值"的
 * 目标排序给出可见度初值，使无后处理时四类节点仍具备可辨识的亮度层次。
 */
export const NODE_VISUAL_THEME: NodeVisualThemeTable = {
  node: {
    color: { baseColor: { h: 210, s: 0.9, l: 0.6 }, emissiveIntensity: 0.0 },
    material: { metalness: 0.1, roughness: 0.6 },
  },
  work: {
    color: { baseColor: { h: 180, s: 0.9, l: 0.55 }, emissiveIntensity: 0.25 },
    material: { metalness: 0.2, roughness: 0.45 },
  },
  charge: {
    color: { baseColor: { h: 48, s: 1.0, l: 0.6 }, emissiveIntensity: 0.6 },
    material: { metalness: 0.25, roughness: 0.4 },
  },
  park: {
    color: { baseColor: { h: 140, s: 0.8, l: 0.55 }, emissiveIntensity: 0.45 },
    material: { metalness: 0.2, roughness: 0.45 },
  },
}

/** SPEC §8.2 节点基础色调色板，供测试与展示层共享断言基准。 */
export const NODE_BASE_COLORS: Readonly<Record<RawNodeType, HslColor>> = {
  node: { h: 210, s: 0.9, l: 0.6 },
  work: { h: 180, s: 0.9, l: 0.55 },
  charge: { h: 48, s: 1.0, l: 0.6 },
  park: { h: 140, s: 0.8, l: 0.55 },
}

/**
 * 路径扁带色彩主题（SPEC §8.2 路径扁带 / 流动高亮）。
 *
 * 不变量：
 * - 基础色低于 Bloom 阈值（§8.2、§8.5）：扁带作为底层拓扑呈现，不进入 Bloom。
 * - 流动高亮明确高于 Bloom 阈值：在着色器中按高亮强度叠加，使峰值线性亮度 > 1.0，
 *   TASK-013 接入 Bloom 后形成稳定发光脉冲；当前无后处理时仍以亮青色脉冲可见。
 * - 色值集中定义，展示层禁止散落色值（§8.2 末条）。
 */
export interface PathColorTheme {
  /** 扁带基础色（SPEC §8.2：hsl(200, 85%, 55%)）。 */
  readonly baseColor: HslColor
  /** 流动高亮色（SPEC §8.2：hsl(185, 100%, 75%)）。 */
  readonly flowHighlightColor: HslColor
  /**
   * 流动高亮叠加强度。在线性空间与脉冲峰值相乘，使峰值亮度明确高于 Bloom 阈值 1.0
   * （§8.2、§8.5）；无后处理时仍保证脉冲在扁带基础色之上清晰可辨。
   */
  readonly flowHighlightIntensity: number
}

/**
 * 流光动画参数（SPEC §7.6 初始流光参数）。
 *
 * 不变量：
 * - 单位显式标注（_M / _MPS / _SECONDS），不通过散落数字隐式表达业务规则（§12）。
 * - 三参数满足 repeat = speed × period 的运动学关系（2.0 = 0.4 × 5.0），
 *   即一个周期内脉冲恰好推进一个重复距离，动画首尾相接无跳变。
 * - 为展示层纯动画配置，非几何编译参数（§12：颜色/材质/Bloom 归 visualTheme）。
 */
export interface PathFlowConfig {
  /** 流光沿弧长的重复距离，单位米（SPEC §7.6：2.0 m）。 */
  readonly flowRepeatM: number
  /** 流光推进速度，单位米/秒（SPEC §7.6：0.4 m/s）。 */
  readonly flowSpeedMps: number
  /** 流光相位有界周期，单位秒（SPEC §7.6：5 s）。 */
  readonly flowPeriodSeconds: number
}

/**
 * 路径视觉主题初值（SPEC §8.2、§7.6）。
 *
 * 基础色与高亮色逐字对齐 SPEC §8.2；流光参数对齐 §7.6；高亮强度初值使脉冲峰值
 * 明确超过 Bloom 阈值，TASK-013 按 Bloom 亮度阈值最终精调时只改本表数值。
 */
export const PATH_VISUAL_THEME: Readonly<{
  readonly color: PathColorTheme
  readonly flow: PathFlowConfig
}> = {
  color: {
    baseColor: { h: 200, s: 0.85, l: 0.55 },
    flowHighlightColor: { h: 185, s: 1.0, l: 0.75 },
    flowHighlightIntensity: 1.5,
  },
  flow: {
    flowRepeatM: 2.0,
    flowSpeedMps: 0.4,
    flowPeriodSeconds: 5.0,
  },
}

/** SPEC §8.2 路径扁带基础色，供测试与展示层共享断言基准。 */
export const PATH_BASE_COLOR: HslColor = { h: 200, s: 0.85, l: 0.55 }

/** SPEC §8.2 流动高亮色，供测试与展示层共享断言基准。 */
export const PATH_FLOW_HIGHLIGHT_COLOR: HslColor = { h: 185, s: 1.0, l: 0.75 }
