/**
 * 政治边界补充资产生产编排：scripts/political/political-boundary-catalog.ts（坐标事实目录）
 *   → china-political-boundary.json（政治边界契约）+ china-political-boundary.provenance.json（来源审计）。
 *
 * 依赖方向：属于离线资产生产层（scripts/political，tsx 运行），单向依赖 src/geo-contracts
 * 契约层与同目录 political-boundary-catalog（项目维护坐标事实）。严禁依赖浏览器 / React /
 * Three.js 或任何运行时状态。坐标全部项目内维护（公开标准地图衍生数据），**无任何网络取数**——
 * 运行时与生产期均零外部网络依赖（SPEC §5.3）。
 *
 * 生产边界（明确范围，避免越权）：
 * - 本脚本只做「确定性序列化 + 契约自检 + 审计写盘」：把坐标事实目录原样组装为
 *   political-boundary 契约载荷，过 validatePoliticalBoundary 与跨契约 bundle 核对后写盘。
 * - 红线完整性（十段线含台湾东侧段 / 点名岛礁 / 点名争议区 / 非官方审图来源）的**断言**不在
 *   本脚本重复实现——由共享红线扫描（src/lib/political-red-line.ts）与资产深度校验
 *   （scripts/verify-assets/political-deep.ts）在 verify:assets 与测试中把关。
 *
 * 非审图数据限制（SPEC §5.3、§6、§8、§13）：
 * 坐标取自公开标准地图衍生数据（representative 精度），来源声明（public/geo/data-sources.json
 * 的 src-project-political）与审计 sidecar 均标注 isOfficialSurvey=false 与非空免责声明；
 * 九段线几何顶点与争议区边界的国标逐点一致性、南海诸岛完整岛礁名录闭包属人工核对项
 * （docs/political-review-record.md）。公开发布前必须取得自然资源主管部门审图号。
 *
 * 可重复性：同一坐标目录多次重产得到逐字节一致的 china-political-boundary.json（字段顺序固定：
 * kind→version→crs→features→source；要素顺序 = 九段线 1..10 → 岛礁点 → 争议区修正）。
 * 载荷 SHA-256 写入 provenance.integrity.politicalSha256，作为防篡改锚点。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  POLITICAL_SOURCE_ID,
  validateContractBundle,
  validatePoliticalBoundary,
  type DataSourceRegistryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts/index'
import { POLITICAL_BOUNDARY_FEATURES } from './political-boundary-catalog'

/** 元数据引用的来源标识，须在 public/geo/data-sources.json 中可解析（与契约层常量对齐）。 */
const DEFAULT_SOURCE_ID = POLITICAL_SOURCE_ID

/** CLI 选项。 */
interface BuildCliOptions {
  outDir: string
  baseName: string
  sourceId: string
}

/**
 * 由坐标事实目录组装完整的政治边界契约（纯函数，供 CLI 写盘与测试复用）。
 * 测试据此断言「重产输出与已交付资产逐字节一致」，证明资产确由本管线产出、未漂移。
 */
export function buildPoliticalBoundaryContract(
  sourceId: string = DEFAULT_SOURCE_ID,
): PoliticalBoundaryContract {
  return {
    kind: 'political-boundary',
    version: '1.0.0',
    crs: 'EPSG:4326',
    features: POLITICAL_BOUNDARY_FEATURES,
    source: { sourceId },
  }
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
    baseName: opts.name ?? 'china-political-boundary',
    sourceId: opts['source-id'] ?? DEFAULT_SOURCE_ID,
  }
}

/**
 * 写盘前对组装好的政治边界契约做契约校验 + 跨契约引用核对。
 * 任一失败即抛错，保证不把不合规资产写入 public/。
 */
