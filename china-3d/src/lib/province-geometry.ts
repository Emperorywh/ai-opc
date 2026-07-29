/**
 * 省级行政区几何的运行时加载与契约校验（数据访问层，TASK-009，SPEC §5.2）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 elevation.ts / projection.ts 同层。它把 TASK-004 交付的
 *   静态资产 public/geo/china-provinces-geometry.json fetch 进来、按 administrative-geometry 契约
 *   校验，返回类型安全的 AdministrativeGeometryContract（features 数组直接供 src/lib/province-borders
 *   的纯函数与 src/lib/province-picking 的所属判定消费）。本模块只依赖契约层 src/geo-contracts
 *   （validateAdministrativeGeometry——唯一校验入口、AdministrativeGeometryContract 类型）。不依赖
 *   React / R3F / Three.js / DOM（fetch 是 Web 标准 API）。
 *
 * 失败语义（与 load-heightmap-texture 同一「绝不静默退化」原则；SPEC §6 政治边界完整性是事故级红线）：
 * - fetch 失败（网络 / HTTP 非 2xx）→ 抛 ProvinceGeometryLoadError（fetch-failed）。
 * - 资产未通过 administrative-geometry 契约校验（kind / crs / features 结构 / 坐标合法性 / adminId
 *   唯一性等）→ 抛 ProvinceGeometryLoadError（contract-invalid）。绝不返回部分 / 伪造几何——省界
 *   准备层会基于错误几何产出错误边界，违反政治红线。
 * - 校验复用契约层唯一入口 validateAdministrativeGeometry，不在本层另写一套几何校验。
 */

import { validateAdministrativeGeometry } from '../geo-contracts'
import type { AdministrativeGeometryContract } from '../geo-contracts'

/** 加载期失败的稳定错误码（含 fetch / 契约两类根因），供调用方确定性处理。 */
export type ProvinceGeometryLoadFailureCode =
  | 'province-geometry.fetch-failed'
  | 'province-geometry.contract-invalid'

/** 加载期错误：携带稳定 code 与简体中文说明，绝不静默退化为空 / 伪造几何。 */
export class ProvinceGeometryLoadError extends Error {
  readonly code: ProvinceGeometryLoadFailureCode
  constructor(code: ProvinceGeometryLoadFailureCode, message: string) {
    super(message)
    this.name = 'ProvinceGeometryLoadError'
    this.code = code
  }
}

/**
 * 从浏览器 fetch 省级行政区几何静态资产并经契约校验。
 *
 * 参数是资产的 URL（默认指向 public/geo 下的生产资产 china-provinces-geometry.json）。取回 JSON
 * 后用 validateAdministrativeGeometry 做契约校验（TASK-004 已通过 provinces 深度校验的资产，运行时
 * 再过同一入口作为防线）。任一步失败抛 ProvinceGeometryLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造 AdministrativeGeometryContract 字面量喂给
 * prepareProvinceBorders / findProvinceAtLonLat，或以 stub 的 fetch 驱动本函数。
 */
export async function loadProvinceGeometry(
  url = '/geo/china-provinces-geometry.json',
): Promise<AdministrativeGeometryContract> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new ProvinceGeometryLoadError(
      'province-geometry.fetch-failed',
      `获取省级行政区几何失败（${url}）：${(cause as Error).message}。`,
    )
  }
  if (!response.ok) {
    throw new ProvinceGeometryLoadError(
      'province-geometry.fetch-failed',
      `获取省级行政区几何失败（${url}）：HTTP ${response.status}。`,
    )
  }
  const payload: unknown = await response.json()
  const outcome = validateAdministrativeGeometry(payload)
  if (!outcome.ok) {
    throw new ProvinceGeometryLoadError(
      'province-geometry.contract-invalid',
      `省级行政区几何未通过 administrative-geometry 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return payload as AdministrativeGeometryContract
}
