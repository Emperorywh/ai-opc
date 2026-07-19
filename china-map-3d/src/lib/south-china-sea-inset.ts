/**
 * 南海诸岛 2D 标准附图的数据准备（领域层，TASK-019，SPEC §3.8 / §5.4）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），把「政治边界补充契约（PoliticalBoundaryContract，TASK-006 共享
 *   事实源，与主图 3D 政治要素层 src/lib/political-features 同源）+ 附图 2D 子范围四至（InsetExtent）」
 *   确定性地变换为「十段线各段的归一化视口 (u,v) 折线 + 岛礁点位的归一化视口 (u,v) + 规范名称」，供
 *   渲染层（src/components/SouthChinaSeaInset 的 SVG overlay）只消费、不再计算。
 * - 单向依赖：契约层 src/geo-contracts（PoliticalBoundaryContract / NineDashLineSegmentFeature /
 *   IslandOrReefPointFeature 类型、红线点名领域真值 political-catalog 的 EXPECTED_NINE_DASH_SEGMENT_COUNT /
 *   TAIWAN_EAST_SEGMENT_INDEX）、同层坐标权威 src/lib/projection（projectToInset —— lon/lat→附图归一化视口
 *   (u,v) 的唯一入口，内部走与主图同一 projectToMercator；InsetViewportPoint 类型）、同层红线扫描共享单源
 *   src/lib/political-red-line（collectPoliticalRedLineGaps）。禁止依赖 React / R3F / Three.js / DOM /
 *   hover 状态 / src/config（与主图政治要素准备层同构的分层约束）。
 *
 * 唯一事实源（TASK-019 实现约束「主图和附图必须共享 TASK-006 数据及 TASK-007 投影；禁止复制一份专用
 * 十段线、岛礁或名称数组」）：
 * - 十段线段序号、岛礁规范名称与坐标全部来自入参 PoliticalBoundaryContract（由 src/lib/political-boundary
 *   从 public/geo/china-political-boundary.json 加载，与主图政治要素层 fetch 同一份资产）。本模块不内置
 *   任何坐标、不补写任何段或点、不维护第二套十段线 / 岛礁数组。
 * - 坐标变换复用 projectToInset（TASK-007 同一墨卡托投影）：同一岛礁点位在主图（projectToWorld）与
 *   附图（projectToInset）来自同一墨卡托结果，仅视口映射不同（SPEC §3.8、TASK-019 验证方式 1「同一坐标
 *   与主图投影结果一致」）。本模块把 projectToInset 的成功值 InsetViewportPoint 直接作为折线顶点 / 点位
 *   坐标，不重组、不二次归一化、不引入第二套投影公式。
 *
 * 红线完整性（SPEC §6、TASK-019 验证方式 2「删除测试输入中的台湾东侧段或任一必需岛礁名称 → 附图准备
 * 明确失败」）：
 * - 准备入口对红线缺项做独立断言：collectPoliticalRedLineGaps（src/lib/political-red-line，TASK-019 抽取
 *   的共享扫描单源）扫描契约、对照 political-catalog 同一份红线目录，返回缺项；本模块据缺项按既定顺序
 *   抛 SouthChinaSeaInsetPrepError（稳定 code，south-china-sea-inset.* 前缀）。任一缺段（尤其台湾东侧
 *   第 10 段）/ 缺点名岛礁 → 整条准备失败，绝不产出「缺段 / 缺点的残缺附图」（残缺附图会把「政治边界
 *   不完整」伪装成「成功呈现」，违反 SPEC §6 红线）。
 * - 红线「目录」与「扫描逻辑」与主图政治要素准备（src/lib/political-features）共用同一份单源，本模块
 *   只是 collectPoliticalRedLineGaps 的第二个消费者、抛各自错误码，不存在第二套段数 / 段序号 / 岛礁名
 *   清单或扫描代码。
 * - 十段线按段（segmentIndex）独立组织输出（PreparedInsetLine[]），不合并为单条连续折线——使每段可
 *   独立审计、台湾东侧段（segmentIndex=10）可独立定位（与主图政治要素层同构，TASK-015 实现约束「不把
 *   十段线合并为不可核查的单条连续折线」沿用到附图）。
 *
 * 异常语义（TASK-019 输出约束「附图准备失败时不静默显示残缺图」、回退边界「回退本 TASK 只会移除右下
 * 2D 附图；主 3D 图...全部保持不变」）：
 * - 输入非法（features 空）→ 抛 empty-features。
 * - 红线缺项 → 抛对应 code（segment-count-mismatch / segment-missing / taiwan-east-segment-missing /
 *   required-island-missing）。
 * - 任一顶点 projectToInset 失败（越出附图四至——正常四至含全部红线要素，不触发；畸形四至或越界坐标
 *   会触发）→ 抛 projection-failed，绝不产出部分折线 / 部分点位。
 * - 渲染层捕获任一上述错误后渲染 null（console.error 记录），主 3D 图不受影响。
 */

