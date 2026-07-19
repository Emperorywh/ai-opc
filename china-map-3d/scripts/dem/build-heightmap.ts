/**
 * DEM 高程资产生成流水线（离线生产层 · 可测试核心）。
 *
 * 依赖方向：属于离线资产生产层（scripts/dem，tsx 运行），单向依赖 src/geo-contracts 契约层
 * 与本目录的 mercator 投影原语。严禁依赖浏览器、React、Three.js 或任何运行时状态。
 *
 * 本模块是 TASK-002「可重复 DEM 高程资产生成能力」的可测试核心：
 * - 输入：一份小型确定性 DEM 夹具（dem-tile-fixture-v1：EPSG:4326 经纬度高程栅格 + 四至
 *   + 分辨率 + 可选 nodata）。
 * - 处理（确定性、可拒绝坏输入）：
 *     1) 输入格式 / CRS / 四至 / 栅格完整性核对；
 *     2) 覆盖范围核对——输入必须完整覆盖目标地理范围，否则确定性失败（不得默认平面兜底）；
 *     3) EPSG:4326 → EPSG:3857 重投影（闭式 mercator，见 mercator.ts）；
 *     4) 目标栅格逐像元中心反算经纬度后双线性重采样；
 *     5) 16 位线性编码：[-1500m, 9000m] → 0..65535，浅水负高程保留，低于 -1500m 截断到下限。
 * - 输出：16 位无符号整数像素缓冲（行主序、北→南、西→东、小端）+ 满足 terrain-meta 契约
 *   的元数据 JSON。
 *
 * 为什么 TS 实现可测试核心而生产用 Python（rasterio）：TS 核心让 pnpm test 在无 Python/
 * rasterio 的 CI 环境也能确定性证明重投影、重采样、截断与负高程保留；Python 生产脚本
 * （build_heightmap.py）处理真实 Copernicus GeoTIFF 下载 / 拼接 / 重投影。二者遵循同一编码
 * 契约（encodeElevationToUint16），产出可互相替换、满足同一外部契约的资产——不维护两套编码。
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  decodeUint16ToElevation,
  encodeElevationToUint16,
  validateTerrainMeta,
  type TerrainMetaContract,
} from '../../src/geo-contracts/index'
import {
  inverseWebMercatorToLonLat,
  projectLonLatToWebMercator,
} from './mercator'

/**
 * SPEC §3.3 / §5.1 的生产参数（中国主图）。
 * 经度 72°E–136°E、纬度 3°N–54°N；高程编码区间 [-1500m, 9000m] → 0..65535。
 */
export const PRODUCTION_TARGET_EXTENT = {
  west: 72,
  south: 3,
  east: 136,
  north: 54,
} as const

export const PRODUCTION_ELEVATION_RANGE = {
  minValueMeters: -1500,
  maxValueMeters: 9000,
} as const

/** SPEC §5.1 生产输出分辨率（4096²）；可测试核心允许调用方传入更小的目标分辨率。 */
export const PRODUCTION_RESOLUTION = { width: 4096, height: 4096 } as const

/** Copernicus DEM 在来源注册表中的稳定 sourceId，供元数据 source 字段追溯。 */
export const PRODUCTION_SOURCE_ID = 'src-copernicus-dem'

/**
 * 小型确定性 DEM 夹具格式（流水线输入，**不是** geo-contracts 运行时契约）。
 * 用 format 字段（而非 kind）标记，避免与契约 kind 字面量混淆。
 * values 为行主序、行 0 = 北、列 0 = 西；长度必须等于 width * height。
 */
export interface DemTileFixture {
  readonly format: 'dem-tile-fixture-v1'
  readonly crs: 'EPSG:4326'
  readonly bounds: {
    readonly west: number
    readonly south: number
    readonly east: number
    readonly north: number
  }
  readonly width: number
  readonly height: number
  readonly nodata: number | null
  readonly values: readonly number[]
}

/** 流水线构建选项：目标范围、目标分辨率、编码区间与来源标识均可注入以便测试。 */
export interface HeightmapBuildOptions {
  readonly targetExtent?: { west: number; south: number; east: number; north: number }
  readonly targetResolution?: { width: number; height: number }
  readonly elevationRange?: { minValueMeters: number; maxValueMeters: number }
  readonly sourceId?: string
}

/** 流水线构建结果：像素缓冲 + 几何信息 + 契约级元数据。 */
export interface HeightmapBuildResult {
  readonly pixels: Uint16Array
  readonly width: number
  readonly height: number
  readonly meta: TerrainMetaContract
}

/**
 * 流水线确定性失败错误。
 * code 供自动化测试精确断言（dem-input.format / crs / coverage / raster-integrity / bounds）。
 */
