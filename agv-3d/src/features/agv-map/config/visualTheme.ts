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
