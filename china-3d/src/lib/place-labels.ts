/**
 * 省名 Billboard 标签 / 省会光点 / 省会名小字的主图呈现数据准备（领域层，TASK-010，SPEC §3.7）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-borders.ts / elevation.ts / projection.ts
 *   同层。它把「地点目录契约（PlaceDirectoryContract，TASK-004 共享事实源：省名锚点 + 省级
 *   行政中心）+ 共享双线性高程查询（ElevationProvider）+ 夸张系数 k + 浮高 / epsilon 配置」
 *   确定性地变换为「34 个省名 Billboard 标签的世界坐标（锚点上方浮高）+ 34 个省级行政中心
 *   光点的世界坐标（贴地）+ 34 个省会名小字标签的世界坐标（光点上方浮高，仅 hover 呈现）」，
 *   供渲染层（src/three/PlaceLabels）**只消费、不再计算**。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（PlaceDirectoryContract /
 *   PlaceDirectoryEntry 类型）、同层坐标权威 src/lib/projection（projectToWorld——
 *   lon/lat→世界 x,z 的唯一入口）、同层高程权威 src/lib/elevation
 *   （ElevationProvider.queryAtWorld——世界点→真实米制海拔的唯一入口）。**禁止**依赖
 *   React / R3F / Three.js / troika / DOM / hover 状态 / src/config（与省界准备层同构的
 *   分层约束：标签视图只能消费地点领域数据、投影和高程结果，不得自行维护经纬度或中文名称
 *   副本）。
 *
 * 唯一事实源（不得自行维护经纬度或中文名称副本）：
 * - 省名锚点经纬度、省级行政中心经纬度、省名（shortName）、省会名全部来自入参
 *   PlaceDirectoryContract（由 src/lib/place-directory 从 public/geo/china-places.json 加载、
 *   经契约校验）。本模块**不**内置任何坐标 / 中文名，也不从别处读取省份数据。
 * - 运行时字体覆盖校验所需的「实际渲染字符串」由本模块的 collectRenderedPlaceLabelStrings
 *   从同一契约确定性提取（省名 + 省会名——渲染层将绘制的全部文本），与离线字体生产脚本
 *   共用同一契约事实源，无第二份字符串副本。
 *
 * 锚点职责边界（SPEC §3.7「默认固定于省几何中心/省会坐标，不做实时碰撞推开；京津沪港澳密集区
 * 接受默认布局」）：
 * - 省名标签固定放置在地点目录的 provinceNameAnchor 锚点上方（world_y = h·k + 浮高）。锚点的
 *   经纬度与人工校正（内蒙古 / 黑龙江 / 甘肃 / 西藏的 distinctAnchor，已附 anchorAdjustmentNote
 *   并经 point-in-polygon 验证）由 TASK-004 地点目录承载。本模块不做任何标签偏移 / 碰撞推开
 *   ——固定锚点 + 固定浮高，密集区域（京津沪港澳）依赖数据层已有的可审计锚点。
 * - 地形遮挡透明度（src/lib/label-occlusion）与 hover 放大置顶（渲染层消费
 *   src/config/province-hover 三常量）各有专属模块，本模块不复制其状态逻辑。
 *
 * 浮高语义（SPEC §3.7）：
 * - 省名标签：world_y = h·k + provinceLabelHeightOffset（浮于锚点地形之上，h 取自共享高程
 *   查询、k 为夸张系数）。h·k 与 GPU vertex shader 的位移公式、省界准备的贴地公式是同一
 *   公式；此处内联以避免 src/lib 反向依赖 src/config。
 * - 省会光点：world_y = h·k + epsilon（贴地，与省界同 h·k+epsilon，epsilon 把光点放到地表
 *   外侧）。34 省会的生产坐标全部落在陆地（已用生产 heightmap 全量核实 h ≥ 0），无需海平面
 *   钳制。
 * - 省会名小字：world_y = h·k + epsilon + capitalLabelHeightOffset（光点上方浮高，仅 hover
 *   该省时呈现，与光点同 x/z 稳定关联）。
 *
 * 异常语义（标签 / 光点加载错误都有明确状态，绝不静默产出缺省 / 错位标签）：
 * - 输入非法（exaggeration 非有限 / 浮高非有限 / epsilon 非有限 / 契约 entries 为空）→ 抛
 *   PlaceLabelPrepError（稳定 code），整条准备失败。
 * - 结构违规（锚点数 ≠ 行政中心数 ≠ 唯一 adminId 数 → 角色-配对失衡）→ 抛
 *   PlaceLabelPrepError，绝不产出缺省 / 重复标签。
 * - 任一点投影失败（projectToWorld 失败——越出主图范围）、任一高程查询失败（queryAtWorld
 *   失败——越出元数据范围 / provider 已释放）→ 抛 PlaceLabelPrepError，绝不产出部分标签。
 */

