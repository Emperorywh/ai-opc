/**
 * 省级边界资产级深度校验。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/verify-assets，tsx 运行），单向依赖
 * src/geo-contracts 契约层与同层 scripts/provinces/province-catalog（34 省目录 adcode 视图）。
 * 不依赖浏览器 / React / Three.js。被 CLI（scripts/verify-assets/run.ts 的 provinces scope）
 * 与测试基线（tests/assets/）共同复用，避免校验逻辑双轨：CLI 读盘后调用本函数，测试以篡改副本
 * 调用同一函数。
 *
 * 与契约校验的关系：契约校验（validateAdministrativeDirectory / validateAdministrativeGeometry）
 * 只验目录与几何的字段结构；本模块在其之上追加「资产级」不变量——
 *   恰好 34 省、港 / 澳 / 台必在、目录与几何一一对应（双射）、与 34 省目录真值精确一致、
 *   所有环闭合、坐标落在中国主图范围、来源可解析、provenance 完整性摘要逐项一致。
 *
 * 政治红线独立锚点（SPEC §6「港澳齐」「台湾省正常呈现」）：
 * REQUIRED_POLITICAL_IDS（CN-710000 / CN-810000 / CN-820000）在本模块**硬编码**，
 * 不经 PROVINCE_CATALOG 间接得出。即便有人误删 catalog 中的台湾 / 港澳，本锚点仍要求资产必须含三者，
 * 校验随之确定性失败。九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦的红线由 political-deep.ts
 * 独立闭环，本模块不得越权声称已完成。
 */

import { createHash } from 'node:crypto'
import {
  CHINA_MAIN_MAP_EXTENT,
  validateAdministrativeDirectory,
  validateAdministrativeGeometry,
  validateContractBundle,
  validateDataSourceRegistry,
  type DataSourceRegistryContract,
} from '../../src/geo-contracts/index'
import {
  EXPECTED_PROVINCE_COUNT,
  PROVINCE_CATALOG,
  REQUIRED_POLITICAL_IDS,
  type ProvinceCatalogEntry,
} from '../provinces/province-catalog'

/**
 * 资产级坐标范围容差（度）。
 * 中国主图范围 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）已为省级边界留出余量
 * （实测 34 省落在大致 [73.5,135.1]×[3.8,53.6]），用 1e-9 只吸收浮点误差，不做实质放宽。
 */
const EXTENT_EPSILON = 1e-9

/** 资产级校验错误码前缀。
 *
 * 契约结构错误（validateAdministrativeDirectory / validateAdministrativeGeometry）与跨契约引用错误
 * （validateContractBundle）保留其原始 code（如 admin-directory.duplicate-id、bundle.unresolved-source-id），
 * 与 terrain-deep 同构——便于测试精确断言、与契约层错误码命名约定一致。这里只登记「契约之外、
 * 资产级独有」的不变量错误码。
 */
const ASSET_ERROR_CODES = {
  directoryCount: 'provinces-asset.directory-count',
  geometryCount: 'provinces-asset.geometry-count',
  missingPoliticalId: 'provinces-asset.missing-political-id',
  bijectionMismatch: 'provinces-asset.bijection-mismatch',
  idSetMismatch: 'provinces-asset.id-set-mismatch',
  entryFieldMismatch: 'provinces-asset.entry-field-mismatch',
  ringNotClosed: 'provinces-asset.ring-not-closed',
  coordinateOutOfExtent: 'provinces-asset.coordinate-out-of-extent',
  provenanceIntegrityMismatch: 'provinces-asset.provenance-integrity-mismatch',
} as const

