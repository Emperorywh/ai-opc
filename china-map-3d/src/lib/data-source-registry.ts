/**
 * 数据来源注册表的运行时加载与契约校验（数据访问层，TASK-021）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 political-boundary.ts / province-geometry.ts 同层。它把
 *   TASK-001 交付的来源声明注册表 public/geo/data-sources.json fetch 进来、按 data-source-registry 契约校验，
 *   返回类型安全的 DataSourceRegistryContract（sources 数组直接供 src/lib/compliance-badge 的合规角标准备
 *   纯函数消费，派生三类署名）。本模块只依赖契约层 src/geo-contracts（validateDataSourceRegistry —— 唯一
 *   校验入口、DataSourceRegistryContract 类型）。不依赖 React / R3F / Three.js / DOM（fetch 是 Web 标准 API）。
 *
 * 单一事实源（TASK-021 实现约束「合规角标只消费来源 / 审图状态」、SPEC §8「数据源署名」）：
 * - 本模块是合规角标运行时消费来源注册表的**唯一**取数入口：fetch public/geo/data-sources.json。该注册表
 *   与 scripts/verify-assets 各 scope 读取的生产注册表是同一份资产，承载 DEM / 边界 / 政治补充等全部来源
 *   声明（含非官方审图免责声明）。角标从该注册表派生署名，不在角标配置 / 组件里复制来源名称或免责声明
 *   字面量——来源新增 / 修订时角标自动跟随，无第二套来源清单。
 *
 * 失败语义（与 loadPoliticalBoundary 同一「绝不静默退化」原则）：
 * - fetch 失败（网络 / HTTP 非 2xx）→ 抛 DataSourceRegistryLoadError（fetch-failed）。
 * - 资产未通过 data-source-registry 契约校验（kind / version / 各来源 id 唯一 / 非官方来源必备非空 disclaimer
 *   等，TASK-001 契约层把关）→ 抛 DataSourceRegistryLoadError（contract-invalid）。绝不返回部分 / 伪造注册表
 *   ——合规角标会基于残缺注册表产出缺失来源的署名，违反 TASK-021 验证方式 2「三类署名均存在」。
 * - 校验复用契约层唯一入口 validateDataSourceRegistry，不在本层另写一套注册表校验（asset-contracts §5）。
 */

import { validateDataSourceRegistry } from '../geo-contracts'
import type { DataSourceRegistryContract } from '../geo-contracts'

/** 加载期失败的稳定错误码（含 fetch / 契约两类根因），供调用方确定性处理。 */
export type DataSourceRegistryLoadFailureCode =
  | 'data-source-registry.fetch-failed'
  | 'data-source-registry.contract-invalid'

/** 加载期错误：携带稳定 code 与简体中文说明，绝不静默退化为空 / 伪造注册表。 */
export class DataSourceRegistryLoadError extends Error {
  readonly code: DataSourceRegistryLoadFailureCode
  constructor(code: DataSourceRegistryLoadFailureCode, message: string) {
    super(message)
    this.name = 'DataSourceRegistryLoadError'
    this.code = code
  }
}

/**
 * 从浏览器 fetch 数据来源注册表静态资产并经契约校验。
 *
 * 参数是资产的 URL（默认指向 public/geo 下的生产资产 data-sources.json，与 COMPLIANCE_DATA_SOURCES_PATH 一致）。
 * 取回 JSON 后用 validateDataSourceRegistry 做契约校验（kind=data-source-registry / version / 各来源 id 唯一 /
 * 非官方来源必备非空 disclaimer 等，TASK-001 已通过契约校验）。任一步失败抛 DataSourceRegistryLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造 DataSourceRegistryContract 字面量或读取生产资产
 * 喂给 prepareComplianceBadge，不走本函数。
 */
export async function loadDataSourceRegistry(
  url = '/geo/data-sources.json',
): Promise<DataSourceRegistryContract> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new DataSourceRegistryLoadError(
      'data-source-registry.fetch-failed',
      `获取数据来源注册表失败（${url}）：${(cause as Error).message}。`,
    )
  }
  if (!response.ok) {
    throw new DataSourceRegistryLoadError(
      'data-source-registry.fetch-failed',
      `获取数据来源注册表失败（${url}）：HTTP ${response.status}。`,
    )
  }
  const payload: unknown = await response.json()
  const outcome = validateDataSourceRegistry(payload)
  if (!outcome.ok) {
    throw new DataSourceRegistryLoadError(
      'data-source-registry.contract-invalid',
      `数据来源注册表未通过 data-source-registry 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return payload as DataSourceRegistryContract
}