export class DemBuildError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DemBuildError'
    this.code = code
  }
}

/** 判定一个值是否为有限数值（剔除 NaN / Infinity，作为高程采样前置条件）。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 核对输入夹具的结构与覆盖范围，任一不变量被违反即抛 DemBuildError。
 * 注意：校验失败必须「在采样之前」发生，确保不会留下看似有效的半成品输出。
 */
function assertFixtureValid(input: DemTileFixture, target: { west: number; south: number; east: number; north: number }): void {
  if (input === null || typeof input !== 'object') {
    throw new DemBuildError('dem-input.format', 'DEM 输入必须为对象。')
  }
  if (input.format !== 'dem-tile-fixture-v1') {
    throw new DemBuildError(
      'dem-input.format',
      `DEM 输入 format 必须为 "dem-tile-fixture-v1"，实际为 ${String(input.format)}。`,
    )
  }
  // 输入基准必须是 EPSG:4326 经纬度；任何其它 CRS（含目标 3857）都在此被拒绝，避免错误投影。
  if (input.crs !== 'EPSG:4326') {
    throw new DemBuildError(
      'dem-input.crs',
      `DEM 输入 crs 必须为 "EPSG:4326"（源基准），实际为 ${String(input.crs)}。`,
    )
  }
  const { west, south, east, north } = input.bounds
  if (![west, south, east, north].every(isFiniteNumber)) {
    throw new DemBuildError('dem-input.bounds', 'DEM 输入 bounds 的四至必须为有限数值。')
  }
  if (!(west < east) || !(south < north)) {
    throw new DemBuildError(
      'dem-input.bounds',
      `DEM 输入 bounds 自相矛盾：需要 west<east 且 south<north，实际 ${west}/${south}/${east}/${north}。`,
    )
  }
  if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
    throw new DemBuildError(
      'dem-input.raster-integrity',
      `DEM 输入 width/height 必须为正整数，实际 ${input.width}/${input.height}。`,
    )
  }
  // 栅格完整性：values 长度必须等于 width*height，且全部为有限数值（nodata 由上游在生成夹具时处理）。
  if (!Array.isArray(input.values) || input.values.length !== input.width * input.height) {
    throw new DemBuildError(
      'dem-input.raster-integrity',
      `DEM 输入 values 长度必须等于 width*height=${input.width * input.height}，实际 ${input.values?.length ?? '(非数组)'}。`,
    )
  }
  if (!input.values.every(isFiniteNumber)) {
    throw new DemBuildError(
      'dem-input.raster-integrity',
      'DEM 输入 values 含非有限数值（NaN/Infinity），流水线不负责猜测填充。',
    )
  }
  // 覆盖范围：输入四至必须完整覆盖目标范围，否则目标栅格会出现无源区域——确定性失败，不得默认平面兜底。
  if (west > target.west || east < target.east || south > target.south || north < target.north) {
    throw new DemBuildError(
      'dem-input.coverage',
      `DEM 输入范围 ${west}/${south}/${east}/${north} 未完整覆盖目标范围 ${target.west}/${target.south}/${target.east}/${target.north}。`,
    )
  }
}

/**
 * 在源 DEM 栅格上做双线性重采样。
 * 行 0 = 北、列 0 = 西；输入像元中心位于连续索引 (col+0.5, row+0.5) 处。
 * 边缘处夹到 [0, dim-1] 像元，保证整张目标栅格都能取到值（覆盖范围核对已确保源完整覆盖目标）。
 */
function sampleBilinear(input: DemTileFixture, lon: number, lat: number): number {
  const lonSpan = input.bounds.east - input.bounds.west
  const latSpan = input.bounds.north - input.bounds.south
  // 经度→列连续索引（像元中心在 col+0.5）。
  const fx = ((lon - input.bounds.west) / lonSpan) * input.width - 0.5
  // 纬度→行连续索引：北端为行 0，故取 (north - lat)。
  const fy = ((input.bounds.north - lat) / latSpan) * input.height - 0.5

  const maxCol = input.width - 1
  const maxRow = input.height - 1
  const x0 = Math.min(Math.max(Math.floor(fx), 0), maxCol)
  const x1 = Math.min(x0 + 1, maxCol)
  const y0 = Math.min(Math.max(Math.floor(fy), 0), maxRow)
  const y1 = Math.min(y0 + 1, maxRow)
  // 在 [0,1] 内的小数权重；边缘外夹到 0，使采样收敛到边界像元。
  const tx = Math.min(Math.max(fx - x0, 0), 1)
  const ty = Math.min(Math.max(fy - y0, 0), 1)

  const v00 = input.values[y0 * input.width + x0]
  const v10 = input.values[y0 * input.width + x1]
  const v01 = input.values[y1 * input.width + x0]
  const v11 = input.values[y1 * input.width + x1]

  const top = v00 + (v10 - v00) * tx
  const bottom = v01 + (v11 - v01) * tx
  return top + (bottom - top) * ty
}

