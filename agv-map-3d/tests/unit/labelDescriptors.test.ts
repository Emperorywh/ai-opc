/*
 * 标签描述符自动化验证（TASK-011，SPEC 2.2 / 2.5 / 2.6 / 5.2 / 7.1 / 9.3 / 11.2 / 15.2 / 16）。
 *
 * 设计：
 *   - 合成 SceneNode / SceneEdge 用于精确锚点 / 偏移 / 分类 / 来源点断言：
 *     节点 Billboard 锚点 (x, 0.250, z) + 局部偏移 (radius×1.5, -radius×1.5)；
 *     LINE 来源点 1/3、BEZIER 来源点参数 t=2/3、车道偏移沿左法线、平面偏移 (0.20, 0.20)。
 *   - 错误实现识别：把局部偏移写成世界坐标、BEZIER 用弧长 2/3 替代参数 2/3、
 *     只偏移 ribbon 不偏移标签、按类型拆分逻辑、数组下标 ID、跳过坏实体等都会让对应断言失败。
 *   - 异常路径：非有限来源点 / 坐标、未知节点类型（无效半径）、缺失车道偏移（无法对应所有者）
 *     → MAP_GEOMETRY_INVALID / MAP_ENTITY_INVALID，均整体拒绝，不输出部分描述符。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildLabelDescriptors，
 *     断言 4810 候选（1767 节点 + 3043 边）、464 operational-node / 1303 node / 3043 edge、
 *     ID 稳定且唯一；按完整 ID 查询中文充电节点 / 固定直线边 / 固定贝塞尔边 / 两类精确反向边，
 *     交叉验证文本、类别、来源点、车道偏移与固定平面偏移。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React / Troika。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNodeLabelDescriptor } from '../../src/labels/nodeLabel'
import { buildEdgeLabelDescriptor } from '../../src/labels/edgeLabel'
import {
  buildLabelDescriptors,
} from '../../src/labels/buildLabelDescriptors'
import { LABEL_ANCHOR_Y } from '../../src/labels/labelDescriptor'
import type {
  LabelDescriptor,
  LabelDescriptorCollection,
} from '../../src/labels/labelDescriptor'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  SceneBezierEdge,
  SceneLineEdge,
  SceneNode,
} from '../../src/domain/sceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { buildTrackModel } from '../../src/geometry/buildTrackModel'
import type { SceneEdge, SceneMap } from '../../src/domain/sceneMap'
import {
  FIXED_ENTITIES,
  PAIRED_LANE_OFFSET,
  SAMPLE_EDGE_COUNTS,
  SAMPLE_NODE_COUNTS,
} from '../fixture/sampleBaseline'

/*
 * SPEC 7.1 / 11.2：标签固定常量（与实现同源 SPEC）。
 */
const NODE_RADIUS_NODE = 0.1
const NODE_RADIUS_OPERATIONAL = 0.15
const NODE_LABEL_LOCAL_OFFSET_RATIO = 1.5
const EDGE_LABEL_PLANE_OFFSET = 0.2

/*
 * 合成 SceneNode 构造工具：默认普通节点 (0,0)。
 */
function sceneNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: 'n-1',
    name: '1',
    type: 'node',
    position: { x: 0, z: 0 },
    angle: null,
    ...overrides,
  }
}

/*
 * 合成 SceneLineEdge 构造工具：默认 (0,0)→(1,0) 的正向直线边。
 */
function lineEdge(overrides: Partial<SceneLineEdge> = {}): SceneLineEdge {
  return {
    kind: 'line',
    id: 'e-line',
    name: '1',
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: 0, z: 0 },
    end: { x: 1, z: 0 },
    isBackEdge: false,
    ...overrides,
  }
}

/*
 * 合成 SceneBezierEdge 构造工具。
 */
function bezierEdge(overrides: Partial<SceneBezierEdge> = {}): SceneBezierEdge {
  return {
    kind: 'cubic',
    id: 'e-bez',
    name: '2',
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: 0, z: 0 },
    control1: { x: 0, z: 1 },
    control2: { x: 1, z: 1 },
    end: { x: 1, z: 0 },
    isBackEdge: false,
    ...overrides,
  }
}

/*
 * 捕获预期抛出的异常；未抛出时失败，便于在断言里复用。
 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出异常，但未抛出')
}

/*
 * 三次贝塞尔单点求值（与 edgeLabel 同口径，测试交叉验证用）。
 */
function cubicBezierAt(
  p0: { x: number; z: number },
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  }
}

/*
 * 三次贝塞尔一阶导数（与 edgeLabel 同口径，测试交叉验证用）。
 */
function cubicBezierDerivative(
  p0: { x: number; z: number },
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  const mt = 1 - t
  const a = 3 * mt * mt
  const b = 6 * mt * t
  const c = 3 * t * t
  return {
    x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
    z: a * (p1.z - p0.z) + b * (p2.z - p1.z) + c * (p3.z - p2.z),
  }
}

