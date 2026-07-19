/**
 * 省名锚点与省级行政中心资产生产编排：scripts/places/place-catalog.ts（34 省真值）
 *   → china-places.json（地点目录契约）+ china-places.provenance.json（来源审计）。
 *
 * 依赖方向：属于离线资产生产层（scripts/places，tsx 运行），单向依赖 src/geo-contracts
 * 契约层与同目录 place-catalog（34 省 × 2 角色领域真值）。严禁依赖浏览器 / React / Three.js
 * 或任何运行时状态。地点坐标全部项目内维护（公开标准地图衍生数据），**无任何网络取数**——
 * 运行时与生产期均零外部网络依赖（TASK-005 实现约束 + SPEC §5.5）。
 *
 * 展开规则（结构上保证「每省恰一个锚点 + 一个行政中心」）：
 * - 遍历 PLACE_CATALOG（按 adcode 升序），每条 province 真值**确定性地展开为两条**地点条目：
 *     1. provinceNameAnchor：name = shortName，coordinate = distinctAnchor?.coordinate ?? capital。
 *     2. administrativeCapital：name = capitalName，coordinate = capital。
 * - 地点 id 由 adminId + 角色后缀派生（如 CN-440000-anchor / CN-440000-capital），稳定、可读、可审计。
 * - 展开逻辑只有一处，无法手抖多写 / 漏写一条——「每省恰两条」是结构不变量而非约定。
 *
 * 锚点人工校正的承载（SPEC §3.7、TASK-005「不得用组件内魔法偏移承载」）：
 * - distinctAnchor 存在时，其 note 原样写入 anchor 条目的 anchorAdjustmentNote，作为可审计的校正依据。
 * - distinctAnchor 缺省时（锚点 = 省会坐标），不写 anchorAdjustmentNote（契约允许该字段缺省）。
 * - 校正锚点已逐一在生产期 point-in-polygon 验证落在省域内（见 places-deep.ts 的几何包含校验，
 *   在 verify:assets 与测试中执行）；本脚本不重复几何包含检查，只负责确定性序列化与契约自检。
 *
 * 非审图数据限制（SPEC §5.5、§8、§13）：
 * 省会 / 锚点坐标取自公开标准地图衍生数据，来源声明（public/geo/data-sources.json 的
 * src-project-capitals）与审计 sidecar 均标注 isOfficialSurvey=false 与非空免责声明。
 * 公开发布前必须取得自然资源主管部门审图号。
 *
 * 可重复性：同一 PLACE_CATALOG 多次重产得到逐字节一致的 china-places.json（字段顺序固定：
 * kind→version→crs→entries→source；条目按 adcode 升序、每省锚点先于行政中心）。地点载荷
 * SHA-256 写入 provenance.integrity.placesSha256，作为防篡改锚点。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validatePlaceDirectory,
  validateContractBundle,
  type PlaceDirectoryContract,
  type PlaceDirectoryEntry,
} from '../../src/geo-contracts/index'
import { PLACE_CATALOG } from './place-catalog'

/** 元数据引用的来源标识，须在 public/geo/data-sources.json 中可解析。 */
const DEFAULT_SOURCE_ID = 'src-project-capitals'

/** CLI 选项。 */
interface BuildCliOptions {
  outDir: string
  baseName: string
  sourceId: string
}

/**
 * 由 adminId + 角色派生地点条目稳定 id。
 * 后缀 -anchor / -capital 与契约角色一一对应，可读、可审计、确定性派生（不依赖数组顺序）。
 */
function derivePlaceId(adminId: string, role: 'anchor' | 'capital'): string {
  return `${adminId}-${role}`
}

/**
 * 把 34 省 × 2 角色真值展开为 68 条地点条目（按 adcode 升序、每省锚点先于行政中心）。
 *
 * 关键不变量（结构上不可违反）：
 * - 每个 province 恰好展开为 1 个锚点 + 1 个行政中心。
 * - 锚点 coordinate 取 distinctAnchor?.coordinate ?? capital；行政中心 coordinate 恒取 capital。
 * - anchorAdjustmentNote 仅在 distinctAnchor 存在时写入（校正依据随锚点走，不污染行政中心条目）。
 */
function expandEntries(): PlaceDirectoryEntry[] {
  const entries: PlaceDirectoryEntry[] = []
  for (const province of PLACE_CATALOG) {
    const hasDistinctAnchor = province.distinctAnchor !== undefined
    const anchorCoordinate = hasDistinctAnchor
      ? province.distinctAnchor!.coordinate
      : province.capital
    entries.push({
      id: derivePlaceId(province.id, 'anchor'),
      adminId: province.id,
      role: 'provinceNameAnchor',
      name: province.shortName,
      coordinate: anchorCoordinate,
      // 仅当锚点偏离省会时附校正依据；锚点 = 省会时缺省，避免出现「字段在但没解释」的隐式偏移。
      ...(hasDistinctAnchor
        ? { anchorAdjustmentNote: province.distinctAnchor!.note }
        : {}),
    })
    entries.push({
      id: derivePlaceId(province.id, 'capital'),
      adminId: province.id,
      role: 'administrativeCapital',
      name: province.capitalName,
      coordinate: province.capital,
    })
  }
  return entries
}

/** 解析 CLI 参数。 */
function parseArgs(argv: string[]): BuildCliOptions {
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
    baseName: opts.name ?? 'china-places',
    sourceId: opts['source-id'] ?? DEFAULT_SOURCE_ID,
  }
}

/**
 * 写盘前对组装好的地点目录做契约校验 + 跨契约引用核对。
 * 任一失败即抛错，保证不把不合规资产写入 public/。
 */