/**
 * 构建 16 位高程图：校验输入 → 逐目标像元重投影 + 双线性重采样 → 16 位线性编码。
 * 输入非法时抛 DemBuildError（在写盘前），保证不产生半成品。
 */
export function buildHeightmap(input: DemTileFixture, options: HeightmapBuildOptions = {}): HeightmapBuildResult {
  const target = options.targetExtent ?? PRODUCTION_TARGET_EXTENT
  const resolution = options.targetResolution ?? PRODUCTION_RESOLUTION
  const range = options.elevationRange ?? PRODUCTION_ELEVATION_RANGE
  const sourceId = options.sourceId ?? PRODUCTION_SOURCE_ID

  assertFixtureValid(input, target)

  // 目标栅格在 EPSG:3857 下的四至（米）。SPEC §3.3：经纬度范围经 Web 墨卡托线性映射到平面。
  const southWest = projectLonLatToWebMercator(target.west, target.south)
  const northEast = projectLonLatToWebMercator(target.east, target.north)
  const xMin = southWest.x
  const xMax = northEast.x
  const yMin = southWest.y
  const yMax = northEast.y
  const dx = (xMax - xMin) / resolution.width
  const dy = (yMax - yMin) / resolution.height

  const pixels = new Uint16Array(resolution.width * resolution.height)
  for (let row = 0; row < resolution.height; row++) {
    // 行 0 = 北：像元中心 y = yMax - (row+0.5)*dy。
    const y = yMax - (row + 0.5) * dy
    for (let col = 0; col < resolution.width; col++) {
      const x = xMin + (col + 0.5) * dx
      // 目标像元中心（EPSG:3857）反算回 EPSG:4326，在源 DEM 上双线性采样得到真实海拔。
      const { lon, lat } = inverseWebMercatorToLonLat(x, y)
      const meters = sampleBilinear(input, lon, lat)
      // 16 位线性编码：clamp-to-range 在编码函数内完成（浅水负高程保留、深海截断到下限）。
      pixels[row * resolution.width + col] = encodeElevationToUint16(
        meters,
        range.minValueMeters,
        range.maxValueMeters,
      )
    }
  }

  const meta: TerrainMetaContract = {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: {
      crs: 'EPSG:4326',
      west: target.west,
      south: target.south,
      east: target.east,
      north: target.north,
    },
    resolution: {
      widthPixels: resolution.width,
      heightPixels: resolution.height,
    },
    elevationEncoding: {
      minValueMeters: range.minValueMeters,
      maxValueMeters: range.maxValueMeters,
      bitDepth: 16,
      encoding: 'linear-unsigned-integer',
      outOfRangePolicy: 'clamp-to-range',
    },
    source: { sourceId },
  }

  // 防御：流水线产物必须自洽通过契约校验；若失败说明本模块与契约漂移，立即暴露而非落盘。
  const outcome = validateTerrainMeta(meta)
  if (!outcome.ok) {
    throw new DemBuildError(
      'dem-output.meta-contract',
      `流水线产出的元数据未通过契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}`,
    )
  }

  return { pixels, width: resolution.width, height: resolution.height, meta }
}

/**
 * 把 16 位高程图写入磁盘（小端 raw + 契约元数据 JSON）。
 * 字节布局：行主序、行 0 = 北、列 0 = 西、每像元 2 字节小端 uint16（.r16）。
 * 先在内存构造全部字节并复核契约，再一次性落盘，避免产生看似有效的半成品。
 *
 * outDir 不存在时按 recursive 创建（与 Python 路径 os.makedirs(out_dir, exist_ok=True) 对齐），
 * 保证两条生产路径在「--out 指向新目录」时的行为一致；创建发生在任何写盘之前，故仍无半成品。
 */