// ─── 节点标签 · 分类（SPEC 11.2 / 任务约束）──────────────────────────────────────

describe('节点标签分类 · type → kind（SPEC 11.2）', () => {
  test('普通节点 type=node → kind=node', () => {
    const d = buildNodeLabelDescriptor(sceneNode({ id: 'n', type: 'node' }))
    expect(d.kind).toBe('node')
  })

  test('work / park / charge → kind=operational-node', () => {
    for (const type of ['work', 'park', 'charge'] as const) {
      const d = buildNodeLabelDescriptor(
        sceneNode({ id: `n-${type}`, type }),
      )
      expect(d.kind).toBe('operational-node')
    }
  })

  test('每个节点恰一个标签；kind 不读取不存在字段', () => {
    // angle = null 的普通节点仍产生 node 标签（不读取 showArrow 等字段）。
    const d = buildNodeLabelDescriptor(
      sceneNode({ id: 'plain', type: 'node', angle: null }),
    )
    expect(d.kind).toBe('node')
    expect(d.ownerId).toBe('plain')
  })
})

// ─── 节点标签 · 锚点与局部偏移（SPEC 11.2 / 7.1）────────────────────────────────

describe('节点标签锚点 · Billboard (x, 0.250, z) + 局部偏移 radius×1.5（SPEC 11.2）', () => {
  test('普通节点：锚点 = 节点中心，局部偏移 = (0.15, -0.15)', () => {
    // radius = 0.10 → localOffset = (0.15, -0.15)（屏幕右下方）。
    const d = buildNodeLabelDescriptor(
      sceneNode({ id: 'n', type: 'node', position: { x: 5, z: -3 } }),
    )
    expect(d.anchorX).toBe(5)
    expect(d.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
    expect(d.anchorZ).toBe(-3)
    expect(d.localOffsetX).toBeCloseTo(NODE_RADIUS_NODE * NODE_LABEL_LOCAL_OFFSET_RATIO, 6)
    expect(d.localOffsetY).toBeCloseTo(-NODE_RADIUS_NODE * NODE_LABEL_LOCAL_OFFSET_RATIO, 6)
  })

  test('作业节点：局部偏移 = (0.225, -0.225)（radius=0.15）', () => {
    const d = buildNodeLabelDescriptor(
      sceneNode({ id: 'w', type: 'work', position: { x: 1, z: 2 }, angle: 0.3 }),
    )
    expect(d.localOffsetX).toBeCloseTo(NODE_RADIUS_OPERATIONAL * NODE_LABEL_LOCAL_OFFSET_RATIO, 6)
    expect(d.localOffsetY).toBeCloseTo(-NODE_RADIUS_OPERATIONAL * NODE_LABEL_LOCAL_OFFSET_RATIO, 6)
    expect(d.anchorX).toBe(1)
    expect(d.anchorZ).toBe(2)
  })

  test('局部偏移是屏幕语义，不预先写成世界坐标（锚点不含偏移分量）', () => {
    // 错误实现把 localOffset 加进 anchorX/Z 会让 anchorX = 5 + 0.15。
    const d = buildNodeLabelDescriptor(
      sceneNode({ id: 'n', type: 'node', position: { x: 5, z: 5 } }),
    )
    expect(d.anchorX).toBe(5) // 不含 localOffset
    expect(d.anchorZ).toBe(5)
    expect(d.localOffsetX).toBeCloseTo(0.15, 6)
  })

  test('坐标只从 SceneNode.position 直接读取（不做第二次转换）', () => {
    // 场景坐标已在适配层转换；标签不应再次取负 / 交换轴 / 平移。
    const d = buildNodeLabelDescriptor(
      sceneNode({ id: 'n', type: 'node', position: { x: 81.98, z: 33.83 } }),
    )
    expect(d.anchorX).toBeCloseTo(81.98, 6)
    expect(d.anchorZ).toBeCloseTo(33.83, 6)
  })
})

// ─── 节点标签 · 文本与稳定 ID（SPEC 11.2 / 任务约束）──────────────────────────────

describe('节点标签文本与稳定 ID · 原始 Unicode + 实体身份（SPEC 11.2）', () => {
  test('文本保持原始 Unicode，不截断 / 转码 / 格式化', () => {
    const chinese = buildNodeLabelDescriptor(
      sceneNode({ id: 'cn', type: 'charge', name: '门口充电桩1', angle: 0.5 }),
    )
    expect(chinese.text).toBe('门口充电桩1')
    const numeric = buildNodeLabelDescriptor(
      sceneNode({ id: 'num', type: 'node', name: '123456' }),
    )
    expect(numeric.text).toBe('123456')
  })

  test('ID 基于 entityId 构造，不用数组下标', () => {
    const d = buildNodeLabelDescriptor(sceneNode({ id: 'abc123', type: 'node' }))
    expect(d.id).toBe('node-label:abc123')
    expect(d.ownerId).toBe('abc123')
  })

  test('同一节点重复构建 → 描述符完全一致', () => {
    const node = sceneNode({ id: 'stable', type: 'work', name: 'X', angle: 1.2 })
    const a = buildNodeLabelDescriptor(node)
    const b = buildNodeLabelDescriptor(node)
    expect(a).toEqual(b)
  })
})

// ─── 节点标签异常 · 整体拒绝（SPEC 16 / 任务异常路径）──────────────────────────────

describe('节点标签异常 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('非有限坐标 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeLabelDescriptor(
        sceneNode({ id: 'nan', type: 'node', position: { x: Number.NaN, z: 0 } }),
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('nan')
    }
  })

  test('Infinity 坐标 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeLabelDescriptor(
        sceneNode({ id: 'inf', type: 'node', position: { x: 0, z: Number.POSITIVE_INFINITY } }),
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('未知节点类型（无效半径）→ MAP_ENTITY_INVALID，不给默认样式', () => {
    const bad = { ...sceneNode({ id: 'bad', type: 'node' }), type: 'warehouse' as never }
    const err = captureError(() => buildNodeLabelDescriptor(bad)) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
      expect(err.entityId).toBe('bad')
    }
  })
})