function assertContracts(contract: PoliticalBoundaryContract, sources: unknown): void {
  const outcome = validatePoliticalBoundary(contract)
  if (!outcome.ok) {
    throw new Error(
      '组装的政治边界补充数据未通过契约校验，拒绝写盘：\n' +
        outcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  // 跨契约引用核对：sourceId 必须能在来源注册表中解析（src-project-political 须已登记）。
  const bundleOutcome = validateContractBundle({
    sources: sources as DataSourceRegistryContract | undefined,
    politicalBoundary: contract,
  })
  if (!bundleOutcome.ok) {
    throw new Error(
      '组装的政治边界补充数据跨契约引用核对失败，拒绝写盘：\n' +
        bundleOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
}

/**
 * 入口：组装契约 → 契约自检 → 写政治边界资产 / 审计 sidecar。
 * 任一阶段失败都在写盘前抛错；写盘前已通过契约校验，确保不产生半成品或不合规资产。
 */
function main(): void {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(
    `政治边界补充资产生产：来源 ${options.sourceId}（项目内维护，无网络取数）\n`,
  )

  const contract = buildPoliticalBoundaryContract(options.sourceId)
  const features = contract.features
  const segmentCount = features.filter((f) => f.type === 'nineDashLineSegment').length
  const islandCount = features.filter((f) => f.type === 'islandOrReefPoint').length
  const correctionCount = features.filter((f) => f.type === 'disputedBoundaryCorrection').length
  process.stderr.write(
    `  要素数：${features.length}（九段线 ${segmentCount} 段 / 岛礁点 ${islandCount} / 争议区修正 ${correctionCount}）\n`,
  )

  // 来源注册表在 public/geo/data-sources.json，写盘前用它做跨契约引用核对。
  const geoDir = resolve(options.outDir === '.' ? process.cwd() : options.outDir)
  let sources: unknown = undefined
  try {
    sources = JSON.parse(readFileSync(resolve(geoDir, 'data-sources.json'), 'utf-8'))
  } catch {
    process.stderr.write(`  未在 ${geoDir} 找到来源注册表 data-sources.json，跳过 sourceId 解析核对。\n`)
  }
  assertContracts(contract, sources)

  const absoluteOut = isAbsolute(options.outDir) ? options.outDir : resolve(process.cwd(), options.outDir)
  mkdirSync(absoluteOut, { recursive: true })

  const contractPath = resolve(absoluteOut, `${options.baseName}.json`)
  // 字段顺序固定（kind→version→crs→features→source），配合要素固定顺序，
  // 使同一坐标目录重产得到逐字节一致输出。
  const contractJson = `${JSON.stringify(contract, null, 2)}\n`
  writeFileSync(contractPath, contractJson, 'utf-8')

  const politicalSha256 = createHash('sha256').update(contractJson, 'utf-8').digest('hex')
  const provenance = {
    kind: 'political-asset-provenance',
    assetPolitical: `${options.baseName}.json`,
    source: {
      sourceId: options.sourceId,
      dataset: '项目自补九段线（含台湾东侧段的标准十段画法）、南海主要岛礁与钓鱼岛/赤尾屿等附属岛屿点位、藏南与阿克赛钦争议区按中国主张画法的修正',
      accessEndpoint: 'offline://project-maintained/china-political-boundary.json',
      note: '九段线（十段画法）段序号、岛礁规范名称与争议区目标区域由 src/geo-contracts/political-catalog 的 SPEC §6 红线点名领域真值单一定义；坐标为 representative（取自公开标准地图衍生数据），九段线几何顶点与争议区边界的国标逐点一致性以人工对照公开标准地图核对为准（见 docs/political-review-record.md）。',
    },
    generation: {
      pipeline: 'scripts/political/build-political.ts',
      catalog: 'scripts/political/political-boundary-catalog.ts（项目维护坐标事实目录）',
      processingParams: {
        tenDashStructure: '十段画法 = 南海 9 段（segmentIndex 1..9）+ 台湾东侧 1 段（segmentIndex 10 = TAIWAN_EAST_SEGMENT_INDEX）',
        requiredIslands: '钓鱼岛 / 赤尾屿 / 曾母暗沙（SPEC §6 / §3.3 点名；另有黄岩岛 / 永兴岛代表点位；完整南海诸岛名录属人工核对项，本资产不声称穷尽）',
        requiredDisputedRegions: '藏南 / 阿克赛钦（SPEC §6 点名，按中国主张画法补充）',
        coordinateExtent: '所有坐标落在中国主图 [72,3,136,54]（含端点），由 verifyPoliticalAsset 的资产级 coordinate-out-of-extent 锚点把关',
        networkAccess: 'none（坐标全部项目内维护，生产期零外网）',
      },
      producedAt: new Date().toISOString(),
      producedBy: 'TASK-004',
    },
    integrity: {
      politicalSha256,
      nineDashSegmentCount: segmentCount,
      islandCount,
      disputedRegionCount: correctionCount,
    },
    disclaimer:
      '本资产为项目自行维护的政治边界补充数据：九段线（含台湾东侧段的标准十段画法）、南海主要岛礁与钓鱼岛/赤尾屿等附属岛屿点位、藏南与阿克赛钦争议区按中国主张画法的修正。' +
      '坐标取自公开标准地图衍生数据，非自然资源主管部门官方审图数据；九段线几何顶点与争议区边界的国标逐点一致性、南海诸岛完整岛礁名录闭包以人工对照公开标准地图核对为准' +
      '（见 docs/political-review-record.md）。仅供内部展示，不得作为正式出版 / 发布用途，公开发布前必须取得自然资源主管部门审图号。',
  }
  const provenancePath = resolve(absoluteOut, `${options.baseName}.provenance.json`)
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf-8')

  process.stdout.write('政治边界补充资产生产完成：\n')
  process.stdout.write(`  政治边界：${contractPath}（${segmentCount} 段九段线 / ${islandCount} 岛礁点 / ${correctionCount} 争议区修正）\n`)
  process.stdout.write(`  审计：${provenancePath}\n`)
  process.stdout.write(`  载荷 SHA-256：${politicalSha256}\n`)
}

// 仅在作为直接脚本入口时运行；被 import 时保持静默（便于复用内部函数做测试）。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  try {
    main()
  } catch (cause: unknown) {
    const err = cause as Error
    console.error(`政治边界补充资产生产失败：${err?.message ?? cause}`)
    process.exit(1)
  }
}
