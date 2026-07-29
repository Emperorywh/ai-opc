/**
 * 资产契约校验 CLI（pnpm verify:assets）。
 *
 * TASK-003 接入 terrain scope：校验 public/terrain 下的生产高程资产（4096² 16 位 heightmap
 * + terrain-meta 元数据 + provenance 审计 sidecar），含位深/尺寸/编码/地势抽样/审计完整性的
 * 深度不变量。TASK-004 接入 geo scopes：sources（生产来源注册表）、provinces（DataV 省级边界
 * 目录 + 几何）、places（省名锚点 + 省级行政中心目录）、political（九段线十段画法 / 岛礁 /
 * 争议区补充资产，SPEC §6 红线），并在 --scope all 末尾追加一次全量生产资产的跨契约引用核对。
 * TASK-005 接入 fonts scope：校验 public/fonts 下的 CJK 标签字体子集（清单结构 + 字符覆盖 +
 * SFNT/cmap 字形映射 + 体积上限 + 完整性锚点，SPEC §3.7）。
 * 后续 TASK 新增生产资产时，在 SCOPE_REGISTRY 追加对应 scope 即可，无需新建第二条校验管线
 * （避免重复契约/双轨入口）。
 *
 * 依赖方向：本脚本属于离线资产生产/校验层（scripts/，devDependency tsx 运行），
 * 只单向依赖 src/geo-contracts 契约层与同层 scripts/dem、scripts/verify-assets 模块；
 * 不进入浏览器运行时包，不被 vite 打包，pnpm build / pnpm lint / pnpm test 均不触发它。
 *
 * 退出码（输出确定性文本，便于 CI 与人工定位）：
 * - 0：全部 scope 通过。
 * - 1：任一 scope 出现校验失败（不变量被违反）。
 * - 2：参数错误。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readContractKind,
  validateContractByKind,
  validateContractBundle,
  type ContractBundle,
} from '../../src/geo-contracts/index'
import { verifyTerrainAsset } from './terrain-deep'
import { verifyProvincesAsset } from './provinces-deep'
import { verifyPlacesAsset } from './places-deep'
import { verifyPoliticalAsset } from './political-deep'
import { LABEL_FONT_MAX_BYTES, verifyLabelFontAsset } from './fonts-deep'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** 单个 scope 的描述：标签 + 自定义校验函数（返回失败计数）。 */
interface ScopeDescriptor {
  readonly label: string
  readonly customVerify: () => number
}

/** 生产高程资产路径（相对项目根）。terrain scope 校验这套生产资产。 */
const PRODUCTION_TERRAIN = {
  meta: 'public/terrain/china-heightmap-4096.meta.json',
  raster: 'public/terrain/china-heightmap-4096.r16',
  provenance: 'public/terrain/china-heightmap-4096.provenance.json',
} as const

/** 生产来源注册表路径（相对项目根）。sources scope 与全部 geo scope 都读取它。 */
const PRODUCTION_SOURCES = 'public/geo/data-sources.json'

/**
 * 生产省级边界资产路径（相对项目根）。provinces scope 校验这套生产资产。
 * 目录与几何拆为两个 kind 各自的文件（目录小而快、几何大而独立加载），二者经深度校验构成一一对应。
 */
const PRODUCTION_PROVINCES = {
  directory: 'public/geo/china-provinces-directory.json',
  geometry: 'public/geo/china-provinces-geometry.json',
  provenance: 'public/geo/china-provinces.provenance.json',
} as const

/**
 * 生产地点目录资产路径（相对项目根）。places scope 校验这套生产资产。
 * 地点目录同时承载省名锚点与省级行政中心（34 省 × 2 角色 = 68 条），并复用省级几何做
 * point-in-polygon 包含校验。
 */
const PRODUCTION_PLACES = {
  places: 'public/geo/china-places.json',
  provenance: 'public/geo/china-places.provenance.json',
} as const

/**
 * 政治边界补充资产路径（相对项目根）。political scope 校验这套生产资产（SPEC §6 红线）。
 * 九段线（十段画法，含台湾东侧段）+ 点名岛礁 + 争议区修正，全部为项目维护的非官方审图数据
 * （docs/political-review-record.md）。
 */
