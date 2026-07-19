/**
 * 资产契约校验 CLI（pnpm verify:assets）。
 *
 * 这是 TASK-001 提供的「非交互自动化验证入口」，后续 TASK 复用同一入口验证正常资产与
 * 损坏资产。sources/provinces/places/political scope 当前指向 tests/fixtures/legal 下的代表夹具
 * （对应生产资产尚未交付，由后续 TASK 接入）；terrain scope 自 TASK-003 起改为校验 public/ 下的
 * 生产高程资产，并追加 scope 专属的更深层不变量（位深/尺寸/地势抽样，见 terrain-deep.ts）。
 *
 * 依赖方向：本脚本属于离线资产生产/校验层（scripts/，devDependency tsx 运行），
 * 只单向依赖 src/geo-contracts 契约层与同层 scripts/dem、scripts/verify-assets 模块；
 * 不进入浏览器运行时包，不被 vite 打包。
 *
 * 退出码：全部通过为 0；任一失败为 1；参数错误为 2。输出确定性文本，便于 CI 与人工定位。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readContractKind,
  validateContractByKind,
  validateContractBundle,
  type ContractBundle,
  type ContractKind,
} from '../../src/geo-contracts/index'
import { verifyTerrainAsset } from './terrain-deep'
import { verifyProvincesAsset } from './provinces-deep'
import { verifyPlacesAsset } from './places-deep'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

/** 单个待校验文件：相对项目根的路径 + 期望契约 kind。 */
interface AssetProbe {
  readonly path: string
  readonly expectedKind: ContractKind
}

/** 单个 scope 的描述：一组待校验文件 + 是否附加跨契约引用核对，或自定义校验函数。 */
interface ScopeDescriptor {
  readonly label: string
  readonly probes: readonly AssetProbe[]
  readonly runBundle?: boolean
  /**
   * 自定义校验：当某 scope 需要超出「按 kind 校验 JSON」的更深层不变量（如 terrain 的位深/尺寸/
   * 地势抽样）时提供，返回失败计数。存在时取代默认 probe 循环。probes 仍可保留以参与 bundle 核对。
   */
  readonly customVerify?: () => number
}

/**
 * 生产高程资产路径（相对项目根）。terrain scope 自 TASK-003 起校验这套生产资产。
 */
const PRODUCTION_TERRAIN = {
  meta: 'public/terrain/china-heightmap-4096.meta.json',
  raster: 'public/terrain/china-heightmap-4096.r16',
  provenance: 'public/terrain/china-heightmap-4096.provenance.json',
  sources: 'public/geo/data-sources.json',
} as const

/**
 * 生产省级边界资产路径（相对项目根）。provinces scope 自 TASK-004 起校验这套生产资产。
 * 目录与几何拆为两个 kind 各自的文件（目录小而快、几何大而独立加载），二者经深度校验构成一一对应。
 */
const PRODUCTION_PROVINCES = {
  directory: 'public/geo/china-provinces-directory.json',
  geometry: 'public/geo/china-provinces-geometry.json',
  provenance: 'public/geo/china-provinces.provenance.json',
  sources: 'public/geo/data-sources.json',
} as const

/**
 * 生产地点目录资产路径（相对项目根）。places scope 自 TASK-005 起校验这套生产资产。
 * 地点目录同时承载省名锚点与省级行政中心（34 省 × 2 角色 = 68 条），并复用省级几何做 point-in-polygon 包含校验。
 */
const PRODUCTION_PLACES = {
  places: 'public/geo/china-places.json',
  provenance: 'public/geo/china-places.provenance.json',
  provinceDirectory: 'public/geo/china-provinces-directory.json',
  provinceGeometry: 'public/geo/china-provinces-geometry.json',
  sources: 'public/geo/data-sources.json',
} as const

/**
 * Scope 注册表。
 * 后续 TASK 新增生产资产时：把对应 scope 的 probes 路径替换/扩展为真实资产路径，或追加 customVerify
 * 即可，无需新建第二条校验管线（避免重复契约/双轨入口）。
 */
