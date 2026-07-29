/**
 * 省级边界资产生产编排：阿里 DataV.GeoAtlas 100000_full.json → 34 省目录 + 几何 + 来源审计。
 *
 * 依赖方向：属于离线资产生产层（scripts/provinces，tsx 运行），单向依赖 src/geo-contracts
 * 契约层与同目录的 province-catalog（34 省目录的 adcode 视图，派生自契约层规范目录）。
 * 严禁依赖浏览器 / React / Three.js 或任何运行时状态。本脚本只在「资产生产期」联网取数，
 * 产物落盘后运行时零外部网络依赖（SPEC §5：所有外部数据在构建期/脚本期处理为静态资产）。
 *
 * 几何修复边界（明确范围，避免越权）：
 * - 只做「格式转换 + 非省级要素过滤」：把 GeoJSON 的 [lon,lat] 数组改为契约命名字段
 *   {lon,lat}；把 adcode 命中 34 省目录的要素纳入资产，**忽略** 100000_JD（九段线）等
 *   非省级要素——九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦等国标完整性由项目政治边界
 *   补充资产（scripts/political）独立闭环。
 * - **不**做拓扑修复（自相交、缝隙、重叠）、**不**做简化或抽稀、**不**补充任何政治要素。
 *   DataV 已知缺陷（部分争议区画法非国标、不含九段线 / 南海岛礁）原样保留，由政治边界
 *   补充资产修正（SPEC §5.2 已知缺陷 → §5.3 项目内补全）。
 * - 环闭合：DataV 的环遵循 GeoJSON 惯例（首尾点重合），原样保留；资产级校验会断言所有环闭合。
 *
 * 非审图数据限制（SPEC §5.2、§8、§13）：
 * DataV.GeoAtlas 为非官方审图数据，资产来源声明（public/geo/data-sources.json 的
 * src-datav-provinces）与审计 sidecar（china-provinces.provenance.json）均标注 isOfficialSurvey=false
 * 与非空免责声明。公开发布前必须取得自然资源主管部门审图号。
 *
 * 可重复性：同一 DataV 快照多次重产得到逐字节一致的目录 / 几何 JSON（要素按 adcode 升序、
 * 坐标字段固定 lon→lat 顺序）。源快照以 SHA-256 写入 provenance.integrity.sourcePayloadSha256，
 * 便于审计「这份资产来自哪一次 DataV 拉取」。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validateAdministrativeDirectory,
  validateAdministrativeGeometry,
  validateContractBundle,
  type AdministrativeGeometry,
  type AdministrativeGeometryContract,
  type AdministrativeDirectoryContract,
  type AdministrativeRegionType,
  type DataSourceRegistryContract,
  type LonLatCoordinate,
} from '../../src/geo-contracts/index'
import {
  PROVINCE_CATALOG,
  type ProvinceCatalogEntry,
} from './province-catalog'

/**
 * DataV.GeoAtlas 省级边界（含港澳台）原始 GeoJSON 端点。
 * 仅用于离线生产期取数；运行时零外网依赖。areas_v3 为 DataV 当前主版本路径。
 */
const DATAV_FULL_BOUNDARY_URL =
  'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json'

/** 单次取数失败后的最大重试次数（含首次共 4 次尝试）。 */
const MAX_ATTEMPTS = 4

/** 指数退避基数（毫秒）。DataV 端点稳定，小退避覆盖偶发抖动即可。 */
const RETRY_BASE_MILLIS = 500

/** 元数据引用的来源标识，须在 public/geo/data-sources.json 中可解析。 */
const DEFAULT_SOURCE_ID = 'src-datav-provinces'

/** CLI 选项。 */
interface FetchCliOptions {
  outDir: string
  baseName: string
  sourceId: string
}

/** DataV GeoJSON 的 Position（[lon, lat] 二元数组）。 */
type GeoJsonPosition = [number, number]

/** DataV GeoJSON Polygon 的坐标：外环 + 内环（洞），每环为 Position 序列。 */
type GeoJsonPolygon = GeoJsonPosition[][]

interface DataVFeature {
  geometry:
    | { type: 'Polygon'; coordinates: GeoJsonPolygon }
    | { type: 'MultiPolygon'; coordinates: GeoJsonPolygon[] }
    | null
  properties: { adcode?: number | string; name?: string; level?: string } | null
}

interface DataVFeatureCollection {
  type: string
  features: DataVFeature[]
}

/** 休眠辅助，用于退避重试。 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 拉取 DataV 100000_full.json。单请求即可获得全国 34 省边界（含九段线要素），
 * 文档级大小（数百 KB）；带退避重试覆盖偶发网络抖动，耗尽重试仍失败则抛错（不写半成品资产）。
 */
