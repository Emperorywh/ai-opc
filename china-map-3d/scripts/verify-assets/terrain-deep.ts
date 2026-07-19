/**
 * 地形资产级深度校验（TASK-003）。
 *
 * 依赖方向：属于离线资产生产/校验层（scripts/verify-assets，tsx 运行），单向依赖
 * src/geo-contracts 契约层与同层 scripts/dem/mercator 投影原语。不依赖浏览器/React/Three.js。
 * 被 CLI（scripts/verify-assets/run.ts 的 terrain scope）与测试基线（tests/assets/）共同复用，
 * 避免校验逻辑双轨：CLI 读盘后调用本函数，测试以篡改副本调用同一函数。
 *
 * 与 TASK-001 契约校验的关系：契约校验（validateTerrainMeta）只验元数据 JSON 的字段结构；
 * 本模块在其之上追加「资产级」不变量——栅格字节与元数据一致、16 位精度未丢失、编码区间可还原、
 * 来源可解析、地势相对关系成立。这些是 TASK-003 验证方式 1、3、4 的落点。
 *
 * 位深与米制解码依据（SPEC §5.1、§7.1、TASK-003 实现约束）：
 * - .r16 是行主序、行 0=北、每像元 2 字节小端 uint16。字节长度必须 = width*height*2，
 *   否则元数据与栅格不一致（篡改分辨率的确定性失败点）。
 * - 编码区间 [-1500m, 9000m] 线性映射到 0..65535；decodeUint16ToElevation 是唯一解码源。
 *   校验抽样端点：理论上 code=0 ↔ -1500m、code=65535 ↔ 9000m，且实测解码值必须落在区间内。
 * - 8 位降级检测：若栅格被图像工具静默降为 8 位再回填 uint16，不同编码数 ≤256。
 *   真实地形（含双线性重采样）不同编码数远超 256（本资产实测数万），以此为精度丢失的确定性判据。
 *
 * 地势抽样依据（SPEC §12.1、§13、TASK-003 验证方式 3、实现约束「不硬编码插值像元魔法常量」）：
 * - 在真实地理区块上做「区域均值」抽样（每区块多点网格取均值），而非单个插值像元。
 *   区域均值对重采样与抽样分辨率不敏感，数量级与相对关系稳定可复现。
 * - 只断言稳定的相对关系与数量级，阈值得自真实地势并留有充足余量：
 *     · 青藏高原区域均值显著高于东部平原区域均值（西高东低，SPEC §1/§12.1）。
 *     · 四川盆地区域均值显著低于其周边山地区域均值（盆地凹陷，SPEC §12.1）。
 *     · 浅海陆架区域存在保留的负高程（-1500m, 0m），证明浅水负高程未被钳制为 0（SPEC §3.5/§5.1）。
 *     · 深海区域被截断到编码下限 -1500m（证明深海 clamp-to-range 生效，SPEC §5.1）。
 */

import { createHash } from 'node:crypto'
import {
  CHINA_MAIN_MAP_EXTENT,
  decodeUint16ToElevation,
  validateTerrainMeta,
  validateDataSourceRegistry,
  type DataSourceRegistryContract,
  type TerrainMetaContract,
} from '../../src/geo-contracts/index'
import { projectLonLatToWebMercator } from '../dem/mercator'

/**
 * 生产资产的目标分辨率（SPEC §5.1 / §7.2：heightmap 纹理 4096²）。
 * 资产级校验固定期望 4096²；若未来交付其它分辨率档位，须先在此登记并同步 SPEC。
 */
const EXPECTED_PRODUCTION_RESOLUTION = { width: 4096, height: 4096 }

/**
 * 8 位降级判据：真实 16 位地形栅格的不同 uint16 编码数远超该阈值；
 * 被静默降为 8 位再回填的栅格不同编码数 ≤256。阈值取 1000 远高于 8 位上限、
 * 远低于真实地形（数万），给出稳定判别余量。
 */
const MIN_DISTINCT_CODES_FOR_16BIT = 1000

/** 经纬度区块中心 + 半径（度），用于区域均值抽样。 */
interface Region {
  readonly centerLat: number
  readonly centerLon: number
  readonly halfSizeLat: number
  readonly halfSizeLon: number
}