export function writeHeightmapAssets(result: HeightmapBuildResult, outDir: string, baseName: string): {
  readonly rasterPath: string
  readonly metaPath: string
} {
  // .r16 小端 uint16 字节流：显式用 DataView 写小端，跨平台一致。
  const bytes = new Uint8Array(result.pixels.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < result.pixels.length; i++) {
    view.setUint16(i * 2, result.pixels[i], true)
  }

  // 与 Python write_assets 对齐：目标目录不存在即创建，避免 --out 指向新目录时 ENOENT。
  mkdirSync(outDir, { recursive: true })
  const rasterPath = join(outDir, `${baseName}.r16`)
  const metaPath = join(outDir, `${baseName}.meta.json`)
  // 仅当元数据再次通过契约校验才写盘；任何异常都不应留下半边文件。
  const outcome = validateTerrainMeta(result.meta)
  if (!outcome.ok) {
    throw new DemBuildError(
      'dem-output.meta-contract',
      `拒绝写入：元数据未通过契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}`,
    )
  }
  writeFileSync(metaPath, `${JSON.stringify(result.meta, null, 2)}\n`, 'utf-8')
  writeFileSync(rasterPath, bytes)
  return { rasterPath, metaPath }
}

/**
 * 读取 .r16 小端 uint16 像素缓冲，供测试 / 资产校验复用同一解码路径。
 * 与 writeHeightmapAssets 严格互逆；长度必须等于 width*height*2。
 */
export function readHeightmapRaster(rasterPath: string, width: number, height: number): Uint16Array {
  const buffer = readFileSync(rasterPath)
  if (buffer.length !== width * height * 2) {
    throw new DemBuildError(
      'dem-output.raster-size',
      `${rasterPath} 字节长度 ${buffer.length} 与 ${width}x${height} 16 位栅格不符。`,
    )
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const pixels = new Uint16Array(width * height)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = view.getUint16(i * 2, true)
  }
  return pixels
}

/** 解析一个 DEM 夹具 JSON 文件为强类型输入。 */
export function readFixture(fixturePath: string): DemTileFixture {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as unknown
  return raw as DemTileFixture
}

/**
 * CLI 入口：tsx scripts/dem/build-heightmap.ts --input <fixture.json> --out <dir> --name <base>
 * 可选：--source-id <id>、--width <n>、--height <n>（覆盖目标分辨率；缺省即 PRODUCTION_RESOLUTION 4096²）。
 * 仅在作为脚本入口（而非被测试 import）时执行；被 import 时为静默模块。
 */
function main(): void {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    const value = args[i + 1]
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      opts[key.slice(2)] = value
      i++
    }
  }
  const inputPath = opts.input
  const outDir = opts.out ?? '.'
  const baseName = opts.name ?? 'china-heightmap'
  if (!inputPath || !existsSync(inputPath)) {
    console.error('用法：tsx scripts/dem/build-heightmap.ts --input <fixture.json> --out <dir> [--name <base>]')
    process.exit(2)
  }

  const input = readFixture(inputPath)
  const buildOptions: HeightmapBuildOptions = {}
  if (opts.width && opts.height) {
    buildOptions.targetResolution = { width: Number(opts.width), height: Number(opts.height) }
  }
  if (opts['source-id']) {
    buildOptions.sourceId = opts['source-id']
  }

  try {
    const result = buildHeightmap(input, buildOptions)
    const absoluteOut = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir)
    const written = writeHeightmapAssets(result, absoluteOut, baseName)
    const observed = observedElevationSummary(result)
    console.log('DEM heightmap 生成完成：')
    console.log(`  栅格：${written.rasterPath}（${result.width}x${result.height}，16 位小端）`)
    console.log(`  元数据：${written.metaPath}`)
    console.log(`  观测高程：最低 ${observed.minMeters.toFixed(1)}m / 最高 ${observed.maxMeters.toFixed(1)}m / 截断像元 ${observed.clampedCount}`)
    console.log(`  来源：${result.meta.source.sourceId}（详见数据来源注册表）`)
  } catch (cause) {
    const err = cause as DemBuildError
    console.error(`DEM 生成失败 [${err.code}]：${err.message}`)
    process.exit(1)
  }
}

/** 扫描像素缓冲统计观测高程（米）与被截断到下限的像元数，供 CLI 审计输出。 */
function observedElevationSummary(result: HeightmapBuildResult): {
  readonly minMeters: number
  readonly maxMeters: number
  readonly clampedCount: number
} {
  const { minValueMeters, maxValueMeters } = result.meta.elevationEncoding
  let minMeters = Infinity
  let maxMeters = -Infinity
  let clampedCount = 0
  for (let i = 0; i < result.pixels.length; i++) {
    const meters = decodeUint16ToElevation(result.pixels[i], minValueMeters, maxValueMeters)
    if (meters < minMeters) minMeters = meters
    if (meters > maxMeters) maxMeters = meters
    if (result.pixels[i] === 0) clampedCount++
  }
  return { minMeters, maxMeters, clampedCount }
}

// 仅在作为直接脚本入口时运行 CLI；被测试 import 时（argv[1] 指向 vitest 二进制）保持静默。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  main()
}
