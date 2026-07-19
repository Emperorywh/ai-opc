/**
 * Web 墨卡托（EPSG:3857 / 球面墨卡托）前向与逆向投影原语（纯 TypeScript）。
 *
 * 依赖方向：属于离线资产生产层（scripts/dem），不依赖浏览器、React、Three.js 或运行时状态。
 * 仅供本目录的 build-heightmap 流水线消费，把 EPSG:4326 经纬度 DEM 重投影到 EPSG:3857
 * 平面米坐标。SPEC §3.3 固定主图投影为 Web 墨卡托；这里实现其闭式公式，避免在可测试核心
 * 里引入 rasterio/pyproj 这类重依赖，让 pnpm test 能在纯 Node 环境确定性复现重投影。
 *
 * 采用 WGS84 球体半长轴 R = 6378137 米（EPSG:3857 的定义常数），与 d3-geo geoMercator、
 * rasterio EPSG:3857 一致；中国主图纬度上限 54°N 远低于墨卡托有效纬度上限 ≈85.0511°，
 * 不会触及奇异点。
 */

/** EPSG:3857 球面墨卡托定义半长轴（米）。 */
export const WEB_MERCATOR_RADIUS = 6378137

/** Web 墨卡托有效纬度上限（度），超过该纬度 y 趋向无穷。 */
export const WEB_MERCATOR_MAX_LATITUDE_DEGREES = 85.05112878

/**
 * 前向投影：EPSG:4326 经纬度（度）→ EPSG:3857 平面米坐标 (x, y)。
 * x = R · lon（弧度），线性；y = R · ln(tan(π/4 + lat/2))。纬度被钳制到有效区间以防越界。
 */
export function projectLonLatToWebMercator(
  lonDegrees: number,
  latDegrees: number,
): { readonly x: number; readonly y: number } {
  const lonRad = (lonDegrees * Math.PI) / 180
  const clampedLat = Math.min(
    WEB_MERCATOR_MAX_LATITUDE_DEGREES,
    Math.max(-WEB_MERCATOR_MAX_LATITUDE_DEGREES, latDegrees),
  )
  const latRad = (clampedLat * Math.PI) / 180
  const x = WEB_MERCATOR_RADIUS * lonRad
  const y = WEB_MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + latRad / 2))
  return { x, y }
}

/**
 * 逆向投影：EPSG:3857 平面米坐标 (x, y) → EPSG:4326 经纬度（度）。
 * 用于重采样时把目标栅格像元中心（EPSG:3857）反算回源 DEM 的经纬度空间做双线性采样。
 */
export function inverseWebMercatorToLonLat(
  xMeters: number,
  yMeters: number,
): { readonly lon: number; readonly lat: number } {
  const lon = ((xMeters / WEB_MERCATOR_RADIUS) * 180) / Math.PI
  const lat =
    ((2 * Math.atan(Math.exp(yMeters / WEB_MERCATOR_RADIUS)) - Math.PI / 2) * 180) / Math.PI
  return { lon, lat }
}