import type { PlaceDirectoryContract, PlaceDirectoryEntry } from '../geo-contracts'
import type { ElevationProvider } from './elevation'
import { projectToWorld } from './projection'

/**
 * 标签准备的入参配置（领域层声明的「我需要什么」，由 src/config/place-labels 提供具体值）。
 *
 * 与省界准备配置同构（浮高 + epsilon），不承载渲染参数（色 / 字号 / 字体 URL 属渲染层，
 * 不进领域层）。
 */
export interface PlaceLabelPrepConfig {
  /** 省名标签浮于锚点地形之上的世界 y 偏移（米）。world_y = h·k + 本值。 */
  readonly provinceLabelHeightOffsetMeters: number
  /** 省会名小字标签浮于省会光点之上的世界 y 偏移（米）。world_y = h·k + epsilon + 本值。 */
  readonly capitalLabelHeightOffsetMeters: number
  /** 贴地 epsilon（米，世界 y 偏移）。省会光点 world_y = h·k + 本值。 */
  readonly terrainEpsilonMeters: number
}

/** 准备好的单个省名 Billboard 标签（固定在可审计锚点上方）。 */
export interface PreparedProvinceNameLabel {
  /** 行政区稳定标识（CN- 前缀），渲染层据此分组与 hover 寻址。 */
  readonly adminId: string
  /** 省名（地点目录 shortName，原样透传——本模块不复制中文名表）。 */
  readonly text: string
  /** 世界坐标 [x, y, z]；y = h·k + provinceLabelHeightOffset（锚点上方浮高）。 */
  readonly position: readonly [number, number, number]
}

/** 准备好的单个省级行政中心光点（贴地，位置真实）。 */
export interface PreparedCapitalPoint {
  /** 行政区稳定标识（CN- 前缀）。 */
  readonly adminId: string
  /** 世界坐标 [x, y, z]；y = h·k + epsilon（贴地）。 */
  readonly position: readonly [number, number, number]
}

/**
 * 准备好的单个省会名小字标签（浮于省会光点之上，与光点同源同坐标稳定关联）。
 * 仅 hover 该省时由渲染层以小字呈现（SPEC §3.7「省会名以小字呈现」的落点）。
 */
export interface PreparedCapitalNameLabel {
  /** 行政区稳定标识（CN- 前缀），渲染层据此与 hover 焦点匹配。 */
  readonly adminId: string
  /** 省会名（地点目录 administrativeCapital 的 name，原样透传）。 */
  readonly name: string
  /** 世界坐标 [x, y, z]；y = h·k + epsilon + capitalLabelHeightOffset（光点上方浮高）。 */
  readonly position: readonly [number, number, number]
}

/** 准备好的全部标签 / 光点（渲染层消费的稳定产物）。 */
export interface PreparedPlaceLabels {
  /** 34 个省名标签（按 adminId 升序，锚点上方浮高）。 */
  readonly provinceLabels: readonly PreparedProvinceNameLabel[]
  /** 34 个省级行政中心光点（按 adminId 升序，贴地）。 */
  readonly capitalPoints: readonly PreparedCapitalPoint[]
  /** 34 个省会名小字标签（按 adminId 升序，光点上方浮高，仅 hover 呈现）。 */
  readonly capitalLabels: readonly PreparedCapitalNameLabel[]
}