// ─── 边标签 · LINE 来源点 1/3（SPEC 11.2）────────────────────────────────────────

describe('边标签 LINE · 来源点 1/3 处 + 平面偏移（SPEC 11.2）', () => {
  test('单边 laneOffset=0：锚点 = 1/3 处 + (0.20, 0.20)', () => {
    // (0,0)→(3,0)：1/3 处 = (1, 0)。laneOffset=0，无车道偏移。
    const d = buildEdgeLabelDescriptor(
      lineEdge({ id: 'L', start: { x: 0, z: 0 }, end: { x: 3, z: 0 } }),
      0,
    )
    expect(d.anchorX).toBeCloseTo(1 + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorZ).toBeCloseTo(0 + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
  })

  test('局部屏幕偏移为 (0, 0)（平面偏移已烘焙进世界锚点）', () => {
    const d = buildEdgeLabelDescriptor(lineEdge({ id: 'L' }), 0)
    expect(d.localOffsetX).toBe(0)
    expect(d.localOffsetY).toBe(0)
  })

  test('非轴对齐直线边：1/3 处坐标正确', () => {
    // (0,0)→(6,3)：1/3 处 = (2, 1)。
    const d = buildEdgeLabelDescriptor(
      lineEdge({ id: 'L', start: { x: 0, z: 0 }, end: { x: 6, z: 3 } }),
      0,
    )
    expect(d.anchorX).toBeCloseTo(2 + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorZ).toBeCloseTo(1 + EDGE_LABEL_PLANE_OFFSET, 6)
  })
})

// ─── 边标签 · BEZIER 来源点 t=2/3（SPEC 11.2）──────────────────────────────────────

describe('边标签 BEZIER · 来源点参数 t=2/3（SPEC 11.2）', () => {
  test('来源点 = 三次贝塞尔参数 t=2/3 处（非弧长 2/3）', () => {
    // S(0,0) C1(0,3) C2(3,3) E(3,0)：t=2/3 处经多项式求值。
    const edge = bezierEdge({
      id: 'B',
      start: { x: 0, z: 0 },
      control1: { x: 0, z: 3 },
      control2: { x: 3, z: 3 },
      end: { x: 3, z: 0 },
    })
    const d = buildEdgeLabelDescriptor(edge, 0)
    const expectedSource = cubicBezierAt(
      edge.start,
      edge.control1,
      edge.control2,
      edge.end,
      2 / 3,
    )
    expect(d.anchorX).toBeCloseTo(expectedSource.x + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorZ).toBeCloseTo(expectedSource.z + EDGE_LABEL_PLANE_OFFSET, 6)
  })

  test('非均匀曲线：参数 t=2/3 不等于弧长 2/3 处', () => {
    // S(0,0) C1(0,1) C2(0,1) E(10,0)：前段慢、后段快，参数与弧长明显不重合。
    // 错误实现用弧长 2/3 会让锚点偏离参数 2/3 点。
    const edge = bezierEdge({
      id: 'B',
      start: { x: 0, z: 0 },
      control1: { x: 0, z: 1 },
      control2: { x: 0, z: 1 },
      end: { x: 10, z: 0 },
    })
    const d = buildEdgeLabelDescriptor(edge, 0)
    const t23 = cubicBezierAt(
      edge.start,
      edge.control1,
      edge.control2,
      edge.end,
      2 / 3,
    )
    expect(d.anchorX).toBeCloseTo(t23.x + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorZ).toBeCloseTo(t23.z + EDGE_LABEL_PLANE_OFFSET, 6)
  })
})

// ─── 边标签 · 车道偏移复用（SPEC 9.3 / 11.2）──────────────────────────────────────

describe('边标签车道偏移 · 复用 laneOffset，沿左法线（SPEC 9.3 / 11.2）', () => {
  test('LINE laneOffset=0.03：来源点沿左法线偏移到 +Z 侧', () => {
    // (0,0)→(4,0)：切线 (1,0)，左法线 (-0,1)=(0,1)，1/3 处 (4/3,0) 偏移到 (4/3, 0.03)。
    const d = buildEdgeLabelDescriptor(
      lineEdge({ id: 'A', start: { x: 0, z: 0 }, end: { x: 4, z: 0 } }),
      PAIRED_LANE_OFFSET,
    )
    expect(d.anchorX).toBeCloseTo(4 / 3 + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(d.anchorZ).toBeCloseTo(PAIRED_LANE_OFFSET + EDGE_LABEL_PLANE_OFFSET, 6)
  })

  test('反向 LINE laneOffset=0.03：左法线相反，偏移到 -Z 侧（两条标签相距 0.06m）', () => {
    // 正向 A：(0,0)→(4,0)，偏移到 z=+0.03。
    const dA = buildEdgeLabelDescriptor(
      lineEdge({ id: 'A', start: { x: 0, z: 0 }, end: { x: 4, z: 0 } }),
      PAIRED_LANE_OFFSET,
    )
    // 反向 B：(4,0)→(0,0)，切线 (-1,0)，左法线 (0,-1)，1/3 处 (8/3,0) 偏移到 (8/3, -0.03)。
    const dB = buildEdgeLabelDescriptor(
      lineEdge({ id: 'B', start: { x: 4, z: 0 }, end: { x: 0, z: 0 } }),
      PAIRED_LANE_OFFSET,
    )
    expect(dA.anchorZ).toBeCloseTo(PAIRED_LANE_OFFSET + EDGE_LABEL_PLANE_OFFSET, 6)
    expect(dB.anchorZ).toBeCloseTo(-PAIRED_LANE_OFFSET + EDGE_LABEL_PLANE_OFFSET, 6)
    // 两个锚点 Z 相距 0.06m（两条车道间距），证明标签与 ribbon 共享车道偏移。
    expect(Math.abs(dA.anchorZ - dB.anchorZ)).toBeCloseTo(2 * PAIRED_LANE_OFFSET, 6)
  })

  test('BEZIER laneOffset=0.03：沿 t=2/3 处左法线偏移', () => {
    const edge = bezierEdge({
      id: 'B',
      start: { x: 0, z: 0 },
      control1: { x: 0, z: 3 },
      control2: { x: 3, z: 3 },
      end: { x: 3, z: 0 },
    })
    const d = buildEdgeLabelDescriptor(edge, PAIRED_LANE_OFFSET)
    // 独立计算：source + laneOffset × 左法线 + 平面偏移。
    const source = cubicBezierAt(edge.start, edge.control1, edge.control2, edge.end, 2 / 3)
    const deriv = cubicBezierDerivative(edge.start, edge.control1, edge.control2, edge.end, 2 / 3)
    const dLen = Math.hypot(deriv.x, deriv.z)
    const tx = deriv.x / dLen
    const tz = deriv.z / dLen
    const leftX = -tz
    const leftZ = tx
    const expectX = source.x + PAIRED_LANE_OFFSET * leftX + EDGE_LABEL_PLANE_OFFSET
    const expectZ = source.z + PAIRED_LANE_OFFSET * leftZ + EDGE_LABEL_PLANE_OFFSET
    expect(d.anchorX).toBeCloseTo(expectX, 6)
    expect(d.anchorZ).toBeCloseTo(expectZ, 6)
  })

  test('laneOffset 不影响来源点本身（只偏移锚点位置）', () => {
    // laneOffset=0 与 laneOffset=0.03 的差应恰为 0.03 × 左法线。
    const edge = lineEdge({ id: 'L', start: { x: 0, z: 0 }, end: { x: 9, z: 0 } })
    const d0 = buildEdgeLabelDescriptor(edge, 0)
    const dP = buildEdgeLabelDescriptor(edge, PAIRED_LANE_OFFSET)
    expect(dP.anchorX - d0.anchorX).toBeCloseTo(0, 6) // 左法线 X=0
    expect(dP.anchorZ - d0.anchorZ).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
  })
})

// ─── 边标签 · 文本与稳定 ID（SPEC 11.2 / 任务约束）────────────────────────────────

describe('边标签文本与稳定 ID · 原始 Unicode + 实体身份（SPEC 11.2）', () => {
  test('kind 恒为 edge；文本保持原始内容', () => {
    const d = buildEdgeLabelDescriptor(lineEdge({ id: 'e1', name: '42' }), 0)
    expect(d.kind).toBe('edge')
    expect(d.text).toBe('42')
    expect(d.ownerId).toBe('e1')
    expect(d.id).toBe('edge-label:e1')
  })
})

// ─── 边标签异常 · 整体拒绝（SPEC 16 / 任务异常路径）──────────────────────────────

describe('边标签异常 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('非有限端点 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildEdgeLabelDescriptor(
        lineEdge({ id: 'nan', start: { x: Number.NaN, z: 0 }, end: { x: 1, z: 0 } }),
        0,
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('nan')
    }
  })

  test('非有限 laneOffset → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildEdgeLabelDescriptor(lineEdge({ id: 'loff' }), Number.NaN),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('loff')
    }
  })

  test('退化弦长（零切线）→ MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildEdgeLabelDescriptor(
        lineEdge({ id: 'zero', start: { x: 0, z: 0 }, end: { x: 0, z: 0 } }),
        0,
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })
})

