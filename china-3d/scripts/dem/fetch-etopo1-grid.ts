/**
 * 高程资产生产编排：NOAA ETOPO1（经 Open Topo Data 取数）→ 4096² 16 位 heightmap + 元数据 + 来源审计。
 *
 * 依赖方向：属于离线资产生产层（scripts/dem，tsx 运行），单向依赖 src/geo-contracts 契约层
 * 与同目录的 build-heightmap（可测试核心）/ mercator 投影原语。
 * 严禁依赖浏览器、React、Three.js 或任何运行时状态。
 *
 * 为什么用 ETOPO1 而非 SPEC 字面提到的 Copernicus DEM GLO-30（可逆决策，已记录于 provenance 与 README）：
 * - 本 TASK 的资产级校验要求「海域包含负高程 / 浅水负高程保留」（SPEC §3.5 / §5.1）。
 * - Copernicus DEM GLO-30 是数字表面模型，开阔海域为 0 或无效值，**不含海洋水深**，
 *   无法提供校验所需的负高程海域样本。
 * - NOAA ETOPO1 是公开的全球地形 + 水深一体化栅格（1 弧分），同时具备真实陆地高程与海洋水深，
 *   可一次性满足「青藏高原高于东部平原 / 盆地低于周边山地 / 海域含负高程」全部地势抽样不变量。
 * - 取数通过公开的 Open Topo Data etopo1 端点（按经纬度点查询），无需凭据；ETOPO1 原始栅格托管于
 *   NOAA NCEI（公共领域数据）。来源、版本与免责声明在 .provenance.json 审计 sidecar 中完整记录，
 *   与元数据 sourceId 互相印证，资产来源可审计。
 * - 该决策可逆：build-heightmap 流水线对输入 DEM 源中立，将来若接入含正式水深的更高分辨率源，
 *   重跑本脚本即可产出同一外部契约的资产。
 *
 * 可重复性：
 * - 本脚本负责「源数据获取」：按目标范围在规则经纬度网格上抽样 ETOPO1，组装成 dem-tile-fixture-v1
 *   （build-heightmap 流水线的既定输入格式），再调用 buildHeightmap 完成 EPSG:4326→EPSG:3857
 *   重投影、双线性重采样到 4096²、16 位线性编码与元数据导出。
 * - 抽样网格是「源数据缓存」，**不作为产品资产提交**（仅本脚本运行期在内存中存在；可用
 *   --cache-grid 写入 gitignored 路径以便断点续跑，但该文件不进版本库）。
 * - 产品资产仅三件：china-heightmap-4096.r16 + .meta.json + .provenance.json，全部落盘到 --out。
 *
 * 编码唯一源仍是 src/geo-contracts/terrain.ts 的 encodeElevationToUint16（由 buildHeightmap 调用），
 * 本脚本不另写编码公式；浅水负高程保留、深海截断到下限的语义由该唯一编码源保证。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PRODUCTION_ELEVATION_RANGE,
  PRODUCTION_RESOLUTION,
  PRODUCTION_TARGET_EXTENT,
  buildHeightmap,
  writeHeightmapAssets,
  type DemTileFixture,
  type HeightmapBuildResult,
} from './build-heightmap'
import { decodeUint16ToElevation } from '../../src/geo-contracts/index'

/**
 * Open Topo Data 公开 etopo1 端点。仅用于离线生产期取数；运行时零外网依赖。
 * 端点文档：GET /v1/etopo1?locations=lat1,lon1|lat2,lon2|...，每次至多 100 个点，结果顺序与入参一致。
 */
const OPEN_TOPO_DATA_ETOPO1_ENDPOINT = 'https://api.opentopodata.org/v1/etopo1'

/** 每次请求的最大点数（Open Topo Data 上限 100）。 */
const API_BATCH_SIZE = 100

/** 请求间隔（毫秒）。Open Topo Data 演示端点建议 ≤1 RPS，留出余量避免触发限流。 */
const API_PACE_MILLIS = 1100

/** 单批失败后的最大重试次数（含首次共 4 次尝试），覆盖偶发网络抖动与瞬时限流。 */
const API_MAX_ATTEMPTS = 4

/** 默认抽样分辨率（度）。0.5° 在中国主图给出 128×102 源栅格，足以分辨高原/盆地/平原/海的相对关系。 */
const DEFAULT_GRID_RESOLUTION_DEGREES = 0.5

/** 元数据引用的来源标识，与 provenance sidecar 的 source.sourceId 互相印证。 */
const DEFAULT_SOURCE_ID = 'src-etopo1-noaa'

/** CLI 选项。 */
interface FetchCliOptions {
  outDir: string
  baseName: string
  sourceId: string
  resolutionDegrees: number
  width: number
  height: number
  cacheGridPath: string | null
}

