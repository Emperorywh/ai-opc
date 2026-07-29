/**
 * 政治边界补充资产级深度校验。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/verify-assets，tsx 运行），单向依赖
 * src/geo-contracts 契约层（含 political-catalog 红线点名真值）与 src/lib/political-red-line
 * 共享红线扫描。不依赖浏览器 / React / Three.js。被 CLI（scripts/verify-assets/run.ts 的
 * political scope）与测试基线（tests/assets/）共同复用，避免校验逻辑双轨：CLI 读盘后调用
 * 本函数，测试以篡改副本调用同一函数。
 *
 * 与契约校验的关系：契约校验（validatePoliticalBoundary）只验要素的字段结构
 * （段序号唯一且为正整数、岛礁名非空、争议区修正含 targetRegion/basis、坐标合法、source.sourceId 非空）；
 * 本模块在其之上追加「资产级」不变量——
 *   恰好 10 个九段线段且序号 1..10 全在（含台湾东侧第 10 段）、SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在、
 *   SPEC §6 点名争议区修正（藏南 / 阿克赛钦）均在、坐标落在中国主图 [72,3,136,54]、
 *   来源可解析且强制非官方审图（isOfficialSurvey=false + 非空 disclaimer）、provenance 完整性摘要逐项一致。
 *
 * 红线扫描的唯一性（与 src/lib/political-red-line.ts 的分工）：
 * - 九段线段序号收集、缺段判定、台湾东侧段存在性、点名岛礁缺失判定，**唯一**来自共享扫描
 *   collectPoliticalRedLineGaps——本模块不另行遍历 features 做等价扫描，避免出现第二套红线扫描逻辑
 *   （一处漏判即可能在某条路径静默放过残缺地图，SPEC §6 红线）。
 * - 本模块只追加共享扫描职责之外的资产级检查：点名争议区（共享扫描按设计不覆盖，其完整性
 *   由资产层把关）、全量坐标范围、来源非官方审图、provenance 防篡改锚点。
 *
 * 自动校验覆盖范围（不得越权声称，docs/political-review-record.md「人工核对」）：
 * - 自动校验只断言「SPEC §6 点名必备项在 + 坐标合法 + 来源非官方审图」，**不**声称：
 *   · 南海诸岛完整岛礁名录已穷尽（完整名录闭包由人工对照公开标准地图确立）；
 *   · 九段线 / 争议区边界的几何顶点与国标逐点重合（顶点级一致性属人工核对）；
 *   · 数据已通过官方审图（所有数据为非官方审图，发布前必须取得审图号）。
 * - 政治红线独立锚点（SPEC §6）：TAIWAN_EAST_SEGMENT_INDEX（台湾东侧第 10 段）经共享扫描
 *   独立断言，不经 REQUIRED_NINE_DASH_SEGMENT_INDICES 间接得出，即便有人误改 catalog 常量，
 *   该锚点仍要求资产必须含此段。
 */