import type {
  PoliticalBoundaryContract,
} from '../geo-contracts'
import { EXPECTED_NINE_DASH_SEGMENT_COUNT, TAIWAN_EAST_SEGMENT_INDEX } from '../geo-contracts/political-catalog'
import { collectPoliticalRedLineGaps } from './political-red-line'
import { projectToInset } from './projection'
import type { InsetExtent, InsetViewportPoint } from './projection'

/**
 * 准备好的单段十段线（附图 2D 视口）。
 *
 * 按 segmentIndex 独立组织（不与其他段合并为连续折线），使每段可独立审计、台湾东侧段（segmentIndex=10）
 * 可独立定位。uvPolyline 为该段各顶点的归一化视口坐标（u,v)∈[0,1]²，由 projectToInset 投影得到。
 */
export interface PreparedInsetLine {
  /** 段序号（1..10），与源契约 segmentIndex 一一对应；台湾东侧段 segmentIndex=10。 */
  readonly segmentIndex: number
  /** 该段折线顶点的归一化视口坐标（u 随经度向东、v 随纬度向北），直接复用 projectToInset 成功值。 */
  readonly uvPolyline: readonly InsetViewportPoint[]
}

/** 准备好的单个岛礁 / 附属岛屿点位（附图 2D 视口，含规范名称）。 */
export interface PreparedInsetPoint {
  /** 规范名称（钓鱼岛 / 赤尾屿 / 曾母暗沙 / 黄岩岛 / 永兴岛等），与源契约 name 一一对应。 */
  readonly name: string
  /** 归一化视口 u（随经度向东，由 projectToInset 得到）。 */
  readonly u: number
  /** 归一化视口 v（随纬度向北，由 projectToInset 得到）。 */
  readonly v: number
}

/** 准备好的南海附图全部要素（渲染层 SVG overlay 直接消费的稳定产物）。 */
export interface PreparedSouthChinaSeaInset {
  /** 十段线各段（按 segmentIndex 升序，台湾东侧段 segmentIndex=10 在内）。 */
  readonly lines: readonly PreparedInsetLine[]
  /** 岛礁 / 附属岛屿点位 + 规范名称（按源契约出现顺序）。 */
  readonly points: readonly PreparedInsetPoint[]
}

/** 准备失败的稳定错误码（供自动化测试精确断言「缺段 / 缺点 / 越界 → 附图准备明确失败」）。 */
export type SouthChinaSeaInsetPrepFailureCode =
  | 'south-china-sea-inset.empty-features'
  | 'south-china-sea-inset.segment-count-mismatch'
  | 'south-china-sea-inset.segment-missing'
  | 'south-china-sea-inset.taiwan-east-segment-missing'
  | 'south-china-sea-inset.required-island-missing'
  | 'south-china-sea-inset.projection-failed'

/**
 * 南海附图准备错误：携带稳定 code 与简体中文说明。
 * 红线缺项（段 / 点）、空契约、或任一投影失败时抛出，使整条准备明确失败、不产出残缺附图
 * （TASK-019 验证方式 2「删除台湾东侧段或任一必需岛礁名称 → 附图准备明确失败」）。
 */
export class SouthChinaSeaInsetPrepError extends Error {
  readonly code: SouthChinaSeaInsetPrepFailureCode
  constructor(code: SouthChinaSeaInsetPrepFailureCode, message: string) {
    super(message)
    this.name = 'SouthChinaSeaInsetPrepError'
    this.code = code
  }
}