/**
 * 规则经纬度网格的像素中心点。
 * 行 0 = 北（max lat）、列 0 = 西（min lon），与 dem-tile-fixture-v1 的栅格约定一致。
 */
interface GridPoints {
  readonly width: number
  readonly height: number
  /** 行主序、行 0 = 北的像素中心纬度序列，长度 = width*height。 */
  readonly lats: number[]
  /** 与 lats 同序的像素中心经度序列。 */
  readonly lons: number[]
}

/**
 * 按目标范围与抽样分辨率构造像素中心网格。
 * 像素中心位于 (col+0.5, row+0.5) 处，确保整张网格的像素都落在目标范围内部，
 * 与 buildHeightmap 的源栅格采样语义（像元中心在 col+0.5）一致。
 */
function buildGridPoints(
  extent: { west: number; south: number; east: number; north: number },
  resolutionDegrees: number,
): GridPoints {
  const lonSpan = extent.east - extent.west
  const latSpan = extent.north - extent.south
  const width = Math.round(lonSpan / resolutionDegrees)
  const height = Math.round(latSpan / resolutionDegrees)
  if (width <= 0 || height <= 0) {
    throw new Error(
      `分辨率 ${resolutionDegrees}° 对范围 [${extent.west},${extent.south},${extent.east},${extent.north}] 产生的网格尺寸非正：${width}x${height}。`,
    )
  }
  const lats: number[] = []
  const lons: number[] = []
  for (let row = 0; row < height; row++) {
    // 行 0 = 北：纬度从 north 向南递减。
    const lat = extent.north - (row + 0.5) * resolutionDegrees
    for (let col = 0; col < width; col++) {
      const lon = extent.west + (col + 0.5) * resolutionDegrees
      lats.push(lat)
      lons.push(lon)
    }
  }
  return { width, height, lats, lons }
}

/** 休眠辅助，用于请求节流。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 单次 GET 取数：把至多 100 个 (lat,lon) 点拼成 locations 查询参数，解析 JSON 结果。
 * 结果顺序与入参一致；返回与入参等长的 elevation 数组（缺失/异常以 NaN 占位，由上层重试处理）。
 */
async function fetchBatch(lats: number[], lons: number[]): Promise<number[]> {
  const locations = lats.map((lat, i) => `${lat},${lons[i]}`).join('|')
  const url = `${OPEN_TOPO_DATA_ETOPO1_ENDPOINT}?locations=${locations}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} @ ${url}`)
  }
  const payload = (await response.json()) as {
    status?: string
    results?: Array<{ elevation: number | null } | null>
  }
  if (payload.status !== 'OK' || !Array.isArray(payload.results)) {
    throw new Error(`端点返回非 OK 状态：${JSON.stringify(payload).slice(0, 200)}`)
  }
  if (payload.results.length !== lats.length) {
    throw new Error(
      `端点返回结果数 ${payload.results.length} 与请求点数 ${lats.length} 不符。`,
    )
  }
  return payload.results.map((entry) => {
    if (entry === null || entry.elevation === null) return Number.NaN
    return entry.elevation
  })
}

/**
 * 对单个分片做带退避的重试取数。
 * 任一分片在耗尽重试仍失败时抛错——由上层在写盘前整体失败，确保不留下看似有效的半成品资产。
 */
async function fetchBatchWithRetry(lats: number[], lons: number[]): Promise<number[]> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchBatch(lats, lons)
    } catch (cause) {
      lastError = cause
      // 指数退避：1s、2s、4s，叠加固定节流间隔。
      const backoff = API_PACE_MILLIS * attempt
      process.stderr.write(
        `    第 ${attempt}/${API_MAX_ATTEMPTS} 次取数失败（${(cause as Error).message}），${backoff}ms 后重试\n`,
      )
      await sleep(backoff)
    }
  }
  throw new Error(`分片取数耗尽重试仍失败：${(lastError as Error)?.message ?? lastError}`)
}

/**
 * 全网格分片取数。按 API_BATCH_SIZE 切片，逐片节流取数，并把每片结果回填到与网格同序的数组。
 * 进度写入 stderr，便于长跑观察；返回行主序、行 0 = 北的高程序列。
 */
