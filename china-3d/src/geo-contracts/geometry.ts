/**
 * 省级行政区几何契约（经纬度多边形/多多边形）。
 *
 * 依赖方向：契约层，依赖 codes.ts、errors.ts、geometry-primitives.ts、terrain.ts 的来源引用类型。
 * 与行政区目录分离：目录只管「标识 + 名称 + 类型」，本契约只管「标识 → 几何」。
 * 两者通过 adminId 单向关联，互不内嵌，保证高内聚低耦合。
 *
 * 冻结的不变量（SPEC §3.3、§3.6、§5.2）：
 * - 源几何 CRS 固定为 EPSG:4326（WGS84）；投影到世界坐标由统一投影层
 *   （src/lib/projection.ts）完成，本契约不承担。
 * - 每个条目以 adminId 关联行政区，标识必须符合 CN- 格式；标识唯一性由本契约保证
 *   （一个行政区在此只能出现一份几何）。
 * - 几何结构合法、坐标落在合法经纬度区间。这是「非法经纬度」场景的确定性失败点。
 */

import {
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
  isRecognizedDataVersion,
  isValidAdministrativeId,
} from './codes'
import { collectAdministrativeGeometryErrors, collectCrsErrors } from './geometry-primitives'
import { type DataSourceRef } from './terrain'
import {
  type AdministrativeGeometry,
} from './geometry-primitives'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 单个行政区的几何条目：稳定标识 + 几何。 */
export interface AdministrativeGeometryFeature {
  /** 关联的行政区稳定标识，必须命中行政区目录。 */
  readonly adminId: string
  readonly geometry: AdministrativeGeometry
}

/** 行政区几何契约主体。 */
export interface AdministrativeGeometryContract {
  readonly kind: 'administrative-geometry'
  readonly version: string
  /** 源几何坐标参考系，固定 EPSG:4326。 */
  readonly crs: 'EPSG:4326'
  readonly features: readonly AdministrativeGeometryFeature[]
  readonly source: DataSourceRef
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 行政区几何校验器。 */
export function validateAdministrativeGeometry(
  payload: unknown,
): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('admin-geometry.not-object', '$', '行政区几何必须为对象。')])
  }
  const record = payload as Partial<AdministrativeGeometryContract>
  const errors = []

  if (record.kind !== 'administrative-geometry') {
    errors.push(
      error('admin-geometry.wrong-kind', '$.kind', '行政区几何的 kind 必须为 "administrative-geometry"。'),
    )
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'admin-geometry.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  errors.push(...collectCrsErrors(record.crs, '$.crs', KNOWN_COORDINATE_REFERENCE_SYSTEMS.EPSG_4326))

  if (!Array.isArray(record.features)) {
    errors.push(error('admin-geometry.features-not-array', '$.features', 'features 必须为数组。'))
    return invalid(errors)
  }
  if (record.features.length === 0) {
    errors.push(error('admin-geometry.empty-features', '$.features', 'features 不得为空。'))
  }

  const seenAdminIds = new Set<string>()
  record.features.forEach((feature, index) => {
    const base = `$.features[${index}]`
    if (feature === null || typeof feature !== 'object') {
      errors.push(error('admin-geometry.feature-not-object', base, '几何条目必须为对象。'))
      return
    }
    const f = feature as Partial<AdministrativeGeometryFeature>
    if (!isValidAdministrativeId(f.adminId)) {
      errors.push(
        error(
          'admin-geometry.admin-id-malformed',
          `${base}.adminId`,
          'adminId 必须匹配 CN- 前缀格式。',
        ),
      )
    } else if (seenAdminIds.has(f.adminId)) {
      errors.push(
        error(
          'admin-geometry.duplicate-admin-id',
          `${base}.adminId`,
          `adminId 重复：${f.adminId}，每个行政区在此只能有一份几何。`,
        ),
      )
    } else {
      seenAdminIds.add(f.adminId)
    }
    errors.push(...collectAdministrativeGeometryErrors(f.geometry, `${base}.geometry`))
  })

  if (record.source === null || typeof record.source !== 'object') {
    errors.push(error('admin-geometry.source-not-object', '$.source', 'source 必须为对象。'))
  } else {
    const sourceId = (record.source as Partial<DataSourceRef>).sourceId
    if (!isNonEmptyString(sourceId)) {
      errors.push(error('admin-geometry.source-id-empty', '$.source.sourceId', 'sourceId 必须为非空字符串。'))
    }
  }

  return errors.length === 0 ? valid() : invalid(errors)
}
