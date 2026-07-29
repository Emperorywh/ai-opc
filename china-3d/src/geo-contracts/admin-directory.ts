/**
 * 省级行政区目录契约 + 规范 34 省级行政区目录。
 *
 * 依赖方向：契约层，依赖 codes.ts 与 errors.ts。行政区目录是后续几何、地点目录、
 * 政治边界补充数据做关联的「稳定标识锚点」：所有跨契约关联都走 adminId，
 * 不得依赖数组顺序、中文名称模糊匹配或渲染对象引用。
 *
 * 冻结的不变量（SPEC §2「区划粒度：省级 34 个省级行政区」、§5.2、§6）：
 * - 每个条目拥有稳定、唯一、符合 ADMINISTRATIVE_ID_PATTERN 的标识；省级条目统一采用
 *   与 GB/T 2260 对齐的 6 位 adcode（如 CN-110000 北京市、CN-710000 台湾省），
 *   与 DataV.GeoAtlas 省级边界数据的 adcode 一一对应，供边界资产按码关联。
 * - 名称与类型显式表达；类型覆盖省、自治区、直辖市、特别行政区四种省级形态。
 * - 本契约只建立「目录」（标识 + 名称 + 类型），不含几何（几何在独立资产契约）、
 *   不含业务字段、不做市级下钻。
 * - CHINA_ADMINISTRATIVE_DIRECTORY 是全仓唯一的省级目录事实源，恰好 34 条，
 *   含台湾省、香港特别行政区、澳门特别行政区（SPEC §6 红线）。
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
  /** 稳定行政区标识（CN- 前缀 + GB/T 2260 对齐 adcode，见 codes.ADMINISTRATIVE_ID_PATTERN）。 */
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

/**
 * 中国省级行政区数量（SPEC §2 冻结：34 个省级行政区）。
 * = 23 省（含台湾省）+ 5 自治区 + 4 直辖市 + 2 特别行政区。
 */
export const EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT = 34

/**
 * 规范 34 省级行政区目录（全仓唯一事实源）。
 *
 * 标识采用 CN- 前缀 + GB/T 2260 前两位省级码扩展的 6 位 adcode，与 DataV.GeoAtlas
 * 省级边界数据的 adcode 对齐；排列按 GB/T 2260 码序（华北→东北→华东→中南→西南→西北→
 * 港澳台），渲染层不得依赖该顺序承载语义（关联一律走 id）。
 *
 * 政治完整性（SPEC §6 红线）：台湾省（CN-710000）作为省级行政区在列；
 * 香港（CN-810000）、澳门（CN-820000）作为特别行政区在列。
 */
export const CHINA_ADMINISTRATIVE_DIRECTORY: readonly AdministrativeDirectoryEntry[] = [
  { id: 'CN-110000', name: '北京市', type: 'municipality' },
  { id: 'CN-120000', name: '天津市', type: 'municipality' },
  { id: 'CN-130000', name: '河北省', type: 'province' },
  { id: 'CN-140000', name: '山西省', type: 'province' },
  { id: 'CN-150000', name: '内蒙古自治区', type: 'autonomousRegion' },
  { id: 'CN-210000', name: '辽宁省', type: 'province' },
  { id: 'CN-220000', name: '吉林省', type: 'province' },
  { id: 'CN-230000', name: '黑龙江省', type: 'province' },
  { id: 'CN-310000', name: '上海市', type: 'municipality' },
  { id: 'CN-320000', name: '江苏省', type: 'province' },
  { id: 'CN-330000', name: '浙江省', type: 'province' },
  { id: 'CN-340000', name: '安徽省', type: 'province' },
  { id: 'CN-350000', name: '福建省', type: 'province' },
  { id: 'CN-360000', name: '江西省', type: 'province' },
  { id: 'CN-370000', name: '山东省', type: 'province' },
  { id: 'CN-410000', name: '河南省', type: 'province' },
  { id: 'CN-420000', name: '湖北省', type: 'province' },
  { id: 'CN-430000', name: '湖南省', type: 'province' },
  { id: 'CN-440000', name: '广东省', type: 'province' },
  { id: 'CN-450000', name: '广西壮族自治区', type: 'autonomousRegion' },
  { id: 'CN-460000', name: '海南省', type: 'province' },
  { id: 'CN-500000', name: '重庆市', type: 'municipality' },
  { id: 'CN-510000', name: '四川省', type: 'province' },
  { id: 'CN-520000', name: '贵州省', type: 'province' },
  { id: 'CN-530000', name: '云南省', type: 'province' },
  { id: 'CN-540000', name: '西藏自治区', type: 'autonomousRegion' },
  { id: 'CN-610000', name: '陕西省', type: 'province' },
  { id: 'CN-620000', name: '甘肃省', type: 'province' },
  { id: 'CN-630000', name: '青海省', type: 'province' },
  { id: 'CN-640000', name: '宁夏回族自治区', type: 'autonomousRegion' },
  { id: 'CN-650000', name: '新疆维吾尔自治区', type: 'autonomousRegion' },
  { id: 'CN-710000', name: '台湾省', type: 'province' },
  { id: 'CN-810000', name: '香港特别行政区', type: 'specialAdministrativeRegion' },
  { id: 'CN-820000', name: '澳门特别行政区', type: 'specialAdministrativeRegion' },
]

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
          'id 必须匹配 CN- 前缀格式（如 CN-110000），不得为空或含非法字符。',
        ),
      )
    } else if (seenIds.has(e.id)) {
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