import { createHash } from 'node:crypto'
import {
  CHINA_MAIN_MAP_EXTENT,
  validatePoliticalBoundary,
  validateContractBundle,
  validateDataSourceRegistry,
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_DISPUTED_REGIONS,
  TAIWAN_EAST_SEGMENT_INDEX,
  type DataSourceRegistryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts/index'
import { collectPoliticalRedLineGaps } from '../../src/lib/political-red-line'

/**
 * 资产级坐标范围容差（度）。
 * 中国主图范围 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）已覆盖九段线 / 岛礁 / 争议区全部坐标
 * （曾母暗沙 ≈ 3.58°N 是南端极限，落在南界 3°N 之内），用 1e-9 只吸收浮点误差，不做实质放宽。
 */
const EXTENT_EPSILON = 1e-9

/** 资产级校验错误码前缀（与 provinces-asset / places-asset 同构）。契约 / bundle 原始错误码保留，此处只登记资产级独有不变量。 */
const ASSET_ERROR_CODES = {
  nineDashSegmentCount: 'political-asset.nine-dash-segment-count',
  nineDashSegmentMissing: 'political-asset.nine-dash-segment-missing',
  taiwanEastSegmentMissing: 'political-asset.taiwan-east-segment-missing',
  islandMissing: 'political-asset.island-missing',
  disputedRegionMissing: 'political-asset.disputed-region-missing',
  coordinateOutOfExtent: 'political-asset.coordinate-out-of-extent',
  unresolvedSource: 'political-asset.unresolved-source',
  officialSurveyViolation: 'political-asset.official-survey-violation',
  provenanceIntegrityMismatch: 'political-asset.provenance-integrity-mismatch',
} as const

/** 单条资产级错误。结构与契约层 ContractValidationError 对齐，便于 CLI 统一打印。 */
export interface PoliticalAssetError {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** 资产级校验结果。 */
export interface PoliticalAssetOutcome {
  readonly ok: boolean
  readonly errors: readonly PoliticalAssetError[]
  /** 抽样摘要（段数、岛礁数、争议区数、坐标四至），供 CLI 与测试观察，非错误项。 */
  readonly samples: PoliticalAssetSamples
}

/** 抽样摘要：各类要素数量与全量坐标四至。 */
export interface PoliticalAssetSamples {
  readonly nineDashSegmentCount: number
  readonly islandCount: number
  readonly disputedRegionCount: number
  readonly observedWest: number
  readonly observedEast: number
  readonly observedSouth: number
  readonly observedNorth: number
  readonly hasTaiwanEastSegment: boolean
}

/** 深度校验入参：政治边界载荷 + 可选来源注册表 / 审计 sidecar / 原始文本（哈希核对）。 */
export interface PoliticalAssetVerificationInput {
  readonly political: unknown
  readonly sourcesRegistry?: unknown
  readonly provenance?: unknown
  /** 政治边界 JSON 原始文本（与落盘字节同源），用于复算 SHA-256 防篡改锚点；核对 provenance 时需要。 */
  readonly politicalText?: string
}

/** 政治边界载荷（运行时最小形状）。 */
interface PoliticalBoundaryShape {
  features?: Array<PoliticalFeatureShape>
  source?: { sourceId?: string }
}

/** 政治边界要素（运行时最小形状，判别联合）。 */
type PoliticalFeatureShape =
  | { type: 'nineDashLineSegment'; segmentIndex?: number; coordinates?: Array<{ lon?: number; lat?: number }> }
  | { type: 'islandOrReefPoint'; name?: string; coordinate?: { lon?: number; lat?: number } }
  | { type: 'disputedBoundaryCorrection'; targetRegion?: string }
  | { type?: string }

/** 资产级深度校验主入口：返回通过 / 失败 + 抽样摘要。 */
export function verifyPoliticalAsset(input: PoliticalAssetVerificationInput): PoliticalAssetOutcome {
  const errors: PoliticalAssetError[] = []

  // 1) 契约结构校验（复用契约层校验器）。保留原始错误码，
  //    使 political-boundary.segment-index-duplicate 等可被测试精确断言（与 provinces-deep / places-deep 同构）。
  const politicalOutcome = validatePoliticalBoundary(input.political)
  if (!politicalOutcome.ok) {
    for (const e of politicalOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }

  // 2) 跨契约引用核对：sourceId 解析（政治边界 ↔ 来源注册表）。保留 bundle 原始错误码。
  if (input.sourcesRegistry !== undefined) {
    const bundleOutcome = validateContractBundle({
      sources: input.sourcesRegistry as DataSourceRegistryContract,
      politicalBoundary: input.political,
    })
    if (!bundleOutcome.ok) {
      for (const e of bundleOutcome.errors) {
        errors.push({ code: e.code, path: e.path, message: e.message })
      }
    }
  }

  const political = input.political as PoliticalBoundaryShape
  const features = Array.isArray(political.features) ? political.features : []

  // 3) 红线点名缺项扫描（唯一扫描实现，来自 src/lib/political-red-line）：
  //    段序号去重计数、缺段序号清单、台湾东侧段存在性、点名岛礁缺失清单。
  //    契约结构校验已先行；此处把载荷按契约形状交给共享扫描（扫描只读取 type/segmentIndex/name，
  //    对轻微形状偏差保持容错，结构问题已由上面的契约校验精确报告）。
  const gaps = collectPoliticalRedLineGaps(political as unknown as PoliticalBoundaryContract)

  // 3a) 九段线段数：恰好 10 段（十段画法，SPEC §6）。与领域真值常量比较，而非「段数自洽」。
  if (gaps.segmentCount !== EXPECTED_NINE_DASH_SEGMENT_COUNT) {
    errors.push({
      code: ASSET_ERROR_CODES.nineDashSegmentCount,
      path: '$.features',
      message: `九段线必须恰好含 ${EXPECTED_NINE_DASH_SEGMENT_COUNT} 段（十段画法），实际为 ${gaps.segmentCount} 段。`,
    })
  }

  // 3b) 段序号 1..10 全在（逐段核对，缺哪段就指明哪段）。
  if (gaps.missingSegmentIndices.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.nineDashSegmentMissing,
      path: '$.features',
      message: `九段线缺少段序号：[${gaps.missingSegmentIndices.join(', ')}]（十段画法需 1..10 全在）。`,
    })
  }

  // 3c) 台湾东侧段（segmentIndex===10）独立硬编码锚点（SPEC §6 红线「含台湾东侧那段」）。
  //     不经段序号清单间接得出，即便常量被误改，此锚点仍要求资产必须含第 10 段。
  if (!gaps.taiwanEastSegmentPresent) {
    errors.push({
      code: ASSET_ERROR_CODES.taiwanEastSegmentMissing,
      path: '$.features',
      message: `九段线缺少台湾东侧段（segmentIndex=${TAIWAN_EAST_SEGMENT_INDEX}），SPEC §6 红线要求十段画法含台湾东侧那段。`,
    })
  }

  // 3d) SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在（逐项核对，缺哪个就指明哪个）。
  if (gaps.missingIslandNames.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.islandMissing,
      path: '$.features',
      message: `缺少 SPEC §6 点名岛礁 / 附属岛屿：[${gaps.missingIslandNames.join('、')}]（完整南海诸岛名录属人工核对项，本锚点不声称穷尽）。`,
    })
  }

  // 4) SPEC §6 点名争议区修正（藏南 / 阿克赛钦）均在（逐项核对，缺哪个就指明哪个）。
  //    争议区完整性按设计由资产层把关，不参与共享红线扫描（见模块头注释）。
  const disputedRegions = new Set<string>()
  const islandNames = new Set<string>()
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue
    if (feature.type === 'disputedBoundaryCorrection') {
      const correction = feature as { targetRegion?: string }
      if (typeof correction.targetRegion === 'string' && correction.targetRegion.trim().length > 0) {
        disputedRegions.add(correction.targetRegion)
      }
    } else if (feature.type === 'islandOrReefPoint') {
      const point = feature as { name?: string }
      if (typeof point.name === 'string' && point.name.trim().length > 0) {
        islandNames.add(point.name)
      }
    }
  }
  const missingRegions: string[] = []
  for (const region of REQUIRED_DISPUTED_REGIONS) {
    if (!disputedRegions.has(region)) {
      missingRegions.push(region)
    }
  }
  if (missingRegions.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.disputedRegionMissing,
      path: '$.features',
      message: `缺少 SPEC §6 点名争议区修正：[${missingRegions.join('、')}]（须按中国主张画法补充）。`,
    })
  }

  // 5) 坐标范围：所有九段线顶点与岛礁坐标落在中国主图 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）。
  let observedWest = Infinity
  let observedEast = -Infinity
  let observedSouth = Infinity
  let observedNorth = -Infinity
  let coordinateSeen = false
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue
    if (feature.type === 'nineDashLineSegment') {
      const seg = feature as { coordinates?: Array<{ lon?: number; lat?: number }> }
      if (Array.isArray(seg.coordinates)) {
        for (const coord of seg.coordinates) {
          observeCoordinate(coord, '$.features[nineDashLineSegment].coordinates')
        }
      }
    } else if (feature.type === 'islandOrReefPoint') {
      const point = feature as { coordinate?: { lon?: number; lat?: number } }
      observeCoordinate(point.coordinate, '$.features[islandOrReefPoint].coordinate')
    }
  }

  // 局部：核对单个坐标是否落在中国主图范围，并更新四至。
  function observeCoordinate(coord: { lon?: number; lat?: number } | undefined, basePath: string): void {
    if (!coord || typeof coord.lon !== 'number' || typeof coord.lat !== 'number') return
    coordinateSeen = true
    const { lon, lat } = coord
    if (lon < observedWest) observedWest = lon
    if (lon > observedEast) observedEast = lon
    if (lat < observedSouth) observedSouth = lat
    if (lat > observedNorth) observedNorth = lat
    if (
      lon < CHINA_MAIN_MAP_EXTENT.west - EXTENT_EPSILON ||
      lon > CHINA_MAIN_MAP_EXTENT.east + EXTENT_EPSILON ||
      lat < CHINA_MAIN_MAP_EXTENT.south - EXTENT_EPSILON ||
      lat > CHINA_MAIN_MAP_EXTENT.north + EXTENT_EPSILON
    ) {
      errors.push({
        code: ASSET_ERROR_CODES.coordinateOutOfExtent,
        path: basePath,
        message: `坐标 (${lon},${lat}) 超出中国主图范围 [${CHINA_MAIN_MAP_EXTENT.west},${CHINA_MAIN_MAP_EXTENT.south},${CHINA_MAIN_MAP_EXTENT.east},${CHINA_MAIN_MAP_EXTENT.north}]。`,
      })
    }
  }

  // 6) 来源引用可解析 + 强制非官方审图（SPEC §6 / §8 红线：政治边界补充数据必须标记非官方审图）。
  //    契约层（source.ts）已强制 isOfficialSurvey=false 时 disclaimer 非空；此处追加资产级独立锚点：
  //    即便有人把政治来源误改为官方审图，本锚点仍要求 isOfficialSurvey===false 且 disclaimer 非空。
  const sourceId = political.source?.sourceId
  if (input.sourcesRegistry !== undefined && typeof sourceId === 'string') {
    const registryOutcome = validateDataSourceRegistry(input.sourcesRegistry)
    if (registryOutcome.ok) {
      const registry = input.sourcesRegistry as DataSourceRegistryContract
      const declaration = registry.sources.find((s) => s.id === sourceId)
      if (declaration === undefined) {
        errors.push({
          code: ASSET_ERROR_CODES.unresolvedSource,
          path: '$.source.sourceId',
          message: `政治边界来源 sourceId=${sourceId} 在数据来源注册表中不存在。`,
        })
      } else {
        // SPEC §6 / §8 红线：政治边界补充数据一律非官方审图，disclaimer 必填非空。
        if (declaration.isOfficialSurvey !== false) {
          errors.push({
            code: ASSET_ERROR_CODES.officialSurveyViolation,
            path: `$.sources[id=${sourceId}].isOfficialSurvey`,
            message: `政治边界来源 ${sourceId} 必须标记 isOfficialSurvey=false（SPEC §6/§8：政治边界补充数据一律非官方审图，发布前须审图）。`,
          })
        }
        if (declaration.disclaimer === undefined || declaration.disclaimer.trim().length === 0) {
          errors.push({
            code: ASSET_ERROR_CODES.officialSurveyViolation,
            path: `$.sources[id=${sourceId}].disclaimer`,
            message: `政治边界来源 ${sourceId} 必须附带非空免责声明（SPEC §8：非官方审图数据必备免责声明）。`,
          })
        }
      }
    }
  }

  // 7) 审计 sidecar 完整性比对（防篡改锚点，与 terrain / provinces / places provenance 同构）。
  //     provenance.integrity 声明 politicalSha256 + 各类要素数量；校验侧逐项复算比对，
  //     避免「声明锚点但不闭环」的装饰性校验。
  if (input.provenance !== undefined && input.provenance !== null) {
    const p = input.provenance as {
      integrity?: {
        politicalSha256?: string
        nineDashSegmentCount?: number
        islandCount?: number
        disputedRegionCount?: number
      }
    }
    const integrity = p.integrity
    if (integrity !== undefined) {
      if (typeof integrity.politicalSha256 === 'string') {
        if (input.politicalText === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.politicalSha256',
            message: '审计声明了 politicalSha256 但校验入参未提供 politicalText，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.politicalText, 'utf-8').digest('hex')
          if (recomputed !== integrity.politicalSha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.politicalSha256',
              message: `审计 politicalSha256=${integrity.politicalSha256} 与复算 ${recomputed} 不一致（政治边界载荷可能被替换或篡改）。`,
            })
          }
        }
      }
      // 数量统计锚点。
      const countChecks: Array<[string, number | undefined, number]> = [
        ['nineDashSegmentCount', integrity.nineDashSegmentCount, gaps.segmentCount],
        ['islandCount', integrity.islandCount, islandNames.size],
        ['disputedRegionCount', integrity.disputedRegionCount, disputedRegions.size],
      ]
      for (const [field, declared, actual] of countChecks) {
        if (typeof declared === 'number' && declared !== actual) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: `$.provenance.integrity.${field}`,
            message: `审计 ${field}=${declared} 与政治边界载荷复算 ${actual} 不一致。`,
          })
        }
      }
    }
  }

  const samples: PoliticalAssetSamples = {
    nineDashSegmentCount: gaps.segmentCount,
    islandCount: islandNames.size,
    disputedRegionCount: disputedRegions.size,
    observedWest: coordinateSeen ? observedWest : NaN,
    observedEast: coordinateSeen ? observedEast : NaN,
    observedSouth: coordinateSeen ? observedSouth : NaN,
    observedNorth: coordinateSeen ? observedNorth : NaN,
    hasTaiwanEastSegment: gaps.taiwanEastSegmentPresent,
  }

  return { ok: errors.length === 0, errors, samples }
}

/**
 * 校验来源注册表是否结构合法（CLI 路径读盘后用于单独判断 sourcesRegistry 可信）。
 * 导出以便测试在需要时复用同一判定（与 provinces-deep 同构）。
 */
export function isSourcesRegistryValid(sourcesRegistry: unknown): sourcesRegistry is DataSourceRegistryContract {
  return validateDataSourceRegistry(sourcesRegistry).ok
}
