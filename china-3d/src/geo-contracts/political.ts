/**
 * 政治边界补充数据契约（九段线含台湾东侧段、南海岛礁、争议区修正）。
 *
 * 依赖方向：契约层，依赖 codes.ts、errors.ts、geometry-primitives.ts、terrain.ts 的来源引用类型。
 * 政治边界补充数据由项目自行维护，明确「非官方审图数据」，3D 主图与 2D 南海附图复用同一份
 * 事实源，不得维护两套坐标（SPEC §5.3、§6、§8）。
 *
 * 冻结的不变量：
 * - 源坐标 CRS 固定为 EPSG:4326。
 * - 九段线以「段」为单位表达（segmentIndex），便于完整性清单逐段核对十段画法；
 *   段序号唯一且为正整数。完整红线核对（缺段、缺点、缺名称）由下游政治边界完整性 TASK
 *   在生产数据上执行，本契约只冻结结构与坐标合法性。
 * - 岛礁/附属岛屿点位必须携带规范名称。
 * - 争议区修正必须记录修正针对的区域与依据说明，保证可追溯、不可悄悄改写为「官方数据」。
 */

import {
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
  isRecognizedDataVersion,
} from './codes'
import {
  collectAdministrativeGeometryErrors,
  collectCoordinateErrors,
  collectCrsErrors,
  type AdministrativeGeometry,
  type LonLatCoordinate,
} from './geometry-primitives'
import { type DataSourceRef } from './terrain'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 九段线单段（十段画法中的一段折线，SPEC §6：含台湾东侧段）。 */
export interface NineDashLineSegmentFeature {
  readonly type: 'nineDashLineSegment'
  /** 段序号（1 起），用于完整性清单逐段核对。 */
  readonly segmentIndex: number
  /** 该段折线的经纬度顶点序列。 */
  readonly coordinates: readonly LonLatCoordinate[]
}

/** 岛礁或附属岛屿点位（南海诸岛、钓鱼岛、赤尾屿等，SPEC §6）。 */
export interface IslandOrReefPointFeature {
  readonly type: 'islandOrReefPoint'
  /** 规范名称（如「钓鱼岛」「曾母暗沙」），不得为空。 */
  readonly name: string
  readonly coordinate: LonLatCoordinate
}

/** 争议区边界修正（藏南、阿克赛钦等，按中国主张画法，SPEC §6）。 */
export interface DisputedBoundaryCorrectionFeature {
  readonly type: 'disputedBoundaryCorrection'
  /** 修正针对的区域名（如「藏南」「阿克赛钦」）。 */
  readonly targetRegion: string
  /** 修正后的边界几何。 */
  readonly geometry: AdministrativeGeometry
  /** 修正依据说明（来源、画法标准），保证可追溯。 */
  readonly basis: string
}

/** 政治边界补充要素的判别联合。 */
export type PoliticalBoundaryFeature =
  | NineDashLineSegmentFeature
  | IslandOrReefPointFeature
  | DisputedBoundaryCorrectionFeature

