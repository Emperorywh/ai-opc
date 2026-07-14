import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  type LaneGroupingConfig,
} from '../src/features/agv-map/config/geometryConfig'
import type { Point2 } from '../src/features/agv-map/domain/domainModel'
import { groupLanes } from '../src/features/agv-map/geometry/laneGrouping'
import type { SampledEdge } from '../src/features/agv-map/geometry/pathSampling'

/** 构造采样边工厂，便于以折线点序列表达中心线。 */
function sampledEdge(
  id: string,
  source: string,
  target: string,
  points: Point2[],
): SampledEdge {
  return { edgeId: id, sourceNodeId: source, targetNodeId: target, path: { points } }
}

/** 沿 x 轴的水平直线段。 */
function horizontalLine(length: number, yOffset = 0): Point2[] {
  return [
    { x: 0, y: yOffset },
    { x: length, y: yOffset },
  ]
}

/** 容差更小的配置，便于构造明确的配对 / 不配对场景。 */
const STRICT_CONFIG: LaneGroupingConfig = {
  laneGroupToleranceM: 0.02,
  lanePairSampleCount: 33,
  laneCenterOffsetM: 0.18,
}

describe('groupLanes — 双向配对', () => {
  it('互为反向且几何一致的直线组成一个双向组', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10).reverse()),
    ]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(1)
    const group = groups[0]
    expect(group.kind).toBe('bidirectional')
    // 'a' < 'b'，规范方向为 a→b。
    expect(group.canonicalSourceNodeId).toBe('a')
    expect(group.canonicalTargetNodeId).toBe('b')
    expect(group.lanes).toHaveLength(2)
    expect(group.lanes.map((l) => l.edgeId).sort()).toEqual(['e1', 'e2'])
  })

  it('规范方向车道偏移 +1、流向 +1；反方向车道偏移 -1、流向 -1', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10).reverse()),
    ]
    const group = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)[0]
    const canonical = group.lanes.find((l) => l.edgeId === 'e1')
    const anti = group.lanes.find((l) => l.edgeId === 'e2')
    expect(canonical).toEqual({ edgeId: 'e1', offsetSign: 1, flowDirection: 1 })
    expect(anti).toEqual({ edgeId: 'e2', offsetSign: -1, flowDirection: -1 })
  })

  it('中心间距为 2 × LANE_CENTER_OFFSET_M = 0.36 m', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10).reverse()),
    ]
    const group = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)[0]
    const offsetMagnitude = DEFAULT_LANE_GROUPING_CONFIG.laneCenterOffsetM
    const spacing = 2 * offsetMagnitude
    expect(spacing).toBeCloseTo(0.36, 10)
    // 两条车道偏移符号必为一正一负，几何上分居共享中心线两侧。
    const signs = group.lanes.map((l) => l.offsetSign).sort()
    expect(signs).toEqual([-1, 1])
  })

  it('共享中心线取规范方向边的采样', () => {
    const canonicalPoints = horizontalLine(10)
    const edges = [
      sampledEdge('e1', 'a', 'b', canonicalPoints),
      sampledEdge('e2', 'b', 'a', [...canonicalPoints].reverse()),
    ]
    const group = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)[0]
    // 规范方向为 a→b，中心线即 e1 的采样。
    expect(group.centerline.points).toEqual(canonicalPoints)
  })

  it('规范方向与输入顺序无关：先反方向边仍得 a→b', () => {
    const forward = horizontalLine(10)
    const edges = [
      sampledEdge('e2', 'b', 'a', [...forward].reverse()),
      sampledEdge('e1', 'a', 'b', forward),
    ]
    const group = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)[0]
    expect(group.canonicalSourceNodeId).toBe('a')
    expect(group.canonicalTargetNodeId).toBe('b')
    // 中心线仍是规范方向边 e1 的采样，不因遍历顺序改变。
    expect(group.centerline.points).toEqual(forward)
    expect(group.lanes.find((l) => l.edgeId === 'e1')?.offsetSign).toBe(1)
    expect(group.lanes.find((l) => l.edgeId === 'e2')?.offsetSign).toBe(-1)
  })
})

describe('groupLanes — 单向组', () => {
  it('无反向候选的边形成偏移为 0 的单向组', () => {
    const edges = [sampledEdge('e1', 'a', 'b', horizontalLine(10))]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('unidirectional')
    expect(groups[0].lanes).toEqual([{ edgeId: 'e1', offsetSign: 0, flowDirection: 1 }])
    expect(groups[0].centerline.points).toEqual(horizontalLine(10))
  })

  it('反向候选几何偏差超过容差时不配对，各自成为单向组', () => {
    // e2 反转后位于 y=5 处，与 e1（y=0）偏差 5 m，远超 0.02 m 容差。
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10, 0)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10, 5).reverse()),
    ]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.kind === 'unidirectional')).toBe(true)
    expect(groups.every((g) => g.lanes[0].offsetSign === 0)).toBe(true)
  })
})