/** 准备失败的稳定错误码（供自动化测试精确断言「结构违规 / 查询失败时整条准备失败」）。 */
export type PlaceLabelPrepFailureCode =
  | 'place-labels.exaggeration-not-finite'
  | 'place-labels.height-offset-not-finite'
  | 'place-labels.epsilon-not-finite'
  | 'place-labels.empty-places'
  | 'place-labels.role-pair-imbalance'
  | 'place-labels.projection-failed'
  | 'place-labels.elevation-query-failed'

/**
 * 标签准备错误：携带稳定 code 与简体中文说明。
 * 输入非法、结构违规（角色-配对失衡）、任一投影 / 高程查询失败时抛出，使整条准备明确失败、
 * 不产出缺省 / 错位标签。
 */
export class PlaceLabelPrepError extends Error {
  readonly code: PlaceLabelPrepFailureCode
  constructor(code: PlaceLabelPrepFailureCode, message: string) {
    super(message)
    this.name = 'PlaceLabelPrepError'
    this.code = code
  }
}

/**
 * 把经纬度投影到主图世界 (x, z) 平面。投影失败（越出主图范围）→ 抛 projection-failed。
 * 省会 / 锚点坐标天然在境内（资产级 coordinate-out-of-extent 已把关），正常运行路径不触发。
 */
function projectEntryToWorld(lon: number, lat: number, context: string): { x: number; z: number } {
  const result = projectToWorld(lon, lat)
  if (!result.ok) {
    throw new PlaceLabelPrepError(
      'place-labels.projection-failed',
      `${context} 投影失败 lon=${lon} lat=${lat}：${result.code}。`,
    )
  }
  return { x: result.value.x, z: result.value.z }
}

/**
 * 查询「贴地」世界 y：world_y = h·k + epsilon（陆地贴合地形）。
 *
 * queryAtWorld 内部先 invertWorld 反算经纬度、再 queryAtLonLat（含元数据范围校验 + 双线性
 * 采样）。任一步失败（越出元数据范围 / provider 已释放 / 反投影失败）→ 抛
 * elevation-query-failed。h·k 与 GPU 位移、省界准备同一公式。
 */
function queryTerrainConformantWorldY(
  x: number,
  z: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  context: string,
): number {
  const query = provider.queryAtWorld(x, z)
  if (!query.ok) {
    throw new PlaceLabelPrepError(
      'place-labels.elevation-query-failed',
      `${context} 贴地高程查询失败 x=${x} z=${z}：${query.code}。`,
    )
  }
  // 真实海拔 h × 夸张系数 k；与 GPU 位移、省界准备同一公式。
  return query.meters * exaggeration + epsilon
}

/**
 * 从地点目录契约确定性提取「渲染层将绘制的全部字符串」（运行时字体覆盖校验用）。
 *
 * 包括：全部省名（provinceNameAnchor 的 name = shortName）+ 全部省会名
 * （administrativeCapital 的 name）。顺序固定（地点目录条目序）。本函数是「渲染字符串集合」
 * 的唯一提取入口——App 装配层在渲染标签前用它对字体清单做覆盖校验（缺字即显式失败），
 * 与离线字体生产脚本从同一契约取数，不存在第二份中文名副本。
 */
export function collectRenderedPlaceLabelStrings(
  placeContract: PlaceDirectoryContract,
): readonly string[] {
  return placeContract.entries.map((entry) => entry.name)
}

/**
 * 把地点目录 entries 按角色分区为「省名锚点」与「省级行政中心」，并断言角色-配对结构。
 *
 * 结构不变量（与 places 资产深度校验同构）：每个 adminId 恰有 1 个 provinceNameAnchor + 1 个
 * administrativeCapital。任一 adminId 的角色数 ≠ 各 1 → 抛 role-pair-imbalance（角色-配对
 * 失衡），绝不产出缺省 / 重复标签。
 */