// ─── 编排 · 计数、顺序与稳定性（SPEC 5.2 / 11.2）──────────────────────────────────

describe('标签编排 · 计数、顺序与稳定性（SPEC 5.2 / 11.2）', () => {
  test('总数 = nodes + edges；顺序为节点在前、边在后', () => {
    const nodes = [
      sceneNode({ id: 'n1', type: 'node' }),
      sceneNode({ id: 'n2', type: 'work', angle: 0.1 }),
    ]
    const edges = [
      lineEdge({ id: 'e1' }),
      lineEdge({ id: 'e2' }),
    ]
    const offsets = new Map([
      ['e1', 0],
      ['e2', PAIRED_LANE_OFFSET],
    ])
    const collection = buildLabelDescriptors(nodes, edges, offsets)
    expect(collection.labelCandidateCount).toBe(4)
    expect(collection.descriptors).toHaveLength(4)
    // 前 2 个为节点标签，后 2 个为边标签。
    expect(collection.descriptors[0].id).toBe('node-label:n1')
    expect(collection.descriptors[1].id).toBe('node-label:n2')
    expect(collection.descriptors[2].id).toBe('edge-label:e1')
    expect(collection.descriptors[3].id).toBe('edge-label:e2')
  })

  test('labelCandidateCount = descriptors.length（交叉一致）', () => {
    const collection = buildLabelDescriptors(
      [sceneNode({ id: 'n1' })],
      [lineEdge({ id: 'e1' })],
      new Map([['e1', 0]]),
    )
    expect(collection.labelCandidateCount).toBe(collection.descriptors.length)
  })

  test('重复构建 → 顺序、ID、数值完全稳定', () => {
    const nodes = [
      sceneNode({ id: 'n1', type: 'charge', name: 'A', angle: 0.5 }),
      sceneNode({ id: 'n2', type: 'node', name: 'B' }),
    ]
    const edges = [
      lineEdge({ id: 'e1', name: '10' }),
      bezierEdge({ id: 'e2', name: '11' }),
    ]
    const offsets = new Map([
      ['e1', 0],
      ['e2', PAIRED_LANE_OFFSET],
    ])
    const a = buildLabelDescriptors(nodes, edges, offsets)
    const b = buildLabelDescriptors(nodes, edges, offsets)
    expect(a.descriptors).toEqual(b.descriptors)
    expect(a.labelCandidateCount).toBe(b.labelCandidateCount)
  })

  test('ID 全部唯一（节点与边命名空间隔离）', () => {
    const nodes = [sceneNode({ id: 'shared', type: 'node' })]
    const edges = [lineEdge({ id: 'shared' })] // 与节点同 ID，验证命名空间隔离
    const collection = buildLabelDescriptors(
      nodes,
      edges,
      new Map([['shared', 0]]),
    )
    const ids = collection.descriptors.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('node-label:shared')
    expect(ids).toContain('edge-label:shared')
  })

  test('不携带任何 bounds（标签不参与内容 bounds / 地面尺寸，SPEC 11.2 / 12.1）', () => {
    const collection = buildLabelDescriptors(
      [sceneNode({ id: 'n1' })],
      [],
      new Map(),
    )
    expect(collection).not.toHaveProperty('bounds')
    expect(collection.descriptors.every((d) => d.anchorY === LABEL_ANCHOR_Y)).toBe(true)
  })
})