/**
 * 地形区块（用于地势抽样不变量）。区块取值依据公开地理常识并留有余量：
 * - 青藏高原：腹地 33°N/88°E，全球最高大面积高原，均值 4000m+。
 * - 东部平原：长江下游 33°N/117°E，海拔数十米。
 * - 四川盆地：30.5°N/105°E，周边被横断/大巴/云贵山地环绕，盆地底 ~500m。
 * - 四川周边山地：环绕盆地的 31.5°N/103°E（西缘横断）与 32°N/108°E（北缘秦巴）合成区域。
 * - 东海陆架（浅海）：28°N/125°E，水深数十至数百米，负高程且未触 -1500m 下限。
 * - 南海深海：15°N/115°E，水深 4000m+，被截断到 -1500m 下限。
 */
const TIBETAN_PLATEAU_REGION: Region = { centerLat: 33, centerLon: 88, halfSizeLat: 1.5, halfSizeLon: 1.5 }
const EASTERN_PLAIN_REGION: Region = { centerLat: 33, centerLon: 117, halfSizeLat: 1.5, halfSizeLon: 1.5 }
const SICHUAN_BASIN_REGION: Region = { centerLat: 30.5, centerLon: 105, halfSizeLat: 0.8, halfSizeLon: 0.8 }
const SICHUAN_SURROUNDINGS_REGION: Region = { centerLat: 31.75, centerLon: 105.5, halfSizeLat: 1.8, halfSizeLon: 2.5 }
const EAST_CHINA_SEA_SHELF_REGION: Region = { centerLat: 28, centerLon: 125, halfSizeLat: 1, halfSizeLon: 1 }
const SOUTH_CHINA_SEA_DEEP_REGION: Region = { centerLat: 15, centerLon: 115, halfSizeLat: 1, halfSizeLon: 1 }

/** 资产级校验错误码前缀。 */
const ASSET_ERROR_CODES = {
  rasterSizeMismatch: 'terrain-asset.raster-size-mismatch',
  resolutionNot4096: 'terrain-asset.resolution-not-4096',
  extentNotMainMap: 'terrain-asset.extent-not-main-map',
  bitDepthDegraded: 'terrain-asset.bit-depth-degraded',
  decodedOutOfRange: 'terrain-asset.decoded-out-of-range',
  tibetanNotHigherThanEastern: 'terrain-asset.tibetan-not-higher-than-eastern',
  basinNotLowerThanSurroundings: 'terrain-asset.basin-not-lower-than-surroundings',
  noPreservedShallowNegative: 'terrain-asset.no-preserved-shallow-negative',
  deepOceanNotClamped: 'terrain-asset.deep-ocean-not-clamped',
  provenanceSourceMismatch: 'terrain-asset.provenance-source-mismatch',
  provenanceIntegrityMismatch: 'terrain-asset.provenance-integrity-mismatch',
  unresolvedSource: 'terrain-asset.unresolved-source',
} as const