function partitionPlacesByRole(
  entries: readonly PlaceDirectoryEntry[],
): { anchors: PlaceDirectoryEntry[]; capitals: PlaceDirectoryEntry[] } {
  const anchors = entries.filter((e) => e.role === 'provinceNameAnchor')
  const capitals = entries.filter((e) => e.role === 'administrativeCapital')
  // 每个角色集合内 adminId 唯一（契约层已保证 id 唯一，但 adminId 可能重复出现于两角色）。
  const anchorAdmins = new Set(anchors.map((a) => a.adminId))
  const capitalAdmins = new Set(capitals.map((a) => a.adminId))
  // 锚点数 = 行政中心数 = 唯一 adminId 数（每 admin 恰 1 锚点 + 1 行政中心）。
  if (
    anchors.length !== capitals.length ||
    anchors.length !== anchorAdmins.size ||
    capitals.length !== capitalAdmins.size ||
    anchorAdmins.size !== capitalAdmins.size
  ) {
    throw new PlaceLabelPrepError(
      'place-labels.role-pair-imbalance',
      `地点目录角色-配对失衡：锚点 ${anchors.length}（唯一 admin ${anchorAdmins.size}）/ 行政中心 ${capitals.length}（唯一 admin ${capitalAdmins.size}），应每 admin 恰 1 锚点 + 1 行政中心——拒绝准备缺省 / 重复标签。`,
    )
  }
  return { anchors, capitals }
}

/**
 * 准备 34 个省名 Billboard 标签（锚点上方浮高），按 adminId 升序输出。
 *
 * 每个锚点：投影到世界 (x,z) → 查询贴地 h·k（epsilon=0，浮高本身已把标签抬到地形之上）→
 * world_y = h·k + provinceLabelHeightOffset → 输出 { adminId, text: anchor.name, position }。
 * text 原样透传 shortName（不复制中文名表）。
 */
function prepareProvinceLabels(
  anchors: readonly PlaceDirectoryEntry[],
  provider: ElevationProvider,
  exaggeration: number,
  provinceLabelHeightOffset: number,
): PreparedProvinceNameLabel[] {
  const labels: PreparedProvinceNameLabel[] = anchors.map((anchor) => {
    const { lon, lat } = anchor.coordinate
    const { x, z } = projectEntryToWorld(lon, lat, `省名锚点「${anchor.name}」`)
    const terrainY = queryTerrainConformantWorldY(
      x,
      z,
      provider,
      exaggeration,
      0, // 省名标签用浮高而非贴地 epsilon：world_y = h·k + 浮高。
      `省名锚点「${anchor.name}」`,
    )
    return {
      adminId: anchor.adminId,
      text: anchor.name,
      position: [x, terrainY + provinceLabelHeightOffset, z] as readonly [number, number, number],
    }
  })
  // 按 adminId 升序，使输出顺序确定、可审计（港澳台 CN-71/81/82 在尾部）。
  labels.sort((a, b) => a.adminId.localeCompare(b.adminId))
  return labels
}

/**
 * 准备 34 个省级行政中心光点（贴地）与 34 个省会名小字标签（光点上方浮高），同遍历产出、
 * 各自按 adminId 升序输出。
 *
 * 每个行政中心：投影到世界 (x,z) → 查询贴地 h·k → 光点 world_y = h·k + epsilon；小字标签
 * world_y = 光点 y + capitalLabelHeightOffset（与光点同 x/z 稳定关联）。name 原样透传省会名。
 */
function prepareCapitalPointsAndLabels(
  capitals: readonly PlaceDirectoryEntry[],
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  capitalLabelHeightOffset: number,
): { points: PreparedCapitalPoint[]; labels: PreparedCapitalNameLabel[] } {
  const points: PreparedCapitalPoint[] = []
  const labels: PreparedCapitalNameLabel[] = []
  for (const capital of capitals) {
    const { lon, lat } = capital.coordinate
    const { x, z } = projectEntryToWorld(lon, lat, `省级行政中心「${capital.name}」`)
    const groundY = queryTerrainConformantWorldY(
      x,
      z,
      provider,
      exaggeration,
      epsilon,
      `省级行政中心「${capital.name}」`,
    )
    points.push({ adminId: capital.adminId, position: [x, groundY, z] as const })
    labels.push({
      adminId: capital.adminId,
      name: capital.name,
      position: [x, groundY + capitalLabelHeightOffset, z] as const,
    })
  }
  points.sort((a, b) => a.adminId.localeCompare(b.adminId))
  labels.sort((a, b) => a.adminId.localeCompare(b.adminId))
  return { points, labels }
}