async function fetchDataV(): Promise<{ payload: DataVFeatureCollection; rawText: string }> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(DATAV_FULL_BOUNDARY_URL)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} @ ${DATAV_FULL_BOUNDARY_URL}`)
      }
      const rawText = await response.text()
      const payload = JSON.parse(rawText) as DataVFeatureCollection
      if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
        throw new Error('DataV 返回非 FeatureCollection 或 features 非数组。')
      }
      return { payload, rawText }
    } catch (cause) {
      lastError = cause
      if (attempt < MAX_ATTEMPTS) {
        const backoff = RETRY_BASE_MILLIS * attempt
        process.stderr.write(`  第 ${attempt}/${MAX_ATTEMPTS} 次取数失败（${(cause as Error).message}），${backoff}ms 后重试\n`)
        await sleep(backoff)
      }
    }
  }
  throw new Error(`DataV 取数耗尽重试仍失败：${(lastError as Error)?.message ?? lastError}`)
}

/** 把 GeoJSON Position（[lon,lat]）转为契约命名字段 {lon,lat}，消除 0/1 位置歧义。 */
function toLonLat(position: GeoJsonPosition): LonLatCoordinate {
  const [lon, lat] = position
  return { lon, lat }
}

/** 把单环（Position 序列）转为契约环（LonLat 序列）。 */
function convertRing(ring: GeoJsonPosition[]): LonLatCoordinate[] {
  return ring.map(toLonLat)
}

/**
 * 把 DataV 要素的 GeoJSON 几何转为契约几何。
 * 保留源类型：单部 Polygon 仍为 Polygon（如内蒙古），多部 MultiPolygon 仍为 MultiPolygon
 * （如海南、台湾、香港等多岛 / 飞地行政区）。不抽稀、不简化、不拓扑修复。
 */
function convertGeometry(feature: DataVFeature): AdministrativeGeometry {
  const geom = feature.geometry
  if (geom === null) {
    throw new Error('DataV 要素几何为 null，无法转换为契约几何。')
  }
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map(convertRing)
    return { type: 'Polygon', rings }
  }
  // MultiPolygon：每个多边形独立拥有自己的环列表。
  const polygons = geom.coordinates.map((polygon) => ({
    rings: polygon.map(convertRing),
  }))
  return { type: 'MultiPolygon', polygons }
}

/**
 * 按 34 省目录对齐 DataV 要素，组装目录条目 + 几何条目（一一对应、按 adcode 升序）。
 *
 * 关键不变量（在写盘前确定性校验，任一不满足即整体失败、不留下半成品资产）：
 * - DataV 必须为目录中全部 34 个 adcode 提供几何；缺一个即失败（SPEC §2「省级 34 个」）。
 * - adcode 不在目录中的要素（如九段线 100000_JD）被忽略并记录，不进入省级资产。
 */
export interface AssembleResult {
  directoryEntries: { id: string; name: string; type: AdministrativeRegionType }[]
  geometryFeatures: { adminId: string; geometry: AdministrativeGeometry }[]
  skippedFeatures: { adcode: string; reason: string }[]
}

export function assembleFromDataV(
  collection: DataVFeatureCollection,
): AssembleResult {
  const byAdcode = new Map<number, DataVFeature>()
  const skipped: { adcode: string; reason: string }[] = []
  for (const feature of collection.features) {
    const raw = feature.properties?.adcode
    if (raw === undefined || raw === null) {
      skipped.push({ adcode: String(raw), reason: '缺 adcode 属性' })
      continue
    }
    const adcode = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
    if (!Number.isInteger(adcode)) {
      skipped.push({ adcode: String(raw), reason: 'adcode 非整数（如九段线 100000_JD）' })
      continue
    }
    if (byAdcode.has(adcode)) {
      skipped.push({ adcode: String(adcode), reason: 'adcode 重复出现，忽略后到要素' })
      continue
    }
    byAdcode.set(adcode, feature)
  }

  const directoryEntries: AssembleResult['directoryEntries'] = []
  const geometryFeatures: AssembleResult['geometryFeatures'] = []
  const missing: string[] = []

  // 按 catalog 顺序（adcode 升序）遍历，保证输出确定性。
  for (const entry of PROVINCE_CATALOG) {
    const feature = byAdcode.get(entry.adcode)
    if (feature === undefined) {
      missing.push(`${entry.id}(adcode ${entry.adcode} ${entry.name})`)
      continue
    }
    directoryEntries.push({ id: entry.id, name: entry.name, type: entry.type })
    geometryFeatures.push({ adminId: entry.id, geometry: convertGeometry(feature) })
  }

  if (missing.length > 0) {
    throw new Error(
      `DataV 缺少以下目录行政区，无法生产完整 34 省资产：${missing.join('、')}。` +
        '请确认 DataV 端点返回了完整省级边界（含港澳台）。',
    )
  }

  return { directoryEntries, geometryFeatures, skippedFeatures: skipped }
}

/** 计算几何资产完整性摘要，供 provenance 审计（数量、环数、坐标数、文件 SHA-256）。 */
function computeGeometryIntegritySummary(
  features: { adminId: string; geometry: AdministrativeGeometry }[],
): {
  featureCount: number
  polygonCount: number
  ringCount: number
  coordinateCount: number
  multiPolygonCount: number
  polygonOnlyCount: number
} {
  let polygonCount = 0
  let ringCount = 0
  let coordinateCount = 0
  let multiPolygonCount = 0
  let polygonOnlyCount = 0
  for (const f of features) {
    if (f.geometry.type === 'MultiPolygon') {
      multiPolygonCount++
      for (const polygon of f.geometry.polygons) {
        polygonCount++
        for (const ring of polygon.rings) {
          ringCount++
          coordinateCount += ring.length
        }
      }
    } else {
      polygonOnlyCount++
      // Polygon 的每个环视作一个多边形外/内环计入 ringCount，与 MultiPolygon 口径一致。
      for (const ring of f.geometry.rings) {
        polygonCount++
        ringCount++
        coordinateCount += ring.length
      }
    }
  }
  return {
    featureCount: features.length,
    polygonCount,
    ringCount,
    coordinateCount,
    multiPolygonCount,
    polygonOnlyCount,
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
  return {
    outDir: opts.out ?? '.',
    baseName: opts.name ?? 'china-provinces',
    sourceId: opts['source-id'] ?? DEFAULT_SOURCE_ID,
  }
}

/**
 * 写盘前对组装好的目录 / 几何做契约校验 + 跨契约引用核对。
 * 任一失败即抛错，保证不把不合规资产写入 public/。
 */
function assertContracts(
  directory: AdministrativeDirectoryContract,
  geometry: AdministrativeGeometryContract,
  sources: unknown,
  catalog: readonly ProvinceCatalogEntry[],
): void {
  const dirOutcome = validateAdministrativeDirectory(directory)
  if (!dirOutcome.ok) {
    throw new Error(
      '组装的行政区目录未通过契约校验，拒绝写盘：\n' +
        dirOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  const geoOutcome = validateAdministrativeGeometry(geometry)
  if (!geoOutcome.ok) {
    throw new Error(
      '组装的行政区几何未通过契约校验，拒绝写盘：\n' +
        geoOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  const bundleOutcome = validateContractBundle({
    sources: sources as DataSourceRegistryContract | undefined,
    administrativeDirectory: directory,
    administrativeGeometry: geometry,
  })
  if (!bundleOutcome.ok) {
    throw new Error(
      '组装的目录 / 几何 / 来源跨契约引用核对失败，拒绝写盘：\n' +
        bundleOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  // 目录与几何的条目集合必须与 34 省目录精确一致（写盘前的最后一道防御）。
  if (directory.entries.length !== catalog.length) {
    throw new Error(
      `目录条目数 ${directory.entries.length} ≠ 目录真值 ${catalog.length}，内部不一致。`,
    )
  }
  if (geometry.features.length !== catalog.length) {
    throw new Error(
      `几何条目数 ${geometry.features.length} ≠ 目录真值 ${catalog.length}，内部不一致。`,
    )
  }
}

/**
 * 入口：取数 → 按 catalog 对齐 → 契约自检 → 写目录 / 几何 / 审计 sidecar。
 * 任一阶段失败都在写盘前抛错；写盘前已通过契约校验，确保不产生半成品或不合规资产。
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(
    `DataV 省级边界资产生产：来源 ${options.sourceId}，端点 ${DATAV_FULL_BOUNDARY_URL}\n`,
  )

  const { payload, rawText } = await fetchDataV()
  const sourceSha256 = createHash('sha256').update(rawText, 'utf-8').digest('hex')
  process.stderr.write(`  DataV 要素数：${payload.features.length}（源快照 SHA-256 ${sourceSha256}）\n`)

  const assembled = assembleFromDataV(payload)
  for (const skip of assembled.skippedFeatures) {
    process.stderr.write(`  忽略非省级要素：adcode=${skip.adcode}（${skip.reason}）\n`)
  }

  const directory: AdministrativeDirectoryContract = {
    kind: 'administrative-directory',
    version: '1.0.0',
    entries: assembled.directoryEntries,
    source: { sourceId: options.sourceId },
  }
  const geometry: AdministrativeGeometryContract = {
    kind: 'administrative-geometry',
    version: '1.0.0',
    crs: 'EPSG:4326',
    features: assembled.geometryFeatures,
    source: { sourceId: options.sourceId },
  }

  // 来源注册表在 public/geo/data-sources.json，写盘前用它做跨契约引用核对。
  const sourcesPath = resolve(options.outDir === '.' ? process.cwd() : options.outDir, 'data-sources.json')
  // 仅当来源注册表与输出同目录时才纳入核对；否则跳过（生产脚本默认同目录）。
  let sources: unknown = undefined
  try {
    // 动态读取避免在 import 期硬编码路径；读不到时 sources 保持 undefined，由目录/几何自校验兜底。
    const { readFileSync } = await import('node:fs')
    sources = JSON.parse(readFileSync(sourcesPath, 'utf-8'))
  } catch {
    process.stderr.write(`  未在 ${sourcesPath} 找到来源注册表，跳过 sourceId 解析核对（请确认已在 public/geo/data-sources.json 登记 ${options.sourceId}）。\n`)
  }
  assertContracts(directory, geometry, sources, PROVINCE_CATALOG)

  const absoluteOut = isAbsolute(options.outDir) ? options.outDir : resolve(process.cwd(), options.outDir)
  mkdirSync(absoluteOut, { recursive: true })

  const directoryPath = resolve(absoluteOut, `${options.baseName}-directory.json`)
  const geometryPath = resolve(absoluteOut, `${options.baseName}-geometry.json`)
  // 字段顺序固定（目录：kind→version→entries→source；几何：kind→version→crs→features→source），
  // 配合要素按 adcode 升序，使同一源快照重产得到逐字节一致输出。
  const directoryJson = `${JSON.stringify(directory, null, 2)}\n`
  const geometryJson = `${JSON.stringify(geometry, null, 2)}\n`
  writeFileSync(directoryPath, directoryJson, 'utf-8')
  writeFileSync(geometryPath, geometryJson, 'utf-8')

  const integrity = computeGeometryIntegritySummary(assembled.geometryFeatures)
  const provenance = {
    kind: 'provinces-asset-provenance',
    assetDirectory: `${options.baseName}-directory.json`,
    assetGeometry: `${options.baseName}-geometry.json`,
    source: {
      sourceId: options.sourceId,
      dataset: '阿里 DataV.GeoAtlas 省级边界（100000_full.json）',
      accessEndpoint: DATAV_FULL_BOUNDARY_URL,
      note: '含省、自治区、直辖市、港澳特别行政区与台湾省；DataV 把九段线作为独立要素（100000_JD）随省级边界一并下发，本生产流程将其过滤，仅保留 34 省目录命中的行政区。',
    },
    generation: {
      pipeline: 'scripts/provinces/fetch-datav-provinces.ts',
      catalog: 'scripts/provinces/province-catalog.ts（34 省目录 adcode 视图，派生自契约层 CHINA_ADMINISTRATIVE_DIRECTORY）',
      processingParams: {
        geometryConversion: 'GeoJSON [lon,lat] → 契约 {lon,lat} 命名字段，类型保留（Polygon / MultiPolygon）',
        topologyRepair: 'none（不做拓扑修复 / 抽稀 / 政治要素补充；九段线 / 南海岛礁 / 争议区由 scripts/political 政治边界补充资产独立闭环）',
        ringClosure: '保留 DataV 原始闭合环（首尾点重合）',
      },
      producedAt: new Date().toISOString(),
      producedBy: 'TASK-004',
    },
    integrity: {
      sourcePayloadSha256: sourceSha256,
      directorySha256: createHash('sha256').update(directoryJson, 'utf-8').digest('hex'),
      geometrySha256: createHash('sha256').update(geometryJson, 'utf-8').digest('hex'),
      ...integrity,
    },
    disclaimer:
      '本资产源自阿里 DataV.GeoAtlas 省级边界（非官方审图数据），不含九段线 / 南海岛礁，' +
      '部分争议区画法非国标；仅供内部展示，不得作为正式出版 / 发布用途，公开发布前须取得自然资源主管部门审图号。',
  }
  const provenancePath = resolve(absoluteOut, `${options.baseName}.provenance.json`)
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf-8')

  process.stdout.write('DataV 省级边界资产生产完成：\n')
  process.stdout.write(`  目录：${directoryPath}（${directory.entries.length} 个省级行政区）\n`)
  process.stdout.write(`  几何：${geometryPath}（${integrity.featureCount} 要素 / ${integrity.polygonCount} 多边形 / ${integrity.ringCount} 环 / ${integrity.coordinateCount} 坐标）\n`)
  process.stdout.write(`  审计：${provenancePath}\n`)
  process.stdout.write(`  源快照 SHA-256：${sourceSha256}\n`)
}

// 仅在作为直接脚本入口时运行；被 import 时保持静默（便于复用内部函数做测试）。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  main().catch((cause: unknown) => {
    const err = cause as Error
    console.error(`DataV 省级边界资产生产失败：${err?.message ?? cause}`)
    process.exit(1)
  })
}
