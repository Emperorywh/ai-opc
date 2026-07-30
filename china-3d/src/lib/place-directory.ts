/**
 * 地点目录的运行时加载与契约校验（数据访问层，TASK-010，SPEC §3.7 / §5.5）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-geometry.ts / elevation.ts 同层。它把
 *   TASK-004 交付的静态资产 public/geo/china-places.json fetch 进来、按 place-directory
 *   契约校验，返回类型安全的 PlaceDirectoryContract（entries 数组直接供 src/lib/place-labels
 *   的主图标签准备纯函数消费——省名锚点 + 省级行政中心）。本模块只依赖契约层
 *   src/geo-contracts（validatePlaceDirectory——唯一校验入口、PlaceDirectoryContract 类型）。
 *   不依赖 React / R3F / Three.js / DOM（fetch 是 Web 标准 API）。
 *
 * 单一事实源（标签和光点视图只能消费地点领域数据，不得自行维护经纬度或中文名称副本）：
 * - 本模块是主图运行时消费地点目录的**唯一**取数入口。省名锚点与省级行政中心坐标全部来自
 *   该资产，组件层（src/three/PlaceLabels）不得自行 fetch 或硬编码坐标 / 名称。
 * - 省名（shortName）与省会名作为领域字符串只在契约资产中维护；本模块原样透传 entries，
 *   不在运行时复制第二份中文名称表（离线字体生产脚本同样读同一资产，见
 *   scripts/fonts/build-font-subset）。
 *
 * 失败语义（与 loadProvinceGeometry 同一「绝不静默退化」原则；SPEC §6 点名台湾 / 港澳标注
 * 齐全是政治红线）：
 * - fetch 失败（网络 / HTTP 非 2xx）→ 抛 PlaceDirectoryLoadError（fetch-failed）。
 * - 资产未通过 place-directory 契约校验（kind / crs / entries 结构 / 角色合法 / 坐标合法性 /
 *   source.sourceId 非空等，TASK-004 已通过 places 深度校验）→ 抛 PlaceDirectoryLoadError
 *   （contract-invalid）。绝不返回部分 / 伪造地点目录——标签准备层会基于残缺数据产出缺省 /
 *   错位标签，违反政治红线。
 * - 校验复用契约层唯一入口 validatePlaceDirectory，不在本层另写一套地点校验。
 */

import { validatePlaceDirectory } from '../geo-contracts'
import type { PlaceDirectoryContract } from '../geo-contracts'

/** 加载期失败的稳定错误码（含 fetch / 契约两类根因），供调用方确定性处理。 */
export type PlaceDirectoryLoadFailureCode =
  | 'place-directory.fetch-failed'
  | 'place-directory.contract-invalid'

/** 加载期错误：携带稳定 code 与简体中文说明，绝不静默退化为空 / 伪造地点目录。 */
export class PlaceDirectoryLoadError extends Error {
  readonly code: PlaceDirectoryLoadFailureCode
  constructor(code: PlaceDirectoryLoadFailureCode, message: string) {
    super(message)
    this.name = 'PlaceDirectoryLoadError'
    this.code = code
  }
}

/**
 * 从浏览器 fetch 地点目录静态资产并经契约校验。
 *
 * 参数是资产的 URL（默认指向 public/geo 下的生产资产 china-places.json）。取回 JSON 后用
 * validatePlaceDirectory 做契约校验（kind / version / crs=EPSG:4326 / entries 结构 / 角色合法 /
 * 坐标合法性 / source.sourceId 非空，TASK-004 已通过 places 深度校验的资产，运行时再过同一
 * 入口作为防线）。任一步失败抛 PlaceDirectoryLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造 PlaceDirectoryContract 字面量喂给
 * preparePlaceLabels，或以 stub 的 fetch 驱动本函数。
 */
export async function loadPlaceDirectory(
  url = '/geo/china-places.json',
): Promise<PlaceDirectoryContract> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new PlaceDirectoryLoadError(
      'place-directory.fetch-failed',
      `获取地点目录失败（${url}）：${(cause as Error).message}。`,
    )
  }
  if (!response.ok) {
    throw new PlaceDirectoryLoadError(
      'place-directory.fetch-failed',
      `获取地点目录失败（${url}）：HTTP ${response.status}。`,
    )
  }
  const payload: unknown = await response.json()
  const outcome = validatePlaceDirectory(payload)
  if (!outcome.ok) {
    throw new PlaceDirectoryLoadError(
      'place-directory.contract-invalid',
      `地点目录未通过 place-directory 契约校验：${outcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return payload as PlaceDirectoryContract
}
