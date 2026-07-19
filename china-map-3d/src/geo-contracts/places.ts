/**
 * 地点目录契约（省名展示锚点 + 省级行政中心点位）。
 *
 * 依赖方向：契约层，依赖 codes.ts、errors.ts、geometry-primitives.ts、terrain.ts 的来源引用类型。
 * 地点目录属于地理领域数据，禁止放进 React 组件、材质参数或 hover 状态中维护
 * （SPEC §3.7、§5.5、TASK-005）。运行时标签/光点渲染层单向消费本契约。
 *
 * 冻结的不变量：
 * - 每个地点以 adminId 关联行政区，标识必须符合 CN- 格式；地点条目内 id 全局唯一。
 * - role 区分「省名展示锚点」与「省级行政中心」；二者语义不同，不得混用。
 * - 坐标用命名字段 { lon, lat } 显式表达，落在合法经纬度区间。
 * - 多岛、狭长或几何中心落海的行政区允许人工校正锚点位置，但校正依据必须显式记录在
 *   anchorAdjustmentNote，不得用组件内魔法偏移承载（SPEC §3.7、TASK-005）。
 * - 默认展示契约仅含「省名 + 省会光点」；不引入业务 tooltip、不下钻、不绑定业务数值。
 */

import {
  KNOWN_COORDINATE_REFERENCE_SYSTEMS,
  isRecognizedDataVersion,
  isValidAdministrativeId,
} from './codes'
import { collectCoordinateErrors, collectCrsErrors } from './geometry-primitives'
import { type DataSourceRef } from './terrain'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 地点角色：省名锚点 或 省级行政中心（省会/首府/直辖市中心/特别行政区中心）。 */
export type PlaceRole = 'provinceNameAnchor' | 'administrativeCapital'

export const RECOGNIZED_PLACE_ROLES: readonly PlaceRole[] = [
  'provinceNameAnchor',
  'administrativeCapital',
]

/** 单个地点条目。 */
export interface PlaceDirectoryEntry {
  /** 地点稳定标识（地点自身唯一）。 */
  readonly id: string
  /** 关联的行政区稳定标识，必须命中行政区目录。 */
  readonly adminId: string
  readonly role: PlaceRole
  /** 展示名称（省名或省会/首府名）。 */
  readonly name: string
  /** 经纬度坐标（EPSG:4326 源基准）。 */
  readonly coordinate: { readonly lon: number; readonly lat: number }
  /**
   * 人工校正说明。
   * 存在人工偏移时必填且非空，记录校正依据；未校正锚点缺省。
   * 禁止用此字段之外的隐式偏移承载位置语义。
   */
  readonly anchorAdjustmentNote?: string
}

/** 地点目录契约主体。 */
export interface PlaceDirectoryContract {
  readonly kind: 'place-directory'
  readonly version: string
  /** 地点坐标参考系，固定 EPSG:4326。 */
  readonly crs: 'EPSG:4326'
  readonly entries: readonly PlaceDirectoryEntry[]
  readonly source: DataSourceRef
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecognizedPlaceRole(value: unknown): value is PlaceRole {
  return typeof value === 'string' && (RECOGNIZED_PLACE_ROLES as readonly string[]).includes(value)
}

/** 地点目录校验器。 */
export function validatePlaceDirectory(payload: unknown): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('place-directory.not-object', '$', '地点目录必须为对象。')])
  }
  const record = payload as Partial<PlaceDirectoryContract>
  const errors = []

  if (record.kind !== 'place-directory') {
    errors.push(error('place-directory.wrong-kind', '$.kind', '地点目录的 kind 必须为 "place-directory"。'))
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'place-directory.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  errors.push(...collectCrsErrors(record.crs, '$.crs', KNOWN_COORDINATE_REFERENCE_SYSTEMS.EPSG_4326))

  if (!Array.isArray(record.entries)) {
    errors.push(error('place-directory.entries-not-array', '$.entries', 'entries 必须为数组。'))
    return invalid(errors)
  }
  if (record.entries.length === 0) {
    errors.push(error('place-directory.empty-entries', '$.entries', 'entries 不得为空。'))
  }

  const seenEntryIds = new Set<string>()
  record.entries.forEach((entry, index) => {
    const base = `$.entries[${index}]`
    if (entry === null || typeof entry !== 'object') {
      errors.push(error('place-directory.entry-not-object', base, '地点条目必须为对象。'))
      return
    }
    const e = entry as Partial<PlaceDirectoryEntry>
    if (!isNonEmptyString(e.id)) {
      errors.push(error('place-directory.id-empty', `${base}.id`, '地点 id 必须为非空字符串。'))
    } else if (seenEntryIds.has(e.id)) {
      errors.push(error('place-directory.duplicate-id', `${base}.id`, `地点 id 重复：${e.id}。`))
    } else {
      seenEntryIds.add(e.id)
    }
    if (!isValidAdministrativeId(e.adminId)) {
      errors.push(
        error('place-directory.admin-id-malformed', `${base}.adminId`, 'adminId 必须匹配 CN- 前缀格式。'),
      )
    }
    if (!isRecognizedPlaceRole(e.role)) {
      errors.push(
        error(
          'place-directory.unknown-role',
          `${base}.role`,
          `role 必须为已知类别之一：${RECOGNIZED_PLACE_ROLES.join('、')}。`,
        ),
      )
    }
    if (!isNonEmptyString(e.name)) {
      errors.push(error('place-directory.name-empty', `${base}.name`, 'name 必须为非空字符串。'))
    }
    errors.push(...collectCoordinateErrors(e.coordinate, `${base}.coordinate`))
    // 校正说明若给出则必须非空：避免出现「字段在但没解释」的隐式偏移。
    if (e.anchorAdjustmentNote !== undefined && !isNonEmptyString(e.anchorAdjustmentNote)) {
      errors.push(
        error(
          'place-directory.anchor-note-empty',
          `${base}.anchorAdjustmentNote`,
          'anchorAdjustmentNote 一旦给出必须为非空字符串，记录人工校正依据。',
        ),
      )
    }
  })

  if (record.source === null || typeof record.source !== 'object') {
    errors.push(error('place-directory.source-not-object', '$.source', 'source 必须为对象。'))
  } else {
    const sourceId = (record.source as Partial<DataSourceRef>).sourceId
    if (!isNonEmptyString(sourceId)) {
      errors.push(error('place-directory.source-id-empty', '$.source.sourceId', 'sourceId 必须为非空字符串。'))
    }
  }

  return errors.length === 0 ? valid() : invalid(errors)
}
