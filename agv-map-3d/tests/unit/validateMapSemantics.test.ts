/*
 * 跨实体语义校验自动化验证（TASK-004，SPEC 5.3 第 3/4/9/10/12 项 / 14.1 / 15.2）。
 *
 * 覆盖：
 *   - 正常路径：真实样本通过全部跨实体语义不变量。
 *   - 合成最小 RawMap 通过校验；边界值（弦长略大于 1e-9、偏差恰为 0.05）合法。
 *   - 范围门禁：非空 zones / nodeEdgeGroups → MAP_ENTITY_INVALID。
 *   - mapId 全链路：响应元 vs 版本元、节点 mapId、边 mapId 任一不一致 → MAP_ENTITY_INVALID。
 *   - 引用完整性：snodeId / enodeId 悬空、自环 → MAP_ENTITY_INVALID。
 *   - 几何前置：零长度边（LINE / BEZIER）→ MAP_GEOMETRY_INVALID。
 *   - 端点偏差：起点 / 终点偏差超过 0.05m → MAP_ENTITY_INVALID；通过后端点不被覆盖。
 *
 * 本文件只消费 RawMap（parseSampleEnvelope 的输出契约），不重复字段级校验用例。
 * 不启动浏览器：真实样本在 node 环境直接读取。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MapDataError, MapErrorCode, isMapDataError } from '../../src/domain/mapDataError'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import type { RawEdge, RawLineEdge, RawBezierEdge, RawMap, RawNode } from '../../src/adapters/rawMap'
import { ENDPOINT_DEVIATION_LIMIT } from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// --- 测试夹具：以最小合法 RawMap 起步，按用例覆盖单字段构造异常。 ---

function makeNode(overrides: Partial<RawNode> = {}): RawNode {
  return {
    id: 'n1',
    name: 'A',
    type: 'node',
    mapId: 'map-1',
    x: 0,
    y: 0,
    angle: null,
    ...overrides,
  }
}

function makeLineEdge(overrides: Partial<RawLineEdge> = {}): RawLineEdge {
  return {
    id: 'e1',
    name: '1',
    mapId: 'map-1',
    snodeId: 'n1',
    enodeId: 'n2',
    sx: 0,
    sy: 0,
    ex: 1,
    ey: 0,
    cx: null,
    cy: null,
    dx: null,
    dy: null,
    isBackEdge: false,
    edgeType: 'LINE',
    ...overrides,
  }
}

function makeBezierEdge(overrides: Partial<RawBezierEdge> = {}): RawBezierEdge {
  return {
    ...makeLineEdge({ id: 'e-bz', edgeType: 'BEZIER' }),
    cx: 0.3,
    cy: 0,
    dx: 0.6,
    dy: 0,
    ...overrides,
  } as RawBezierEdge
}

function makeRawMap(args: {
  nodes?: readonly RawNode[]
  edges?: readonly RawEdge[]
  zones?: unknown[]
  nodeEdgeGroups?: unknown[]
  metadata?: Partial<RawMap['metadata']>
} = {}): RawMap {
  // 默认两个节点 n1(0,0)/n2(1,0)，一条 n1→n2 的合法 LINE 边，端点与节点坐标对齐，全部 mapId 一致。
  const nodes = args.nodes ?? [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 1, y: 0, name: 'B' })]
  const edges = args.edges ?? [
    makeLineEdge({ snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 1, ey: 0 }),
  ]
  return {
    metadata: {
      envelopeMapId: 'map-1',
      mapId: 'map-1',
      mapName: '测试地图',
      version: 'V1',
      ...args.metadata,
    },
    nodes,
    edges,
    zones: args.zones ?? [],
    nodeEdgeGroups: args.nodeEdgeGroups ?? [],
  }
}

// 捕获并断言 MapDataError；未抛出或抛出非 MapDataError 都算用例失败。
function captureError(fn: () => unknown): MapDataError {
  try {
    fn()
  } catch (e) {
    if (!isMapDataError(e)) {
      throw new Error(`期望 MapDataError，但捕获到：${String(e)}`)
    }
    return e
  }
  throw new Error('期望抛出 MapDataError，但未抛出任何异常')
}

// 断言中文消息存在且非空（SPEC 14.1）。
function expectChineseMessage(err: MapDataError): void {
  expect(err.message, '错误消息必须为非空中文').toMatch(/[一-鿿]/)
  expect(err.message.length).toBeGreaterThan(0)
}

describe('跨实体语义校验 · 正常路径（TASK-004）', () => {
  test('真实样本通过全部跨实体语义不变量', () => {
    const raw = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const map = parseSampleEnvelope(raw)
    // 真实样本无悬空引用、无自环、最短弦长 0.04m、最大端点偏差 0.030m，应整体通过。
    expect(() => validateMapSemantics(map)).not.toThrow()
  })

  test('合成最小 RawMap 通过校验', () => {
    expect(() => validateMapSemantics(makeRawMap())).not.toThrow()
  })

  test('合成四类节点与两类边的 RawMap 通过校验', () => {
    const map = makeRawMap({
      nodes: [
        makeNode({ id: 'n-node', x: 0, y: 0 }),
        makeNode({ id: 'n-work', type: 'work', angle: 0.5, x: 0, y: 0 }),
        makeNode({ id: 'n-park', type: 'park', angle: -0.5, x: 1, y: 0 }),
        makeNode({ id: 'n-charge', type: 'charge', angle: 1.2, x: 2, y: 0 }),
      ],
      edges: [
        makeLineEdge({ id: 'e-line', snodeId: 'n-work', enodeId: 'n-park', sx: 0, sy: 0, ex: 1, ey: 0 }),
        makeBezierEdge({ id: 'e-bz', snodeId: 'n-park', enodeId: 'n-charge', sx: 1, sy: 0, ex: 2, ey: 0 }),
      ],
    })
    expect(() => validateMapSemantics(map)).not.toThrow()
  })

  test('弦长略大于 1e-9 的极短边合法', () => {
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 2e-9, y: 0 })],
      edges: [makeLineEdge({ id: 'e-short', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 2e-9, ey: 0 })],
    })
    expect(() => validateMapSemantics(map)).not.toThrow()
  })

  test('端点偏差恰为门限 0.05m 合法（边界含端）', () => {
    // 节点 n2 位于 (0,0)；边终点 (0.05, 0) → 偏差 hypot(0.05,0)=0.05，等于门限，不超过。
    // 用 0 作为节点坐标避免 1.05-1.0 的浮点减法误差。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 0, y: 0, name: 'B' })],
      edges: [makeLineEdge({ snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 0.05, ey: 0 })],
    })
    expect(() => validateMapSemantics(map)).not.toThrow()
  })

  test('校验成功后边端点保持原值，未被节点坐标覆盖', () => {
    // 边终点 (1.04, 0.02) 与节点 n2 (1, 0) 存在偏差但通过门限；校验后端点必须保持不变。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 1, y: 0 })],
      edges: [makeLineEdge({ id: 'e-keep', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 1.04, ey: 0.02 })],
    })
    validateMapSemantics(map)
    const edge = map.edges[0] as RawLineEdge
    expect(edge.ex).toBe(1.04)
    expect(edge.ey).toBe(0.02)
    // 节点坐标也未被边端点覆盖。
    const endNode = map.nodes.find((n) => n.id === 'n2')!
    expect(endNode.x).toBe(1)
    expect(endNode.y).toBe(0)
  })
})

describe('跨实体语义校验 · 范围门禁（SPEC 5.3 第 3 项）', () => {
  test('zones 非空 → MAP_ENTITY_INVALID', () => {
    const map = makeRawMap({ zones: [{ id: 'zone-1' }] })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('zones')
    expectChineseMessage(err)
  })

  test('nodeEdgeGroups 非空 → MAP_ENTITY_INVALID', () => {
    const map = makeRawMap({ nodeEdgeGroups: [{ id: 'group-1' }] })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('nodeEdgeGroups')
    expectChineseMessage(err)
  })
})

describe('跨实体语义校验 · mapId 全链路一致（SPEC 5.3 第 4 项）', () => {
  test('响应元 mapId 与版本元 mapId 不一致', () => {
    const map = makeRawMap({ metadata: { envelopeMapId: 'other' } })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('data.mapId')
    expectChineseMessage(err)
  })

  test('节点 mapId 与地图 mapId 不一致', () => {
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1' }), makeNode({ id: 'n2', name: 'B', mapId: 'other' })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('nodes[1].mapId')
    expect(err.entityId).toBe('n2')
  })

  test('边 mapId 与地图 mapId 不一致', () => {
    const map = makeRawMap({
      edges: [makeLineEdge({ id: 'e1', mapId: 'other' })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('edges[0].mapId')
    expect(err.entityId).toBe('e1')
  })
})

describe('跨实体语义校验 · 引用完整性与自环（SPEC 5.3 第 9 项）', () => {
  test('snodeId 引用不存在的节点（悬空引用）', () => {
    const map = makeRawMap({
      edges: [makeLineEdge({ id: 'e1', snodeId: 'ghost' })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('snodeId')
    expect(err.entityId).toBe('e1')
    expectChineseMessage(err)
  })

  test('enodeId 引用不存在的节点（悬空引用）', () => {
    const map = makeRawMap({
      edges: [makeLineEdge({ id: 'e1', enodeId: 'ghost' })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('enodeId')
    expect(err.entityId).toBe('e1')
  })

  test('snodeId === enodeId（自环）', () => {
    // 自环节点必须存在，否则会先命中悬空引用；这里让 n1 同时作起终点。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1' })],
      edges: [makeLineEdge({ id: 'e-self', snodeId: 'n1', enodeId: 'n1', sx: 0, sy: 0, ex: 1, ey: 0 })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.entityId).toBe('e-self')
    expect(err.message).toMatch(/自环/)
  })
})

describe('跨实体语义校验 · 弦长下界（SPEC 5.3 第 10 项）', () => {
  test('零长度 LINE 边 → MAP_GEOMETRY_INVALID', () => {
    const map = makeRawMap({
      edges: [makeLineEdge({ id: 'e-zero', sx: 0, sy: 0, ex: 0, ey: 0 })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.entityId).toBe('e-zero')
    expect(err.message).toMatch(/弦长/)
  })

  test('极短 LINE 边（弦长 5e-10，低于 1e-9）→ MAP_GEOMETRY_INVALID', () => {
    const map = makeRawMap({
      edges: [makeLineEdge({ id: 'e-tiny', sx: 0, sy: 0, ex: 5e-10, ey: 0 })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.entityId).toBe('e-tiny')
  })

  test('BEZIER 边 start === end（弦长为零）→ MAP_GEOMETRY_INVALID', () => {
    // 即便控制点不为零，弦长由端点决定；端点重合即判零长度。
    const map = makeRawMap({
      edges: [
        makeBezierEdge({
          id: 'e-bz-zero',
          snodeId: 'n1',
          enodeId: 'n2',
          sx: 0,
          sy: 0,
          ex: 0,
          ey: 0,
          cx: 0.3,
          cy: 0,
          dx: 0.6,
          dy: 0,
        }),
      ],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.entityId).toBe('e-bz-zero')
  })
})

describe('跨实体语义校验 · 端点偏差门限（SPEC 5.3 第 12 项）', () => {
  test('起点偏差超过 0.05m → MAP_ENTITY_INVALID', () => {
    // 节点 n1 位于 (0,0)；边起点 (0.06, 0) → 偏差 0.06 > 0.05。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 1, y: 0 })],
      edges: [makeLineEdge({ id: 'e-dev-s', snodeId: 'n1', enodeId: 'n2', sx: 0.06, sy: 0, ex: 1, ey: 0 })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.entityId).toBe('e-dev-s')
    expect(err.jsonPath).toContain('.sx')
    expect(err.message).toMatch(/起点/)
  })

  test('终点偏差超过 0.05m → MAP_ENTITY_INVALID', () => {
    // 节点 n2 位于 (1,0)；边终点 (1.06, 0) → 偏差 0.06 > 0.05。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 1, y: 0 })],
      edges: [makeLineEdge({ id: 'e-dev-e', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 1.06, ey: 0 })],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.entityId).toBe('e-dev-e')
    expect(err.jsonPath).toContain('.ex')
    expect(err.message).toMatch(/终点/)
  })

  test(`端点偏差门限等于 ${ENDPOINT_DEVIATION_LIMIT}（与 fixture 常量一致）`, () => {
    expect(ENDPOINT_DEVIATION_LIMIT).toBe(0.05)
  })
})

describe('跨实体语义校验 · 整体拒绝（无部分输出）', () => {
  test('单条坏边导致整体拒绝，不输出部分合法集合', () => {
    // 三条边，其中第二条零长度；validateMapSemantics 必须在第二条处整体失败。
    const map = makeRawMap({
      nodes: [makeNode({ id: 'n1', x: 0, y: 0 }), makeNode({ id: 'n2', x: 1, y: 0 })],
      edges: [
        makeLineEdge({ id: 'e-ok-1', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 1, ey: 0 }),
        makeLineEdge({ id: 'e-bad', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 0, ey: 0 }),
        makeLineEdge({ id: 'e-ok-2', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 2, ey: 0 }),
      ],
    })
    const err = captureError(() => validateMapSemantics(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.entityId).toBe('e-bad')
  })
})
