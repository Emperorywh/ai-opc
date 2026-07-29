/**
 * SPEC §6 政治边界红线点名缺项的共享扫描（领域层）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），只依赖契约层 src/geo-contracts（PoliticalBoundaryContract
 *   类型与红线点名领域真值：REQUIRED_NINE_DASH_SEGMENT_INDICES / TAIWAN_EAST_SEGMENT_INDEX /
 *   REQUIRED_ISLAND_NAMES）。不依赖 React / R3F / Three.js / DOM / 配置层 / 其他领域计算——
 *   是一份「只读消费红线目录、产出缺项事实」的纯函数。
 *
 * 为什么单独成模块（避免两套红线扫描逻辑）：
 * - 资产深度校验（scripts/verify-assets/political-deep.ts）与后续运行时消费（主图十段线 /
 *   岛礁准备、2D 南海附图准备）都要对同一份政治边界契约做「SPEC §6 红线点名项是否齐全」的判定。
 *   若各处各自遍历 features、各自对照目录常量，就会出现多份等价的扫描代码——一旦其中一处漏判
 *   （如只查段数、漏查台湾东侧段独立锚点），残缺地图会在那一处静默生成，违反 SPEC §6 红线。
 * - 故把扫描逻辑抽成一份纯函数 collectPoliticalRedLineGaps：遍历契约 features，对照红线目录常量，
 *   返回结构化缺项（段数 / 缺段序号 / 台湾东侧段是否在 / 缺点名岛礁名）。消费者各自据缺项抛自己
 *   的稳定错误码（political-asset.* 等），因此：
 *     · 红线「目录」（点名了哪些段 / 岛礁）唯一来自契约层 political-catalog；
 *     · 红线「扫描逻辑」（如何在契约里把它们找出来、如何判定缺项）唯一来自本模块。
 *   二者都是单一定义点，没有第二套段数 / 段序号 / 岛礁名清单或扫描代码。
 * - 本模块只返回缺项事实，不抛错、不复制目录常量、不持有目录副本——它只是 political-catalog 的
 *   一个只读消费者 + 一份共享扫描实现。
 *
 * 扫描语义：
 * - 遍历 features：nineDashLineSegment 收集段序号、islandOrReefPoint 收集规范名称；
 *   disputedBoundaryCorrection 不参与红线点名扫描（争议区完整性由资产深度校验把关，SPEC §6）。
 * - 段序号去重后得 segmentCount（消费者据此判「是否恰好 10 段」）。
 * - 逐项对照 REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10）得 missingSegmentIndices。
 * - 独立判定台湾东侧段（TAIWAN_EAST_SEGMENT_INDEX = 10）是否在——即便段序号清单被误改，该独立
 *   锚点仍要求资产含此段（SPEC §6 红线「含台湾东侧那段」的硬锚点）。
 * - 逐项对照 REQUIRED_ISLAND_NAMES（钓鱼岛 / 赤尾屿 / 曾母暗沙）得 missingIslandNames。
 */

import type { PoliticalBoundaryContract } from '../geo-contracts'
import {
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
} from '../geo-contracts'

/**
 * 红线点名缺项扫描结果（纯数据，调用方决定如何报错）。
 *
 * 字段语义对应 SPEC §6 / political-catalog 的红线点名项：
 * - segmentCount：契约中 nineDashLineSegment 的去重段序号数；齐全时应等于
 *   EXPECTED_NINE_DASH_SEGMENT_COUNT（= REQUIRED_NINE_DASH_SEGMENT_INDICES.length = 10）。
 * - missingSegmentIndices：相对 REQUIRED_NINE_DASH_SEGMENT_INDICES（1..10）缺失的段序号。
 * - taiwanEastSegmentPresent：台湾东侧段（segmentIndex = TAIWAN_EAST_SEGMENT_INDEX = 10）是否在
 *   （独立锚点，不随段序号清单间接得出）。
 * - missingIslandNames：相对 REQUIRED_ISLAND_NAMES（钓鱼岛 / 赤尾屿 / 曾母暗沙）缺失的规范名称。
 */
export interface PoliticalRedLineGaps {
  readonly segmentCount: number
  readonly missingSegmentIndices: readonly number[]
  readonly taiwanEastSegmentPresent: boolean
  readonly missingIslandNames: readonly string[]
}

/**
 * 扫描政治边界契约，对照 SPEC §6 红线点名目录，返回缺项（不抛错）。
 *
 * 调用方（资产深度校验 / 运行时消费准备）据返回的缺项各自抛稳定错误码，故本函数只负责
 * 「如实算出缺什么」。扫描逻辑单一来源于此：消费者不再各自遍历 features、各自对照目录常量
 * （详见模块头注释）。
 *
 * @param contract 政治边界补充契约（已通过 political-boundary 契约校验的共享事实源）。
 * @returns 红线点名缺项（段数 / 缺段序号 / 台湾东侧段是否在 / 缺点名岛礁名）。
 */
export function collectPoliticalRedLineGaps(
  contract: PoliticalBoundaryContract,
): PoliticalRedLineGaps {
  const segmentIndices = new Set<number>()
  const islandNames = new Set<string>()
  for (const feature of contract.features) {
    if (feature.type === 'nineDashLineSegment') {
      segmentIndices.add(feature.segmentIndex)
    } else if (feature.type === 'islandOrReefPoint') {
      islandNames.add(feature.name)
    }
    // disputedBoundaryCorrection 不参与红线点名扫描（争议区完整性由资产深度校验把关）。
  }

  const missingSegmentIndices = REQUIRED_NINE_DASH_SEGMENT_INDICES.filter(
    (index) => !segmentIndices.has(index),
  )
  const missingIslandNames = REQUIRED_ISLAND_NAMES.filter((name) => !islandNames.has(name))

  return {
    segmentCount: segmentIndices.size,
    missingSegmentIndices,
    taiwanEastSegmentPresent: segmentIndices.has(TAIWAN_EAST_SEGMENT_INDEX),
    missingIslandNames,
  }
}
