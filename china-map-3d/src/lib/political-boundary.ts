/**
 * 政治边界补充数据的运行时加载与契约校验（数据访问层，TASK-015）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-geometry.ts / elevation.ts / projection.ts 同层。
 *   它把 TASK-006 交付的静态资产 public/geo/china-political-boundary.json fetch 进来、按 political-boundary
 *   契约校验，返回类型安全的 PoliticalBoundaryContract（features 数组直接供 src/lib/political-features 的
 *   主图渲染准备纯函数消费）。本模块只依赖契约层 src/geo-contracts（validatePoliticalBoundary —— 唯一
 *   校验入口、PoliticalBoundaryContract 类型）。不依赖 React / R3F / Three.js / DOM（fetch 是 Web 标准 API）。
 *
 * 单一事实源（TASK-015 实现约束「渲染只消费 TASK-006 的共享事实源，后续 2D 附图复用相同数据」、
 * 「不得复制、手改或在组件内补写十段线 / 岛礁坐标」）：
 * - 本模块是主图运行时消费政治边界数据的**唯一**取数入口：fetch public/geo/china-political-boundary.json。
 *   十段线 / 岛礁坐标全部来自该资产，组件层（src/three/PoliticalFeatures）不得自行 fetch 或硬编码坐标。
 * - 后续 2D 南海附图（TASK-019）复用同一资产（SPEC §3.8、§5.4），不维护第二套坐标。
 *
 * 失败语义（与 loadProvinceGeometry 同一「绝不静默退化」原则，TASK-015 输出约束「缺段 / 缺点异常路径能
 * 阻断渲染准备，不能静默显示残缺地图」）：
 * - fetch 失败（网络 / HTTP 非 2xx）→ 抛 PoliticalBoundaryLoadError（fetch-failed）。
 * - 资产未通过 political-boundary 契约校验（kind / crs / features 结构 / 段序号唯一 / 岛礁名非空 / 坐标合法性 /
 *   source.sourceId 非空等）→ 抛 PoliticalBoundaryLoadError（contract-invalid）。绝不返回部分 / 伪造政治
 *   边界——主图渲染准备层会基于残缺数据产出残缺十段线 / 缺失岛礁，违反政治边界完整性红线（SPEC §6）。
 * - 红线完整性（恰好 10 段含台湾东侧段、点名岛礁在、点名争议区在、坐标落在中国主图、来源非官方审图）
 *   由资产级深度校验（scripts/verify-assets/political-deep）在离线管线把关；运行时由准备层
 *   （src/lib/political-features 的 preparePoliticalFeatures）对「十段 + 台湾东侧段 + 点名岛礁」做独立
 *   锚点断言，缺任一项即抛错阻断渲染（TASK-015 验证方式 2）。
 * - 校验复用契约层唯一入口 validatePoliticalBoundary，不在本层另写一套政治边界校验（asset-contracts §5）。
 */

import { validatePoliticalBoundary } from '../geo-contracts'
import type { PoliticalBoundaryContract } from '../geo-contracts'

/** 加载期失败的稳定错误码（含 fetch / 契约两类根因），供调用方确定性处理。 */
export type PoliticalBoundaryLoadFailureCode =
  | 'political-boundary.fetch-failed'
  | 'political-boundary.contract-invalid'

/** 加载期错误：携带稳定 code 与简体中文说明，绝不静默退化为空 / 伪造政治边界。 */
export class PoliticalBoundaryLoadError extends Error {
  readonly code: PoliticalBoundaryLoadFailureCode
  constructor(code: PoliticalBoundaryLoadFailureCode, message: string) {
    super(message)
    this.name = 'PoliticalBoundaryLoadError'
    this.code = code
  }
}

/**
 * 从浏览器 fetch 政治边界补充静态资产并经契约校验。
 *
 * 参数是资产的 URL（默认指向 public/geo 下的生产资产 china-political-boundary.json）。取回 JSON 后用
 * validatePoliticalBoundary 做契约校验（kind / version / crs=EPSG:4326 / features 结构 / 段序号唯一 /
 * 岛礁名非空 / 坐标合法性 / source.sourceId 非空，TASK-006 已通过政治边界深度校验）。任一步失败抛
 * PoliticalBoundaryLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造 PoliticalBoundaryContract 字面量喂给
 * preparePoliticalFeatures，不走本函数。
 */
export async function loadPoliticalBoundary(
  url = '/geo/china-political-boundary.json',
): Promise<PoliticalBoundaryContract> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new PoliticalBoundaryLoadError(
      'political-boundary.fetch-failed',
      `获取政治边界补充数据失败（${url}）：${(cause as Error).message}。`,
    )
  }
  if (!response.ok) {
    throw new PoliticalBoundaryLoadError(
      'political-boundary.fetch-failed',
      `获取政治边界补充数据失败（${url}）：HTTP ${response.status}。`,
    )
  }
  const payload: unknown = await response.json()
  const outcome = validatePoliticalBoundary(payload)
  if (!outcome.ok) {
    throw new PoliticalBoundaryLoadError(
      'political-boundary.contract-invalid',
      `政治边界补充数据未通过 political-boundary 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return payload as PoliticalBoundaryContract
}
