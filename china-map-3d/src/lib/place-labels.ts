/**
 * 省名 / 省会光点 / 岛礁名称标注的主图呈现数据准备（领域层，TASK-016）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 province-borders.ts / political-features.ts / elevation.ts /
 *   projection.ts 同层。它把「地点目录契约（PlaceDirectoryContract，TASK-005 共享事实源：省名锚点 + 省级行政
 *   中心）+ 政治边界补充契约（PoliticalBoundaryContract，TASK-006 共享事实源：岛礁 / 附属岛屿规范名称与
 *   坐标）+ 共享双线性高程查询（ElevationProvider）+ 夸张系数 k + 浮高 / epsilon / 海平面 y 配置」确定性地
 *   变换为「34 个省名 Billboard 标签的世界坐标（锚点上方浮高）+ 34 个省级行政中心光点的世界坐标（贴地）+
 *   岛礁名称标签的世界坐标（岛礁点位上方浮高）」，供渲染层（src/three/PlaceLabels）**只消费、不再计算**。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（PlaceDirectoryContract / PoliticalBoundaryContract /
 *   IslandOrReefPointFeature / PlaceRole 类型、SPEC §6 红线点名领域真值 political-catalog 的
 *   REQUIRED_ISLAND_NAMES）、同层坐标权威 src/lib/projection（projectToWorld —— lon/lat→世界 x,z 的唯一入口）、
 *   同层高程权威 src/lib/elevation（ElevationProvider.queryAtWorld —— 世界点→真实米制海拔的唯一入口）。
 *   **禁止**依赖 React / R3F / Three.js / troika / DOM / hover 状态 / src/config（与省界 / 政治要素准备层同构的
 *   分层约束，TASK-016 实现约束「标签和光点视图只能消费地点 / 政治领域数据、投影和高程结果，不得自行维护
 *   经纬度或中文名称副本」）。
 *
 * 唯一事实源（TASK-016 实现约束「不得自行维护经纬度或中文名称副本」）：
 * - 省名锚点经纬度、省级行政中心经纬度、省名（shortName）全部来自入参 PlaceDirectoryContract（由
 *   src/lib/place-directory 从 public/geo/china-places.json 加载、经契约校验）。
 * - 岛礁规范名称与坐标全部来自入参 PoliticalBoundaryContract（由 src/lib/political-boundary 从
 *   public/geo/china-political-boundary.json 加载）。本模块**不**内置任何坐标 / 中文名，**不**从别处读取省 / 岛礁
 *   数据。字体子集的来源字符串也由本模块的 collectAllLabelDomainStrings 从同一对契约确定性提取（供字体覆盖
 *   校验与离线字体生产脚本共用，无第二份字符串副本）。
 *
 * 锚点职责边界（TASK-016 实现约束「标签使用固定锚点，不实现实时碰撞推开；京津沪港澳等密集区域可使用数据层
 *   已有的可审计锚点校正」）：
 * - 省名标签固定放置在地点目录的 provinceNameAnchor 锚点上方（world_y = h·k + 浮高）。锚点的经纬度与
 *   人工校正（内蒙古 / 黑龙江 / 甘肃 / 西藏的 distinctAnchor，已附 anchorAdjustmentNote 并经 point-in-polygon
 *   验证）由 TASK-005 地点目录承载。本模块不在组件内做任何标签偏移 / 碰撞推开——固定锚点 + 固定浮高，
 *   密集区域（京津沪港澳）依赖数据层已有的可审计锚点，不在本层引入实时碰撞系统（TASK-016 实现约束）。
 * - 地形遮挡透明度处理由 TASK-017 交付、hover 放大置顶由 TASK-018 交付，本模块不复制其状态逻辑
 *   （TASK-016 实现约束「不在此处复制状态逻辑」）。
 *
 * 浮高语义（SPEC §3.7「Billboard 标签」、TASK-016 输出约束「固定在可审计锚点上方并始终面向相机」）：
 * - 省名标签：world_y = h·k + provinceLabelHeightOffset（浮于锚点地形之上，h 取自共享高程查询、k 为夸张系数）。
 *   h·k 与 GPU vertex shader 的 `displaced.y = h * uExaggeration`、省界 / 政治要素准备的 queryTerrainWorldY
 *   是同一公式；此处内联以避免 src/lib 反向依赖 src/config。
 * - 省会光点：world_y = h·k + epsilon（贴地，与省界同 h·k+epsilon，epsilon 把光点放到地表外侧）。
 * - 岛礁名称标签：world_y = max(h·k, seaLevel) + epsilon + islandLabelHeightOffset（岛礁点位上方浮高）。
 *   海平面贴合语义与政治要素准备（src/lib/political-features）同构：岛礁多在海域，海域负高程（h<0）会使
 *   h·k 为负、把标签压到海面之下被吞没，故钳制到海平面之上再浮高。此处的 max(h·k, seaLevel) 是「岛礁标签
 *   海平面贴合」的本层职责（标签需在可见的岛礁点位上方），非复制投影 / 解码公式。
 *
 * 异常语义（TASK-016 输出约束「标签、地点光点和字体加载错误都有明确状态」、验证方式 2「缺字 / 缺点时应
 *   明确失败」）：
 * - 输入非法（exaggeration 非有限 / 浮高非有限 / epsilon 非有限 / seaLevel 非有限 / 契约 entries 为空）→ 抛
 *   PlaceLabelPrepError（稳定 code），整条准备失败。
 * - 结构违规（锚点数 ≠ 行政中心数 ≠ 唯一 adminId 数 → 角色-配对失衡；SPEC §6 点名岛礁缺项）→ 抛
 *   PlaceLabelPrepError，绝不产出缺省 / 错位标签。
 * - 任一点投影失败（projectToWorld 失败——越出主图范围）、任一高程查询失败（queryAtWorld 失败——越出
 *   元数据范围 / provider 已释放）→ 抛 PlaceLabelPrepError，绝不产出部分标签 / 光点。
 */