/**
 * 把政治边界补充契约确定性地准备为南海附图 2D 视口要素（十段线各段归一化折线 + 岛礁点位 + 规范名称）。
 *
 * 流水线：
 * 1. 入参校验：features 非空（空契约 → empty-features）。
 * 2. 红线完整性（collectPoliticalRedLineGaps 共享扫描单源）：十段含台湾东侧段、点名岛礁均在，缺任一项
 *    即按既定顺序抛对应 code。
 * 3. 逐段九段线：各顶点经 projectToInset 投影到归一化视口 (u,v)，组成该段折线；任一投影失败 →
 *    projection-failed。
 * 4. 逐岛礁点位：经纬度经 projectToInset 投影到 (u,v)，附规范名称；任一投影失败 → projection-failed。
 * 5. 按段序号升序输出，使台湾东侧段（segmentIndex=10）位置确定、可审计。
 *
 * 争议区修正（disputedBoundaryCorrection）不被本模块消费——附图只呈现十段线与岛礁点位（SPEC §3.8），
 * 争议区按中国主张画法的修正影响省级边界表达，由主图省界层承载。本模块与主图政治要素准备层一样跳过
 * disputedBoundaryCorrection（src/lib/political-features 同构）。
 *
 * @param contract 政治边界补充契约（TASK-006 共享事实源，与主图政治要素层同源，已通过 political-boundary
 *   契约校验）。
 * @param extent 附图 2D 子范围四至（EPSG:4326 度，来自 src/config/south-china-sea-inset）。
 * @returns 十段线各段归一化折线 + 岛礁点位 + 规范名称（渲染层 SVG overlay 直接消费）。
 * @throws {SouthChinaSeaInsetPrepError} 空契约、红线缺项、或任一投影失败时。
 */
export function prepareSouthChinaSeaInset(
  contract: PoliticalBoundaryContract,
  extent: InsetExtent,
): PreparedSouthChinaSeaInset {
  if (contract.features.length === 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.empty-features',
      '南海附图准备需要至少一个要素，实际 contract.features 为空。',
    )
  }

  // 红线完整性（SPEC §6：十段含台湾东侧段、点名岛礁均在；扫描逻辑与主图政治要素准备共用
  // collectPoliticalRedLineGaps 单源，红线目录唯一来自 political-catalog）。
  const gaps = collectPoliticalRedLineGaps(contract)
  if (gaps.segmentCount !== EXPECTED_NINE_DASH_SEGMENT_COUNT) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.segment-count-mismatch',
      `九段线必须恰好含 ${EXPECTED_NINE_DASH_SEGMENT_COUNT} 段（十段画法），实际为 ${gaps.segmentCount} 段——拒绝准备残缺南海附图。`,
    )
  }
  if (gaps.missingSegmentIndices.length > 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.segment-missing',
      `九段线缺少段序号：[${gaps.missingSegmentIndices.join(', ')}]（十段画法需 1..10 全在）——拒绝准备残缺南海附图。`,
    )
  }
  if (!gaps.taiwanEastSegmentPresent) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.taiwan-east-segment-missing',
      `九段线缺少台湾东侧段（segmentIndex=${TAIWAN_EAST_SEGMENT_INDEX}），SPEC §6 红线要求十段画法含台湾东侧那段——拒绝准备残缺南海附图。`,
    )
  }
  if (gaps.missingIslandNames.length > 0) {
    throw new SouthChinaSeaInsetPrepError(
      'south-china-sea-inset.required-island-missing',
      `缺少 SPEC §6 点名岛礁 / 附属岛屿：[${gaps.missingIslandNames.join('、')}]——拒绝准备缺失岛礁点位的残缺南海附图。`,
    )
  }

  const lines: PreparedInsetLine[] = []
  const points: PreparedInsetPoint[] = []

  for (const feature of contract.features) {
    if (feature.type === 'nineDashLineSegment') {
      // 逐顶点投影到附图归一化视口；任一失败 → projection-failed，绝不产出部分折线。
      const uv: InsetViewportPoint[] = []
      for (let i = 0; i < feature.coordinates.length; i++) {
        const coord = feature.coordinates[i]
        const result = projectToInset(coord.lon, coord.lat, extent)
        if (!result.ok) {
          throw new SouthChinaSeaInsetPrepError(
            'south-china-sea-inset.projection-failed',
            `九段线第 ${feature.segmentIndex} 段的第 ${i} 个顶点投影失败 lon=${coord.lon} lat=${coord.lat}：${result.code}。`,
          )
        }
        uv.push(result.value)
      }
      lines.push({ segmentIndex: feature.segmentIndex, uvPolyline: uv })
    } else if (feature.type === 'islandOrReefPoint') {
      // 岛礁点位投影到附图归一化视口；失败 → projection-failed。
      const { lon, lat } = feature.coordinate
      const result = projectToInset(lon, lat, extent)
      if (!result.ok) {
        throw new SouthChinaSeaInsetPrepError(
          'south-china-sea-inset.projection-failed',
          `岛礁点位「${feature.name}」投影失败 lon=${lon} lat=${lat}：${result.code}。`,
        )
      }
      points.push({ name: feature.name, u: result.value.u, v: result.value.v })
    }
    // disputedBoundaryCorrection 不被附图消费（见函数注释）。
  }

  // 按段序号升序输出，使台湾东侧段（segmentIndex=10）位置确定、可审计。
  lines.sort((a, b) => a.segmentIndex - b.segmentIndex)

  return { lines, points }
}