function assertContracts(directory: PlaceDirectoryContract, sources: unknown, provinceDirectory: unknown): void {
  const outcome = validatePlaceDirectory(directory)
  if (!outcome.ok) {
    throw new Error(
      '组装的地点目录未通过契约校验，拒绝写盘：\n' +
        outcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  // 跨契约引用核对：sourceId 解析 + adminId 解析（地点 ↔ 省级目录）。
  const bundleOutcome = validateContractBundle({
    sources,
    administrativeDirectory: provinceDirectory,
    placeDirectory: directory,
  })
  if (!bundleOutcome.ok) {
    throw new Error(
      '组装的地点目录跨契约引用核对失败，拒绝写盘：\n' +
        bundleOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
}

/**
 * 入口：展开真值 → 契约自检 → 写地点目录 / 审计 sidecar。
 * 任一阶段失败都在写盘前抛错；写盘前已通过契约校验，确保不产生半成品或不合规资产。
 */
function main(): void {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(
    `地点目录资产生产：来源 ${options.sourceId}（项目内维护，无网络取数）\n`,
  )

  const entries = expandEntries()
  process.stderr.write(`  展开条目数：${entries.length}（34 省 × 2 角色）\n`)

  const directory: PlaceDirectoryContract = {
    kind: 'place-directory',
    version: '1.0.0',
    crs: 'EPSG:4326',
    entries,
    source: { sourceId: options.sourceId },
  }

  // 来源注册表与省级目录在 public/geo/，写盘前用它们做跨契约引用核对。
  const geoDir = resolve(options.outDir === '.' ? process.cwd() : options.outDir)
  let sources: unknown = undefined
  let provinceDirectory: unknown = undefined
  try {
    sources = JSON.parse(readFileSync(resolve(geoDir, 'data-sources.json'), 'utf-8'))
  } catch {
    process.stderr.write(`  未在 ${geoDir} 找到来源注册表 data-sources.json，跳过 sourceId 解析核对。\n`)
  }
  try {
    provinceDirectory = JSON.parse(
      readFileSync(resolve(geoDir, 'china-provinces-directory.json'), 'utf-8'),
    )
  } catch {
    process.stderr.write(
      `  未在 ${geoDir} 找到省级目录 china-provinces-directory.json，跳过 adminId 解析核对。\n`,
    )
  }
  assertContracts(directory, sources, provinceDirectory)

  const absoluteOut = isAbsolute(options.outDir) ? options.outDir : resolve(process.cwd(), options.outDir)
  mkdirSync(absoluteOut, { recursive: true })

  const directoryPath = resolve(absoluteOut, `${options.baseName}.json`)
  // 字段顺序固定（kind→version→crs→entries→source），配合条目按 adcode 升序、每省锚点先于行政中心，
  // 使同一 PLACE_CATALOG 重产得到逐字节一致输出。
  const directoryJson = `${JSON.stringify(directory, null, 2)}\n`
  writeFileSync(directoryPath, directoryJson, 'utf-8')

  const placesSha256 = createHash('sha256').update(directoryJson, 'utf-8').digest('hex')
  const provenance = {
    kind: 'places-asset-provenance',
    assetPlaces: `${options.baseName}.json`,
    source: {
      sourceId: options.sourceId,
      dataset: '项目维护省名锚点与省级行政中心目录（34 省 × 2 角色）',
      accessEndpoint: 'offline://project-maintained/china-places.json',
      note: '省会/首府/直辖市中心/特别行政区中心坐标取自公开权威城市坐标；省名锚点取省域内可读位置（狭长 / 多岛省份已人工校正并附 anchorAdjustmentNote，校正锚点均已 point-in-polygon 验证落在省域内）。',
    },
    generation: {
      pipeline: 'scripts/places/build-places.ts',
      catalog: 'scripts/places/place-catalog.ts（34 省 × 2 角色领域真值）',
      processingParams: {
        expansion: '每条 province 真值确定性展开为 1 个 provinceNameAnchor + 1 个 administrativeCapital',
        anchorRule: '锚点 = distinctAnchor?.coordinate ?? capital；行政中心 = capital',
        idDerivation: '地点 id = `${adminId}-anchor` / `${adminId}-capital`（确定性派生）',
        containmentCheck: '由 places-deep.ts 在 verify:assets / 测试中执行（point-in-polygon）',
        networkAccess: 'none（地点坐标全部项目内维护，生产期零外网）',
      },
      producedAt: new Date().toISOString(),
      producedBy: 'TASK-005',
    },
    integrity: {
      placesSha256,
      entryCount: entries.length,
      anchorCount: entries.filter((e) => e.role === 'provinceNameAnchor').length,
      capitalCount: entries.filter((e) => e.role === 'administrativeCapital').length,
      adjustedAnchorCount: entries.filter((e) => e.anchorAdjustmentNote !== undefined).length,
    },
    disclaimer:
      '本资产为项目维护的省名锚点与省级行政中心目录（坐标取自公开标准地图衍生数据，非官方审图数据），' +
      '仅供内部展示，不得作为正式出版 / 发布用途，公开发布前须取得自然资源主管部门审图号。',
  }
  const provenancePath = resolve(absoluteOut, `${options.baseName}.provenance.json`)
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf-8')

  process.stdout.write('地点目录资产生产完成：\n')
  process.stdout.write(`  地点目录：${directoryPath}（${entries.length} 条 = 34 省 × 2 角色）\n`)
  process.stdout.write(`  审计：${provenancePath}\n`)
  process.stdout.write(`  地点载荷 SHA-256：${placesSha256}\n`)
}

// 仅在作为直接脚本入口时运行；被 import 时保持静默（便于复用内部函数做测试）。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  try {
    main()
  } catch (cause: unknown) {
    const err = cause as Error
    console.error(`地点目录资产生产失败：${err?.message ?? cause}`)
    process.exit(1)
  }
}