/** 单条资产级错误。结构与契约层 ContractValidationError 对齐，便于 CLI 统一打印。 */
export interface ProvincesAssetError {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** 资产级校验结果。 */
export interface ProvincesAssetOutcome {
  readonly ok: boolean
  readonly errors: readonly ProvincesAssetError[]
  /** 抽样摘要（数量、类型构成、坐标四至），供 CLI 与测试观察，非错误项。 */
  readonly samples: ProvincesAssetSamples
}

/** 抽样摘要：数量、类型构成与全量坐标四至。 */
export interface ProvincesAssetSamples {
  readonly directoryCount: number
  readonly geometryCount: number
  readonly typeBreakdown: { readonly province: number; readonly autonomousRegion: number; readonly municipality: number; readonly specialAdministrativeRegion: number }
  readonly geometryTypeBreakdown: { readonly polygon: number; readonly multiPolygon: number }
  readonly observedWest: number
  readonly observedEast: number
  readonly observedSouth: number
  readonly observedNorth: number
  readonly polygonCount: number
  readonly ringCount: number
  readonly coordinateCount: number
}

/** 深度校验入参：目录 + 几何 + 可选来源注册表 / 审计 sidecar / 原始文本（用于哈希核对）。 */
export interface ProvincesAssetVerificationInput {
  readonly directory: unknown
  readonly geometry: unknown
  readonly sourcesRegistry?: unknown
  readonly provenance?: unknown
  /** 目录 JSON 原始文本（与落盘字节同源），用于复算 SHA-256 防篡改锚点；核对 provenance 时需要。 */
  readonly directoryText?: string
  /** 几何 JSON 原始文本，用途同上。 */
  readonly geometryText?: string
}

/** 目录条目（运行时最小形状）。 */
interface DirectoryEntryShape {
  id?: string
  name?: string
  type?: string
}

/** 几何条目（运行时最小形状）。 */
interface GeometryFeatureShape {
  adminId?: string
  geometry?: {
    type?: string
    rings?: Array<Array<{ lon?: number; lat?: number }>>
    polygons?: Array<{ rings?: Array<Array<{ lon?: number; lat?: number }>> }>
  }
}

/** 由目录真值派生的查找表，按 id 比对 name / type。 */
const CATALOG_BY_ID: ReadonlyMap<string, ProvinceCatalogEntry> = new Map(
  PROVINCE_CATALOG.map((entry) => [entry.id, entry]),
)

/**
 * 遍历几何的所有环，回调每个环（含其归属 adminId 与 JSON 路径前缀）。
 * Polygon 与 MultiPolygon 按各自的环层级展开，统一交给环级检查（闭合 / 坐标范围）消费。
 */
function forEachRing(
  features: readonly GeometryFeatureShape[],
  visitor: (adminId: string, ringPath: string, ring: Array<{ lon?: number; lat?: number }>) => void,
): void {
  for (const feature of features) {
    const adminId = feature.adminId ?? '<?>'
    const geometry = feature.geometry
    if (!geometry) continue
    if (geometry.type === 'Polygon' && Array.isArray(geometry.rings)) {
      geometry.rings.forEach((ring, ringIndex) => {
        visitor(adminId, `$.features[adminId=${adminId}].geometry.rings[${ringIndex}]`, ring)
      })
    } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.polygons)) {
      geometry.polygons.forEach((polygon, polygonIndex) => {
        if (!polygon || !Array.isArray(polygon.rings)) return
        polygon.rings.forEach((ring, ringIndex) => {
          visitor(
            adminId,
            `$.features[adminId=${adminId}].geometry.polygons[${polygonIndex}].rings[${ringIndex}]`,
            ring,
          )
        })
      })
    }
  }
}