/**
 * 把地点目录契约确定性地准备为主图标签 / 光点呈现要素（省名标签 + 省会光点 + 省会名小字）。
 *
 * 流水线：
 * 1. 入参校验：exaggeration 有限、浮高有限、epsilon 有限、地点 entries 非空。
 * 2. 角色-配对结构断言（partitionPlacesByRole）：每 admin 恰 1 锚点 + 1 行政中心，否则抛
 *    role-pair-imbalance。
 * 3. 省名标签：锚点投影 + 贴地 h·k + 浮高。
 * 4. 省会光点 + 省会名小字：行政中心投影 + 贴地 h·k + epsilon（+ 小字浮高）。
 *
 * @param placeContract 地点目录契约（TASK-004 共享事实源，已通过 place-directory 契约校验）。
 * @param provider 共享双线性高程查询（TASK-006），与 GPU 位移同一份高程事实源。
 * @param exaggeration 垂直夸张系数 k（来自配置层，合法范围由配置层保证）。
 * @param config 省名 / 省会名小字浮高 + epsilon（来自 src/config/place-labels）。
 * @returns 省名标签 + 省会光点 + 省会名小字标签的世界坐标（渲染层直接消费）。
 * @throws {PlaceLabelPrepError} 输入非法、结构违规、任一投影 / 高程查询失败时。
 */
export function preparePlaceLabels(
  placeContract: PlaceDirectoryContract,
  provider: ElevationProvider,
  exaggeration: number,
  config: PlaceLabelPrepConfig,
): PreparedPlaceLabels {
  // 入参校验（任一非法 → 显式失败，绝不静默产出缺省 / 错位标签）。
  if (!Number.isFinite(exaggeration)) {
    throw new PlaceLabelPrepError(
      'place-labels.exaggeration-not-finite',
      `夸张系数必须为有限数值，实际为 ${exaggeration}。`,
    )
  }
  if (
    !Number.isFinite(config.provinceLabelHeightOffsetMeters) ||
    !Number.isFinite(config.capitalLabelHeightOffsetMeters)
  ) {
    throw new PlaceLabelPrepError(
      'place-labels.height-offset-not-finite',
      `标签浮高必须为有限数值，实际省名=${config.provinceLabelHeightOffsetMeters} / 省会名=${config.capitalLabelHeightOffsetMeters}。`,
    )
  }
  if (!Number.isFinite(config.terrainEpsilonMeters)) {
    throw new PlaceLabelPrepError(
      'place-labels.epsilon-not-finite',
      `贴地 epsilon 必须为有限数值，实际为 ${config.terrainEpsilonMeters}。`,
    )
  }
  if (placeContract.entries.length === 0) {
    throw new PlaceLabelPrepError(
      'place-labels.empty-places',
      '标签准备需要至少一个地点条目，实际 placeContract.entries 为空。',
    )
  }

  // 角色-配对结构断言（每 admin 恰 1 锚点 + 1 行政中心）。
  const { anchors, capitals } = partitionPlacesByRole(placeContract.entries)

  const provinceLabels = prepareProvinceLabels(
    anchors,
    provider,
    exaggeration,
    config.provinceLabelHeightOffsetMeters,
  )
  const { points: capitalPoints, labels: capitalLabels } = prepareCapitalPointsAndLabels(
    capitals,
    provider,
    exaggeration,
    config.terrainEpsilonMeters,
    config.capitalLabelHeightOffsetMeters,
  )

  return { provinceLabels, capitalPoints, capitalLabels }
}
