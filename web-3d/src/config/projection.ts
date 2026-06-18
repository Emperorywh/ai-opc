/**
 * 投影契约 —— 核心对齐契约（SPEC §5 / ROADMAP R2）。
 *
 * 所有子系统（地形顶点、边界、河流、标签锚点）必须经同一投影函数
 * `project(lon, lat) → [x, z]` 投影到工作坐标系，杜绝错位返工。
 *
 * 工作坐标系（SPEC §5.1）：平面宽 2.0（X，经度方向）× 纵 1.0（Z，纬度方向）。高度 Y 独立。
 *
 * 投影分阶段（SPEC §5.2 / D4）：
 *   - MVP（Phase 1）：Equirectangular —— DEM 1:1 直接作 heightmap，快速跑通。
 *   - Phase 2（M9，当前）：Robinson —— 离线一次性重投影 DEM + 矢量，消除极区拉伸，
 *     获得「国家地理图鉴」美感。
 *
 * **Robinson 归一化**：proj4 的 robin 投影输出米制坐标（±MAX_X / ±MAX_Y），
 * 归一化到与 equirect 完全相同的输出范围 `x ∈ [-1,1] / z ∈ [-0.5,0.5]`。
 * 这样 PLANE 几何 / shader 的 worldXY→UV 映射 / 所有依赖 project 输出范围的代码**零改动**
 * （兑现 M9「渲染层 diff 为空」验收）。Robinson 矩形真实比例 1.9717:1 拉伸到 PLANE 2:1，
 * 横向 ~1.4% 拉伸，美学可忽略。
 *
 * **proj4 同源**：前端 `project()` 与 pipeline 重烘焙（scripts/data-pipeline/lib/robinson.mjs）
 * 用同一 proj4 robin 定义 + 同一组归一化常数 → 像素网格严格对齐。proj4 在 M9 引入
 * （SPEC §3 line115 计划；Task 19 备注「proj4 重投影推迟 M9」）。
 *
 * `project()` 与高度解码契约由 Task 03 实现；Robinson 切换由 Task 26 实现。
 */
import proj4 from 'proj4'

/** 支持的投影类型（MVP = equirectangular，Phase 2 = robinson）。 */
export type ProjectionName = 'equirectangular' | 'robinson'

/** 当前启用投影（Phase 2 起固定 robinson）。 */
export const PROJECTION: ProjectionName = 'robinson'

/** 工作平面尺寸（SPEC §5.1）。宽（X，经度方向）× 纵（Z，纬度方向）。 */
export const PLANE_WIDTH = 2.0
export const PLANE_HEIGHT = 1.0

/** 高度夸张倍率（SPEC §6.1 / D5）：真实高度 × 2.5。 */
export const HEIGHT_EXAGGERATION = 2.5

// ===========================================================================
// Robinson 投影定义（proj4，WGS84 椭球，lon_0=0）—— 与 pipeline 同源
// ===========================================================================

/** proj4 Robinson 定义串（lon_0=0，单位米）。前端与 pipeline 共用此串保证同源。 */
export const ROBINSON_DEF = '+proj=robin +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'

/** 预编译 proj4 Proj 对象（避免每次调用重复解析定义串）。 */
const WGS84_PROJ = new proj4.Proj('EPSG:4326')
const ROBINSON_PROJ = new proj4.Proj(ROBINSON_DEF)

/**
 * Robinson 投影 X / Y 最大值（米）—— 归一化常数。
 *
 *   ROBINSON_MAX_X = robinson(180, 0).x   // 经度 ±180 → x ∈ ±MAX_X（赤道最宽）
 *   ROBINSON_MAX_Y = robinson(0, 90).y    // 纬度 ±90 → y ∈ ±MAX_Y（极点最高/低）
 *
 * proj4 在 WGS84 椭球下为确定常数（≈ 17005833 / 8625155），前端与 pipeline 各自从
 * proj4 计算同一表达式 → 值严格一致（不硬编码，规避 proj4 版本/椭球差异风险）。
 */
export const ROBINSON_MAX_X = proj4(WGS84_PROJ, ROBINSON_PROJ, [180, 0])[0]
export const ROBINSON_MAX_Y = proj4(WGS84_PROJ, ROBINSON_PROJ, [0, 90])[1]

// ===========================================================================
// 投影函数（SPEC §5.1）
// ===========================================================================

/**
 * 经纬度 → 工作平面坐标（SPEC §5.1，Robinson 投影，Task 26）。
 *
 *   lon ∈ [-180,180] → x ∈ [-1, 1]（经度方向；归一化 robinson.x / MAX_X × PLANE_WIDTH/2）
 *   lat ∈ [-90, 90]  → z ∈ [-0.5, 0.5]（纬度方向；向北为 -z；归一化 -robinson.y / MAX_Y × PLANE_HEIGHT/2）
 *
 * 输出范围与 equirect 完全相同 → 渲染层零改动。Robinson 非线性：高纬经线收敛
 * （lat=89 时 lon=180 → x≈0.54，equirect 恒 1.0），消除极区横向拉伸。
 *
 * 所有子系统（地形顶点 / 边界 / 河流 / 标签锚点）必须经此函数投影，确保对齐（R2）。
 */
export function project(lon: number, lat: number): readonly [number, number] {
  const [rx, ry] = proj4(WGS84_PROJ, ROBINSON_PROJ, [lon, lat])
  const x = (rx / ROBINSON_MAX_X) * (PLANE_WIDTH / 2)
  const z = (-ry / ROBINSON_MAX_Y) * (PLANE_HEIGHT / 2)
  return [x, z]
}

/**
 * 工作平面坐标 → 经纬度（`project` 反函数；供拾取 / DEM 重烘焙反采样等用）。
 *
 * Robinson 反投影由 proj4 数值求解（精确，round-trip 误差 ≪ 1e-6）。投影矩形内部
 * 全覆盖无空洞（Robinson 伪圆柱全球填满矩形）。
 */
export function unproject(x: number, z: number): readonly [number, number] {
  const rx = (x / (PLANE_WIDTH / 2)) * ROBINSON_MAX_X
  const ry = (-z / (PLANE_HEIGHT / 2)) * ROBINSON_MAX_Y
  const [lon, lat] = proj4(ROBINSON_PROJ, WGS84_PROJ, [rx, ry])
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