async function fetchGridElevations(grid: GridPoints): Promise<number[]> {
  const total = grid.lats.length
  const elevations: number[] = new Array(total)
  for (let start = 0; start < total; start += API_BATCH_SIZE) {
    const end = Math.min(start + API_BATCH_SIZE, total)
    const batchLats = grid.lats.slice(start, end)
    const batchLons = grid.lons.slice(start, end)
    const batchIndex = Math.floor(start / API_BATCH_SIZE) + 1
    const batchCount = Math.ceil(total / API_BATCH_SIZE)
    process.stderr.write(`  取数 ${batchIndex}/${batchCount}（点 ${start + 1}-${end}/${total}）...\n`)
    const partial = await fetchBatchWithRetry(batchLats, batchLons)
    for (let i = 0; i < partial.length; i++) {
      elevations[start + i] = partial[i]
    }
    // 节流：除非已是最后一片，否则等待固定间隔后再发下一片。
    if (end < total) {
      await sleep(API_PACE_MILLIS)
    }
  }
  // 全网格取完后，若有 NaN（个别点端点返回 null），整体失败——不猜测填充，保证源栅格真实可审计。
  if (elevations.some((v) => !Number.isFinite(v))) {
    throw new Error('ETOPO1 取数含空值（端点对个别点返回 null），拒绝以猜测值填充源栅格。')
  }
  return elevations
}

/** 把规则网格组装成 dem-tile-fixture-v1（build-heightmap 流水线的既定输入格式）。 */
function assembleFixture(
  extent: { west: number; south: number; east: number; north: number },
  grid: GridPoints,
  elevations: number[],
): DemTileFixture {
  return {
    format: 'dem-tile-fixture-v1',
    crs: 'EPSG:4326',
    bounds: { west: extent.west, south: extent.south, east: extent.east, north: extent.north },
    width: grid.width,
    height: grid.height,
    // dem-tile-fixture-v1 不使用 nodata（取数阶段已确保无空值），置 null 表示无 nodata 掩码。
    nodata: null,
    values: elevations,
  }
}

/**
 * 计算资产完整性摘要，供 .provenance.json 审计。
 * 摘要均为可由资产本身复算的统计量（不依赖外部魔法常量），便于审计与回归比对。
 */
function computeIntegritySummary(
  result: HeightmapBuildResult,
  rasterBytes: Uint8Array,
): {
  readonly rasterBytes: number
  readonly sha256: string
  readonly distinctCodes: number
  readonly observedMinMeters: number
  readonly observedMaxMeters: number
  readonly clampedToMinCount: number
} {
  const { minValueMeters, maxValueMeters } = result.meta.elevationEncoding
  let minMeters = Infinity
  let maxMeters = -Infinity
  let clamped = 0
  const distinct = new Set<number>()
  for (let i = 0; i < result.pixels.length; i++) {
    const code = result.pixels[i]
    distinct.add(code)
    if (code === 0) clamped++
    const meters = decodeUint16ToElevation(code, minValueMeters, maxValueMeters)
    if (meters < minMeters) minMeters = meters
    if (meters > maxMeters) maxMeters = meters
  }
  return {
    rasterBytes: rasterBytes.length,
    sha256: createHash('sha256').update(rasterBytes).digest('hex'),
    distinctCodes: distinct.size,
    observedMinMeters: minMeters,
    observedMaxMeters: maxMeters,
    clampedToMinCount: clamped,
  }
}

/** 解析 CLI 参数。 */
function parseArgs(argv: string[]): FetchCliOptions {
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      opts[key.slice(2)] = value
      i++
    }
  }
  const outDir = opts.out ?? '.'
  const baseName = opts.name ?? 'china-heightmap-4096'
  const sourceId = opts['source-id'] ?? DEFAULT_SOURCE_ID
  const resolutionDegrees = Number(opts['resolution-degrees'] ?? DEFAULT_GRID_RESOLUTION_DEGREES)
  const width = Number(opts.width ?? PRODUCTION_RESOLUTION.width)
  const height = Number(opts.height ?? PRODUCTION_RESOLUTION.height)
  const cacheGridPath = opts['cache-grid'] ?? null
  if (!Number.isFinite(resolutionDegrees) || resolutionDegrees <= 0) {
    throw new Error(`--resolution-degrees 必须为正数，实际为 ${opts['resolution-degrees']}。`)
  }
  return { outDir, baseName, sourceId, resolutionDegrees, width, height, cacheGridPath }
}