import type {
  IslandOrReefPointFeature,
  PlaceDirectoryContract,
  PlaceDirectoryEntry,
  PoliticalBoundaryContract,
} from '../geo-contracts'
import { REQUIRED_ISLAND_NAMES } from '../geo-contracts/political-catalog'
import type { ElevationProvider } from './elevation'
import { projectToWorld } from './projection'

/**
 * 标签准备的入参配置（领域层声明的「我需要什么」，由 src/config/place-labels 提供具体值）。
 *
 * 与省界 / 政治要素准备配置同构（浮高 + epsilon + 海平面 y），不承载渲染参数（色 / 字号 / 字体 URL 属
 * 渲染层，不进领域层）。
 */
export interface PlaceLabelPrepConfig {
  /** 省名标签浮于锚点地形之上的世界 y 偏移（米）。world_y = h·k + 本值。 */
  readonly provinceLabelHeightOffsetMeters: number
  /** 岛礁名称标签浮于岛礁点位之上的世界 y 偏移（米）。world_y = max(h·k, seaLevel) + epsilon + 本值。 */
  readonly islandLabelHeightOffsetMeters: number
  /** 贴地 epsilon（米，世界 y 偏移）。省会光点 world_y = h·k + 本值。 */
  readonly terrainEpsilonMeters: number
  /** 海平面世界 y（米），岛礁名称标签海平面贴合的锚点（与动态海面同一米制海平面）。 */
  readonly seaLevelYMeters: number
}

