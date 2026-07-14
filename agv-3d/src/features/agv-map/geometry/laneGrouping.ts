import type { Point2 } from '../domain/domainModel'
import type { LaneGroupingConfig } from '../config/geometryConfig'
import type { SampledEdge, SampledPath } from './pathSampling'

/**
 * 车道分组（SPEC §7.4）。
 *
 * 不变量：
 * - 纯函数：相同输入与相同配置产生字节级稳定的分组结果，不读取系统时间、
 *   随机源、相机或任何展示状态（SPEC §7.1）。
 * - 原始审计标记无效：输入 SampledEdge 不携带 isBackEdge，分组只依据反向拓扑
 *   关系和几何等价性，因此 isBackEdge 的任意取值变化不影响分组、规范方向与偏移
 *   结果（SPEC §4.2、§4.4、§7.4，TASK-003 验收）。
 * - 反向候选唯一：校验层保证每个有向节点对最多一条边（DUPLICATE_DIRECTED_PAIR），
 *   故 source/target 对调后命中的反向边唯一。
 * - 规范方向稳定：双向组方向恒为较小节点 ID 指向较大节点 ID，与遍历顺序无关。
 * - 偏移确定：规范方向车道偏移 +LANE_CENTER_OFFSET_M，反方向车道偏移
 *   -LANE_CENTER_OFFSET_M，单向组偏移 0；两条有向边 id 与各自流向完整保留在 lanes 中。
 */

/** 单条车道记录：保留有向边 id、侧向偏移符号与流向，供扁带编译消费。 */
export interface LaneRecord {
  readonly edgeId: string
  /**
   * 相对共享中心线的侧向偏移符号：规范方向 +1、反方向 -1、单向 0。
   * 实际偏移量 = offsetSign × LANE_CENTER_OFFSET_M（单向为 0）。
   */
  readonly offsetSign: number
  /**
   * 流动方向，相对规范中心线弧长：规范方向 +1、反方向 -1。
   * 单向组按自身源→目标方向构建弧长，恒为 +1（SPEC §7.6）。
   */
  readonly flowDirection: number
}

/** 一个车道组：共享中心线及其下属车道记录。 */
export interface LaneGroup {
  readonly kind: 'bidirectional' | 'unidirectional'
  /** 规范方向的源节点 id：双向组为较小 ID，单向组为自身源节点。 */
  readonly canonicalSourceNodeId: string
  /** 规范方向的目标节点 id：双向组为较大 ID，单向组为自身目标节点。 */
  readonly canonicalTargetNodeId: string
  /**
   * 共享中心线。双向组使用规范方向边的采样，消除反向几何的小量坐标差异
   * （SPEC §7.4）；单向组使用自身采样。扁带编译据此做侧向偏移与展开。
   */
  readonly centerline: SampledPath
  readonly lanes: readonly LaneRecord[]
}

/**
 * 将采样后的有向边按反向拓扑与几何等价性分组成车道组。
 *
 * 算法步骤（SPEC §7.4）：
 * 1. 建立 `sourceNodeId>targetNodeId → SampledEdge` 索引，用于 O(1) 查找反向候选。
 * 2. 按输入顺序遍历每条未分组边，查找其反向拓扑候选（source/target 对调）。
 * 3. 候选存在、非自身且未分组时，将候选路径反转到相同起终方向，各自按弧长等参数
 *    采样 LANE_PAIR_SAMPLE_COUNT 个点，比较最大对应点偏差。
 * 4. 偏差不超过 LANE_GROUP_TOLERANCE_M 则组成双向组；否则该边作为单向组
 *    （候选边留待其自身迭代时处理）。
 * 5. 双向组规范方向由较小节点 ID 指向较大节点 ID，保证结果稳定。
 */
export function groupLanes(
  edges: readonly SampledEdge[],
  config: LaneGroupingConfig,
): LaneGroup[] {
  // 有向对索引。校验层保证同一 source>target 键唯一，重复写入在此不会发生。
  const byDirectedPair = new Map<string, SampledEdge>()
  for (const edge of edges) {
    byDirectedPair.set(directedPairKey(edge.sourceNodeId, edge.targetNodeId), edge)
  }

  const grouped = new Set<string>()
  const groups: LaneGroup[] = []

  for (const edge of edges) {
    if (grouped.has(edge.edgeId)) continue

    // 反向拓扑候选：source 与 target 对调。
    const reverse = byDirectedPair.get(directedPairKey(edge.targetNodeId, edge.sourceNodeId))
    if (reverse !== undefined && reverse.edgeId !== edge.edgeId && !grouped.has(reverse.edgeId)) {
      if (centerlinesGeometricallyEqual(edge.path, reverse.path, config)) {
        // 几何等价：组成双向组。规范方向与遍历顺序无关，仅由节点 ID 序决定。
        const [canonical, anti] = orderAsCanonical(edge, reverse)
        grouped.add(canonical.edgeId)
        grouped.add(anti.edgeId)
        groups.push(buildBidirectionalGroup(canonical, anti))
        continue
      }
    }

    // 无反向候选、候选已分组或几何不等价：作为偏移为 0 的单向组。
    grouped.add(edge.edgeId)
    groups.push(buildUnidirectionalGroup(edge))
  }

  return groups
}

