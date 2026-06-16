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
 * `project()` 与高度解码契约由 Task 03 实现（见下）；本文件为全局对齐单一契约。
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

// ===========================================================================
// 投影函数（SPEC §5.1）—— Task 03 实现
// ===========================================================================

/**
 * 经纬度 → 工作平面坐标（SPEC §5.1）。
 *
 *   lon ∈ [-180,180] → x ∈ [-1, 1]（经度方向，PLANE_WIDTH 的一半）
 *   lat ∈ [-90, 90]  → z ∈ [-0.5, 0.5]（纬度方向；向北为 -z）
 *
 * 所有子系统（地形顶点 / 边界 / 河流 / 标签锚点）必须经此函数投影，确保对齐（R2）。
 */
export function project(lon: number, lat: number): readonly [number, number] {
  const x = (lon / 180) * (PLANE_WIDTH / 2)
  const z = (-lat / 90) * (PLANE_HEIGHT / 2)
  return [x, z]
}

/** 工作平面坐标 → 经纬度（`project` 反函数；供拾取等用）。 */
export function unproject(x: number, z: number): readonly [number, number] {
  const lon = (x / (PLANE_WIDTH / 2)) * 180
  const lat = (z / (PLANE_HEIGHT / 2)) * -90
  return [lon, lat]
}

// ===========================================================================
// 高度解码契约（SPEC §5.1 / §6.1，R3：CPU/GPU 同源）
// ===========================================================================

/**
 * 高程元数据子集（来自 `public/data/meta.json`，Task 02 烘焙产出）。
 * 同时作为 CPU 查询与 GPU shader 解码的输入，保证两路同源。
 * `MetaJson` 结构兼容本类型（鸭子类型，无需显式依赖）。
 */
export type ElevationMeta = {
  /** 数据源声明的最低高程（米）。 */
  elevationMin: number
  /** 数据源声明的最高高程（米）。 */
  elevationMax: number
  /** 海平面高程（米，默认 0）。 */
  seaLevelMeters: number
  /** heightmap 像素宽。 */
  width: number
  /** heightmap 像素高。 */
  height: number
}

/**
 * 世界 Y 单位/米（艺术基准值，MVP 固定）。
 *
 * 真实地球尺度下「米 → 世界单位」极小（不可见），故取一个让地形可见的基准；
 * `HEIGHT_EXAGGERATION`（=2.5）作为 Task 04 的视觉微调旋钮。
 *
 * 校核（合成 DEM elevationMax=6500 / elevationMin=-5000）：
 *   峰值 6500m → +0.1625；海沟 -5000m → -0.125；地形起伏 ≈ ±0.16（平面半宽 1.0）。
 *
 * ⚠️ CPU 与 GPU 经 `computeHeightUniforms` 派生同一组数，故改此常量可在一处对齐。
 */
export const WORLD_Y_PER_METER = 1e-5

/**
 * 归一化高程 h∈[0,1] → 高程（米）。与 Task 02 烘焙公式互逆：
 *   raw16 = round((elev − min)/(max − min) · 65535)  ⇒  elev = min + h · (max − min)
 */
export function heightToMeters(h: number, meta: ElevationMeta): number {
  return meta.elevationMin + h * (meta.elevationMax - meta.elevationMin)
}

/** 高程（米）→ 世界 Y（含 `HEIGHT_EXAGGERATION` 夸张）。CPU/GPU 共用。 */
export function metersToWorldY(meters: number): number {
  return meters * HEIGHT_EXAGGERATION * WORLD_Y_PER_METER
}

/** 归一化高程 h∈[0,1] → 世界 Y（组合，便于 CPU 查询）。 */
export function heightToWorldY(h: number, meta: ElevationMeta): number {
  return metersToWorldY(heightToMeters(h, meta))
}

/**
 * 派生 shader 位移 uniform（scale / offset）—— CPU 与 GLSL 用同一组数。
 *
 * GLSL：`worldY = h * uHeightScale + uHeightOffset`（h 为 heightmap 采样的归一化值）；
 * CPU 查询 `heightToWorldY(h, meta)` 与之等价 → 误差为浮点舍入级（≪ 1e-4，满足 M1 验收）。
 */
export function computeHeightUniforms(meta: ElevationMeta): {
  scale: number
  offset: number
} {
  const k = HEIGHT_EXAGGERATION * WORLD_Y_PER_METER
  return {
    scale: (meta.elevationMax - meta.elevationMin) * k,
    offset: meta.elevationMin * k,
  }
}
