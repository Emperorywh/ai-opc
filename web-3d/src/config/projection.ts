/**
 * 投影契约 —— 核心对齐契约（SPEC §5 / ROADMAP R2）。
 *
 * 所有子系统（地形顶点、边界、河流、标签锚点）必须经同一投影函数
 * `project(lon, lat) → [x, z]` 投影到工作坐标系，杜绝错位返工。
 *
 * 工作坐标系（SPEC §5.1）：平面宽 2.0（X，经度方向）× 纵 1.0（Z，纬度方向），
 * 对应 equirectangular 的 2:1 经纬比。高度 Y 独立。
 *   x = lon / 180          // lon ∈ [-180,180] → x ∈ [-1,1]
 *   z = -lat / 90 * 0.5    // lat ∈ [-90,90]   → z ∈ [-0.5,0.5]（向北 -z）
 *   y = heightExaggerated  // 真实高度 × HEIGHT_EXAGGERATION
 *
 * MVP（Phase 1）用 Equirectangular；Phase 2 升级 Robinson（SPEC §5.2 / D4）。
 * 切换投影只需改本文件 + 重跑 pipeline，渲染层零改动（R2）。
 *
 * ⚠️ `project()` 的实现与单元测试在 Task 03 完成；本文件仅落地类型与常量骨架。
 */

/** 支持的投影类型（MVP = equirectangular，Phase 2 = robinson）。 */
export type ProjectionName = 'equirectangular' | 'robinson'

/** 当前启用投影（MVP 阶段固定 equirectangular）。 */
export const PROJECTION: ProjectionName = 'equirectangular'

/** 工作平面尺寸（SPEC §5.1）。宽（X，经度方向）× 纵（Z，纬度方向）。 */
export const PLANE_WIDTH = 2.0
export const PLANE_HEIGHT = 1.0

/** 高度夸张倍率（SPEC §6.1 / D5）：真实高度 × 2.5。 */
export const HEIGHT_EXAGGERATION = 2.5
