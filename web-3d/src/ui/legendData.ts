/**
 * 图例数据（SPEC §6.7「Legend 图例（地物配色说明）」+ §2.1 色彩规范，Task 25）。
 *
 * 纯常量（可在 Node 单测），与 credits.ts 同构——非组件模块承载数据，组件模块 Legend.tsx
 * 只导出组件（满足 react-refresh/only-export-components）。
 *
 * 图例项 = 地图可见地物 → 配色（与渲染层同源）→ 中文标签：
 *   · 地形分层色经 desaturateHex（与 terrainMaterial `TERRAIN_COLORS` 同源，§2.1「S 降 20%」）：
 *     平原=grassland[0]、丘陵=mountain[1]、山脉=mountain[0]、雪线=snow；
 *   · 海洋取 palette.oceanShallow→oceanDeep（oceanMaterial 直接使用，未 desaturate；横向渐变示深浅）；
 *   · 国家边界=palette.border（BorderLines 暖白描边）、争议=palette.disputed（DisputedLines 暖灰虚线）。
 *
 * 仅列「实际渲染可见」的地物——palette 中 desert（terrain 仅取 desert[0] 作海岸沙滩，未独立成
 * 「沙漠」层）/ plateau（shader 未用）不入图例，避免「图例有、地图无」的误导。
 */
import { palette, desaturateHex } from '../config/palette'

/** 图例形状：solid=填充色块，line=描边线，dashed=虚线。 */
export type LegendShape = 'solid' | 'line' | 'dashed'

/** 单个图例项。 */
export interface LegendItem {
  /** 地物中文标签（如「海洋」「山脉」）。 */
  label: string
  /**
   * 配色（与渲染层同源）：单色 string 或渐变 [浅, 深]（海洋深浅）。
   * 地形层已 desaturate（与 terrainMaterial 同源），海洋/边界取 palette 原值（渲染层直接使用）。
   * 注：用可变元组（非 readonly）以便 `Array.isArray` 正确收窄类型（Legend 渲染色样用）。
   */
  color: string | [string, string]
  /** 形状。 */
  shape: LegendShape
}

/** 地形层 desaturate（与 terrainMaterial §2.1「S 降 20%」同源）。 */
const D = (hex: string): string => desaturateHex(hex)

/**
 * 图例完整项（覆盖地图全部可见地物配色；顺序：海洋 → 地形低→高 → 边界 → 争议）。
 * 「完整」= 地图上每一类可见配色特征均有对应图例项（SPEC §6.7 / ROADMAP Task 25 验收）。
 */
export const LEGEND_ITEMS: readonly LegendItem[] = [
  { label: '海洋', color: [palette.oceanShallow, palette.oceanDeep], shape: 'solid' },
  { label: '平原', color: D(palette.grassland[0]), shape: 'solid' },
  { label: '丘陵', color: D(palette.mountain[1]), shape: 'solid' },
  { label: '山脉', color: D(palette.mountain[0]), shape: 'solid' },
  { label: '雪线', color: D(palette.snow), shape: 'solid' },
  { label: '国家边界', color: palette.border, shape: 'line' },
  { label: '争议地区', color: palette.disputed, shape: 'dashed' },
]
