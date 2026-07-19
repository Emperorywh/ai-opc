/**
 * 省级行政区目录契约。
 *
 * 依赖方向：契约层，依赖 codes.ts 与 errors.ts。行政区目录是后续几何、地点目录、
 * 政治边界补充数据做关联的「稳定标识锚点」：所有跨契约关联都走 adminId，
 * 不得依赖数组顺序、中文名称模糊匹配或渲染对象引用。
 *
 * 冻结的不变量（SPEC §2「区划粒度」、§5.2、§6、TASK-004）：
 * - 每个条目拥有稳定、唯一、符合 ADMINISTRATIVE_ID_PATTERN 的标识。
 * - 名称与类型显式表达；类型覆盖省、自治区、直辖市、特别行政区四种省级形态。
 * - 本契约只建立「目录」（标识 + 名称 + 类型），不含几何（几何在独立契约）、
 *   不含业务字段、不做市级下钻。
 * 34 个省级行政区的「恰好数量」校验由下游省级边界 TASK 在生产数据上执行，
 * 本契约只保证目录内部的结构、唯一性与格式不变量。
 */

import { isRecognizedDataVersion, isValidAdministrativeId } from './codes'
import { type DataSourceRef } from './terrain'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 省级行政区类型。 */
export type AdministrativeRegionType =
  | 'province'
  | 'autonomousRegion'
  | 'municipality'
  | 'specialAdministrativeRegion'

export const RECOGNIZED_REGION_TYPES: readonly AdministrativeRegionType[] = [
  'province',
  'autonomousRegion',
  'municipality',
  'specialAdministrativeRegion',
]

/** 单个省级行政区目录条目。 */
export interface AdministrativeDirectoryEntry {
  /** 稳定行政区标识（CN- 前缀命名空间，见 codes.ADMINISTRATIVE_ID_PATTERN）。 */
  readonly id: string
  /** 规范名称（中文）。 */
  readonly name: string
  /** 行政区类型。 */
  readonly type: AdministrativeRegionType
}

/** 行政区目录契约主体。 */
export interface AdministrativeDirectoryContract {
  readonly kind: 'administrative-directory'
  readonly version: string
  readonly entries: readonly AdministrativeDirectoryEntry[]
  readonly source: DataSourceRef
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecognizedRegionType(value: unknown): value is AdministrativeRegionType {
  return typeof value === 'string' && (RECOGNIZED_REGION_TYPES as readonly string[]).includes(value)
}

/** 行政区目录校验器。 */
export function validateAdministrativeDirectory(
  payload: unknown,
): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('admin-directory.not-object', '$', '行政区目录必须为对象。')])
  }
  const record = payload as Partial<AdministrativeDirectoryContract>
  const errors = []

  if (record.kind !== 'administrative-directory') {
    errors.push(
      error('admin-directory.wrong-kind', '$.kind', '行政区目录的 kind 必须为 "administrative-directory"。'),
    )
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'admin-directory.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  if (!Array.isArray(record.entries)) {
    errors.push(error('admin-directory.entries-not-array', '$.entries', 'entries 必须为数组。'))
    return invalid(errors)
  }
  if (record.entries.length === 0) {
    errors.push(error('admin-directory.empty-entries', '$.entries', '行政区目录不得为空。'))
  }

  const seenIds = new Set<string>()
  record.entries.forEach((entry, index) => {
    const base = `$.entries[${index}]`
    if (entry === null || typeof entry !== 'object') {
      errors.push(error('admin-directory.entry-not-object', base, '目录条目必须为对象。'))
      return
    }
    const e = entry as Partial<AdministrativeDirectoryEntry>
    if (!isValidAdministrativeId(e.id)) {
      errors.push(
        error(
          'admin-directory.id-malformed',
          `${base}.id`,
          'id 必须匹配 CN- 前缀格式（如 CN-GD），不得为空或含非法字符。',
        ),
      )
    } else if (seenIds.has(e.id)) {
      // 重复标识：确定性失败的核心场景之一（TASK-001 验证方式 2）。
      errors.push(
        error('admin-directory.duplicate-id', `${base}.id`, `行政区标识重复：${e.id}，标识必须全局唯一。`),
      )
    } else {
      seenIds.add(e.id)
    }
    if (!isNonEmptyString(e.name)) {
      errors.push(error('admin-directory.name-empty', `${base}.name`, 'name 必须为非空字符串。'))
    }
    if (!isRecognizedRegionType(e.type)) {
      errors.push(
        error(
          'admin-directory.unknown-type',
          `${base}.type`,
          `type 必须为已知类别之一：${RECOGNIZED_REGION_TYPES.join('、')}。`,
        ),
      )
    }
  })

  if (record.source === null || typeof record.source !== 'object') {
    errors.push(error('admin-directory.source-not-object', '$.source', 'source 必须为对象。'))
  } else {
    const sourceId = (record.source as Partial<DataSourceRef>).sourceId
    if (!isNonEmptyString(sourceId)) {
      errors.push(error('admin-directory.source-id-empty', '$.source.sourceId', 'sourceId 必须为非空字符串。'))
    }
  }

  return errors.length === 0 ? valid() : invalid(errors)
}
