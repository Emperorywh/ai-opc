/**
 * 数据来源声明契约。
 *
 * 依赖方向：契约层，只依赖 codes.ts 与 errors.ts。所有资产契约以「来源引用」方式关联
 * 到来源声明（sourceId），来源详情集中在本契约中表达一次，避免在多处复制漂移。
 *
 * 领域红线（SPEC §5.2、§5.3、§6、§8、§13）：
 * - DataV.GeoAtlas 与项目自补的九段线/岛礁/争议区数据一律标记为非官方审图，
 *   isOfficialSurvey=false 且 disclaimer 必填。
 * - ETOPO1 是公开科学数据集，但同样不是中国官方审图数据，正式发布前仍须走审图。
 * - originUrl 仅作为离线审计记录；运行时禁止据此发起任何网络请求（SPEC §5：
 *   所有外部数据必须先转为仓库内静态资产，运行时零外部网络依赖）。
 */

import { isRecognizedDataVersion } from './codes'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 来源类别，便于按类别审计与统计。 */
export type DataSourceKind =
  | 'digitalElevationModel'
  | 'administrativeBoundary'
  | 'politicalBoundarySupplement'
  | 'placeGazetteer'

export const RECOGNIZED_SOURCE_KINDS: readonly DataSourceKind[] = [
  'digitalElevationModel',
  'administrativeBoundary',
  'politicalBoundarySupplement',
  'placeGazetteer',
]

/**
 * 单份数据来源声明。
 * 一份来源声明可以被多个资产契约引用，故以集合形式（DataSourceRegistry）承载。
 */
export interface DataSourceDeclaration {
  /** 稳定来源标识，供其他契约以 sourceId 引用。 */
  readonly id: string
  /** 来源展示名称，例如 "NOAA ETOPO1"、"阿里 DataV.GeoAtlas"。 */
  readonly name: string
  /** 原始数据获取地址。仅作离线审计，运行时禁止据此联网。 */
  readonly originUrl: string
  /** 来源类别。 */
  readonly kind: DataSourceKind
  /**
   * 是否为官方审图数据。
   * 本项目当前所有来源（含 ETOPO1）均为非官方审图数据，发布前必须取得审图号。
   */
  readonly isOfficialSurvey: boolean
  /** 数据版本或快照摘要（如 DEM 版本号、DataV 拉取日期），用于可审计追溯。 */
  readonly version: string
  /** 许可证或使用条款标识。 */
  readonly license: string
  /**
   * 非官方审图数据必备的免责声明。
   * isOfficialSurvey 为 false 时必填且不得为空字符串。
   */
  readonly disclaimer?: string
}

/**
 * 来源声明注册表契约。
 * 顶层 kind 标识其为一个来源集合；sources 以数组形式给出，内部 id 必须唯一。
 */
export interface DataSourceRegistryContract {
  readonly kind: 'data-source-registry'
  /** 注册表自身的版本字段，沿用静态资产版本语义。 */
  readonly version: string
  readonly sources: readonly DataSourceDeclaration[]
}

/** 判定一个字符串是否为非空白。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 来源声明注册表的校验器。 */
export function validateDataSourceRegistry(
  payload: unknown,
): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('source-registry.not-object', '$', '来源注册表必须为对象。')])
  }
  const record = payload as Partial<DataSourceRegistryContract>
  const errors = []
  if (record.kind !== 'data-source-registry') {
    errors.push(error('source-registry.wrong-kind', '$.kind', '来源注册表的 kind 必须为 "data-source-registry"。'))
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'source-registry.unknown-version',
        '$.version',
        `来源注册表的 version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }
  if (!Array.isArray(record.sources)) {
    errors.push(error('source-registry.sources-not-array', '$.sources', 'sources 必须为数组。'))
    return invalid(errors)
  }

  const seenIds = new Set<string>()
  record.sources.forEach((source, index) => {
    const base = `$.sources[${index}]`
    if (source === null || typeof source !== 'object') {
      errors.push(error('source.not-object', base, '来源声明必须为对象。'))
      return
    }
    const s = source as Partial<DataSourceDeclaration>
    if (!isNonEmptyString(s.id)) {
      errors.push(error('source.missing-id', `${base}.id`, '来源 id 必须为非空字符串。'))
    } else if (seenIds.has(s.id)) {
      errors.push(error('source.duplicate-id', `${base}.id`, `来源 id 重复：${s.id}。`))
    } else {
      seenIds.add(s.id)
    }
    if (!isNonEmptyString(s.name)) {
      errors.push(error('source.missing-name', `${base}.name`, '来源 name 必须为非空字符串。'))
    }
    if (!isNonEmptyString(s.originUrl)) {
      errors.push(
        error('source.missing-origin-url', `${base}.originUrl`, 'originUrl 必须为非空字符串（离线审计记录）。'),
      )
    }
    if (!isRecognizedSourceKind(s.kind)) {
      errors.push(
        error(
          'source.unknown-kind',
          `${base}.kind`,
          `来源 kind 必须为已知类别之一：${RECOGNIZED_SOURCE_KINDS.join('、')}。`,
        ),
      )
    }
    if (typeof s.isOfficialSurvey !== 'boolean') {
      errors.push(
        error(
          'source.is-official-survey-not-boolean',
          `${base}.isOfficialSurvey`,
          'isOfficialSurvey 必须为布尔值。',
        ),
      )
    }
    if (!isNonEmptyString(s.version)) {
      errors.push(error('source.missing-version', `${base}.version`, '来源 version 必须为非空字符串。'))
    }
    if (!isNonEmptyString(s.license)) {
      errors.push(error('source.missing-license', `${base}.license`, '来源 license 必须为非空字符串。'))
    }
    // 非官方审图红线：免责声明强制。官方来源（未来若接入）允许缺省。
    if (s.isOfficialSurvey === false && !isNonEmptyString(s.disclaimer)) {
      errors.push(
        error(
          'source.non-official-without-disclaimer',
          `${base}.disclaimer`,
          '非官方审图数据必须附带非空免责声明（SPEC §8）。',
        ),
      )
    }
  })

  return errors.length === 0 ? valid() : invalid(errors)
}

function isRecognizedSourceKind(value: unknown): value is DataSourceKind {
  return typeof value === 'string' && (RECOGNIZED_SOURCE_KINDS as readonly string[]).includes(value)
}