// ─── 编排异常 · 缺失车道偏移（SPEC 16 / 任务“无法对应所有者”异常）──────────────────

describe('标签编排异常 · 缺失车道偏移（SPEC 16）', () => {
  test('边在 edgeLaneOffsets 中缺失 → MAP_GEOMETRY_INVALID，不留下部分描述符', () => {
    const err = captureError(() =>
      buildLabelDescriptors(
        [sceneNode({ id: 'n1' })],
        [lineEdge({ id: 'missing' })],
        new Map(), // 空 map，未覆盖该边
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('missing')
    }
  })

  test('失败时不返回部分描述符（异常抛出后无返回值）', () => {
    expect(() =>
      buildLabelDescriptors(
        [sceneNode({ id: 'n1' })],
        [lineEdge({ id: 'good' }), lineEdge({ id: 'bad' })],
        new Map([['good', 0]]), // 缺 'bad'
      ),
    ).toThrow()
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.2 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let collection!: LabelDescriptorCollection
let edgeIdToDescriptor!: Map<string, LabelDescriptor>
let nodeIdToDescriptor!: Map<string, LabelDescriptor>
let edgeIdToLaneOffset!: Map<string, number>
let sceneMap!: SceneMap
let edgeIdToEdge!: Map<string, SceneEdge>

beforeAll(async () => {
  // SPEC 15.1：哈希不符才能继续回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  sceneMap = normalizeSceneMap(rawMap)
  const trackModel = buildTrackModel(sceneMap)
  // 从 TrackModel 提取每条边的车道偏移标量（复用 TASK-006 结果，不重新判断重合）。
  edgeIdToLaneOffset = new Map<string, number>()
  for (const lane of trackModel.tracks) {
    edgeIdToLaneOffset.set(lane.edgeId, lane.laneOffset)
  }
  collection = buildLabelDescriptors(
    sceneMap.nodes,
    sceneMap.edges,
    edgeIdToLaneOffset,
  )
  edgeIdToDescriptor = new Map<string, LabelDescriptor>()
  nodeIdToDescriptor = new Map<string, LabelDescriptor>()
  edgeIdToEdge = new Map<string, SceneEdge>()
  for (const d of collection.descriptors) {
    if (d.kind === 'edge') edgeIdToDescriptor.set(d.ownerId, d)
    else nodeIdToDescriptor.set(d.ownerId, d)
  }
  for (const e of sceneMap.edges) {
    edgeIdToEdge.set(e.id, e)
  }
})

/*
 * 从 SceneEdge 独立计算边标签世界锚点（测试交叉验证用，不复用 edgeLabel 内部函数）。
 * LINE 来源点 1/3、BEZIER 来源点参数 t=2/3；沿左法线应用 laneOffset；再加 (0.20, 0.20)。
 */
function expectedEdgeAnchor(edge: SceneEdge, laneOffset: number): { x: number; z: number } {
  let sx: number, sz: number, tx: number, tz: number
  if (edge.kind === 'line') {
    const dx = edge.end.x - edge.start.x
    const dz = edge.end.z - edge.start.z
    const len = Math.hypot(dx, dz)
    sx = edge.start.x + dx * (1 / 3)
    sz = edge.start.z + dz * (1 / 3)
    tx = dx / len
    tz = dz / len
  } else {
    const source = cubicBezierAt(edge.start, edge.control1, edge.control2, edge.end, 2 / 3)
    const deriv = cubicBezierDerivative(edge.start, edge.control1, edge.control2, edge.end, 2 / 3)
    const len = Math.hypot(deriv.x, deriv.z)
    sx = source.x
    sz = source.z
    tx = deriv.x / len
    tz = deriv.z / len
  }
  const leftX = -tz
  const leftZ = tx
  return {
    x: sx + laneOffset * leftX + EDGE_LABEL_PLANE_OFFSET,
    z: sz + laneOffset * leftZ + EDGE_LABEL_PLANE_OFFSET,
  }
}

describe('真实样本标签 · 规模与分类（SPEC 2.2 / 5.2 / 15.2）', () => {
  test('候选总数 4810 = 1767 节点 + 3043 边', () => {
    expect(collection.labelCandidateCount).toBe(
      SAMPLE_NODE_COUNTS.total + SAMPLE_EDGE_COUNTS.total,
    )
    expect(collection.labelCandidateCount).toBe(4810)
    expect(collection.descriptors).toHaveLength(4810)
  })

  test('分类计数：operational-node 464、node 1303、edge 3043', () => {
    const counts = { 'operational-node': 0, node: 0, edge: 0 }
    for (const d of collection.descriptors) {
      counts[d.kind]++
    }
    expect(counts['operational-node']).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount) // 464
    expect(counts.node).toBe(SAMPLE_NODE_COUNTS.node) // 1303
    expect(counts.edge).toBe(SAMPLE_EDGE_COUNTS.total) // 3043
  })

  test('ID 全部稳定且唯一', () => {
    const ids = collection.descriptors.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 所有 ID 均带类别前缀，基于实体身份（非数组下标）。
    expect(ids.every((id) => id.startsWith('node-label:') || id.startsWith('edge-label:'))).toBe(true)
  })

  test('所有锚点高度恒为 0.250；所有数值有限', () => {
    for (const d of collection.descriptors) {
      expect(d.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
      expect(Number.isFinite(d.anchorX)).toBe(true)
      expect(Number.isFinite(d.anchorZ)).toBe(true)
      expect(Number.isFinite(d.localOffsetX)).toBe(true)
      expect(Number.isFinite(d.localOffsetY)).toBe(true)
    }
  })

  test('顺序稳定：节点标签在前（nodes 顺序），边标签在后（edges 顺序）', () => {
    // 第 1767 个为最后一个节点标签，第 1768 个为第一个边标签。
    expect(collection.descriptors[SAMPLE_NODE_COUNTS.total - 1].kind).not.toBe('edge')
    expect(collection.descriptors[SAMPLE_NODE_COUNTS.total].kind).toBe('edge')
  })
})

describe('真实样本标签 · 固定回归实体（SPEC 2.6 / 11.2）', () => {
  test('中文充电节点 178744a4... 文本 / 类别 / 锚点 / 偏移符合 SPEC', () => {
    const id = FIXED_ENTITIES.chineseChargeNode.id
    const d = nodeIdToDescriptor.get(id)
    expect(d).toBeDefined()
    // 文本保持原始中文 Unicode，不截断 / 转码。
    expect(d!.text).toBe(FIXED_ENTITIES.chineseChargeNode.name)
    expect(d!.text).toBe('门口充电桩1')
    // 类别为 operational-node（charge）。
    expect(d!.kind).toBe('operational-node')
    // 锚点 = 节点场景坐标（地图 (-139.35, 13.6) → 场景 (-57.53, -1.06)）。
    expect(d!.anchorX).toBeCloseTo(-57.53, 2)
    expect(d!.anchorZ).toBeCloseTo(-1.06, 2)
    expect(d!.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
    // 局部偏移 = radius(0.15) × 1.5 = (0.225, -0.225)。
    expect(d!.localOffsetX).toBeCloseTo(0.225, 6)
    expect(d!.localOffsetY).toBeCloseTo(-0.225, 6)
  })

  test('普通节点 d0f03a8c... 类别为 node，无作业偏移', () => {
    const id = FIXED_ENTITIES.normalNode.id
    const d = nodeIdToDescriptor.get(id)
    expect(d).toBeDefined()
    expect(d!.kind).toBe('node')
    expect(d!.text).toBe('2')
    // 锚点 = 节点场景坐标（地图 (0.16, -21.29) → 场景 (81.98, 33.83)）。
    expect(d!.anchorX).toBeCloseTo(81.98, 2)
    expect(d!.anchorZ).toBeCloseTo(33.83, 2)
    // 局部偏移 = radius(0.10) × 1.5 = (0.15, -0.15)。
    expect(d!.localOffsetX).toBeCloseTo(0.15, 6)
    expect(d!.localOffsetY).toBeCloseTo(-0.15, 6)
  })

  test('固定直线边 d59c4b42... 来源点 = 1/3 处 + 车道偏移 + 平面偏移', () => {
    const id = FIXED_ENTITIES.lineEdge.id
    const d = edgeIdToDescriptor.get(id)
    expect(d).toBeDefined()
    expect(d!.kind).toBe('edge')
    expect(d!.text).toBe('326') // 原始数字名称保持不变
    const laneOffset = edgeIdToLaneOffset.get(id)!
    expect([0, PAIRED_LANE_OFFSET]).toContain(laneOffset)
    // 独立重算锚点：1/3 处 + laneOffset × 左法线 + (0.20, 0.20)。
    const expected = expectedEdgeAnchor(edgeIdToEdge.get(id)!, laneOffset)
    expect(d!.anchorX).toBeCloseTo(expected.x, 6)
    expect(d!.anchorZ).toBeCloseTo(expected.z, 6)
    expect(d!.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
    expect(d!.localOffsetX).toBe(0)
    expect(d!.localOffsetY).toBe(0)
  })

  test('固定贝塞尔边 7d85a192... 来源点 = 参数 t=2/3 处（非弧长 2/3）', () => {
    const id = FIXED_ENTITIES.bezierEdge.id
    const d = edgeIdToDescriptor.get(id)
    expect(d).toBeDefined()
    expect(d!.kind).toBe('edge')
    expect(d!.text).toBe('1025') // 原始数字名称保持不变
    const laneOffset = edgeIdToLaneOffset.get(id)!
    expect([0, PAIRED_LANE_OFFSET]).toContain(laneOffset)
    // 独立重算锚点：参数 t=2/3 处 + laneOffset × 左法线 + (0.20, 0.20)。
    const expected = expectedEdgeAnchor(edgeIdToEdge.get(id)!, laneOffset)
    expect(d!.anchorX).toBeCloseTo(expected.x, 6)
    expect(d!.anchorZ).toBeCloseTo(expected.z, 6)
    expect(d!.anchorY).toBeCloseTo(LABEL_ANCHOR_Y, 6)
  })
})

describe('真实样本标签 · 精确反向边对的车道偏移（SPEC 2.4 / 9.3 / 11.2）', () => {
  test('false/false 重合对：两条边标签都成对偏移，锚点与独立重算一致', () => {
    const [idA, idB] = FIXED_ENTITIES.falseFalsePair.ids
    const dA = edgeIdToDescriptor.get(idA)!
    const dB = edgeIdToDescriptor.get(idB)!
    expect(dA).toBeDefined()
    expect(dB).toBeDefined()
    // 两条边都成对（laneOffset = 0.03）。
    expect(edgeIdToLaneOffset.get(idA)).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    expect(edgeIdToLaneOffset.get(idB)).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    // 锚点与独立重算一致（车道偏移已沿左法线应用到标签）。
    const expA = expectedEdgeAnchor(edgeIdToEdge.get(idA)!, PAIRED_LANE_OFFSET)
    const expB = expectedEdgeAnchor(edgeIdToEdge.get(idB)!, PAIRED_LANE_OFFSET)
    expect(dA.anchorX).toBeCloseTo(expA.x, 6)
    expect(dA.anchorZ).toBeCloseTo(expA.z, 6)
    expect(dB.anchorX).toBeCloseTo(expB.x, 6)
    expect(dB.anchorZ).toBeCloseTo(expB.z, 6)
  })

  test('false/true 重合对：两条边标签都成对偏移，锚点与独立重算一致', () => {
    const [idA, idB] = FIXED_ENTITIES.falseTruePair.ids
    const dA = edgeIdToDescriptor.get(idA)!
    const dB = edgeIdToDescriptor.get(idB)!
    expect(edgeIdToLaneOffset.get(idA)).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    expect(edgeIdToLaneOffset.get(idB)).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    const expA = expectedEdgeAnchor(edgeIdToEdge.get(idA)!, PAIRED_LANE_OFFSET)
    const expB = expectedEdgeAnchor(edgeIdToEdge.get(idB)!, PAIRED_LANE_OFFSET)
    expect(dA.anchorX).toBeCloseTo(expA.x, 6)
    expect(dA.anchorZ).toBeCloseTo(expA.z, 6)
    expect(dB.anchorX).toBeCloseTo(expB.x, 6)
    expect(dB.anchorZ).toBeCloseTo(expB.z, 6)
  })

  test('最短反向边对（0.04m）：标签锚点与独立重算一致', () => {
    for (const entity of FIXED_ENTITIES.shortestChordPair) {
      const d = edgeIdToDescriptor.get(entity.id)!
      const laneOffset = edgeIdToLaneOffset.get(entity.id)!
      const expected = expectedEdgeAnchor(edgeIdToEdge.get(entity.id)!, laneOffset)
      expect(d.anchorX).toBeCloseTo(expected.x, 6)
      expect(d.anchorZ).toBeCloseTo(expected.z, 6)
    }
  })

  test('全部 3043 条边标签锚点与独立重算一致（来源点 + 车道偏移 + 平面偏移）', () => {
    // 强交叉验证：每条边的标签锚点都等于独立公式结果，证明标签复用同一车道偏移事实。
    for (const edge of sceneMap.edges) {
      const d = edgeIdToDescriptor.get(edge.id)!
      const laneOffset = edgeIdToLaneOffset.get(edge.id)!
      const expected = expectedEdgeAnchor(edge, laneOffset)
      expect(d.anchorX).toBeCloseTo(expected.x, 6)
      expect(d.anchorZ).toBeCloseTo(expected.z, 6)
    }
  })

  test('全部 1767 个节点标签锚点 = 节点场景坐标', () => {
    for (const node of sceneMap.nodes) {
      const d = nodeIdToDescriptor.get(node.id)!
      expect(d.anchorX).toBeCloseTo(node.position.x, 6)
      expect(d.anchorZ).toBeCloseTo(node.position.z, 6)
    }
  })
})

describe('真实样本标签 · 稳定性与 bounds 隔离（SPEC 11.2 / 12.2 / 15.2）', () => {
  test('重复构建 → 描述符顺序、ID、数值完全一致', async () => {
    const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const rawMap = parseSampleEnvelope(rawJson)
    validateMapSemantics(rawMap)
    const sceneMap = normalizeSceneMap(rawMap)
    const trackModel = buildTrackModel(sceneMap)
    const offsets = new Map<string, number>()
    for (const lane of trackModel.tracks) {
      offsets.set(lane.edgeId, lane.laneOffset)
    }
    const rebuilt = buildLabelDescriptors(sceneMap.nodes, sceneMap.edges, offsets)
    expect(rebuilt.descriptors).toEqual(collection.descriptors)
    expect(rebuilt.labelCandidateCount).toBe(collection.labelCandidateCount)
  })

  test('标签不参与内容 bounds（集合不含 bounds 字段）', () => {
    expect(collection).not.toHaveProperty('bounds')
  })
})
