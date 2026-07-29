/**
 * 资产契约的统一验证入口。
 *
 * 依赖方向：契约层最顶端的「门面」，聚合各具体契约校验器，只依赖同层的其它契约模块。
 * 测试基线、资产校验 CLI（pnpm verify:assets）与运行时数据访问层都通过这里调用校验，
 * 后续 TASK 复用同一入口验证正常资产与损坏资产。
 *
 * 提供两类入口：
 * 1. validateContractByKind —— 按 payload 自身的 kind 字段分发到对应校验器，
 *    适合「拿到一份未知 JSON、先看它是不是某类契约」的场景。
 * 2. validateContractBundle —— 跨契约引用核对：把多份契约放在一起，检查 sourceId/adminId
 *    引用是否都能解析到目标，发现「孤儿引用」这类单契约校验无法发现的不一致。
 */

import { validateAdministrativeDirectory } from './admin-directory'
import { validateAdministrativeGeometry } from './geometry'
import { validateLabelFontManifest } from './label-font'
import { validatePlaceDirectory } from './places'
import { validatePoliticalBoundary } from './political'
import { validateDataSourceRegistry, type DataSourceRegistryContract } from './source'
import { validateTerrainMeta } from './terrain'
import {
  type ContractValidationOutcome,
  type ContractValidationError,
  error,
  invalid,
  valid,
} from './errors'

/** 全部契约 kind 字面量。 */
export type ContractKind =
  | 'terrain-meta'
  | 'administrative-directory'
  | 'administrative-geometry'
  | 'place-directory'
  | 'political-boundary'
  | 'data-source-registry'
  | 'label-font-manifest'

const KIND_TO_LABEL: Record<ContractKind, string> = {
  'terrain-meta': '地形元数据',
  'administrative-directory': '行政区目录',
  'administrative-geometry': '行政区几何',
  'place-directory': '地点目录',
  'political-boundary': '政治边界补充数据',
  'data-source-registry': '数据来源注册表',
  'label-font-manifest': '标签字体清单',
}

/**
 * 按 payload 自身的 kind 字段分发到对应校验器。
 * 未知 kind 或缺失 kind 视为确定性失败（给出可定位错误），不静默接受。
 */
export function validateContractByKind(payload: unknown): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('contract.not-object', '$', '契约载荷必须为对象。')])
  }
  const kind = (payload as { kind?: unknown }).kind
  switch (kind) {
    case 'terrain-meta':
      return validateTerrainMeta(payload)
    case 'administrative-directory':
      return validateAdministrativeDirectory(payload)
    case 'administrative-geometry':
      return validateAdministrativeGeometry(payload)
    case 'place-directory':
      return validatePlaceDirectory(payload)
    case 'political-boundary':
      return validatePoliticalBoundary(payload)
    case 'data-source-registry':
      return validateDataSourceRegistry(payload)
    case 'label-font-manifest':
      return validateLabelFontManifest(payload)
    default:
      return invalid([
        error(
          'contract.unknown-kind',
          '$.kind',
          `未知的契约 kind：${String(kind)}。期望之一为：${(Object.keys(KIND_TO_LABEL) as ContractKind[]).join('、')}。`,
        ),
      ])
  }
}

/**
 * 从一份疑似契约载荷中安全提取 kind 字段。
 * 供 CLI / 测试在分发前打标签使用。
 */
export function readContractKind(payload: unknown): ContractKind | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const kind = (payload as { kind?: unknown }).kind
  if (typeof kind === 'string' && kind in KIND_TO_LABEL) {
    return kind as ContractKind
  }
  return undefined
}

/**
 * 一个契约包：把若干契约载荷放在一起做跨契约引用核对。
 * 注意：本函数假设传入的每份载荷自身已经通过 validateContractByKind（或先在本函数内重跑一次）。
 * 引用核对只检查「引用是否能解析到目标」，不重复各契约的内部结构校验。
 */
export interface ContractBundle {
  readonly sources?: DataSourceRegistryContract
  readonly administrativeDirectory?: unknown
  readonly administrativeGeometry?: unknown
  readonly placeDirectory?: unknown
  readonly politicalBoundary?: unknown
  readonly terrainMeta?: unknown
}

/**
 * 跨契约引用核对。
 * 核对项：
 * - 任一契约的 source.sourceId 必须能在来源注册表中解析到一条来源声明。
 * - 行政区几何与地点目录中的 adminId 必须能在行政区目录中解析到一条条目。
 * 缺少对应目录/注册表时，相关引用一律判为「无法解析」并报错，而不是静默放过。
 */