/** 资产级深度校验主入口：返回通过 / 失败 + 抽样摘要。 */
export function verifyProvincesAsset(input: ProvincesAssetVerificationInput): ProvincesAssetOutcome {
  const errors: ProvincesAssetError[] = []

  // 1) 目录与几何各自的契约结构校验（复用契约层校验器）。保留原始错误码，
  //    使 admin-directory.duplicate-id 等可被测试精确断言（与 terrain-deep 同构）。
  const dirOutcome = validateAdministrativeDirectory(input.directory)
  if (!dirOutcome.ok) {
    for (const e of dirOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }
  const geoOutcome = validateAdministrativeGeometry(input.geometry)
  if (!geoOutcome.ok) {
    for (const e of geoOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }

  // 2) 跨契约引用核对：sourceId 解析 + adminId 解析（目录 ↔ 几何）。保留 bundle 原始错误码。
  if (input.sourcesRegistry !== undefined) {
    const bundleOutcome = validateContractBundle({
      sources: input.sourcesRegistry as DataSourceRegistryContract,
      administrativeDirectory: input.directory,
      administrativeGeometry: input.geometry,
    })
    if (!bundleOutcome.ok) {
      for (const e of bundleOutcome.errors) {
        errors.push({ code: e.code, path: e.path, message: e.message })
      }
    }
  }

  const directory = input.directory as { entries?: DirectoryEntryShape[]; source?: { sourceId?: string } }
  const geometry = input.geometry as { features?: GeometryFeatureShape[]; source?: { sourceId?: string } }
  const entries = Array.isArray(directory.entries) ? directory.entries : []
  const features = Array.isArray(geometry.features) ? geometry.features : []

  // 抽样摘要默认值（结构非法时用 0 占位，避免后续比较引用 NaN / undefined）。
  let samples: ProvincesAssetSamples = {
    directoryCount: entries.length,
    geometryCount: features.length,
    typeBreakdown: { province: 0, autonomousRegion: 0, municipality: 0, specialAdministrativeRegion: 0 },
    geometryTypeBreakdown: { polygon: 0, multiPolygon: 0 },
    observedWest: NaN,
    observedEast: NaN,
    observedSouth: NaN,
    observedNorth: NaN,
    polygonCount: 0,
    ringCount: 0,
    coordinateCount: 0,
  }

  // 3) 恰好 34 个目录条目（与目录真值常量比较，而非「目录长度自洽」）。
  if (entries.length !== EXPECTED_PROVINCE_COUNT) {
    errors.push({
      code: ASSET_ERROR_CODES.directoryCount,
      path: '$.entries',
      message: `省级行政区目录必须恰好含 ${EXPECTED_PROVINCE_COUNT} 个条目，实际为 ${entries.length}。`,
    })
  }
  // 几何条目数也必须恰好 34（每个行政区一份几何）。
  if (features.length !== EXPECTED_PROVINCE_COUNT) {
    errors.push({
      code: ASSET_ERROR_CODES.geometryCount,
      path: '$.features',
      message: `省级行政区几何必须恰好含 ${EXPECTED_PROVINCE_COUNT} 个要素，实际为 ${features.length}。`,
    })
  }

  const directoryIds = new Set(entries.map((e) => e.id).filter((v): v is string => typeof v === 'string'))
  const geometryIds = new Set(features.map((f) => f.adminId).filter((v): v is string => typeof v === 'string'))

  // 4) 政治红线：港 / 澳 / 台必须存在（硬编码锚点，独立于目录真值）。
  for (const requiredId of REQUIRED_POLITICAL_IDS) {
    if (!directoryIds.has(requiredId)) {
      errors.push({
        code: ASSET_ERROR_CODES.missingPoliticalId,
        path: '$.entries',
        message: `省级行政区目录缺少政治必备项 ${requiredId}（港 / 澳 / 台之一），SPEC §6 红线。`,
      })
    }
    if (!geometryIds.has(requiredId)) {
      errors.push({
        code: ASSET_ERROR_CODES.missingPoliticalId,
        path: '$.features',
        message: `省级行政区几何缺少政治必备项 ${requiredId}（港 / 澳 / 台之一），SPEC §6 红线。`,
      })
    }
  }

  // 5) 目录 ↔ 几何双射：id 集合必须完全一致（每个目录条目有且仅有一份几何，反之亦然）。
  const sameSize = directoryIds.size === geometryIds.size
  const dirOnly = [...directoryIds].filter((id) => !geometryIds.has(id))
  const geoOnly = [...geometryIds].filter((id) => !directoryIds.has(id))
  if (!sameSize || dirOnly.length > 0 || geoOnly.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.bijectionMismatch,
      path: '$',
      message:
        `行政区目录与几何未构成一一对应：仅目录有 [${dirOnly.join(',')}]，仅几何有 [${geoOnly.join(',')}]。`,
    })
  }

  // 6) 目录 id 集合必须与 34 省目录真值精确一致（防止多 / 少一个非预期行政区）。
  const catalogIds = new Set(PROVINCE_CATALOG.map((e) => e.id))
  const extraInDir = [...directoryIds].filter((id) => !catalogIds.has(id))
  const missingFromDir = [...catalogIds].filter((id) => !directoryIds.has(id))
  if (extraInDir.length > 0 || missingFromDir.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.idSetMismatch,
      path: '$.entries',
      message:
        `目录 id 集合与 34 省目录真值不一致：多余 [${extraInDir.join(',')}]，缺失 [${missingFromDir.join(',')}]。`,
    })
  }

  // 7) 每个目录条目的 name / type 必须与目录真值精确一致（防止改名 / 改类型而 id 不变）。
  const typeBreakdown = { province: 0, autonomousRegion: 0, municipality: 0, specialAdministrativeRegion: 0 }
  for (const entry of entries) {
    const catalogEntry = typeof entry.id === 'string' ? CATALOG_BY_ID.get(entry.id) : undefined
    if (catalogEntry === undefined) continue
    if (entry.name !== catalogEntry.name || entry.type !== catalogEntry.type) {
      errors.push({
        code: ASSET_ERROR_CODES.entryFieldMismatch,
        path: `$.entries[id=${entry.id}]`,
        message: `目录条目字段与真值不符：实际 name=${entry.name} type=${entry.type}，期望 name=${catalogEntry.name} type=${catalogEntry.type}。`,
      })
    }
    if (entry.type === 'province' || entry.type === 'autonomousRegion' || entry.type === 'municipality' || entry.type === 'specialAdministrativeRegion') {
      typeBreakdown[entry.type]++
    }
  }

  // 结构校验通过后，再做几何内容级检查（环闭合 / 坐标范围 / 统计量），否则在脏数据上产生噪声错误。
  const structureOk = dirOutcome.ok && geoOutcome.ok
  let observedWest = Infinity
  let observedEast = -Infinity
  let observedSouth = Infinity
  let observedNorth = -Infinity
  let polygonCount = 0
  let ringCount = 0
  let coordinateCount = 0
  const geometryTypeBreakdown = { polygon: 0, multiPolygon: 0 }

  if (structureOk) {
    for (const feature of features) {
      const g = feature.geometry
      if (!g) continue
      if (g.type === 'Polygon') geometryTypeBreakdown.polygon++
      else if (g.type === 'MultiPolygon') geometryTypeBreakdown.multiPolygon++
    }

    // 8) 环闭合：每个环首尾点必须重合（lon 与 lat 都相等）。
    //    9) 坐标范围：所有坐标落在中国主图 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）。
    forEachRing(features, (adminId, ringPath, ring) => {
      ringCount++
      polygonCount++ // 与生产侧 computeGeometryIntegritySummary 口径一致：每个环计为一个多边形。
      if (ring.length === 0) return
      const first = ring[0]
      const last = ring[ring.length - 1]
      if (
        typeof first.lon !== 'number' || typeof first.lat !== 'number' ||
        typeof last.lon !== 'number' || typeof last.lat !== 'number' ||
        Math.abs(first.lon - last.lon) > EXTENT_EPSILON ||
        Math.abs(first.lat - last.lat) > EXTENT_EPSILON
      ) {
        errors.push({
          code: ASSET_ERROR_CODES.ringNotClosed,
          path: ringPath,
          message: `${adminId} 的环未闭合：首点与尾点不重合。资产级要求所有环首尾重合（DataV 原始环已闭合）。`,
        })
      }
      for (const coord of ring) {
        coordinateCount++
        const lon = coord.lon
        const lat = coord.lat
        if (typeof lon !== 'number' || typeof lat !== 'number') continue
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
            path: ringPath,
            message: `${adminId} 的坐标 (${lon},${lat}) 超出中国主图范围 [${CHINA_MAIN_MAP_EXTENT.west},${CHINA_MAIN_MAP_EXTENT.south},${CHINA_MAIN_MAP_EXTENT.east},${CHINA_MAIN_MAP_EXTENT.north}]。`,
          })
        }
      }
    })

    samples = {
      directoryCount: entries.length,
      geometryCount: features.length,
      typeBreakdown,
      geometryTypeBreakdown,
      observedWest,
      observedEast,
      observedSouth,
      observedNorth,
      polygonCount,
      ringCount,
      coordinateCount,
    }
  }

  // 10) 审计 sidecar 完整性比对（防篡改锚点，与 terrain provenance 同构）。
  //     provenance.integrity 声明 sourcePayloadSha256 / directorySha256 / geometrySha256 与数量统计；
  //     校验侧逐项复算比对，避免「声明锚点但不闭环」的装饰性校验。
  if (input.provenance !== undefined && input.provenance !== null) {
    const p = input.provenance as {
      integrity?: {
        sourcePayloadSha256?: string
        directorySha256?: string
        geometrySha256?: string
        featureCount?: number
        polygonCount?: number
        ringCount?: number
        coordinateCount?: number
      }
    }
    const integrity = p.integrity
    if (integrity !== undefined) {
      // 目录 / 几何 SHA-256：对原始文本复算，须与审计声明逐字符一致。
      if (typeof integrity.directorySha256 === 'string') {
        if (input.directoryText === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.directorySha256',
            message: '审计声明了 directorySha256 但校验入参未提供 directoryText，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.directoryText, 'utf-8').digest('hex')
          if (recomputed !== integrity.directorySha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.directorySha256',
              message: `审计 directorySha256=${integrity.directorySha256} 与复算 ${recomputed} 不一致（目录可能被替换或篡改）。`,
            })
          }
        }
      }
      if (typeof integrity.geometrySha256 === 'string') {
        if (input.geometryText === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.geometrySha256',
            message: '审计声明了 geometrySha256 但校验入参未提供 geometryText，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.geometryText, 'utf-8').digest('hex')
          if (recomputed !== integrity.geometrySha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.geometrySha256',
              message: `审计 geometrySha256=${integrity.geometrySha256} 与复算 ${recomputed} 不一致（几何可能被替换或篡改）。`,
            })
          }
        }
      }
      // 数量统计锚点（仅当结构校验通过、统计量可信时比对）。
      if (structureOk) {
        const countChecks: Array<[string, number | undefined, number]> = [
          ['featureCount', integrity.featureCount, features.length],
          ['polygonCount', integrity.polygonCount, polygonCount],
          ['ringCount', integrity.ringCount, ringCount],
          ['coordinateCount', integrity.coordinateCount, coordinateCount],
        ]
        for (const [field, declared, actual] of countChecks) {
          if (typeof declared === 'number' && declared !== actual) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: `$.provenance.integrity.${field}`,
              message: `审计 ${field}=${declared} 与几何复算 ${actual} 不一致。`,
            })
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, samples }
}

/**
 * 校验来源注册表是否结构合法（CLI 路径读盘后用于单独判断 sourcesRegistry 可信）。
 * 导出以便测试在需要时复用同一判定。
 */
export function isSourcesRegistryValid(sourcesRegistry: unknown): sourcesRegistry is DataSourceRegistryContract {
  return validateDataSourceRegistry(sourcesRegistry).ok
}
