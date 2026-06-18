/**
 * Robinson 投影（proj4）—— pipeline 重烘焙专用，与 `src/config/projection.ts` 同源。
 *
 * **同源契约（M9 风险验证 #2「全矢量对齐」的基石）**：
 *   - ROBINSON_DEF 定义串、ROBINSON_MAX_X/Y 常数表达式、project/unproject 归一化公式
 *     与前端 `src/config/projection.ts` 逐字一致 → pipeline 烘焙的 Robinson 像素网格与
 *     前端 `project()` 输出的 worldXY 严格对齐（heightmap 像素中心 = PlaneGeometry 顶点）。
 *   - 两端各自从 proj4 计算常数（不硬编码），规避 proj4 版本/椭球差异。
 *
 * 用途：DEM 重烘焙时，每个 Robinson 像素 (px,py) → worldXY → `unprojectRobinson` → (lon,lat)
 *   → 采样原 equirect heightmap → 写入 Robinson 网格。Robinson 像素均匀对应 worldXY，
 *   故 shader 的 `worldXY→UV` 映射（Task 04）零改动即可采样 Robinson heightmap。
 */
import proj4 from 'proj4'

/** 工作平面尺寸（与 src/config/projection.ts 同）。 */
export const PLANE_WIDTH = 2.0
export const PLANE_HEIGHT = 1.0

/** proj4 Robinson 定义串（lon_0=0，WGS84，米）—— 与前端同串。 */
export const ROBINSON_DEF = '+proj=robin +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'

/** 预编译 proj4 Proj 对象（避免每次调用重复解析定义串）。 */
const WGS84 = new proj4.Proj('EPSG:4326')
const ROBIN = new proj4.Proj(ROBINSON_DEF)

/**
 * Robinson 归一化常数（米）—— 与前端同表达式。
 *   MAX_X = robinson(180,0).x（赤道经度 ±180 → x ∈ ±MAX_X）
 *   MAX_Y = robinson(0,90).y（纬度 ±90 → y ∈ ±MAX_Y）
 */
export const ROBINSON_MAX_X = proj4(WGS84, ROBIN, [180, 0])[0]
export const ROBINSON_MAX_Y = proj4(WGS84, ROBIN, [0, 90])[1]

/**
 * 经纬度 → 工作平面坐标（Robinson 正投影 + 归一化，与前端 `project` 同源）。
 * @returns {[number, number]} [x∈[-1,1], z∈[-0.5,0.5]]
 */
export function projectRobinson(lon, lat) {
  const [rx, ry] = proj4(WGS84, ROBIN, [lon, lat])
  return [(rx / ROBINSON_MAX_X) * (PLANE_WIDTH / 2), (-ry / ROBINSON_MAX_Y) * (PLANE_HEIGHT / 2)]
}

/**
 * 工作平面坐标 → 经纬度（Robinson 反投影，与前端 `unproject` 同源）。
 * proj4 数值反投影，round-trip 误差 ≪ 1e-6。
 * @param {number} x ∈[-1,1]
 * @param {number} z ∈[-0.5,0.5]
 * @returns {[number, number]} [lon, lat]
 */
export function unprojectRobinson(x, z) {
  const rx = (x / (PLANE_WIDTH / 2)) * ROBINSON_MAX_X
  const ry = (-z / (PLANE_HEIGHT / 2)) * ROBINSON_MAX_Y
  return proj4(ROBIN, WGS84, [rx, ry])
}
