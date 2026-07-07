// ============================================================================
// loader 单元测试
// ----------------------------------------------------------------------------
// 覆盖两类场景（对应 docs/PLAN_agv-map-phase1.md §6.1、§6.6）：
// 1. 真实样例统计量：节点/边计数、标题/标识、包围盒范围、无退化告警；
// 2. 构造退化用例：零长度/自环/null 控制点贝塞尔/未知 type/非 ENABLED/
//    顶层缺失，逐条断言对应的告警与归一化结果。
// ============================================================================

import { describe, expect, it } from 'vitest'
import sample from '../../src/json/getMapInfo.json'
import { loadMapData } from './loader.ts'

// ----------------------------------------------------------------------------
// 工具：构造最小合法的顶层 JSON 骨架，便于退化用例只写关心的部分
// ----------------------------------------------------------------------------
function makeMap(opts: {
  mapState?: string
  mapName?: string
  mapId?: string
  nodes?: unknown[]
  edges?: unknown[]
}): unknown {
  return {
    code: 200,
    message: 'success',
    data: {
      mapId: opts.mapId ?? 'test-map',
      mapName: opts.mapName ?? '测试地图',
      mapState: opts.mapState ?? 'ENABLED',
      currentMapInfoVersion: {
        mapJson: {
          nodes: opts.nodes ?? [],
          edges: opts.edges ?? [],
        },
      },
    },
  }
}