/**
 * 入口：取数 → 组装 fixture → buildHeightmap → 写资产 + 审计。
 * 任一阶段失败都在写盘前抛错（writeHeightmapAssets 内部亦二次校验元数据契约），不产生半成品。
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const extent = PRODUCTION_TARGET_EXTENT
  process.stderr.write(
    `ETOPO1 高程资产生产：范围 [${extent.west},${extent.south},${extent.east},${extent.north}]，` +
      `抽样 ${options.resolutionDegrees}°，目标 ${options.width}x${options.height}，来源 ${options.sourceId}\n`,
  )

  const grid = buildGridPoints(extent, options.resolutionDegrees)
  process.stderr.write(`  源栅格 ${grid.width}x${grid.height} = ${grid.lats.length} 个像元\n`)

  // 源栅格缓存（可选）：若 --cache-grid 指向已存在文件则直接读取，跳过取数；否则取数后写入该路径。
  // 该缓存仅用于断点续跑，必须位于 gitignored 路径，不作为产品资产提交。
  let elevations: number[]
  if (options.cacheGridPath && existsSync(options.cacheGridPath)) {
    process.stderr.write(`  命中源栅格缓存：${options.cacheGridPath}，跳过取数\n`)
    const cached = JSON.parse(readFileSync(options.cacheGridPath, 'utf-8')) as {
      values: number[]
    }
    if (!Array.isArray(cached.values) || cached.values.length !== grid.lats.length) {
      throw new Error('源栅格缓存与当前网格尺寸不符，请删除缓存后重跑。')
    }
    elevations = cached.values
  } else {
    elevations = await fetchGridElevations(grid)
    if (options.cacheGridPath) {
      mkdirSync(resolve(options.cacheGridPath, '..'), { recursive: true })
      writeFileSync(
        options.cacheGridPath,
        JSON.stringify({ width: grid.width, height: grid.height, values: elevations }),
      )
      process.stderr.write(`  源栅格缓存已写入：${options.cacheGridPath}（gitignored，非产品资产）\n`)
    }
  }

  const fixture = assembleFixture(extent, grid, elevations)
  const result = buildHeightmap(fixture, {
    targetExtent: extent,
    targetResolution: { width: options.width, height: options.height },
    elevationRange: PRODUCTION_ELEVATION_RANGE,
    sourceId: options.sourceId,
  })

  const absoluteOut = isAbsolute(options.outDir)
    ? options.outDir
    : resolve(process.cwd(), options.outDir)
  // writeHeightmapAssets 返回栅格与元数据落盘路径，并内部校验元数据契约。
  const written = writeHeightmapAssets(result, absoluteOut, options.baseName)
  const rasterBytes = readFileSync(written.rasterPath)
  const integrity = computeIntegritySummary(result, rasterBytes)

  // 审计 sidecar：记录来源、生成参数、时间与完整性摘要。非契约 kind，仅作可审计文档；
  // 深度校验（scripts/verify-assets/terrain-deep.ts）逐项复算 integrity 并核对 sourceId 一致。
  const provenance = {
    kind: 'terrain-asset-provenance',
    assetRaster: `${options.baseName}.r16`,
    assetMeta: `${options.baseName}.meta.json`,
    source: {
      sourceId: options.sourceId,
      dataset: 'NOAA ETOPO1 Ice Surface 1-arc-minute global relief',
      accessEndpoint: OPEN_TOPO_DATA_ETOPO1_ENDPOINT,
      note: '经 Open Topo Data 公开端点按规则经纬度网格抽样；ETOPO1 含陆地高程与海洋水深。',
    },
    generation: {
      pipeline: 'scripts/dem/fetch-etopo1-grid.ts -> scripts/dem/build-heightmap.ts',
      sourceGridResolutionDegrees: options.resolutionDegrees,
      sourceGridSize: { width: grid.width, height: grid.height },
      targetExtent: { west: extent.west, south: extent.south, east: extent.east, north: extent.north },
      targetResolution: { width: options.width, height: options.height },
      elevationRange: { ...PRODUCTION_ELEVATION_RANGE },
      crs: 'EPSG:3857',
      producedAt: new Date().toISOString(),
      producedBy: 'TASK-003',
    },
    integrity,
    disclaimer:
      '本资产源自 NOAA ETOPO1（公开科学地形数据集，含海洋水深），经粗分辨率抽样后重采样到 4096²，' +
      '非中国官方审图数据；仅供内部展示，公开发布前须取得自然资源主管部门审图号。',
  }
  const provenancePath = `${written.rasterPath.slice(0, -'.r16'.length)}.provenance.json`
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf-8')

  process.stdout.write('ETOPO1 高程资产生产完成：\n')
  process.stdout.write(`  栅格：${written.rasterPath}（${result.width}x${result.height}，16 位小端）\n`)
  process.stdout.write(`  元数据：${written.metaPath}\n`)
  process.stdout.write(`  审计：${provenancePath}\n`)
  process.stdout.write(
    `  观测高程：最低 ${integrity.observedMinMeters.toFixed(1)}m / 最高 ${integrity.observedMaxMeters.toFixed(1)}m / ` +
      `截断到下限像元 ${integrity.clampedToMinCount} / 不同编码数 ${integrity.distinctCodes}\n`,
  )
  process.stdout.write(`  SHA-256：${integrity.sha256}\n`)
}

// 仅在作为直接脚本入口时运行；被 import 时保持静默（便于复用内部函数做测试）。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  main().catch((cause: unknown) => {
    const err = cause as Error
    console.error(`ETOPO1 高程资产生产失败：${err?.message ?? cause}`)
    process.exit(1)
  })
}