/** 政治边界补充数据契约主体（对应 SPEC §5.3 九段线/岛礁项目内补全数据）。 */
export interface PoliticalBoundaryContract {
  readonly kind: 'political-boundary'
  readonly version: string
  /** 坐标参考系，固定 EPSG:4326。 */
  readonly crs: 'EPSG:4326'
  readonly features: readonly PoliticalBoundaryFeature[]
  readonly source: DataSourceRef
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 政治边界补充数据校验器。 */
export function validatePoliticalBoundary(payload: unknown): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('political-boundary.not-object', '$', '政治边界补充数据必须为对象。')])
  }
  const record = payload as Partial<PoliticalBoundaryContract>
  const errors = []

  if (record.kind !== 'political-boundary') {
    errors.push(
      error('political-boundary.wrong-kind', '$.kind', '政治边界补充数据的 kind 必须为 "political-boundary"。'),
    )
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'political-boundary.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  errors.push(...collectCrsErrors(record.crs, '$.crs', KNOWN_COORDINATE_REFERENCE_SYSTEMS.EPSG_4326))

  if (!Array.isArray(record.features)) {
    errors.push(error('political-boundary.features-not-array', '$.features', 'features 必须为数组。'))
    return invalid(errors)
  }
  if (record.features.length === 0) {
    errors.push(error('political-boundary.empty-features', '$.features', 'features 不得为空。'))
  }

  const seenSegmentIndices = new Set<number>()
  record.features.forEach((feature, index) => {
    const base = `$.features[${index}]`
    if (feature === null || typeof feature !== 'object') {
      errors.push(error('political-boundary.feature-not-object', base, '要素必须为对象。'))
      return
    }
    const f = feature as { type?: unknown }

    if (f.type === 'nineDashLineSegment') {
      const seg = feature as Partial<NineDashLineSegmentFeature>
      if (!isPositiveInteger(seg.segmentIndex)) {
        errors.push(
          error(
            'political-boundary.segment-index-invalid',
            `${base}.segmentIndex`,
            'segmentIndex 必须为正整数（从 1 起）。',
          ),
        )
      } else if (seenSegmentIndices.has(seg.segmentIndex)) {
        errors.push(
          error(
            'political-boundary.segment-index-duplicate',
            `${base}.segmentIndex`,
            `segmentIndex 重复：${seg.segmentIndex}，段序号必须唯一。`,
          ),
        )
      } else {
        seenSegmentIndices.add(seg.segmentIndex)
      }
      if (!Array.isArray(seg.coordinates) || seg.coordinates.length < 2) {
        errors.push(
          error(
            'political-boundary.segment-coordinates-too-few',
            `${base}.coordinates`,
            '一段折线至少需要 2 个坐标。',
          ),
        )
      } else {
        seg.coordinates.forEach((coordinate, coordinateIndex) => {
          errors.push(...collectCoordinateErrors(coordinate, `${base}.coordinates[${coordinateIndex}]`))
        })
      }
      return
    }

    if (f.type === 'islandOrReefPoint') {
      const point = feature as Partial<IslandOrReefPointFeature>
      if (!isNonEmptyString(point.name)) {
        errors.push(
          error('political-boundary.island-name-empty', `${base}.name`, '岛礁/岛屿名称不得为空。'),
        )
      }
      errors.push(...collectCoordinateErrors(point.coordinate, `${base}.coordinate`))
      return
    }

    if (f.type === 'disputedBoundaryCorrection') {
      const correction = feature as Partial<DisputedBoundaryCorrectionFeature>
      if (!isNonEmptyString(correction.targetRegion)) {
        errors.push(
          error(
            'political-boundary.target-region-empty',
            `${base}.targetRegion`,
            '争议区修正必须给出 targetRegion。',
          ),
        )
      }
      errors.push(
        ...collectAdministrativeGeometryErrors(correction.geometry, `${base}.geometry`),
      )
      if (!isNonEmptyString(correction.basis)) {
        errors.push(
          error(
            'political-boundary.basis-empty',
            `${base}.basis`,
            '争议区修正必须给出 basis（修正依据），保证可追溯。',
          ),
        )
      }
      return
    }

    errors.push(
      error(
        'political-boundary.unknown-feature-type',
        `${base}.type`,
        '要素 type 必须为 "nineDashLineSegment"、"islandOrReefPoint" 或 "disputedBoundaryCorrection"。',
      ),
    )
  })

  if (record.source === null || typeof record.source !== 'object') {
    errors.push(error('political-boundary.source-not-object', '$.source', 'source 必须为对象。'))
  } else {
    const sourceId = (record.source as Partial<DataSourceRef>).sourceId
    if (!isNonEmptyString(sourceId)) {
      errors.push(
        error('political-boundary.source-id-empty', '$.source.sourceId', 'sourceId 必须为非空字符串。'),
      )
    }
  }

  return errors.length === 0 ? valid() : invalid(errors)
}