function directedPairKey(sourceNodeId: string, targetNodeId: string): string {
  return `${sourceNodeId}>${targetNodeId}`
}

/**
 * 判定反向候选中心线在统一方向后是否几何等价。
 *
 * 坐标约定：a 与 b 互为反向拓扑候选（a.source = b.target, a.target = b.source），
 * 因此 b 的采样方向（b.source→b.target）与 a 相反；先反转 b 的点序列使其与 a 同向，
 * 再各自按弧长等参数采样后逐一比较对应点。
 *
 * 边界条件：
 * - 等参数采样点数固定为 LANE_PAIR_SAMPLE_COUNT，与渲染自适应采样相互独立（SPEC §7.4）。
 * - 各自按自身总长归一化到 [0,1]，衡量曲线形状一致性；979 对完全重合边偏差为 0，
 *   19 对小偏差边偏差 ≤ 0.02 m（SPEC §4.2）。
 */
function centerlinesGeometricallyEqual(
  a: SampledPath,
  b: SampledPath,
  config: LaneGroupingConfig,
): boolean {
  const bReversed = reverseSampledPath(b)
  const aPoints = resampleByArcLength(a, config.lanePairSampleCount)
  const bPoints = resampleByArcLength(bReversed, config.lanePairSampleCount)

  let maxDeviation = 0
  for (let i = 0; i < aPoints.length; i += 1) {
    const deviation = Math.hypot(aPoints[i].x - bPoints[i].x, aPoints[i].y - bPoints[i].y)
    if (deviation > maxDeviation) maxDeviation = deviation
  }
  return maxDeviation <= config.laneGroupToleranceM
}

/**
 * 把互为反向的两条边按规范方向排列：较小节点 ID → 较大节点 ID 在前。
 * 节点 ID 为定长 32 位十六进制串，字典序与数值序一致，直接用字符串比较即可。
 */
function orderAsCanonical(a: SampledEdge, b: SampledEdge): [SampledEdge, SampledEdge] {
  // a 与 b 互为反向：a.source = b.target、a.target = b.source。
  // a 为规范方向当且仅当 a.source ≤ a.target（较小 ID 在前）；
  // 双向分支中 source 与 target 必不同（自环边的反向候选是自身，已被 edgeId 排除）。
  if (a.sourceNodeId <= a.targetNodeId) {
    return [a, b]
  }
  return [b, a]
}

function buildBidirectionalGroup(canonical: SampledEdge, anti: SampledEdge): LaneGroup {
  return {
    kind: 'bidirectional',
    canonicalSourceNodeId: canonical.sourceNodeId,
    canonicalTargetNodeId: canonical.targetNodeId,
    // 共享中心线只取规范方向边的采样，消除反向几何的小量坐标差异（SPEC §7.4）。
    centerline: canonical.path,
    lanes: [
      { edgeId: canonical.edgeId, offsetSign: 1, flowDirection: 1 },
      { edgeId: anti.edgeId, offsetSign: -1, flowDirection: -1 },
    ],
  }
}

function buildUnidirectionalGroup(edge: SampledEdge): LaneGroup {
  return {
    kind: 'unidirectional',
    canonicalSourceNodeId: edge.sourceNodeId,
    canonicalTargetNodeId: edge.targetNodeId,
    centerline: edge.path,
    lanes: [{ edgeId: edge.edgeId, offsetSign: 0, flowDirection: 1 }],
  }
}

function reverseSampledPath(path: SampledPath): SampledPath {
  return { points: [...path.points].reverse() }
}

/**
 * 按弧长等参数化把折线重采样到 count 个点（SPEC §7.4 等参数点比较）。
 *
 * 不变量：
 * - 首点恒为 pts[0]、末点恒为 pts[n-1]（t=0 与 t=1 精确落在端点）。
 * - 上游保证 pts.length >= 2 且相邻点不重合，故 total > 0，分母安全。
 * - 利用 target 的单调不减性复用 seg 游标，整体为线性时间。
 */
function resampleByArcLength(path: SampledPath, count: number): Point2[] {
  const pts = path.points
  const n = pts.length

  // 累计弧长：cumLen[i] 为 pts[0] 到 pts[i] 的折线长度。
  const cumLen = new Array<number>(n)
  cumLen[0] = 0
  for (let i = 1; i < n; i += 1) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  }
  const total = cumLen[n - 1]

  const result: Point2[] = []
  let seg = 0
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1)
    const target = t * total
    // 推进 seg 直到 target 落入 [cumLen[seg], cumLen[seg+1]]；末点 t=1 时 seg 停在 n-2。
    while (seg < n - 2 && cumLen[seg + 1] < target) {
      seg += 1
    }
    const segStart = cumLen[seg]
    const segLen = cumLen[seg + 1] - segStart
    const localT = segLen === 0 ? 0 : (target - segStart) / segLen
    const from = pts[seg]
    const to = pts[seg + 1]
    result.push({
      x: from.x + (to.x - from.x) * localT,
      y: from.y + (to.y - from.y) * localT,
    })
  }
  return result
}