// ----------------------------------------------------------------------------
// 真实样例：1806 节点 / 3101 边（含 108 条 BEZIER）
// 真实数据无任何退化项，loader 应产出去退化后的完整数据且 warnings 为空。
// ----------------------------------------------------------------------------
describe('loadMapData · 真实样例', () => {
  const result = loadMapData(sample)

  it('节点数 === 1806', () => {
    expect(result.nodes.length).toBe(1806)
  })

  it('边数 === 3101（无退化剔除）', () => {
    expect(result.edges.length).toBe(3101)
  })

  it('mapName === "中环大地图"', () => {
    expect(result.mapName).toBe('中环大地图')
  })

  it('mapId === "50e6465395bd40f59ebe1a0adb90a679"', () => {
    expect(result.mapId).toBe('50e6465395bd40f59ebe1a0adb90a679')
  })

  it('包围盒为有限数值且覆盖预期范围', () => {
    const { minX, maxX, minY, maxY } = result.bbox
    // 全部为有限数值（非 ±Infinity/NaN）
    expect(Number.isFinite(minX)).toBe(true)
    expect(Number.isFinite(maxX)).toBe(true)
    expect(Number.isFinite(minY)).toBe(true)
    expect(Number.isFinite(maxY)).toBe(true)
    // 宽高为正（地图确有覆盖范围）
    expect(maxX).toBeGreaterThan(minX)
    expect(maxY).toBeGreaterThan(minY)
    // 实测值（真实样例首次运行得到，精度锁定到 ±0.005）
    expect(minX).toBeCloseTo(-165.74, 2)
    expect(maxX).toBeCloseTo(2.1, 2)
    expect(minY).toBeCloseTo(-25.12, 2)
    expect(maxY).toBeCloseTo(50.2, 2)
  })

  it('真实数据无退化告警', () => {
    expect(result.warnings).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// 退化处理：构造最小用例，逐条断言告警与归一化结果
// ----------------------------------------------------------------------------
describe('loadMapData · 退化处理', () => {
  it('零长度边：丢弃并产出 ZERO_LENGTH 告警', () => {
    const raw = makeMap({
      edges: [
        {
          id: 'e-zero',
          name: 'n',
          mapId: 'm',
          edgeType: 'LINE',
          sx: 1,
          sy: 2,
          ex: 1,
          ey: 2,
          isBackEdge: false,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
    })
    const r = loadMapData(raw)
    expect(r.edges).toHaveLength(0)
    expect(r.warnings).toContainEqual({
      kind: 'ZERO_LENGTH',
      id: 'e-zero',
      detail: 'zero-length edge dropped',
    })
  })

  it('自环边：丢弃并产出 SELF_LOOP 告警', () => {
    const raw = makeMap({
      edges: [
        {
          id: 'e-loop',
          name: 'n',
          mapId: 'm',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 5,
          ey: 5,
          isBackEdge: false,
          snodeId: 'a',
          enodeId: 'a',
        },
      ],
    })
    const r = loadMapData(raw)
    expect(r.edges).toHaveLength(0)
    expect(r.warnings).toContainEqual({
      kind: 'SELF_LOOP',
      id: 'e-loop',
      detail: 'self-loop edge dropped',
    })
  })

  it('BEZIER 控制点缺失：退化为 LINE 并产出 BEZIER_MISSING_CTRL 告警', () => {
    const raw = makeMap({
      edges: [
        {
          id: 'e-bez',
          name: 'n',
          mapId: 'm',
          edgeType: 'BEZIER',
          sx: 0,
          sy: 0,
          ex: 5,
          ey: 5,
          cx: 1,
          cy: 1,
          dx: null,
          dy: 4,
          isBackEdge: false,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
    })
    const r = loadMapData(raw)
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0].edgeType).toBe('LINE')
    // 控制点被清空
    expect(r.edges[0].cx).toBeNull()
    expect(r.edges[0].dy).toBeNull()
    expect(r.warnings).toContainEqual({
      kind: 'BEZIER_MISSING_CTRL',
      id: 'e-bez',
      detail: 'bezier missing control point, degraded to LINE',
    })
  })

  it('LINE 边携带控制点：忽略控制点并产出 LINE_IGNORE_CTRL 告警', () => {
    const raw = makeMap({
      edges: [
        {
          id: 'e-line',
          name: 'n',
          mapId: 'm',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 5,
          ey: 5,
          cx: 1,
          cy: 1,
          dx: 2,
          dy: 2,
          isBackEdge: false,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
    })
    const r = loadMapData(raw)
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0].cx).toBeNull()
    expect(r.edges[0].dx).toBeNull()
    expect(r.warnings).toContainEqual({
      kind: 'LINE_IGNORE_CTRL',
      id: 'e-line',
      detail: 'LINE edge has control point, ignored',
    })
  })

  it('未知 node type：归一化为 node 并产出 NODE_TYPE_UNKNOWN 告警', () => {
    const raw = makeMap({
      nodes: [
        {
          id: 'n-unknown',
          name: 'X',
          mapId: 'm',
          type: 'mystery',
          x: 1,
          y: 2,
          angle: null,
        },
      ],
    })
    const r = loadMapData(raw)
    expect(r.nodes).toHaveLength(1)
    expect(r.nodes[0].type).toBe('node')
    expect(
      r.warnings.some(
        (w) => w.kind === 'NODE_TYPE_UNKNOWN' && w.id === 'n-unknown',
      ),
    ).toBe(true)
  })

  it('mapState 非 ENABLED：继续渲染并产出 MAP_STATE_DISABLED 告警', () => {
    const raw = makeMap({
      mapState: 'DISABLED',
      nodes: [
        { id: 'n0', name: 'A', mapId: 'm', type: 'node', x: 0, y: 0, angle: null },
      ],
    })
    const r = loadMapData(raw)
    expect(r.nodes).toHaveLength(1)
    expect(
      r.warnings.some((w) => w.kind === 'MAP_STATE_DISABLED'),
    ).toBe(true)
  })

  it('顶层结构缺失：返回带 PARSE_ERROR 告警的空 MapData', () => {
    const r = loadMapData({ code: 500, data: null })
    expect(r.nodes).toHaveLength(0)
    expect(r.edges).toHaveLength(0)
    expect(r.bbox).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 })
    expect(
      r.warnings.some((w) => w.kind === 'PARSE_ERROR'),
    ).toBe(true)
  })

  it('包围盒：综合节点与边端点取 min/max', () => {
    const raw = makeMap({
      nodes: [
        // 节点贡献 (-10, -5)
        { id: 'n0', name: 'A', mapId: 'm', type: 'node', x: -10, y: -5, angle: null },
        // 节点贡献 (2, 8)
        { id: 'n1', name: 'B', mapId: 'm', type: 'node', x: 2, y: 8, angle: null },
      ],
      edges: [
        // 边端点贡献 (3, 3) 与 (20, 1)（控制点不参与包围盒）
        {
          id: 'e0',
          name: 'n',
          mapId: 'm',
          edgeType: 'BEZIER',
          sx: 3,
          sy: 3,
          ex: 20,
          ey: 1,
          cx: 100,
          cy: 100,
          dx: -100,
          dy: -100,
          isBackEdge: false,
          snodeId: 'a',
          enodeId: 'b',
        },
      ],
    })
    const r = loadMapData(raw)
    // minX = min(-10, 3, 20) = -10
    expect(r.bbox.minX).toBe(-10)
    // maxX = max(2, 3, 20) = 20（控制点 100 不参与）
    expect(r.bbox.maxX).toBe(20)
    // minY = min(-5, 3, 1) = -5（控制点 -100 不参与）
    expect(r.bbox.minY).toBe(-5)
    // maxY = max(8, 3, 1) = 8（控制点 100 不参与）
    expect(r.bbox.maxY).toBe(8)
    // 该 BEZIER 控制点齐全，不应触发退化告警
    expect(r.warnings).toEqual([])
  })

  it('空地图：返回退化包围盒，无告警', () => {
    const r = loadMapData(makeMap({}))
    expect(r.nodes).toHaveLength(0)
    expect(r.edges).toHaveLength(0)
    expect(r.bbox).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0 })
    expect(r.warnings).toEqual([])
  })
})
