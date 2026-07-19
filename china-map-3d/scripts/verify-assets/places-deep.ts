/**
 * 省名锚点与省级行政中心资产级深度校验（TASK-005）。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/verify-assets，tsx 运行），单向依赖
 * src/geo-contracts 契约层与同层 scripts/places/place-catalog（34 省 × 2 角色领域真值）。
 * 不依赖浏览器 / React / Three.js。被 CLI（scripts/verify-assets/run.ts 的 places scope）
 * 与测试基线（tests/assets/）共同复用，避免校验逻辑双轨：CLI 读盘后调用本函数，测试以篡改副本
 * 调用同一函数。
 *
 * 与 TASK-001 契约校验的关系：契约校验（validatePlaceDirectory）只验地点条目的字段结构
 * （id / adminId / role / name / coordinate / anchorAdjustmentNote）；本模块在其之上追加
 * 「资产级」不变量——
 *   恰好 34 个行政区 × (1 锚点 + 1 行政中心) = 68 条、adminId 集合与 34 省真值精确一致、
 *   每条 name 与真值一致、坐标落在中国主图 [72,3,136,54]、点落入对应省域几何（或附显式校正说明）、
 *   港 / 澳 / 台三者的锚点与行政中心均在、来源可解析、provenance 完整性摘要逐项一致。
 * 这些是 TASK-005 验证方式 1、2、3 的落点。
 *
 * 点位 - 省域几何包含校验（point-in-polygon，TASK-005 验证方式 2「点位落入对应行政区」）：
 * - 当入参提供 administrativeGeometry（生产省级边界资产）时，对每条地点坐标做射线法包含判定；
 *   任一非「已校正」坐标落在对应省域外即确定性失败。
 * - 「已校正」判定：地点条目携带非空 anchorAdjustmentNote 即视为已记录人工校正，
 *   跳过包含校验（SPEC §3.7、TASK-005「落入对应行政区或具有显式校正说明」）。
 *   未提供几何时跳过包含校验并在 samples 标记，避免「未检却假装通过」。
 *
 * 政治红线独立锚点（SPEC §6、TASK-005 验证方式 2「台湾、港澳...用例通过」）：
 * REQUIRED_POLITICAL_PLACE_IDS（CN-710000 / CN-810000 / CN-820000）在本模块**硬编码**，
 * 不经 PLACE_CATALOG 间接得出。即便有人误删 catalog 中的台湾 / 港澳，本锚点仍要求资产必须含三者的
 * 锚点与行政中心，校验随之确定性失败。九段线 / 南海岛礁 / 钓鱼岛 / 藏南 / 阿克赛钦完整国标画法
 * 由 TASK-006 闭环，本 TASK 不得越权声称已完成。
 */

import { createHash } from 'node:crypto'
import {
  CHINA_MAIN_MAP_EXTENT,
  validatePlaceDirectory,
  validateContractBundle,
} from '../../src/geo-contracts/index'
import {
  EXPECTED_PLACE_ENTRY_COUNT,
  EXPECTED_PLACE_PROVINCE_COUNT,
  PLACE_CATALOG,
  PLACE_ENTRIES_PER_PROVINCE,
  REQUIRED_POLITICAL_PLACE_IDS,
  type PlaceCatalogEntry,
} from '../places/place-catalog'

/**
 * 资产级坐标范围容差（度）。
 * 中国主图范围 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）已覆盖全部省会与锚点坐标
 * （实测落在 [87.6,121.6]×[22.2,45.8]），用 1e-9 只吸收浮点误差，不做实质放宽。
 */
const EXTENT_EPSILON = 1e-9

/** 资产级校验错误码前缀（与 provinces-asset 同构）。契约 / bundle 原始错误码保留，此处只登记资产级独有不变量。 */
const ASSET_ERROR_CODES = {
  entryCount: 'places-asset.entry-count',
  adminCount: 'places-asset.admin-count',
  rolePair: 'places-asset.role-pair',
  idSetMismatch: 'places-asset.id-set-mismatch',
  nameMismatch: 'places-asset.name-mismatch',
  missingPoliticalId: 'places-asset.missing-political-id',
  coordinateOutOfExtent: 'places-asset.coordinate-out-of-extent',
  pointOutsideProvince: 'places-asset.point-outside-province',
  provenanceIntegrityMismatch: 'places-asset.provenance-integrity-mismatch',
} as const