const PRODUCTION_POLITICAL = {
  political: 'public/geo/china-political-boundary.json',
  provenance: 'public/geo/china-political-boundary.provenance.json',
} as const

/**
 * 标签字体子集资产路径（相对项目根）。fonts scope 校验这套生产资产（SPEC §3.7）。
 * 字体二进制（占位字形，KB 级）+ 字符清单 + 审计 sidecar；字符来源为 places / political
 * 生产契约与页面静态文案（src/lib/static-copy.ts）。
 */
const PRODUCTION_FONTS = {
  font: 'public/fonts/china-labels-font.subset.ttf',
  manifest: 'public/fonts/china-labels-font.manifest.json',
  provenance: 'public/fonts/china-labels-font.provenance.json',
} as const

/** Scope 注册表。后续 TASK 新增生产资产时在此追加 scope。 */
const SCOPE_REGISTRY: Record<string, ScopeDescriptor> = {
  sources: {
    label: '生产数据来源注册表（结构契约 + 非官方审图免责声明红线）',
    customVerify: verifyProductionSources,
  },
  terrain: {
    label: '生产高程资产（深度校验：位深/尺寸/编码/地势抽样/审计完整性）',
    customVerify: verifyProductionTerrain,
  },
  provinces: {
    label: '生产省级边界资产（深度校验：34 省/港澳台/目录-几何双射/真值一致/环闭合/坐标范围/来源/审计）',
    customVerify: verifyProductionProvinces,
  },
  places: {
    label: '生产地点目录资产（深度校验：68 条/34 省×2 角色/港澳台/真值一致/坐标范围/省域包含/来源/审计）',
    customVerify: verifyProductionPlaces,
  },
  political: {
    label: '政治边界补充资产（深度校验：十段线/台湾东侧段/点名岛礁/点名争议区/坐标范围/非官方审图来源/审计）',
    customVerify: verifyProductionPolitical,
  },
  fonts: {
    label: '标签字体子集资产（深度校验：清单结构/字符全覆盖/SFNT-cmap 字形映射/体积上限/完整性锚点）',
    customVerify: verifyProductionFonts,
  },
}

