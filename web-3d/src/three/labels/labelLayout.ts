/**
 * 标签层布局/配置 —— 纯常量 + 纯函数（SPEC §6.5，可脱离 three/troika 单测）。
 *
 * Task 14：troika 标签锚点计算 = `project(lon,lat)`（R2 单一投影契约）+ CPU 高度查询表 `y`
 * （R3 同源）+ heightOffset 浮起。视觉样式（字号/色/描边）集中此处，便于 Review 调参。
 *
 * 与 Ocean/Terrain 的 `oceanMaterial.ts` / `terrainMaterial.ts` 同构：非组件模块承载常量与纯函数，
 * 组件模块（`LabelLayer.tsx`）只导出组件（满足 react-refresh/only-export-components）。
 */
import { project, metersToWorldY } from '../../config/projection'
import type { ElevationMeta } from '../../config/projection'
import { sampleWorldY } from '../../data/assets'
import type { ElevationData, Label } from '../../data/types'

/**
 * 标签视觉样式（动漫/图鉴风：暖白描边字，低饱和地形上的高对比标注）。
 * 视觉观感属美学范畴，做到合理默认即停，「好不好看」交人工 Review。
 */
export const LABEL_STYLE = {
  /** 字号（世界单位；平面半宽 1.0，七大洲名 2-4 字宽约 0.14-0.28）。 */
  fontSize: 0.07,
  /** 字色（暖白，取 palette.border 同源水彩暖白，§2.1）。 */
  color: '#F3E9D2',
  /** 水平锚点居中。 */
  anchorX: 'center',
  /** 垂直锚点居中。 */
  anchorY: 'middle',
  /** 描边宽度（世界单位；增强可读性，描边字）。 */
  outlineWidth: 0.006,
  /** 描边色（深色，高对比）。 */
  outlineColor: '#1a1d22',
  /** 描边不透明度。 */
  outlineOpacity: 0.95,
  /**
   * 锚点 Y 偏移（世界单位；标签略浮于地表/海面，避免与地形几何 z-fighting、
   * 以及 troika SDF 字面贴在山体表面被遮挡）。
   */
  heightOffset: 0.012,
} as const

/**
 * 标签字体 URL：Task 12 子集化产出的 `public/fonts/map-zh.woff2`（经 Vite BASE_URL 解析）。
 * 懒求值（运行时在浏览器侧读 `import.meta.env.BASE_URL`，与 `assets.ts:dataUrl` 同模式）。
 */
export function labelFontUrl(): string {
  return `${import.meta.env.BASE_URL}fonts/map-zh.woff2`
}

/**
 * 标签 3D 世界锚点（SPEC §6.5「project(lon,lat) + 地形高度查询 y」）。
 *
 *   x,z = project(lon,lat)                       // R2 投影契约，与地形/边界同源
 *   y   = max(sampleWorldY, seaLevelWorldY)      // 陆地贴地表 / 大洋贴海平面
 *      + heightOffset                            // 浮起避免 z-fighting
 *
 * 大洋锚点取海平面而非海底：大洋处 `sampleWorldY` 为海底高程（负值），若锚点落海底，
 * 标签会被半透明海洋几何覆盖不可见（Task 06 渲染顺序：Ocean 后绘读 Terrain 深度）。
 * `max(地面, 海面)` 让陆地标签贴地、大洋标签贴海面（y=0），地理 + 视觉均正确。
 *
 * `metersToWorldY(meta.seaLevelMeters)` 与 Ocean 的 `seaLevelWorldY` 同源（R3）。
 */
export function labelWorldPosition(
  label: Label,
  elevation: ElevationData,
  meta: ElevationMeta,
  yOffset: number = 0,
): [number, number, number] {
  const [x, z] = project(label.lon, label.lat)
  const groundY = sampleWorldY(elevation, meta, label.lon, label.lat)
  const seaY = metersToWorldY(meta.seaLevelMeters)
  const y = Math.max(groundY, seaY)
  return [x, y + yOffset, z]
}