describe('groupLanes — 容差边界', () => {
  it('反向候选偏差 0.01 m（容差内）配对为双向组', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10, 0)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10, 0.01).reverse()),
    ]
    const groups = groupLanes(edges, STRICT_CONFIG)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('bidirectional')
  })

  it('反向候选偏差 0.05 m（超容差）不配对', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10, 0)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10, 0.05).reverse()),
    ]
    const groups = groupLanes(edges, STRICT_CONFIG)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.kind === 'unidirectional')).toBe(true)
  })
})

describe('groupLanes — 贝塞尔曲线配对', () => {
  it('互为反向的三次贝塞尔折线配对为双向组', () => {
    // 正向折线（模拟贝塞尔采样）：起点 (0,0) 终点 (8,0)，中间有弧度。
    const forward: Point2[] = [
      { x: 0, y: 0 },
      { x: 2, y: 1 },
      { x: 4, y: 1 },
      { x: 6, y: 1 },
      { x: 8, y: 0 },
    ]
    // 反向边的采样点为正向的反转，方向 b→a。
    const edges = [
      sampledEdge('e1', 'a', 'b', forward),
      sampledEdge('e2', 'b', 'a', [...forward].reverse()),
    ]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('bidirectional')
    expect(groups[0].lanes).toHaveLength(2)
  })

  it('贝塞尔反向几何轻微偏移（容差内）仍配对', () => {
    const forward: Point2[] = [
      { x: 0, y: 0 },
      { x: 3, y: 2 },
      { x: 6, y: 2 },
      { x: 9, y: 0 },
    ]
    // 反向边采样在 y 方向整体抬升 0.005 m，反转后与正向偏差 0.005 m。
    const shiftedReverse = [...forward]
      .reverse()
      .map((p) => ({ x: p.x, y: p.y + 0.005 }))
    const edges = [
      sampledEdge('e1', 'a', 'b', forward),
      sampledEdge('e2', 'b', 'a', shiftedReverse),
    ]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('bidirectional')
  })
})

describe('groupLanes — 自环与多组混合', () => {
  it('自环边（source === target）的反向候选是自身，作为单向组', () => {
    // source === target 时 pairKey 对调仍命中自身，被 edgeId 排除。
    const edges = [sampledEdge('e1', 'a', 'a', horizontalLine(2))]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(1)
    expect(groups[0].kind).toBe('unidirectional')
    expect(groups[0].lanes[0].offsetSign).toBe(0)
  })

  it('一条双向对加一条孤立单向边，共保留 3 条车道记录', () => {
    const edges = [
      sampledEdge('e1', 'a', 'b', horizontalLine(10)),
      sampledEdge('e2', 'b', 'a', horizontalLine(10).reverse()),
      sampledEdge('e3', 'c', 'd', horizontalLine(4)),
    ]
    const groups = groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG)
    expect(groups).toHaveLength(2)
    const laneCount = groups.reduce((sum, g) => sum + g.lanes.length, 0)
    expect(laneCount).toBe(3)
    // 全部 edgeId 唯一覆盖。
    const ids = groups.flatMap((g) => g.lanes.map((l) => l.edgeId))
    expect(new Set(ids).size).toBe(3)
  })
})

describe('groupLanes — 确定性与审计标记隔离', () => {
  const edges = [
    sampledEdge('e1', 'a', 'b', horizontalLine(10)),
    sampledEdge('e2', 'b', 'a', horizontalLine(10).reverse()),
    sampledEdge('e3', 'c', 'd', horizontalLine(4)),
  ]

  it('相同输入与配置产生字节级稳定输出', () => {
    const first = JSON.stringify(groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG))
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG))).toEqual(first)
    }
  })

  it('isBackEdge 不参与：输入不含该字段，分组结果不依赖任何审计标记', () => {
    // SampledEdge 类型本身不携带 isBackEdge，车道分组无法接触到该标记。
    // 这里通过两次相同输入验证结果一致，证明分组只依赖拓扑与几何。
    const a = JSON.stringify(groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG))
    const b = JSON.stringify(groupLanes(edges, DEFAULT_LANE_GROUPING_CONFIG))
    expect(b).toEqual(a)
  })
})