const SCOPE_REGISTRY: Record<string, ScopeDescriptor> = {
  sources: {
    label: '数据来源注册表',
    probes: [{ path: 'tests/fixtures/legal/data-sources.json', expectedKind: 'data-source-registry' }],
  },
  terrain: {
    label: '生产高程资产（深度校验：位深/尺寸/编码/地势抽样/来源）',
    probes: [],
    customVerify: verifyProductionTerrain,
  },
  provinces: {
    label: '生产省级边界资产（深度校验：34 省/港澳台/目录-几何双射/真值一致/环闭合/坐标范围/来源/审计）',
    // probes 保留指向 tests/fixtures/legal 的代表夹具，仅为 `--scope all` 末尾的跨契约 bundle 核对
    // （fixture 地点目录引用 CN-GD/CN-HI/CN-MO，需由 fixture 行政区目录解析）提供目录与几何。
    // 本 scope 实际的资产校验由 customVerify 在生产资产上执行（与 terrain scope 同构）。
    probes: [
      { path: 'tests/fixtures/legal/admin-directory.json', expectedKind: 'administrative-directory' },
      { path: 'tests/fixtures/legal/admin-geometry.json', expectedKind: 'administrative-geometry' },
    ],
    customVerify: verifyProductionProvinces,
  },
  places: {
    label: '生产地点目录资产（深度校验：68 条/34 省×2 角色/港澳台/真值一致/坐标范围/省域包含/来源/审计）',
    // probes 保留指向 tests/fixtures/legal 的代表夹具，仅为 `--scope all` 末尾的跨契约 bundle 核对
    // （fixture 地点目录引用 CN-GD/CN-HI/CN-MO，需由 fixture 行政区目录解析）提供地点载荷。
    // 本 scope 实际的资产校验由 customVerify 在生产资产上执行（与 terrain / provinces scope 同构）。
    probes: [{ path: 'tests/fixtures/legal/places.json', expectedKind: 'place-directory' }],
    customVerify: verifyProductionPlaces,
  },
  political: {
    label: '政治边界补充数据',
    probes: [{ path: 'tests/fixtures/legal/political-boundary.json', expectedKind: 'political-boundary' }],
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

/** 把校验通过的载荷按 kind 归位到 bundle，供跨契约核对消费。 */
function addToBundle(bundle: ContractBundle, kind: ContractKind, payload: unknown): void {
  switch (kind) {
    case 'data-source-registry':
      bundle.sources = payload as ContractBundle['sources']
      break
    case 'administrative-directory':
      bundle.administrativeDirectory = payload
      break
    case 'administrative-geometry':
      bundle.administrativeGeometry = payload
      break
    case 'place-directory':
      bundle.placeDirectory = payload
      break
    case 'political-boundary':
      bundle.politicalBoundary = payload
      break
    case 'terrain-meta':
      bundle.terrainMeta = payload
      break
    default:
      break
  }
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
 * 生产高程资产深度校验（TASK-003 terrain scope）。
 * 加载元数据、栅格、来源注册表与审计 sidecar，调用 verifyTerrainAsset 一次性给出
 * 位深/尺寸/编码/地势抽样/来源的全部结论，并打印抽样摘要便于人工读图。
 */
function verifyProductionTerrain(): number {
  console.log('▶ 校验 scope：terrain（生产高程资产 · 深度校验）')
  let failures = 0
  let meta: unknown
  let sources: unknown
  let pixels: Uint16Array
  let rasterBytes: Uint8Array
  let width = 0
  let height = 0
  let provenance: unknown = undefined
  try {
    meta = readJsonFile(PRODUCTION_TERRAIN.meta)
    sources = readJsonFile(PRODUCTION_TERRAIN.sources)
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
    sourcesRegistry: sources,
    provenance,
    rasterBytes,
  })
  if (outcome.ok) {
    console.log(`  ✓ ${PRODUCTION_TERRAIN.meta}（元数据契约通过）`)
    console.log(`  ✓ ${PRODUCTION_TERRAIN.raster}（位深 ${outcome.samples.distinctCodes} 个不同编码，16 位精度保持）`)
    console.log(
      `  · 抽样（米）：青藏 ${outcome.samples.tibetanMeters.toFixed(0)} / 东部 ${outcome.samples.easternMeters.toFixed(0)} / ` +
        `四川盆地 ${outcome.samples.sichuanBasinMeters.toFixed(0)} / 周边山地 ${outcome.samples.sichuanSurroundingsMeters.toFixed(0)} / ` +
        `东海陆架 ${outcome.samples.eastChinaSeaShelfMeters.toFixed(0)} / 南海深海 ${outcome.samples.southChinaSeaDeepMeters.toFixed(0)}`,
    )
    console.log(
      `  · 编码端点：code=0 → ${outcome.samples.decodedAtZeroCode}m / code=65535 → ${outcome.samples.decodedAtMaxCode}m / ` +
        `实测 [${outcome.samples.observedMinMeters.toFixed(0)}, ${outcome.samples.observedMaxMeters.toFixed(0)}]`,
    )
    console.log('  ✓ 地势抽样不变量通过：青藏高于东部、盆地低于周边、浅海含负高程、深海截断到下限')
    console.log(
      `  ✓ ${PRODUCTION_TERRAIN.sources}（来源引用解析）+ ${PRODUCTION_TERRAIN.provenance}（完整性摘要逐项一致：SHA-256 / 字节数 / 统计量）`,
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
    sources = readJsonFile(PRODUCTION_PROVINCES.sources)
    // 目录 / 几何的原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    directoryText = readFileSync(resolve(projectRoot, PRODUCTION_PROVINCES.directory), 'utf-8')
    geometryText = readFileSync(resolve(projectRoot, PRODUCTION_PROVINCES.geometry), 'utf-8')
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
      `  ✓ ${PRODUCTION_PROVINCES.sources}（来源引用解析）+ ${PRODUCTION_PROVINCES.provenance}（完整性摘要逐项一致：SHA-256 / 数量统计）`,
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
 * 生产地点目录资产深度校验（TASK-005 places scope）。
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
    provinceDirectory = readJsonFile(PRODUCTION_PLACES.provinceDirectory)
    provinceGeometry = readJsonFile(PRODUCTION_PLACES.provinceGeometry)
    sources = readJsonFile(PRODUCTION_PLACES.sources)
    // 地点目录原始文本用于复算 SHA-256 防篡改锚点；与落盘字节同源（readFileSync 原样读出）。
    placesText = readFileSync(resolve(projectRoot, PRODUCTION_PLACES.places), 'utf-8')
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
      `  ✓ ${PRODUCTION_PLACES.sources}（来源引用解析）+ ${PRODUCTION_PLACES.provenance}（完整性摘要逐项一致：SHA-256 / 数量统计）`,
    )
  } else {
    failures++
    for (const err of outcome.errors) {
      console.error(`  ✗ [${err.code}] ${err.path}: ${err.message}`)
    }
  }
  return failures
}

/** 校验单个 scope，返回失败计数。把所有错误一次性打印，避免逐条往复。 */
function verifyScope(scopeName: string, descriptor: ScopeDescriptor): number {
  // 自定义校验（如 terrain 的深度校验）取代默认 probe 循环。
  if (descriptor.customVerify) {
    return descriptor.customVerify()
  }
  console.log(`▶ 校验 scope：${scopeName}（${descriptor.label}）`)
  let failures = 0

  const bundlePayload: ContractBundle = {}
  for (const probe of descriptor.probes) {
    const payload = readJsonFile(probe.path)
    const actualKind = readContractKind(payload)
    if (actualKind !== probe.expectedKind) {
      console.error(`  ✗ ${probe.path}：期望 kind=${probe.expectedKind}，实际为 ${String(actualKind)}`)
      failures++
      continue
    }
    const outcome = validateContractByKind(payload)
    if (outcome.ok) {
      console.log(`  ✓ ${probe.path}`)
      addToBundle(bundlePayload, probe.expectedKind, payload)
    } else {
      failures++
      console.error(`  ✗ ${probe.path}`)
      for (const err of outcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  if (descriptor.runBundle) {
    const bundleOutcome = validateContractBundle(bundlePayload)
    if (bundleOutcome.ok) {
      console.log('  ✓ 该 scope 跨契约引用核对通过')
    } else {
      failures++
      console.error('  ✗ 该 scope 跨契约引用核对失败')
      for (const err of bundleOutcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  return failures
}

function main(): void {
  let scopes: string[]
  try {
    scopes = parseArgs(process.argv.slice(2))
  } catch (cause) {
    console.error(String((cause as Error).message ?? cause))
    process.exit(2)
  }

  // 展开 all 为全部已登记 scope，并在末尾追加一次跨契约 bundle 核对。
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
    totalFailures += verifyScope(scope, SCOPE_REGISTRY[scope])
  }

  // 末尾跨契约核对：把全部 scope 的合法夹具放在一起检查 sourceId / adminId 引用是否解析。
  if (wantBundle) {
    console.log('▶ 校验 scope：bundle（全量跨契约引用核对）')
    const bundle: ContractBundle = {}
    for (const scope of expanded) {
      for (const probe of SCOPE_REGISTRY[scope].probes) {
        addToBundle(bundle, probe.expectedKind, readJsonFile(probe.path))
      }
    }
    const outcome = validateContractBundle(bundle)
    if (outcome.ok) {
      console.log('  ✓ 跨契约引用核对（sourceId / adminId 全部解析）')
    } else {
      totalFailures++
      console.error('  ✗ 跨契约引用核对失败')
      for (const err of outcome.errors) {
        console.error(`      [${err.code}] ${err.path}: ${err.message}`)
      }
    }
  }

  if (totalFailures > 0) {
    console.error(`\n校验完成，存在 ${totalFailures} 项失败。`)
    process.exit(1)
  }
  console.log('\n校验完成，全部通过。')
}

main()