/** 准备好的单个省名 Billboard 标签（固定在可审计锚点上方）。 */
export interface PreparedProvinceNameLabel {
  /** 行政区稳定标识（CN- 前缀），渲染层据此分组、后续 hover（TASK-018）据此寻址。 */
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

/** 准备好的单个岛礁名称标签（浮于岛礁点位之上，名称与点位同源同坐标稳定关联）。 */
export interface PreparedIslandNameLabel {
  /** 岛礁规范名称（政治边界 islandOrReefPoint.name，原样透传）。 */
  readonly name: string
  /** 世界坐标 [x, y, z]；y = max(h·k, seaLevel) + epsilon + islandLabelHeightOffset（岛礁点位上方浮高）。 */
  readonly position: readonly [number, number, number]
}

/** 准备好的全部标签 / 光点（渲染层消费的稳定产物）。 */
export interface PreparedPlaceLabels {
  /** 34 个省名标签（按 adminId 升序，锚点上方浮高）。 */
  readonly provinceLabels: readonly PreparedProvinceNameLabel[]
  /** 34 个省级行政中心光点（按 adminId 升序，贴地）。 */
  readonly capitalPoints: readonly PreparedCapitalPoint[]
  /** 岛礁名称标签（按政治契约出现顺序，岛礁点位上方浮高）。 */
  readonly islandLabels: readonly PreparedIslandNameLabel[]
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺点 / 结构违规 / 查询失败时整条准备失败」）。 */
export type PlaceLabelPrepFailureCode =
  | 'place-labels.exaggeration-not-finite'
  | 'place-labels.height-offset-not-finite'
  | 'place-labels.epsilon-not-finite'
  | 'place-labels.sea-level-not-finite'
  | 'place-labels.empty-places'
  | 'place-labels.role-pair-imbalance'
  | 'place-labels.required-island-missing'
  | 'place-labels.projection-failed'
  | 'place-labels.elevation-query-failed'

/**
 * 标签准备错误：携带稳定 code 与简体中文说明。
 * 输入非法、结构违规（角色-配对失衡 / 点名岛礁缺项）、任一投影 / 高程查询失败时抛出，使整条准备明确失败、
 * 不产出缺省 / 错位标签（TASK-016 验证方式 2）。
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
 * 省会 / 锚点 / 岛礁坐标天然在境内（资产级 coordinate-out-of-extent 已把关），正常运行路径不触发。
 */
function projectEntryToWorld(
  lon: number,
  lat: number,
  context: string,
): { x: number; z: number } {
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
 * 查询「贴地」世界 y：world_y = h·k + epsilon（陆地贴合地形，省会光点用）。
 *
 * queryAtWorld 内部先 invertWorld 反算经纬度、再 queryAtLonLat（含元数据范围校验 + 双线性采样）。
 * 任一步失败（越出元数据范围 / provider 已释放 / 反投影失败）→ 抛 elevation-query-failed。
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
  // 真实海拔 h × 夸张系数 k；与 GPU 位移、省界 / 政治要素准备同一公式。
  return query.meters * exaggeration + epsilon
}

/**
 * 查询「海平面贴合」世界 y：world_y = max(h·k, seaLevel) + epsilon（岛礁名称标签的基础高度用）。
 *
 * 海平面贴合语义（见文件头）：陆地（h·k>0）贴合地形；海域（h·k≤0）钳制到海平面之上 epsilon，
 * 使岛礁名称标签不被半透明海面吞没（与政治要素岛礁点位同构）。
 */
function querySeaLevelConformantWorldY(
  x: number,
  z: number,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  context: string,
): number {
  const query = provider.queryAtWorld(x, z)
  if (!query.ok) {
    throw new PlaceLabelPrepError(
      'place-labels.elevation-query-failed',
      `${context} 海平面贴合高程查询失败 x=${x} z=${z}：${query.code}。`,
    )
  }
  const terrainWorldY = query.meters * exaggeration
  return Math.max(terrainWorldY, seaLevelYMeters) + epsilon
}

/**
 * 从地点目录 + 政治边界契约确定性提取「字体子集必须覆盖的全部领域字符串」。
 *
 * 包括：全部省名（provinceNameAnchor 的 name = shortName）+ 全部省会名（administrativeCapital 的 name）+
 * 全部岛礁规范名称（islandOrReefPoint 的 name）。本函数是运行时字体覆盖校验与离线字体生产脚本共用的同一
 * 提取入口——二者从同一对契约得到逐字符一致的字符串集合，不存在第二份中文名副本（TASK-016 实现约束）。
 *
 * 省会名虽默认不作为大字标签渲染（SPEC §3.7「省会名以 tooltip / 小字呈现，最终在实现时定」），但字体子集
 * 必须覆盖它（TASK-016 输出约束「中文字体只包含实际所需字符」的「所需」含可选呈现的省会名），故纳入覆盖
 * 范围；是否实际渲染省会名由渲染层决定，不影响字体覆盖完整性。
 */
export function collectAllLabelDomainStrings(
  placeContract: PlaceDirectoryContract,
  politicalContract: PoliticalBoundaryContract,
): readonly string[] {
  const names: string[] = []
  for (const entry of placeContract.entries) {
    names.push(entry.name)
  }
  for (const feature of politicalContract.features) {
    if (feature.type === 'islandOrReefPoint') {
      names.push(feature.name)
    }
  }
  return names
}

/**
 * 把地点目录 entries 按角色分区为「省名锚点」与「省级行政中心」，并断言角色-配对结构。
 *
 * 结构不变量（与 places-deep 同构）：每个 adminId 恰有 1 个 provinceNameAnchor + 1 个 administrativeCapital。
 * 任一 adminId 的角色数 ≠ 各 1 → 抛 role-pair-imbalance（角色-配对失衡），绝不产出缺省 / 重复标签。
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
 * 每个锚点：投影到世界 (x,z) → 查询贴地 h·k → world_y = h·k + provinceLabelHeightOffset（浮高）→
 * 输出 { adminId, text: anchor.name, position: [x, y, z] }。text 原样透传 shortName（不复制中文名表）。
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
      0, // 省名标签用浮高而非贴地 epsilon：world_y = h·k + 浮高（浮高本身已把标签抬到地形之上）。
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
 * 准备 34 个省级行政中心光点（贴地），按 adminId 升序输出。
 *
 * 每个行政中心：投影到世界 (x,z) → 查询贴地 h·k → world_y = h·k + epsilon（贴地）→
 * 输出 { adminId, position: [x, y, z] }。省会名不在此产出（保存在领域目录，渲染层可选小字呈现）。
 */
function prepareCapitalPoints(
  capitals: readonly PlaceDirectoryEntry[],
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
): PreparedCapitalPoint[] {
  const points: PreparedCapitalPoint[] = capitals.map((capital) => {
    const { lon, lat } = capital.coordinate
    const { x, z } = projectEntryToWorld(lon, lat, `省级行政中心「${capital.name}」`)
    const y = queryTerrainConformantWorldY(
      x,
      z,
      provider,
      exaggeration,
      epsilon,
      `省级行政中心「${capital.name}」`,
    )
    return {
      adminId: capital.adminId,
      position: [x, y, z] as readonly [number, number, number],
    }
  })
  points.sort((a, b) => a.adminId.localeCompare(b.adminId))
  return points
}

/**
 * 断言政治边界契约含 SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙），缺任一项 → 抛 required-island-missing。
 *
 * 与政治要素准备层 assertRedLineCompleteness 共用同一份 political-catalog.REQUIRED_ISLAND_NAMES 领域真值，
 * 不在本模块手写第二套岛礁名清单（TASK-016 实现约束「不得复制中文名称副本」）。
 */
function assertRequiredIslandsPresent(politicalContract: PoliticalBoundaryContract): void {
  const names = new Set<string>()
  for (const feature of politicalContract.features) {
    if (feature.type === 'islandOrReefPoint') {
      names.add(feature.name)
    }
  }
  const missing = REQUIRED_ISLAND_NAMES.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new PlaceLabelPrepError(
      'place-labels.required-island-missing',
      `缺少 SPEC §6 点名岛礁 / 附属岛屿：[${missing.join('、')}]——拒绝准备缺失岛礁名称标签的残缺主图。`,
    )
  }
}

/**
 * 准备岛礁名称标签（岛礁点位上方浮高），按政治契约出现顺序输出。
 *
 * 每个岛礁点位：投影到世界 (x,z) → 查询海平面贴合 max(h·k, seaLevel)+epsilon →
 * world_y = 海平面贴合 y + islandLabelHeightOffset（岛礁点位上方浮高）→
 * 输出 { name, position: [x, y, z] }。name 原样透传（不复制）。岛礁名称标签与 TASK-015 岛礁点位同源同坐标
 * （都从 politicalContract.features 的 islandOrReefPoint 经同一 projectToWorld 投影），稳定关联。
 */
function prepareIslandLabels(
  politicalContract: PoliticalBoundaryContract,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  islandLabelHeightOffset: number,
): PreparedIslandNameLabel[] {
  const labels: PreparedIslandNameLabel[] = []
  for (const feature of politicalContract.features) {
    if (feature.type !== 'islandOrReefPoint') continue
    labels.push(
      prepareSingleIslandLabel(
        feature,
        provider,
        exaggeration,
        epsilon,
        seaLevelYMeters,
        islandLabelHeightOffset,
      ),
    )
  }
  return labels
}

function prepareSingleIslandLabel(
  feature: IslandOrReefPointFeature,
  provider: ElevationProvider,
  exaggeration: number,
  epsilon: number,
  seaLevelYMeters: number,
  islandLabelHeightOffset: number,
): PreparedIslandNameLabel {
  const { lon, lat } = feature.coordinate
  const { x, z } = projectEntryToWorld(lon, lat, `岛礁名称标签「${feature.name}」`)
  const baseY = querySeaLevelConformantWorldY(
    x,
    z,
    provider,
    exaggeration,
    epsilon,
    seaLevelYMeters,
    `岛礁名称标签「${feature.name}」`,
  )
  return {
    name: feature.name,
    position: [x, baseY + islandLabelHeightOffset, z] as readonly [number, number, number],
  }
}

/**
 * 把地点目录 + 政治边界契约确定性地准备为主图标签 / 光点呈现要素（省名标签 + 省会光点 + 岛礁名称标签）。
 *
 * 流水线：
 * 1. 入参校验：exaggeration 有限、浮高有限、epsilon 有限、seaLevel 有限、地点 entries 非空。
 * 2. 角色-配对结构断言（partitionPlacesByRole）：每 admin 恰 1 锚点 + 1 行政中心，否则抛 role-pair-imbalance。
 * 3. 岛礁红线断言（assertRequiredIslandsPresent）：SPEC §6 点名岛礁均在，否则抛 required-island-missing。
 * 4. 省名标签：锚点投影 + 贴地 h·k + 浮高。
 * 5. 省会光点：行政中心投影 + 贴地 h·k + epsilon。
 * 6. 岛礁名称标签：岛礁点位投影 + 海平面贴合 + 浮高。
 *
 * @param placeContract 地点目录契约（TASK-005 共享事实源，已通过 place-directory 契约校验）。
 * @param politicalContract 政治边界补充契约（TASK-006 共享事实源，岛礁名称 + 坐标的唯一来源）。
 * @param provider 共享双线性高程查询（TASK-008），与 GPU 位移同一份高程事实源。
 * @param exaggeration 垂直夸张系数 k（来自配置层，合法范围由配置层保证）。
 * @param config 省名 / 岛礁浮高 + epsilon + 海平面 y（来自 src/config/place-labels）。
 * @returns 省名标签 + 省会光点 + 岛礁名称标签的世界坐标（渲染层直接消费）。
 * @throws {PlaceLabelPrepError} 输入非法、结构违规、点名岛礁缺项、任一投影 / 高程查询失败时。
 */
export function preparePlaceLabels(
  placeContract: PlaceDirectoryContract,
  politicalContract: PoliticalBoundaryContract,
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
    !Number.isFinite(config.islandLabelHeightOffsetMeters)
  ) {
    throw new PlaceLabelPrepError(
      'place-labels.height-offset-not-finite',
      `标签浮高必须为有限数值，实际省名=${config.provinceLabelHeightOffsetMeters} / 岛礁=${config.islandLabelHeightOffsetMeters}。`,
    )
  }
  if (!Number.isFinite(config.terrainEpsilonMeters)) {
    throw new PlaceLabelPrepError(
      'place-labels.epsilon-not-finite',
      `贴地 epsilon 必须为有限数值，实际为 ${config.terrainEpsilonMeters}。`,
    )
  }
  if (!Number.isFinite(config.seaLevelYMeters)) {
    throw new PlaceLabelPrepError(
      'place-labels.sea-level-not-finite',
      `海平面世界 y 必须为有限数值，实际为 ${config.seaLevelYMeters}。`,
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
  // 岛礁红线断言（SPEC §6 点名岛礁均在）。
  assertRequiredIslandsPresent(politicalContract)

  const provinceLabels = prepareProvinceLabels(
    anchors,
    provider,
    exaggeration,
    config.provinceLabelHeightOffsetMeters,
  )
  const capitalPoints = prepareCapitalPoints(
    capitals,
    provider,
    exaggeration,
    config.terrainEpsilonMeters,
  )
  const islandLabels = prepareIslandLabels(
    politicalContract,
    provider,
    exaggeration,
    config.terrainEpsilonMeters,
    config.seaLevelYMeters,
    config.islandLabelHeightOffsetMeters,
  )

  return { provinceLabels, capitalPoints, islandLabels }
}