/** 单条资产级错误。结构与契约层 ContractValidationError 对齐，便于 CLI 统一打印。 */
export interface PlacesAssetError {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** 资产级校验结果。 */
export interface PlacesAssetOutcome {
  readonly ok: boolean
  readonly errors: readonly PlacesAssetError[]
  /** 抽样摘要（数量、角色构成、是否做了几何包含校验），供 CLI 与测试观察，非错误项。 */
  readonly samples: PlacesAssetSamples
}

/** 抽样摘要：条目数、行政区数、角色构成、调整锚点数、包含校验状态。 */
export interface PlacesAssetSamples {
  readonly entryCount: number
  readonly adminCount: number
  readonly anchorCount: number
  readonly capitalCount: number
  readonly adjustedAnchorCount: number
  /** 几何包含校验是否实际执行（未提供几何时为 false，避免「未检却假装通过」）。 */
  readonly containmentChecked: boolean
}

/** 深度校验入参：地点目录 + 可选省级目录 / 几何 / 来源注册表 / 审计 sidecar / 原始文本（哈希核对）。 */
export interface PlacesAssetVerificationInput {
  readonly places: unknown
  readonly provinceDirectory?: unknown
  readonly provinceGeometry?: unknown
  readonly sourcesRegistry?: unknown
  readonly provenance?: unknown
  /** 地点目录 JSON 原始文本（与落盘字节同源），用于复算 SHA-256 防篡改锚点；核对 provenance 时需要。 */
  readonly placesText?: string
}

/** 地点条目（运行时最小形状）。 */
interface PlaceEntryShape {
  id?: string
  adminId?: string
  role?: string
  name?: string
  coordinate?: { lon?: number; lat?: number }
  anchorAdjustmentNote?: string
}

/** 几何条目（运行时最小形状，与 provinces-deep 同构）。 */
interface GeometryFeatureShape {
  adminId?: string
  geometry?: {
    type?: string
    rings?: Array<Array<{ lon?: number; lat?: number }>>
    polygons?: Array<{ rings?: Array<Array<{ lon?: number; lat?: number }>> }>
  }
}

/** 由真值派生的查找表：按 adminId 取 shortName / capitalName，用于 name 一致性比对。 */
interface CatalogTruth {
  shortName: string
  capitalName: string
}
const CATALOG_BY_ID: ReadonlyMap<string, CatalogTruth> = new Map(
  PLACE_CATALOG.map((entry: PlaceCatalogEntry) => [
    entry.id,
    { shortName: entry.shortName, capitalName: entry.capitalName },
  ]),
)

/** 射线法判定点是否在一个环（外环或内环）的多边形内部。 */
function pointInRing(lon: number, lat: number, ring: Array<{ lon?: number; lat?: number }>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon
    const yi = ring[i].lat
    const xj = ring[j].lon
    const yj = ring[j].lat
    if (typeof xi !== 'number' || typeof yi !== 'number' || typeof xj !== 'number' || typeof yj !== 'number') {
      continue
    }
    // 纬度跨越测试经向半线时，计算交点经度做内外翻转判定（经典射线法）。
    const intersect = ((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * 点是否在一个多边形（rings[0] 外环，rings[1..] 内环 / 洞）内部。
 * 在外环内 且 不在任何内环内 → 内部。
 */
function pointInPolygonRings(lon: number, lat: number, rings: Array<Array<{ lon?: number; lat?: number }>>): boolean {
  if (rings.length === 0) return false
  if (!pointInRing(lon, lat, rings[0])) return false
  for (let k = 1; k < rings.length; k++) {
    if (pointInRing(lon, lat, rings[k])) return false
  }
  return true
}

/**
 * 点是否在行政区几何内部（Polygon 或 MultiPolygon）。
 * MultiPolygon：任一多边形包含即视为内部（岛屿 / 飞地多块的省）。
 */
function pointInGeometry(lon: number, lat: number, geometry: GeometryFeatureShape['geometry']): boolean {
  if (!geometry) return false
  if (geometry.type === 'Polygon' && Array.isArray(geometry.rings)) {
    return pointInPolygonRings(lon, lat, geometry.rings)
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.polygons)) {
    return geometry.polygons.some((polygon) =>
      polygon && Array.isArray(polygon.rings) ? pointInPolygonRings(lon, lat, polygon.rings) : false,
    )
  }
  return false
}

/** 资产级深度校验主入口：返回通过 / 失败 + 抽样摘要。 */
export function verifyPlacesAsset(input: PlacesAssetVerificationInput): PlacesAssetOutcome {
  const errors: PlacesAssetError[] = []

  // 1) 地点目录契约结构校验（复用 TASK-001 校验器）。保留原始错误码，
  //    使 place-directory.duplicate-id 等可被测试精确断言（与 provinces-deep 同构）。
  const placesOutcome = validatePlaceDirectory(input.places)
  if (!placesOutcome.ok) {
    for (const e of placesOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }

  // 2) 跨契约引用核对：sourceId 解析 + adminId 解析（地点 ↔ 省级目录）。保留 bundle 原始错误码。
  if (input.sourcesRegistry !== undefined || input.provinceDirectory !== undefined) {
    const bundleOutcome = validateContractBundle({
      sources: input.sourcesRegistry,
      administrativeDirectory: input.provinceDirectory,
      placeDirectory: input.places,
    })
    if (!bundleOutcome.ok) {
      for (const e of bundleOutcome.errors) {
        errors.push({ code: e.code, path: e.path, message: e.message })
      }
    }
  }

  const places = input.places as { entries?: PlaceEntryShape[] }
  const entries = Array.isArray(places.entries) ? places.entries : []

  // 抽样摘要默认值（结构非法时用 0 占位，避免后续比较引用 NaN / undefined）。
  let samples: PlacesAssetSamples = {
    entryCount: entries.length,
    adminCount: new Set(entries.map((e) => e.adminId).filter((v): v is string => typeof v === 'string')).size,
    anchorCount: 0,
    capitalCount: 0,
    adjustedAnchorCount: 0,
    containmentChecked: false,
  }

  // 3) 恰好 68 条地点条目（34 省 × 2 角色，由真值常量派生，而非「条目数自洽」）。
  if (entries.length !== EXPECTED_PLACE_ENTRY_COUNT) {
    errors.push({
      code: ASSET_ERROR_CODES.entryCount,
      path: '$.entries',
      message: `地点目录必须恰好含 ${EXPECTED_PLACE_ENTRY_COUNT} 条（${EXPECTED_PLACE_PROVINCE_COUNT} 省 × ${PLACE_ENTRIES_PER_PROVINCE} 角色），实际为 ${entries.length}。`,
    })
  }

  // 4) 恰好 34 个唯一行政区（每省恰一对锚点 + 行政中心）。
  const adminToAnchors = new Map<string, number>()
  const adminToCapitals = new Map<string, number>()
  let anchorCount = 0
  let capitalCount = 0
  let adjustedAnchorCount = 0
  for (const entry of entries) {
    if (entry.role === 'provinceNameAnchor') {
      anchorCount++
      if (entry.anchorAdjustmentNote !== undefined && entry.anchorAdjustmentNote.trim().length > 0) {
        adjustedAnchorCount++
      }
      adminToAnchors.set(entry.adminId ?? '__missing__', (adminToAnchors.get(entry.adminId ?? '__missing__') ?? 0) + 1)
    } else if (entry.role === 'administrativeCapital') {
      capitalCount++
      adminToCapitals.set(entry.adminId ?? '__missing__', (adminToCapitals.get(entry.adminId ?? '__missing__') ?? 0) + 1)
    }
  }

  const uniqueAdminIds = new Set(
    entries.map((e) => e.adminId).filter((v): v is string => typeof v === 'string'),
  )
  if (uniqueAdminIds.size !== EXPECTED_PLACE_PROVINCE_COUNT) {
    errors.push({
      code: ASSET_ERROR_CODES.adminCount,
      path: '$.entries',
      message: `地点目录必须恰好覆盖 ${EXPECTED_PLACE_PROVINCE_COUNT} 个省级行政区，实际为 ${uniqueAdminIds.size}。`,
    })
  }

  // 5) 每个行政区恰有 1 个锚点 + 1 个行政中心（缺失 / 重复 / 关联到其他行政区都失败）。
  //    以 34 真值为基准逐项核对，任一行政区锚点数 ≠ 1 或 行政中心数 ≠ 1 即失败。
  const rolePairViolations: string[] = []
  for (const catalogEntry of PLACE_CATALOG) {
    const anchors = adminToAnchors.get(catalogEntry.id) ?? 0
    const capitals = adminToCapitals.get(catalogEntry.id) ?? 0
    if (anchors !== 1 || capitals !== 1) {
      rolePairViolations.push(`${catalogEntry.id}（锚点 ${anchors} / 行政中心 ${capitals}）`)
    }
  }
  // 也捕捉「关联到非 34 真值行政区」的游离 adminId。
  for (const adminId of uniqueAdminIds) {
    if (!CATALOG_BY_ID.has(adminId)) {
      rolePairViolations.push(`${adminId}（不在 34 省真值内）`)
    }
  }
  if (rolePairViolations.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.rolePair,
      path: '$.entries',
      message: `每个行政区必须恰有 1 个锚点 + 1 个行政中心，违规：${rolePairViolations.join('、')}。`,
    })
  }

  // 6) adminId 集合必须与 34 省真值精确一致（防止多 / 少一个非预期行政区）。
  const catalogIds = new Set(PLACE_CATALOG.map((e) => e.id))
  const extraInPlaces = [...uniqueAdminIds].filter((id) => !catalogIds.has(id))
  const missingFromPlaces = [...catalogIds].filter((id) => !uniqueAdminIds.has(id))
  if (extraInPlaces.length > 0 || missingFromPlaces.length > 0) {
    errors.push({
      code: ASSET_ERROR_CODES.idSetMismatch,
      path: '$.entries',
      message: `地点目录 adminId 集合与 34 省真值不一致：多余 [${extraInPlaces.join(',')}]，缺失 [${missingFromPlaces.join(',')}]。`,
    })
  }

  // 7) 每条 name 必须与真值一致（锚点 = shortName；行政中心 = capitalName）。
  for (const entry of entries) {
    const truth = typeof entry.adminId === 'string' ? CATALOG_BY_ID.get(entry.adminId) : undefined
    if (truth === undefined) continue
    const expectedName = entry.role === 'provinceNameAnchor' ? truth.shortName : truth.capitalName
    if (entry.name !== expectedName) {
      errors.push({
        code: ASSET_ERROR_CODES.nameMismatch,
        path: `$.entries[id=${entry.id}]`,
        message: `地点条目 name 与真值不符：实际 ${entry.name}，期望 ${expectedName}（adminId=${entry.adminId} role=${entry.role}）。`,
      })
    }
  }

  // 8) 政治红线：港 / 澳 / 台必须各有锚点与行政中心（硬编码锚点，独立于真值）。
  for (const requiredId of REQUIRED_POLITICAL_PLACE_IDS) {
    if ((adminToAnchors.get(requiredId) ?? 0) < 1) {
      errors.push({
        code: ASSET_ERROR_CODES.missingPoliticalId,
        path: '$.entries',
        message: `地点目录缺少 ${requiredId} 的 provinceNameAnchor（港 / 澳 / 台之一），SPEC §6 红线。`,
      })
    }
    if ((adminToCapitals.get(requiredId) ?? 0) < 1) {
      errors.push({
        code: ASSET_ERROR_CODES.missingPoliticalId,
        path: '$.entries',
        message: `地点目录缺少 ${requiredId} 的 administrativeCapital（港 / 澳 / 台之一），SPEC §6 红线。`,
      })
    }
  }

  // 9) 坐标范围：所有坐标落在中国主图 [72,3,136,54]（codes.CHINA_MAIN_MAP_EXTENT）。
  for (const entry of entries) {
    const c = entry.coordinate
    if (!c || typeof c.lon !== 'number' || typeof c.lat !== 'number') continue
    if (
      c.lon < CHINA_MAIN_MAP_EXTENT.west - EXTENT_EPSILON ||
      c.lon > CHINA_MAIN_MAP_EXTENT.east + EXTENT_EPSILON ||
      c.lat < CHINA_MAIN_MAP_EXTENT.south - EXTENT_EPSILON ||
      c.lat > CHINA_MAIN_MAP_EXTENT.north + EXTENT_EPSILON
    ) {
      errors.push({
        code: ASSET_ERROR_CODES.coordinateOutOfExtent,
        path: `$.entries[id=${entry.id}].coordinate`,
        message: `${entry.id} 的坐标 (${c.lon},${c.lat}) 超出中国主图范围 [${CHINA_MAIN_MAP_EXTENT.west},${CHINA_MAIN_MAP_EXTENT.south},${CHINA_MAIN_MAP_EXTENT.east},${CHINA_MAIN_MAP_EXTENT.north}]。`,
      })
    }
  }

  // 10) 点位 - 省域几何包含（TASK-005 验证方式 2）。仅当提供几何时执行；未提供则在 samples 标记未检。
  let containmentChecked = false
  if (input.provinceGeometry !== undefined) {
    containmentChecked = true
    const geometryPayload = input.provinceGeometry as { features?: GeometryFeatureShape[] }
    const features = Array.isArray(geometryPayload.features) ? geometryPayload.features : []
    const geometryById = new Map<string, GeometryFeatureShape['geometry']>()
    for (const feature of features) {
      if (typeof feature.adminId === 'string') {
        geometryById.set(feature.adminId, feature.geometry)
      }
    }
    for (const entry of entries) {
      const c = entry.coordinate
      if (!c || typeof c.lon !== 'number' || typeof c.lat !== 'number') continue
      // 已附显式校正说明 → 跳过包含校验（SPEC §3.7、TASK-005「落入对应行政区或具有显式校正说明」）。
      if (entry.anchorAdjustmentNote !== undefined && entry.anchorAdjustmentNote.trim().length > 0) continue
      const geometry = typeof entry.adminId === 'string' ? geometryById.get(entry.adminId) : undefined
      if (geometry === undefined) continue // 几何缺失由 provinces scope / bundle 校验负责，此处不重复报。
      if (!pointInGeometry(c.lon, c.lat, geometry)) {
        errors.push({
          code: ASSET_ERROR_CODES.pointOutsideProvince,
          path: `$.entries[id=${entry.id}].coordinate`,
          message: `${entry.id}（${entry.name}）的坐标 (${c.lon},${c.lat}) 未落入对应行政区 ${entry.adminId} 的几何，且未附 anchorAdjustmentNote 校正说明。`,
        })
      }
    }
  }

  samples = {
    entryCount: entries.length,
    adminCount: uniqueAdminIds.size,
    anchorCount,
    capitalCount,
    adjustedAnchorCount,
    containmentChecked,
  }

  // 11) 审计 sidecar 完整性比对（防篡改锚点，与 TASK-003 / TASK-004 provenance 同构）。
  if (input.provenance !== undefined && input.provenance !== null) {
    const p = input.provenance as {
      integrity?: {
        placesSha256?: string
        entryCount?: number
        anchorCount?: number
        capitalCount?: number
        adjustedAnchorCount?: number
      }
    }
    const integrity = p.integrity
    if (integrity !== undefined) {
      if (typeof integrity.placesSha256 === 'string') {
        if (input.placesText === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.placesSha256',
            message: '审计声明了 placesSha256 但校验入参未提供 placesText，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.placesText, 'utf-8').digest('hex')
          if (recomputed !== integrity.placesSha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.placesSha256',
              message: `审计 placesSha256=${integrity.placesSha256} 与复算 ${recomputed} 不一致（地点目录可能被替换或篡改）。`,
            })
          }
        }
      }
      // 数量统计锚点（结构合法、统计量可信时比对）。
      const countChecks: Array<[string, number | undefined, number]> = [
        ['entryCount', integrity.entryCount, entries.length],
        ['anchorCount', integrity.anchorCount, anchorCount],
        ['capitalCount', integrity.capitalCount, capitalCount],
        ['adjustedAnchorCount', integrity.adjustedAnchorCount, adjustedAnchorCount],
      ]
      for (const [field, declared, actual] of countChecks) {
        if (typeof declared === 'number' && declared !== actual) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: `$.provenance.integrity.${field}`,
            message: `审计 ${field}=${declared} 与地点目录复算 ${actual} 不一致。`,
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, samples }
}