export function validateContractBundle(bundle: ContractBundle): ContractValidationOutcome {
  const errors: ContractValidationError[] = []

  const knownSourceIds = new Set<string>()
  if (bundle.sources) {
    // 来源注册表自身的结构校验先跑一遍，确保来源集合可信。
    const registryOutcome = validateDataSourceRegistry(bundle.sources)
    if (!registryOutcome.ok) {
      errors.push(...registryOutcome.errors)
    } else {
      bundle.sources.sources.forEach((source) => knownSourceIds.add(source.id))
    }
  }

  const knownAdminIds = new Set<string>()
  if (bundle.administrativeDirectory) {
    const directoryOutcome = validateAdministrativeDirectory(bundle.administrativeDirectory)
    if (!directoryOutcome.ok) {
      errors.push(...directoryOutcome.errors)
    } else {
      const directory = bundle.administrativeDirectory as { entries: Array<{ id: string }> }
      directory.entries.forEach((entry) => knownAdminIds.add(entry.id))
    }
  }

  // 来源引用核对：所有携带 source.sourceId 的契约都要能解析。
  const sourceRefCarriers: Array<{ label: string; payload: unknown }> = [
    { label: '行政区目录', payload: bundle.administrativeDirectory },
    { label: '行政区几何', payload: bundle.administrativeGeometry },
    { label: '地点目录', payload: bundle.placeDirectory },
    { label: '政治边界补充数据', payload: bundle.politicalBoundary },
    { label: '地形元数据', payload: bundle.terrainMeta },
  ]
  for (const carrier of sourceRefCarriers) {
    if (!carrier.payload) continue
    const sourceId = readSourceId(carrier.payload)
    if (sourceId !== undefined) {
      if (knownSourceIds.size === 0) {
        errors.push(
          error(
            'bundle.missing-source-registry',
            '$',
            `${carrier.label} 引用了来源 ${sourceId}，但未提供数据来源注册表，引用无法解析。`,
          ),
        )
      } else if (!knownSourceIds.has(sourceId)) {
        errors.push(
          error(
            'bundle.unresolved-source-id',
            '$',
            `${carrier.label} 引用的 sourceId=${sourceId} 在数据来源注册表中不存在。`,
          ),
        )
      }
    }
  }

  // 行政区引用核对：几何与地点目录中的 adminId 必须能解析到目录。
  if (bundle.administrativeGeometry) {
    const geometry = bundle.administrativeGeometry as {
      features?: Array<{ adminId?: string }>
    }
    geometry.features?.forEach((feature, index) => {
      const adminId = feature.adminId
      if (typeof adminId !== 'string') return
      if (knownAdminIds.size === 0) {
        errors.push(
          error(
            'bundle.missing-admin-directory',
            '$',
            `行政区几何第 ${index} 项引用了 ${adminId}，但未提供行政区目录，引用无法解析。`,
          ),
        )
      } else if (!knownAdminIds.has(adminId)) {
        errors.push(
          error(
            'bundle.unresolved-admin-id',
            '$',
            `行政区几何引用的 adminId=${adminId} 在行政区目录中不存在。`,
          ),
        )
      }
    })
  }
  if (bundle.placeDirectory) {
    const places = bundle.placeDirectory as {
      entries?: Array<{ adminId?: string }>
    }
    places.entries?.forEach((entry, index) => {
      const adminId = entry.adminId
      if (typeof adminId !== 'string') return
      if (knownAdminIds.size === 0) {
        errors.push(
          error(
            'bundle.missing-admin-directory',
            '$',
            `地点目录第 ${index} 项引用了 ${adminId}，但未提供行政区目录，引用无法解析。`,
          ),
        )
      } else if (!knownAdminIds.has(adminId)) {
        errors.push(
          error(
            'bundle.unresolved-admin-id',
            '$',
            `地点目录引用的 adminId=${adminId} 在行政区目录中不存在。`,
          ),
        )
      }
    })
  }

  return errors.length === 0 ? valid() : invalid(errors)
}

/** 从载荷中安全读取 source.sourceId，缺失则返回 undefined。 */
function readSourceId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const source = (payload as { source?: { sourceId?: unknown } }).source
  if (source === null || typeof source !== 'object') return undefined
  const sourceId = source.sourceId
  return typeof sourceId === 'string' ? sourceId : undefined
}