/** 单条资产级错误。结构与契约层 ContractValidationError 对齐，便于 CLI 统一打印。 */
export interface TerrainAssetError {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** 资产级校验结果。 */
export interface TerrainAssetOutcome {
  readonly ok: boolean
  readonly errors: readonly TerrainAssetError[]
  /** 抽样摘要（区域均值/端点解码），供 CLI 与测试观察，非错误项。 */
  readonly samples: TerrainAssetSamples
}

/** 抽样摘要：所有地势区块的区域均值与编码端点解码值。 */
export interface TerrainAssetSamples {
  readonly tibetanMeters: number
  readonly easternMeters: number
  readonly sichuanBasinMeters: number
  readonly sichuanSurroundingsMeters: number
  readonly eastChinaSeaShelfMeters: number
  readonly southChinaSeaDeepMeters: number
  readonly decodedAtZeroCode: number
  readonly decodedAtMaxCode: number
  readonly observedMinMeters: number
  readonly observedMaxMeters: number
  readonly distinctCodes: number
}

/** 深度校验入参：栅格像素 + 元数据 + 可选来源注册表与审计 sidecar。 */
export interface TerrainAssetVerificationInput {
  readonly meta: unknown
  readonly pixels: Uint16Array
  readonly width: number
  readonly height: number
  readonly sourcesRegistry?: unknown
  readonly provenance?: unknown
  /**
   * 栅格原始小端字节（与 .r16 落盘字节一致的 Uint8Array），用于复算 SHA-256 防篡改锚点。
   * 可选：纯像素内存副本（如部分测试）可不传，但 provenance 声明 sha256 时必须提供，
   * 否则校验报「无法复算 sha256」——生产 CLI 路径始终从同一 readFileSync 结果同时取字节与像素。
   */
  readonly rasterBytes?: Uint8Array
}

/** 在栅格像素空间做双线性采样，返回 uint16 编码值。行 0=北、列 0=西。 */
function bilinearSampleCode(
  pixels: Uint16Array,
  width: number,
  height: number,
  fx: number,
  fy: number,
): number {
  const maxCol = width - 1
  const maxRow = height - 1
  const x0 = Math.min(Math.max(Math.floor(fx), 0), maxCol)
  const x1 = Math.min(x0 + 1, maxCol)
  const y0 = Math.min(Math.max(Math.floor(fy), 0), maxRow)
  const y1 = Math.min(y0 + 1, maxRow)
  const tx = Math.min(Math.max(fx - x0, 0), 1)
  const ty = Math.min(Math.max(fy - y0, 0), 1)
  const v00 = pixels[y0 * width + x0]
  const v10 = pixels[y0 * width + x1]
  const v01 = pixels[y1 * width + x0]
  const v11 = pixels[y1 * width + x1]
  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return Math.round(top + (bottom - top) * ty)
}

/**
 * 把地理 (lon,lat) 映射到栅格像素分数坐标 (fx,fy)。
 * 与 buildHeightmap 的目标像元布局严格互逆：像元中心 (col+0.5,row+0.5) 对应范围四至经墨卡托后的均匀网格。
 */
function lonLatToRasterFraction(
  meta: TerrainMetaContract,
  lon: number,
  lat: number,
  width: number,
  height: number,
): { fx: number; fy: number } {
  const { geographicExtent: ext } = meta
  const sw = projectLonLatToWebMercator(ext.west, ext.south)
  const ne = projectLonLatToWebMercator(ext.east, ext.north)
  const { x, y } = projectLonLatToWebMercator(lon, lat)
  const fx = ((x - sw.x) / (ne.x - sw.x)) * width - 0.5
  // 行 0 = 北（yMax），故 fy = (yMax - y)/(yMax-yMin)*height - 0.5。
  const fy = ((ne.y - y) / (ne.y - sw.y)) * height - 0.5
  return { fx, fy }
}

/**
 * 区域均值抽样：在区块内取 pointsPerAxis×pointsPerAxis 网格，逐点双线性采样解码后取均值。
 * 区域均值而非单像元，保证抽样对重采样分辨率稳定（实现约束：不硬编码插值像元魔法常量）。
 */
function sampleRegionMeanMeters(
  meta: TerrainMetaContract,
  pixels: Uint16Array,
  width: number,
  height: number,
  region: Region,
  pointsPerAxis = 3,
): number {
  const { minValueMeters, maxValueMeters } = meta.elevationEncoding
  let sum = 0
  let count = 0
  for (let i = 0; i < pointsPerAxis; i++) {
    for (let j = 0; j < pointsPerAxis; j++) {
      const lat = region.centerLat - region.halfSizeLat + (2 * region.halfSizeLat * i) / (pointsPerAxis - 1)
      const lon = region.centerLon - region.halfSizeLon + (2 * region.halfSizeLon * j) / (pointsPerAxis - 1)
      const { fx, fy } = lonLatToRasterFraction(meta, lon, lat, width, height)
      const code = bilinearSampleCode(pixels, width, height, fx, fy)
      sum += decodeUint16ToElevation(code, minValueMeters, maxValueMeters)
      count++
    }
  }
  return sum / count
}

/**
 * 计算不同编码数、实测解码最值与截断到下限（code=0）像元数。
 * 这些统计量同时供 8 位降级判据、端点抽样与 provenance.integrity 逐项比对（防篡改锚点）。
 * 截断到下限的像元即编码为 0 的像元（深海被 clamp-to-range 到 -1500m，SPEC §5.1）。
 */
function computeRasterStats(pixels: Uint16Array, minValueMeters: number, maxValueMeters: number): {
  distinctCodes: number
  observedMinMeters: number
  observedMaxMeters: number
  clampedToMinCount: number
} {
  const distinct = new Set<number>()
  let observedMinMeters = Infinity
  let observedMaxMeters = -Infinity
  let clampedToMinCount = 0
  for (let i = 0; i < pixels.length; i++) {
    const code = pixels[i]
    distinct.add(code)
    if (code === 0) clampedToMinCount++
    const meters = decodeUint16ToElevation(code, minValueMeters, maxValueMeters)
    if (meters < observedMinMeters) observedMinMeters = meters
    if (meters > observedMaxMeters) observedMaxMeters = meters
  }
  return { distinctCodes: distinct.size, observedMinMeters, observedMaxMeters, clampedToMinCount }
}

/** 资产级深度校验主入口：返回通过/失败 + 抽样摘要。 */
export function verifyTerrainAsset(input: TerrainAssetVerificationInput): TerrainAssetOutcome {
  const errors: TerrainAssetError[] = []
  const { pixels, width, height } = input

  // 1) 元数据契约校验（复用 TASK-001 校验器）：位深、CRS、编码区间、版本等结构不变量。
  const metaOutcome = validateTerrainMeta(input.meta)
  if (!metaOutcome.ok) {
    for (const e of metaOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }

  // 元数据契约不通过时，后续以栅格为中心的检查无法可靠进行；但仍尽可能给出栅格级错误。
  const meta = input.meta as Partial<TerrainMetaContract>
  const minValueMeters = meta.elevationEncoding?.minValueMeters ?? -1500
  const maxValueMeters = meta.elevationEncoding?.maxValueMeters ?? 9000

  // 抽样摘要默认值（元数据非法时用区间端点占位，避免后续比较引用 NaN）。
  let samples: TerrainAssetSamples = {
    tibetanMeters: NaN,
    easternMeters: NaN,
    sichuanBasinMeters: NaN,
    sichuanSurroundingsMeters: NaN,
    eastChinaSeaShelfMeters: NaN,
    southChinaSeaDeepMeters: NaN,
    decodedAtZeroCode: decodeUint16ToElevation(0, minValueMeters, maxValueMeters),
    decodedAtMaxCode: decodeUint16ToElevation(65535, minValueMeters, maxValueMeters),
    observedMinMeters: NaN,
    observedMaxMeters: NaN,
    distinctCodes: 0,
  }

  // 2) 栅格字节与元数据分辨率一致：pixels.length 必须 = width*height。
  //    篡改元数据分辨率（验证方式 4）会在此被确定性发现。
  if (pixels.length !== width * height) {
    errors.push({
      code: ASSET_ERROR_CODES.rasterSizeMismatch,
      path: '$.resolution',
      message: `栅格像元数 ${pixels.length} 与分辨率 ${width}x${height}=${width * height} 不一致。`,
    })
  }

  // 3) 生产分辨率须为 4096²（SPEC §5.1/§7.2 资产档位）。
  if (width !== EXPECTED_PRODUCTION_RESOLUTION.width || height !== EXPECTED_PRODUCTION_RESOLUTION.height) {
    errors.push({
      code: ASSET_ERROR_CODES.resolutionNot4096,
      path: '$.resolution',
      message: `生产高程资产分辨率必须为 ${EXPECTED_PRODUCTION_RESOLUTION.width}x${EXPECTED_PRODUCTION_RESOLUTION.height}，实际为 ${width}x${height}。`,
    })
  }

  // 4) 地理范围须为中国主图 [72,3,136,54]（SPEC §3.3）。篡改范围会在此被确定性发现。
  const ext = meta.geographicExtent
  const expected = CHINA_MAIN_MAP_EXTENT
  const epsilon = 1e-9
  if (
    typeof ext?.west !== 'number' ||
    typeof ext?.east !== 'number' ||
    typeof ext?.south !== 'number' ||
    typeof ext?.north !== 'number' ||
    Math.abs(ext.west - expected.west) > epsilon ||
    Math.abs(ext.east - expected.east) > epsilon ||
    Math.abs(ext.south - expected.south) > epsilon ||
    Math.abs(ext.north - expected.north) > epsilon
  ) {
    errors.push({
      code: ASSET_ERROR_CODES.extentNotMainMap,
      path: '$.geographicExtent',
      message: `生产高程资产地理范围必须为中国主图 [${expected.west},${expected.south},${expected.east},${expected.north}]，实际为 [${ext?.west},${ext?.south},${ext?.east},${ext?.north}]。`,
    })
  }

  // 元数据契约或栅格尺寸不通过时，跳过依赖一致布局的抽样类检查（避免噪声错误淹没根因）。
  const metaAndSizeOk = metaOutcome.ok && pixels.length === width * height

  // 栅格统计量（不同编码数 / 实测解码最值 / 截断到下限像元数）。提升到外层作用域，
  // 使下方 provenance.integrity 比对与上面的抽样判据复用同一份确定性复算结果。
  // 仅在元数据与栅格尺寸一致（stats 可信）时赋值，否则保持 null，比对阶段据此跳过。
  let stats: ReturnType<typeof computeRasterStats> | null = null

  if (metaAndSizeOk) {
    const validMeta = input.meta as TerrainMetaContract
    stats = computeRasterStats(pixels, minValueMeters, maxValueMeters)

    // 5) 8 位降级判据：不同编码数须远超 256。
    if (stats.distinctCodes < MIN_DISTINCT_CODES_FOR_16BIT) {
      errors.push({
        code: ASSET_ERROR_CODES.bitDepthDegraded,
        path: '$.elevationEncoding.bitDepth',
        message: `栅格不同 uint16 编码数 ${stats.distinctCodes} 过少（< ${MIN_DISTINCT_CODES_FOR_16BIT}），疑似被静默降为 8 位；16 位精度丢失。`,
      })
    }

    // 6) 实测解码值须落在编码区间内（端点 code=0↔min、code=65535↔max 由 decode 公式保证）。
    if (
      stats.observedMinMeters < minValueMeters - epsilon ||
      stats.observedMaxMeters > maxValueMeters + epsilon
    ) {
      errors.push({
        code: ASSET_ERROR_CODES.decodedOutOfRange,
        path: '$.elevationEncoding',
        message: `实测解码高程 [${stats.observedMinMeters}, ${stats.observedMaxMeters}] 超出编码区间 [${minValueMeters}, ${maxValueMeters}]。`,
      })
    }

    // 7) 地势相对关系抽样。
    const tibetanMeters = sampleRegionMeanMeters(validMeta, pixels, width, height, TIBETAN_PLATEAU_REGION)
    const easternMeters = sampleRegionMeanMeters(validMeta, pixels, width, height, EASTERN_PLAIN_REGION)
    const sichuanBasinMeters = sampleRegionMeanMeters(validMeta, pixels, width, height, SICHUAN_BASIN_REGION)
    const sichuanSurroundingsMeters = sampleRegionMeanMeters(
      validMeta,
      pixels,
      width,
      height,
      SICHUAN_SURROUNDINGS_REGION,
    )
    const eastChinaSeaShelfMeters = sampleRegionMeanMeters(
      validMeta,
      pixels,
      width,
      height,
      EAST_CHINA_SEA_SHELF_REGION,
    )
    const southChinaSeaDeepMeters = sampleRegionMeanMeters(
      validMeta,
      pixels,
      width,
      height,
      SOUTH_CHINA_SEA_DEEP_REGION,
    )

    samples = {
      tibetanMeters,
      easternMeters,
      sichuanBasinMeters,
      sichuanSurroundingsMeters,
      eastChinaSeaShelfMeters,
      southChinaSeaDeepMeters,
      decodedAtZeroCode: decodeUint16ToElevation(0, minValueMeters, maxValueMeters),
      decodedAtMaxCode: decodeUint16ToElevation(65535, minValueMeters, maxValueMeters),
      observedMinMeters: stats.observedMinMeters,
      observedMaxMeters: stats.observedMaxMeters,
      distinctCodes: stats.distinctCodes,
    }

    // 青藏高原均值须显著高于东部平原（西高东低）。阈值 1500m 远低于实测 ~4000m 差距。
    if (!(tibetanMeters > easternMeters + 1500)) {
      errors.push({
        code: ASSET_ERROR_CODES.tibetanNotHigherThanEastern,
        path: '$.terrainSampling',
        message: `青藏高原区域均值 ${tibetanMeters.toFixed(0)}m 未显著高于东部平原 ${easternMeters.toFixed(0)}m（需高出 ≥1500m）。`,
      })
    }
    // 四川盆地均值须显著低于周边山地。阈值 400m 远低于实测 ~1000m+ 差距。
    if (!(sichuanSurroundingsMeters > sichuanBasinMeters + 400)) {
      errors.push({
        code: ASSET_ERROR_CODES.basinNotLowerThanSurroundings,
        path: '$.terrainSampling',
        message: `四川盆地区域均值 ${sichuanBasinMeters.toFixed(0)}m 未显著低于周边山地 ${sichuanSurroundingsMeters.toFixed(0)}m（周边需高出 ≥400m）。`,
      })
    }
    // 浅海陆架须存在保留的负高程（-1500m, 0m），证明浅水负高程未被钳制为 0。
    if (!(eastChinaSeaShelfMeters < -10 && eastChinaSeaShelfMeters > -1500)) {
      errors.push({
        code: ASSET_ERROR_CODES.noPreservedShallowNegative,
        path: '$.terrainSampling',
        message: `东海陆架区域均值 ${eastChinaSeaShelfMeters.toFixed(0)}m 未落在保留浅水负高程区间 (-1500, -10)，浅水负高程疑似丢失。`,
      })
    }
    // 深海须被截断到下限附近（≤ -1400m），证明深海 clamp-to-range 生效。
    if (!(southChinaSeaDeepMeters <= -1400)) {
      errors.push({
        code: ASSET_ERROR_CODES.deepOceanNotClamped,
        path: '$.terrainSampling',
        message: `南海深海区域均值 ${southChinaSeaDeepMeters.toFixed(0)}m 未被截断到下限附近（需 ≤ -1400m），深海 clamp-to-range 疑似失效。`,
      })
    }
  }

  // 8) 来源引用可解析：sourceId 须能在来源注册表中找到（若提供注册表）。
  if (input.sourcesRegistry !== undefined) {
    const registryOutcome = validateDataSourceRegistry(input.sourcesRegistry)
    const sourceId = (meta.source as { sourceId?: string } | undefined)?.sourceId
    if (!registryOutcome.ok) {
      errors.push({
        code: ASSET_ERROR_CODES.unresolvedSource,
        path: '$.sources',
        message: `来源注册表自身未通过契约校验：${registryOutcome.errors.map((e) => e.code).join(', ')}。`,
      })
    } else if (typeof sourceId === 'string') {
      const registry = input.sourcesRegistry as DataSourceRegistryContract
      const known = registry.sources.some((s) => s.id === sourceId)
      if (!known) {
        errors.push({
          code: ASSET_ERROR_CODES.unresolvedSource,
          path: '$.source.sourceId',
          message: `元数据 sourceId=${sourceId} 在来源注册表中不存在。`,
        })
      }
    }
  }

  // 9) 审计 sidecar 完整性比对（TASK-003 防篡改闭环）。
  //    provenance.integrity 声明 rasterBytes / sha256 / distinctCodes / observedMinMeters /
  //    observedMaxMeters / clampedToMinCount 六项摘要；生产侧（fetch-etopo1-grid.ts 的
  //    computeIntegritySummary）已用 createHash('sha256') 与逐像元扫描把它们落盘。
  //    校验侧必须逐项复算比对，否则 integrity 块对自动校验形同装饰——只比对 rasterBytes
  //    会被「同字节数的劣化/篡改栅格」绕过：SHA-256 不一致、统计量漂移都不会被发现。
  //    SHA-256 是天然防篡改锚点（任意单字节改动即变），统计量提供内容级交叉核对。
  if (input.provenance !== undefined && input.provenance !== null) {
    const p = input.provenance as {
      source?: { sourceId?: string }
      integrity?: {
        rasterBytes?: number
        sha256?: string
        distinctCodes?: number
        observedMinMeters?: number
        observedMaxMeters?: number
        clampedToMinCount?: number
      }
    }
    const metaSourceId = (meta.source as { sourceId?: string } | undefined)?.sourceId
    if (
      typeof p.source?.sourceId === 'string' &&
      typeof metaSourceId === 'string' &&
      p.source.sourceId !== metaSourceId
    ) {
      errors.push({
        code: ASSET_ERROR_CODES.provenanceSourceMismatch,
        path: '$.provenance.source.sourceId',
        message: `审计 sourceId=${p.source.sourceId} 与元数据 sourceId=${metaSourceId} 不一致。`,
      })
    }
    const integrity = p.integrity
    if (integrity !== undefined) {
      // rasterBytes：审计声明的栅格字节数须与实际像元数×2 一致。
      if (typeof integrity.rasterBytes === 'number' && integrity.rasterBytes !== pixels.length * 2) {
        errors.push({
          code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
          path: '$.provenance.integrity.rasterBytes',
          message: `审计 rasterBytes=${integrity.rasterBytes} 与栅格实际字节 ${pixels.length * 2} 不一致。`,
        })
      }
      // sha256：最强防篡改锚点。对栅格原始小端字节复算 SHA-256，须与审计声明逐字符一致。
      // 生产 CLI 路径必传 rasterBytes（与 .r16 落盘字节同源）；若声明了 sha256 却未提供字节，
      // 视为校验缺口并报错，避免「声明锚点但不闭环」的装饰性校验。
      if (typeof integrity.sha256 === 'string') {
        if (input.rasterBytes === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.sha256',
            message: '审计声明了 sha256 但校验入参未提供 rasterBytes，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.rasterBytes).digest('hex')
          if (recomputed !== integrity.sha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.sha256',
              message: `审计 sha256=${integrity.sha256} 与栅格复算 ${recomputed} 不一致（栅格可能被替换或篡改）。`,
            })
          }
        }
      }
      // 统计量锚点：distinctCodes / observedMinMeters / observedMaxMeters / clampedToMinCount
      // 由栅格像素确定性导出，须与审计声明精确一致（仅当元数据与栅格尺寸一致、stats 可信时比对）。
      // observedMin/Max 用 epsilon 容差吸收浮点解码误差；计数量（distinctCodes / clampedToMinCount）精确相等。
      if (stats !== null) {
        if (typeof integrity.distinctCodes === 'number' && integrity.distinctCodes !== stats.distinctCodes) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.distinctCodes',
            message: `审计 distinctCodes=${integrity.distinctCodes} 与栅格复算 ${stats.distinctCodes} 不一致。`,
          })
        }
        if (
          typeof integrity.observedMinMeters === 'number' &&
          Math.abs(integrity.observedMinMeters - stats.observedMinMeters) > epsilon
        ) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.observedMinMeters',
            message: `审计 observedMinMeters=${integrity.observedMinMeters} 与栅格复算 ${stats.observedMinMeters} 不一致。`,
          })
        }
        if (
          typeof integrity.observedMaxMeters === 'number' &&
          Math.abs(integrity.observedMaxMeters - stats.observedMaxMeters) > epsilon
        ) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.observedMaxMeters',
            message: `审计 observedMaxMeters=${integrity.observedMaxMeters} 与栅格复算 ${stats.observedMaxMeters} 不一致。`,
          })
        }
        if (
          typeof integrity.clampedToMinCount === 'number' &&
          integrity.clampedToMinCount !== stats.clampedToMinCount
        ) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.clampedToMinCount',
            message: `审计 clampedToMinCount=${integrity.clampedToMinCount} 与栅格复算 ${stats.clampedToMinCount} 不一致。`,
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, samples }
}
