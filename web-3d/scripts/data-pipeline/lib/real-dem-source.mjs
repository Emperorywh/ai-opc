/**
 * 真实 DEM 数据源（GEBCO 2026）—— 实现 DemSource 契约（与 lib/dem-source.mjs 合成源同接口）。
 *
 * 契约（与 createSyntheticSource 完全一致，lib/heightmap.mjs.generateDem() 数据源无关、零改动消费）：
 *   DemSource = {
 *     name, width, height,
 *     elevationMin, elevationMax,     // 高程范围(米)，映射 raw uint16 0..65535
 *     seaLevelMeters,                 // =0
 *     heightExaggeration,             // =2.5（与 src/config/projection.ts 同步）
 *     getElevation(lon, lat): number  // 带符号高程(米)，>0 陆地 <0 海洋
 *   }
 *
 * 数据：GEBCO_2026 Grid（公共域，15″ 全球海洋陆地一体高程，equirectangular WGS84，
 *   含 bathymetry → 喂 M2 海洋深浅渐变 SPEC §6.2）。下载 8 个 GeoTIFF tiles（各 90°×90°）
 *   放 scripts/data-pipeline/raw/gebco/（.gitignore，不进 git/构建）。
 *
 * 加载策略（免 GDAL，纯 JS geotiff）：逐 tile fromFile → getImage → getBoundingBox() 读经纬范围
 *   （不硬编码切分约定）→ readRasters({width,height,pool:null}) 降采样到该 tile 在全局栅格的子区域
 *   尺寸 → 按经纬偏移写入全局 Float32 栅格。pool:null 主线程解码，规避 Node web-worker 兼容问题。
 *
 * 采样约定（R3 同源）：getElevation 严格对齐 src/data/assets.ts 的 sampleHeight ——
 *   像素中心（floor(sx-0.5)）、经度方向环绕、纬度方向钳制。
 *   栅格布局顶行=+90°N（与 heightmap.mjs pixelToLonLat 一致；GEBCO 北朝上行序天然匹配）。
 */

