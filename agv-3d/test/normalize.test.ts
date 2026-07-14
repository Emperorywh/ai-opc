import { describe, expect, it } from 'vitest'
import type { RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { auditRawMap, normalizeMap } from '../src/features/agv-map/domain/normalize'

function validPayload(): RawMapPayload {
  return {
    nodes: [
      { id: 'n1', type: 'node', x: 1.5, y: -2, angle: null },
      { id: 'w1', type: 'work', x: 5, y: 5, angle: 0.7 },
      { id: 'c1', type: 'charge', x: 7, y: 7, angle: 3.14 },
    ],
    edges: [
      {
        id: 'e1',
        edgeType: 'LINE',
        sx: 1,
        sy: 2,
        ex: 3,
        ey: 4,
        cx: null,
        cy: null,
        dx: null,
        dy: null,
        snodeId: 'n1',
        enodeId: 'w1',
        isBackEdge: false,
      },
      {
        id: 'e2',
        edgeType: 'BEZIER',
        sx: 0,
        sy: 0,
        ex: 10,
        ey: 10,
        cx: 2,
        cy: 3,
        dx: 7,
        dy: 8,
        snodeId: 'w1',
        enodeId: 'c1',
        isBackEdge: true,
      },
    ],
    zones: [],
    nodeEdgeGroups: [],
  }
}

describe('normalizeMap', () => {
  it('节点位置与角度正确映射', () => {
    const model = normalizeMap(validPayload())
    expect(model.nodes[0]).toEqual({ id: 'n1', type: 'node', position: { x: 1.5, y: -2 }, angle: null })
    expect(model.nodes[1]).toEqual({ id: 'w1', type: 'work', position: { x: 5, y: 5 }, angle: 0.7 })
  })

  it('直线边映射为 line 路径并保留端点坐标', () => {
    const model = normalizeMap(validPayload())
    expect(model.edges[0]).toEqual({
      id: 'e1',
      sourceNodeId: 'n1',
      targetNodeId: 'w1',
      path: { kind: 'line', start: { x: 1, y: 2 }, end: { x: 3, y: 4 } },
    })
  })

  it('贝塞尔边映射为 cubic-bezier 路径，控制点来自 cx/cy/dx/dy', () => {
    const model = normalizeMap(validPayload())
    expect(model.edges[1]).toEqual({
      id: 'e2',
      sourceNodeId: 'w1',
      targetNodeId: 'c1',
      path: {
        kind: 'cubic-bezier',
        start: { x: 0, y: 0 },
        control1: { x: 2, y: 3 },
        control2: { x: 7, y: 8 },
        end: { x: 10, y: 10 },
      },
    })
  })

  it('显式丢弃契约外字段', () => {
    const payload = validPayload()
    const extra = payload.nodes[0] as unknown as Record<string, unknown>
    extra.name = 'extra'
    extra.cost = 42
    const node = normalizeMap(payload).nodes[0]
    expect(node).not.toHaveProperty('name')
    expect(node).not.toHaveProperty('cost')
    expect(Object.keys(node).sort()).toEqual(['angle', 'id', 'position', 'type'])
  })

  it('计数与输入一致', () => {
    const model = normalizeMap(validPayload())
    expect(model.nodes).toHaveLength(3)
    expect(model.edges).toHaveLength(2)
  })
})

describe('auditRawMap', () => {
  it('统计节点类型、边类型与审计标记', () => {
    expect(auditRawMap(validPayload())).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      zoneCount: 0,
      nodeEdgeGroupCount: 0,
      nodeTypeCount: { node: 1, work: 1, charge: 1, park: 0 },
      edgeTypeCount: { LINE: 1, BEZIER: 1 },
      isBackEdgeCount: 1,
    })
  })
})