/** 解析命令行参数，返回需要执行的 scope 名数组。 */
function parseArgs(argv: readonly string[]): string[] {
  const scopes: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    // pnpm 透传 `pnpm verify:assets -- --scope x` 时可能把裸 `--` 也带入 argv，忽略它。
    if (flag === '--') {
      continue
    }
    if (flag === '--scope') {
      const next = argv[i + 1]
      if (!next) {
        throw new Error('--scope 需要一个参数，取值为：all, ' + Object.keys(SCOPE_REGISTRY).join(', '))
      }
      scopes.push(next)
      i++
    } else if (flag === '--help' || flag === '-h') {
      process.stdout.write(
        [
          '用法：pnpm verify:assets -- --scope <name>',
          '',
          '可选 scope：all, ' + Object.keys(SCOPE_REGISTRY).join(', '),
          '未提供 --scope 时等价于 --scope all。',
          '',
          '退出码：0=全部通过；1=存在校验失败；2=参数错误。',
          '',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      throw new Error(`未知参数：${flag}（仅支持 --scope <name>）`)
    }
  }
  if (scopes.length === 0) scopes.push('all')
  return scopes
}

/** 读取并解析 JSON 文件，失败时抛出带路径的可定位错误。 */
function readJsonFile(relativePath: string): unknown {
  const absolute = resolve(projectRoot, relativePath)
  try {
    return JSON.parse(readFileSync(absolute, 'utf-8')) as unknown
  } catch (cause) {
    throw new Error(`无法读取或解析 JSON：${relativePath}（绝对路径：${absolute}）`, { cause })
  }
}

/** 读取 JSON 文件的原始文本（与落盘字节同源），供 SHA-256 防篡改锚点复算。 */
function readJsonText(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf-8')
}

/**
 * 读取 .r16 裸字节并解码为小端 uint16 像素数组，同时回传原始字节。
 * 故意不按元数据 width/height 截断——把「实际像元数」原样交给 verifyTerrainAsset，
 * 让「栅格尺寸与元数据一致」这条不变量在 CLI 路径也能被真正检查（而非恒真）。
 * 原始字节（bytes）与 .r16 落盘字节同源，供 verifyTerrainAsset 复算 SHA-256 防篡改锚点。
 */
function readRasterPixelsLittleEndian(relativePath: string): { bytes: Uint8Array; pixels: Uint16Array } {
  const absolute = resolve(projectRoot, relativePath)
  const bytes = readFileSync(absolute)
  if (bytes.length % 2 !== 0) {
    throw new Error(`栅格字节长度 ${bytes.length} 非偶数，无法按 uint16 解码：${relativePath}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const pixels = new Uint16Array(bytes.length / 2)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = view.getUint16(i * 2, true)
  }
  return { bytes, pixels }
}

/**
 * 生产来源注册表校验（sources scope）。
 * 结构契约校验（kind 分发 → validateDataSourceRegistry），并逐项打印登记来源，
 * 便于人工确认「每个资产引用的 sourceId 都有登记且带免责声明」。
 */
function verifyProductionSources(): number {
  console.log('▶ 校验 scope：sources（生产数据来源注册表）')
  let failures = 0
  let registry: unknown
  try {
    registry = readJsonFile(PRODUCTION_SOURCES)
  } catch (cause) {
    failures++
    console.error(`  ✗ 生产来源注册表读取失败：${(cause as Error).message}`)
    return failures
  }

  const actualKind = readContractKind(registry)
  if (actualKind !== 'data-source-registry') {
    failures++
    console.error(`  ✗ ${PRODUCTION_SOURCES}：期望 kind=data-source-registry，实际为 ${String(actualKind)}`)
    return failures
  }
  const outcome = validateContractByKind(registry)
  if (!outcome.ok) {
    failures++
    console.error(`  ✗ ${PRODUCTION_SOURCES}`)
    for (const err of outcome.errors) {
      console.error(`      [${err.code}] ${err.path}: ${err.message}`)
    }
    return failures
  }

  const sources = (registry as { sources: Array<{ id: string; name: string; isOfficialSurvey: boolean }> }).sources
  console.log(`  ✓ ${PRODUCTION_SOURCES}（${sources.length} 份来源声明 · 注册表契约通过）`)
  for (const source of sources) {
    console.log(`  · ${source.id}：${source.name}（isOfficialSurvey=${source.isOfficialSurvey}）`)
  }
  return failures
}

/**
 * 生产高程资产深度校验（TASK-003 terrain scope）。
 * 加载元数据、栅格与审计 sidecar，调用 verifyTerrainAsset 一次性给出
 * 位深/尺寸/编码/地势抽样/审计完整性的全部结论，并打印抽样摘要便于人工读图。
 */
function verifyProductionTerrain(): number {
  console.log('▶ 校验 scope：terrain（生产高程资产 · 深度校验）')
  let failures = 0
  let meta: unknown
  let pixels: Uint16Array
  let rasterBytes: Uint8Array
  let width = 0
  let height = 0
  let provenance: unknown = undefined
  try {
    meta = readJsonFile(PRODUCTION_TERRAIN.meta)
    const raster = readRasterPixelsLittleEndian(PRODUCTION_TERRAIN.raster)
    pixels = raster.pixels
    rasterBytes = raster.bytes
    const resolution = (meta as { resolution?: { widthPixels?: number; heightPixels?: number } }).resolution
    width = resolution?.widthPixels ?? 0
    height = resolution?.heightPixels ?? 0
    provenance = readJsonFile(PRODUCTION_TERRAIN.provenance)
  } catch (cause) {
    failures++
    console.error(`  ✗ 生产高程资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyTerrainAsset({
    meta,
    pixels,
    width,
    height,
    provenance,
    rasterBytes,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_TERRAIN.meta}（元数据契约通过）`)
    console.log(`  ✓ ${PRODUCTION_TERRAIN.raster}（位深 ${outcome.samples.distinctCodes} 个不同编码，16 位精度保持）`)
    console.log(
      `  · 抽样（米）：青藏 ${outcome.samples.tibetanMeters.toFixed(0)} / 东部 ${outcome.samples.easternMeters.toFixed(0)} / ` +
        `四川盆地 ${outcome.samples.sichuanBasinMeters.toFixed(0)} / 周边山地 ${outcome.samples.sichuanSurroundingsMeters.toFixed(0)} / ` +
        `塔里木盆地 ${outcome.samples.tarimBasinMeters.toFixed(0)} / 天山 ${outcome.samples.tarimNorthRimMeters.toFixed(0)} / 昆仑 ${outcome.samples.tarimSouthRimMeters.toFixed(0)} / ` +
        `东海陆架 ${outcome.samples.eastChinaSeaShelfMeters.toFixed(0)} / 南海深海 ${outcome.samples.southChinaSeaDeepMeters.toFixed(0)}`,
    )
    console.log(
      `  · 编码端点：code=0 → ${outcome.samples.decodedAtZeroCode}m / code=65535 → ${outcome.samples.decodedAtMaxCode}m / ` +
        `实测 [${outcome.samples.observedMinMeters.toFixed(0)}, ${outcome.samples.observedMaxMeters.toFixed(0)}]`,
    )
    console.log('  ✓ 地势抽样不变量通过：青藏高于东部、四川/塔里木盆地低于周边山地、浅海含负高程、深海截断到下限')
    console.log(
      `  ✓ ${PRODUCTION_TERRAIN.provenance}（来源与元数据一致 + 完整性摘要逐项一致：SHA-256 / 字节数 / 统计量）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/**
 * 生产省级边界资产深度校验（TASK-004 provinces scope）。
 * 加载目录、几何、来源注册表与审计 sidecar，调用 verifyProvincesAsset 一次性给出
 * 34 省 / 港澳台 / 目录-几何双射 / 真值一致 / 环闭合 / 坐标范围 / 来源 / 审计的全部结论，
 * 并打印抽样摘要（类型构成、坐标四至、数量统计）便于人工读图。
 */
function verifyProductionProvinces(): number {
  console.log('▶ 校验 scope：provinces（生产省级边界资产 · 深度校验）')
  let failures = 0
  let directory: unknown
  let geometry: unknown
  let sources: unknown
  let provenance: unknown = undefined
  let directoryText: string | undefined = undefined
  let geometryText: string | undefined = undefined
  try {
    directory = readJsonFile(PRODUCTION_PROVINCES.directory)
    geometry = readJsonFile(PRODUCTION_PROVINCES.geometry)
    sources = readJsonFile(PRODUCTION_SOURCES)
    // 目录 / 几何的原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    directoryText = readJsonText(PRODUCTION_PROVINCES.directory)
    geometryText = readJsonText(PRODUCTION_PROVINCES.geometry)
    provenance = readJsonFile(PRODUCTION_PROVINCES.provenance)
  } catch (cause) {
    failures++
    console.error(`  ✗ 生产省级边界资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyProvincesAsset({
    directory,
    geometry,
    sourcesRegistry: sources,
    provenance,
    directoryText,
    geometryText,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_PROVINCES.directory}（${outcome.samples.directoryCount} 个省级行政区 · 目录契约通过）`)
    console.log(`  ✓ ${PRODUCTION_PROVINCES.geometry}（${outcome.samples.geometryCount} 要素 · ${outcome.samples.polygonCount} 多边形 · ${outcome.samples.ringCount} 环 · ${outcome.samples.coordinateCount} 坐标）`)
    console.log(
      `  · 类型构成：省 ${outcome.samples.typeBreakdown.province} / 自治区 ${outcome.samples.typeBreakdown.autonomousRegion} / 直辖市 ${outcome.samples.typeBreakdown.municipality} / 特别行政区 ${outcome.samples.typeBreakdown.specialAdministrativeRegion}（几何 Polygon ${outcome.samples.geometryTypeBreakdown.polygon} / MultiPolygon ${outcome.samples.geometryTypeBreakdown.multiPolygon}）`,
    )
    console.log(
      `  · 坐标四至：经度 [${outcome.samples.observedWest.toFixed(3)}, ${outcome.samples.observedEast.toFixed(3)}] / 纬度 [${outcome.samples.observedSouth.toFixed(3)}, ${outcome.samples.observedNorth.toFixed(3)}]（落在中国主图 [72,3,136,54]）`,
    )
    console.log('  ✓ 深度不变量通过：恰好 34 省、港 / 澳 / 台均在、目录-几何双射、与 34 省目录真值一致、所有环闭合')
    console.log(
      `  ✓ ${PRODUCTION_SOURCES}（来源引用解析）+ ${PRODUCTION_PROVINCES.provenance}（完整性摘要逐项一致：SHA-256 / 数量统计）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/**
 * 生产地点目录资产深度校验（TASK-004 places scope）。
 * 加载地点目录、省级目录 / 几何（用于 adminId 解析与 point-in-polygon 包含校验）、来源注册表
 * 与审计 sidecar，调用 verifyPlacesAsset 一次性给出 68 条 / 34 省双角色 / 港澳台 / 真值一致 /
 * 坐标范围 / 省域包含 / 来源 / 审计的全部结论，并打印抽样摘要（角色构成、调整锚点数、包含校验状态）
 * 便于人工读图。
 */
function verifyProductionPlaces(): number {
  console.log('▶ 校验 scope：places（生产地点目录资产 · 深度校验）')
  let failures = 0
  let places: unknown
  let provinceDirectory: unknown
  let provinceGeometry: unknown
  let sources: unknown
  let provenance: unknown = undefined
  let placesText: string | undefined = undefined
  try {
    places = readJsonFile(PRODUCTION_PLACES.places)
    provinceDirectory = readJsonFile(PRODUCTION_PROVINCES.directory)
    provinceGeometry = readJsonFile(PRODUCTION_PROVINCES.geometry)
    sources = readJsonFile(PRODUCTION_SOURCES)
    // 地点目录原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    placesText = readJsonText(PRODUCTION_PLACES.places)
    provenance = readJsonFile(PRODUCTION_PLACES.provenance)
  } catch (cause) {
    failures++
    console.error(`  ✗ 生产地点目录资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyPlacesAsset({
    places,
    provinceDirectory,
    provinceGeometry,
    sourcesRegistry: sources,
    provenance,
    placesText,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_PLACES.places}（${outcome.samples.entryCount} 条 = ${outcome.samples.adminCount} 省 × 2 角色 · 地点契约通过）`)
    console.log(
      `  · 角色构成：省名锚点 ${outcome.samples.anchorCount}（其中人工校正 ${outcome.samples.adjustedAnchorCount}） / 省级行政中心 ${outcome.samples.capitalCount}`,
    )
    console.log(
      `  · 几何包含校验：${outcome.samples.containmentChecked ? '已执行（非校正坐标均落入对应省域）' : '未执行（未提供省级几何）'}`,
    )
    console.log('  ✓ 深度不变量通过：恰好 34 省 × (1 锚点 + 1 行政中心)、adminId 与 34 省真值一致、港 / 澳 / 台均在、坐标落中国主图、点落入对应省域')
    console.log(
      `  ✓ ${PRODUCTION_SOURCES}（来源引用解析）+ ${PRODUCTION_PLACES.provenance}（完整性摘要逐项一致：SHA-256 / 数量统计）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/**
 * 政治边界补充资产深度校验（TASK-004 political scope，SPEC §6 红线）。
 * 加载政治边界载荷、来源注册表与审计 sidecar，调用 verifyPoliticalAsset 一次性给出
 * 十段线 / 台湾东侧段 / 点名岛礁 / 点名争议区 / 坐标范围 / 非官方审图来源 / 审计的全部结论，
 * 并打印抽样摘要（段数、岛礁数、争议区数、坐标四至）便于人工读图。
 *
 * 覆盖边界（诚实声明，docs/political-review-record.md）：自动校验只覆盖 SPEC §6 点名必备项；
 * 南海诸岛完整岛礁名录、九段线 / 争议区几何顶点与国标逐点一致性属人工核对；
 * 全部政治边界数据为非官方审图数据，公开发布前必须取得自然资源主管部门审图号。
 */
function verifyProductionPolitical(): number {
  console.log('▶ 校验 scope：political（政治边界补充资产 · 深度校验）')
  let failures = 0
  let political: unknown
  let sources: unknown
  let provenance: unknown = undefined
  let politicalText: string | undefined = undefined
  try {
    political = readJsonFile(PRODUCTION_POLITICAL.political)
    sources = readJsonFile(PRODUCTION_SOURCES)
    provenance = readJsonFile(PRODUCTION_POLITICAL.provenance)
    // 政治边界载荷原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    politicalText = readJsonText(PRODUCTION_POLITICAL.political)
  } catch (cause) {
    failures++
    console.error(`  ✗ 政治边界补充资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyPoliticalAsset({
    political,
    sourcesRegistry: sources,
    provenance,
    politicalText,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_POLITICAL.political}（${outcome.samples.nineDashSegmentCount} 段九段线 · ${outcome.samples.islandCount} 岛礁 · ${outcome.samples.disputedRegionCount} 争议区修正）`)
    console.log(
      `  · 台湾东侧段（segmentIndex=10）：${outcome.samples.hasTaiwanEastSegment ? '在' : '缺'}（SPEC §6 红线）`,
    )
    console.log(
      `  · 坐标四至：经度 [${Number.isNaN(outcome.samples.observedWest) ? 'N/A' : outcome.samples.observedWest.toFixed(3)}, ${Number.isNaN(outcome.samples.observedEast) ? 'N/A' : outcome.samples.observedEast.toFixed(3)}] / 纬度 [${Number.isNaN(outcome.samples.observedSouth) ? 'N/A' : outcome.samples.observedSouth.toFixed(3)}, ${Number.isNaN(outcome.samples.observedNorth) ? 'N/A' : outcome.samples.observedNorth.toFixed(3)}]（落在中国主图 [72,3,136,54]）`,
    )
    console.log('  ✓ 深度不变量通过：恰好 10 段含台湾东侧段、点名岛礁（钓鱼岛/赤尾屿/曾母暗沙）均在、点名争议区（藏南/阿克赛钦）均在')
    console.log(
      `  ✓ ${PRODUCTION_SOURCES}（来源引用解析 · 非官方审图 isOfficialSurvey=false + 非空 disclaimer）+ ${PRODUCTION_POLITICAL.provenance}（完整性摘要逐项一致：SHA-256 / 数量统计）`,
    )
    console.log(
      '  ⚠ 自动校验只覆盖 SPEC §6 点名必备项；南海诸岛完整岛礁名录、九段线/争议区几何顶点与国标逐点一致性属人工核对（见 docs/political-review-record.md）；全部数据为非官方审图数据，公开发布前须取得审图号。',
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/**
 * 标签字体子集资产深度校验（TASK-005 fonts scope，SPEC §3.7）。
 * 加载字体清单、字体二进制、生产地点 / 政治契约（字符来源）与审计 sidecar，调用
 * verifyLabelFontAsset 一次性给出清单结构 / 字符全覆盖 / sourceStrings 保真 / SFNT-cmap
 * 字形映射 / 体积上限 / 完整性锚点的全部结论，并打印抽样摘要（字符数、字节数、来源构成）
 * 便于人工审计。
 */
function verifyProductionFonts(): number {
  console.log('▶ 校验 scope：fonts（标签字体子集资产 · 深度校验）')
  let failures = 0
  let manifest: unknown
  let fontBytes: Uint8Array
  let places: unknown
  let political: unknown
  let provenance: unknown = undefined
  let manifestText: string | undefined = undefined
  let placesText: string | undefined = undefined
  let politicalText: string | undefined = undefined
  try {
    manifest = readJsonFile(PRODUCTION_FONTS.manifest)
    fontBytes = readFileSync(resolve(projectRoot, PRODUCTION_FONTS.font))
    places = readJsonFile(PRODUCTION_PLACES.places)
    political = readJsonFile(PRODUCTION_POLITICAL.political)
    // 清单 / 输入契约的原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    manifestText = readJsonText(PRODUCTION_FONTS.manifest)
    placesText = readJsonText(PRODUCTION_PLACES.places)
    politicalText = readJsonText(PRODUCTION_POLITICAL.political)
    provenance = readJsonFile(PRODUCTION_FONTS.provenance)
  } catch (cause) {
    failures++
    console.error(`  ✗ 标签字体子集资产文件读取失败：${(cause as Error).message}`)
    return failures
  }

  const outcome = verifyLabelFontAsset({
    manifest,
    fontBytes,
    manifestText,
    places,
    political,
    provenance,
    placesText,
    politicalText,
  })
  if (outcome.ok) {
    console.log(
      `  ✓ ${PRODUCTION_FONTS.manifest}（${outcome.samples.characterCount} 字符 · 清单契约通过 · 字符来源：省名/省会名 ${outcome.samples.placeNameCount} + 岛礁名 ${outcome.samples.islandNameCount} + 静态文案 ${outcome.samples.staticCopyCount}）`,
    )
    console.log(
      `  ✓ ${PRODUCTION_FONTS.font}（${outcome.samples.fontByteLength} 字节 ≪ 上限 ${LABEL_FONT_MAX_BYTES} · ${outcome.samples.numGlyphs} 字形 · cmap 映射 ${outcome.samples.cmapChecked ? '逐字核验通过' : '未执行'}）`,
    )
    console.log('  ✓ 深度不变量通过：34 省名 + 省会名 + 附图标注岛礁名 + 合规角标免责声明全部字符被清单覆盖（缺失字符检测可确定性失败）')
    console.log(
      `  ✓ ${PRODUCTION_FONTS.provenance}（完整性摘要逐项一致：字体 / 清单 SHA-256、字符数、字节数 + 输入契约哈希锚点）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/**
 * 全量生产资产跨契约引用核对（--scope all 末尾执行一次）。
 * 把全部生产契约载荷放在一起，核对 sourceId / adminId 引用是否都能解析：
 * - 地形元数据 / 省界目录与几何 / 地点目录 / 政治边界的 sourceId → 生产来源注册表；
 * - 省界几何 / 地点目录的 adminId → 生产省级目录。
 * 发现「单契约校验无法发现的孤儿引用」（如某资产引用了未登记来源）。
 */
function verifyProductionBundle(): number {
  console.log('▶ 校验 scope：bundle（全量生产资产跨契约引用核对）')
  let bundle: ContractBundle
  try {
    bundle = {
      sources: readJsonFile(PRODUCTION_SOURCES) as ContractBundle['sources'],
      administrativeDirectory: readJsonFile(PRODUCTION_PROVINCES.directory),
      administrativeGeometry: readJsonFile(PRODUCTION_PROVINCES.geometry),
      placeDirectory: readJsonFile(PRODUCTION_PLACES.places),
      politicalBoundary: readJsonFile(PRODUCTION_POLITICAL.political),
      terrainMeta: readJsonFile(PRODUCTION_TERRAIN.meta),
    }
  } catch (cause) {
    console.error(`  ✗ 生产资产读取失败：${(cause as Error).message}`)
    return 1
  }
  const outcome = validateContractBundle(bundle)
  if (outcome.ok) {
    console.log('  ✓ 跨契约引用核对（sourceId / adminId 全部解析到生产注册表与规范 34 省目录）')
    return 0
  }
  console.error('  ✗ 跨契约引用核对失败')
  for (const err of outcome.errors) {
    console.error(`      [${err.code}] ${err.path}: ${err.message}`)
  }
  return 1
}

function main(): void {
  let scopes: string[]
  try {
    scopes = parseArgs(process.argv.slice(2))
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exit(2)
  }

  // 展开 all 为全部已登记 scope，并在末尾追加一次全量生产资产跨契约引用核对。
  const expanded: string[] = []
  let wantBundle = false
  for (const scope of scopes) {
    if (scope === 'all') {
      expanded.push(...Object.keys(SCOPE_REGISTRY))
      wantBundle = true
    } else if (scope in SCOPE_REGISTRY) {
      expanded.push(scope)
    } else {
      console.error(`未知 scope：${scope}。可选：all, ${Object.keys(SCOPE_REGISTRY).join(', ')}`)
      process.exit(2)
    }
  }

  let totalFailures = 0
  for (const scope of expanded) {
    totalFailures += SCOPE_REGISTRY[scope].customVerify()
  }
  if (wantBundle) {
    totalFailures += verifyProductionBundle()
  }

  if (totalFailures > 0) {
    console.error(`\n校验完成，存在 ${totalFailures} 项失败。`)
    process.exit(1)
  }
  console.log('\n校验完成，全部通过。')
}

main()