import { fromFile } from 'geotiff'
import { readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TILES_DIR = resolve(__dirname, '../raw/gebco')

/**
 * 输出高程映射范围（米）。覆盖 GEBCO 真实范围：马里亚纳 -10916 轻微 clamp（视觉无影响），
 * 珠峰 8848 完整保留。16-bit 步长 ≈0.29m/级，精度远超需求。固定值 → 烘焙产物确定可复现
 * （优于实测 min/max）；海平面 0 落固定 raw 位置，海岸线判定稳定。
 */
export const ELEVATION_MIN = -10000
export const ELEVATION_MAX = 9000

/**
 * 双线性采样高程栅格（米）。约定严格对齐 src/data/assets.ts 的 sampleHeight：
 * 像素中心（floor(sx-0.5)）、经度方向环绕、纬度方向钳制。
 * 纯函数，不依赖 geotiff，可单测。
 *
 * @param {Float32Array|Int16Array} grid 全局栅格（顶行=+90°N）
 * @param {number} W 宽（经度方向）
 * @param {number} H 高（纬度方向）
 * @param {number} lon [-180,180]
 * @param {number} lat [-90,90]
 * @returns {number} 带符号高程（米）
 */
export function bilinearSampleElev(grid, W, H, lon, lat) {
  const sx = ((lon + 180) / 360) * W
  const sy = ((90 - lat) / 180) * H
  const x0 = Math.floor(sx - 0.5)
  const y0 = Math.floor(sy - 0.5)
  const fx = sx - 0.5 - x0
  const fy = sy - 0.5 - y0
  const wrap = (i) => ((i % W) + W) % W
  const clamp = (i) => Math.min(H - 1, Math.max(0, i))
  const xi0 = wrap(x0)
  const xi1 = wrap(x0 + 1)
  const yi0 = clamp(y0)
  const yi1 = clamp(y0 + 1)
  const h00 = grid[yi0 * W + xi0]
  const h10 = grid[yi0 * W + xi1]
  const h01 = grid[yi1 * W + xi0]
  const h11 = grid[yi1 * W + xi1]
  const a = h00 + (h10 - h00) * fx
  const b = h01 + (h11 - h01) * fx
  return a + (b - a) * fy
}

/**
 * 经纬范围 → 全局栅格行列范围（像素边界对齐，顶行=+90°N）。
 * @returns {{ xStart:number, xEnd:number, yStart:number, yEnd:number }}
 */
function lonLatRangeToPixelRange(lonMin, lonMax, latMin, latMax, W, H) {
  const xStart = Math.round(((lonMin + 180) / 360) * W)
  const xEnd = Math.round(((lonMax + 180) / 360) * W)
  const yStart = Math.round(((90 - latMax) / 180) * H)
  const yEnd = Math.round(((90 - latMin) / 180) * H)
  return { xStart, xEnd, yStart, yEnd }
}

/**
 * 加载一个 GEBCO tile，降采样并写入全局栅格对应区域。
 * @param {string} tiffPath tile 文件路径
 * @param {Float32Array} global 全局栅格（原地写入）
 * @param {number} W 全局宽
 * @param {number} H 全局高
 * @returns {Promise<{ file:string, bounds:number[], xStart:number, yStart:number, subW:number, subH:number }>}
 */
async function mergeTile(tiffPath, global, W, H) {
  const tiff = await fromFile(tiffPath)
  try {
    const image = await tiff.getImage()
    // getBoundingBox → [minX,minY,maxX,maxY]，北朝上地理 CRS 即 [lonMin,latMin,lonMax,latMax]
    const [lonMin, latMin, lonMax, latMax] = image.getBoundingBox()
    let { xStart, xEnd, yStart, yEnd } = lonLatRangeToPixelRange(lonMin, lonMax, latMin, latMax, W, H)
    // clamp 进全局栅格边界（防 round 越界 1px）
    xStart = Math.max(0, Math.min(W, xStart))
    xEnd = Math.max(0, Math.min(W, xEnd))
    yStart = Math.max(0, Math.min(H, yStart))
    yEnd = Math.max(0, Math.min(H, yEnd))
    const subW = Math.max(1, xEnd - xStart)
    const subH = Math.max(1, yEnd - yStart)
    // 读整个 tile 降采样到 subW×subH；行 0=北，与全局栅格布局一致；pool:null 主线程解码
    const rasters = await image.readRasters({ width: subW, height: subH, pool: null })
    const band = rasters[0] // GEBCO 单 band 高程（int16，米），默认 interleave:false → 数组首元素
    for (let y = 0; y < subH; y++) {
      const rowBase = (yStart + y) * W + xStart
      const srcBase = y * subW
      for (let x = 0; x < subW; x++) global[rowBase + x] = band[srcBase + x]
    }
    return { file: tiffPath, bounds: [lonMin, latMin, lonMax, latMax], xStart, yStart, subW, subH }
  } finally {
    await tiff.close()
  }
}

/**
 * 创建 GEBCO 2026 真实 DEM 数据源（异步加载 tiles 后返回同步 source）。
 * @param {{ width?:number, height?:number, tilesDir?:string }} [opts]
 * @returns {Promise<object>} DemSource 契约对象
 */
export async function createRealDemSource(opts = {}) {
  const width = opts.width ?? 4096
  const height = opts.height ?? 2048
  const tilesDir = opts.tilesDir ?? DEFAULT_TILES_DIR

  if (!existsSync(tilesDir)) {
    throw new Error(
      `GEBCO tiles 目录不存在：${tilesDir}\n` +
        `请从 https://www.gebco.net/data-products/gridded-bathymetry-data 下载 GEBCO_2026 的 GeoTIFF（8 tiles 或单个全球文件均可）放入该目录。`,
    )
  }
  const tifFiles = readdirSync(tilesDir)
    .filter((f) => /\.tiff?$/i.test(f))
    .sort()
    .map((f) => join(tilesDir, f))
  if (tifFiles.length === 0) {
    throw new Error(`GEBCO tiles 目录无 *.tif 文件：${tilesDir}`)
  }

  const global = new Float32Array(width * height)
  console.log(`[real-dem] 加载 ${tifFiles.length} 个 GEBCO tiles → ${width}×${height} 栅格…`)
  const merged = []
  for (const f of tifFiles) {
    const info = await mergeTile(f, global, width, height)
    const name = info.file.split(/[\\/]/).pop()
    const b = info.bounds.map((n) => n.toFixed(1)).join(', ')
    console.log(`  · ${name}  bounds=[${b}]  → 偏移(${info.xStart},${info.yStart}) ${info.subW}×${info.subH}`)
    merged.push(info)
  }

  // 统计实际高程范围（供报告；映射仍用固定 ELEVATION_MIN/MAX）
  let rMin = Infinity
  let rMax = -Infinity
  for (let i = 0; i < global.length; i++) {
    const v = global[i]
    if (v < rMin) rMin = v
    if (v > rMax) rMax = v
  }

  /**
   * @param {number} lon [-180,180]
   * @param {number} lat [-90,90]
   * @returns {number} 带符号高程（米）
   */
  function getElevation(lon, lat) {
    return bilinearSampleElev(global, width, height, lon, lat)
  }

  return {
    name: 'gebco-2026',
    width,
    height,
    elevationMin: ELEVATION_MIN,
    elevationMax: ELEVATION_MAX,
    seaLevelMeters: 0,
    heightExaggeration: 2.5,
    getElevation,
    // 额外元信息（generateDem 不读，仅供 CLI 报告）
    _rasterRange: [rMin, rMax],
  }
}
