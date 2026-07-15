import { describe, expect, it } from 'vitest'
import type { RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { auditDataIntegrity, auditRawMap, normalizeMap } from '../src/features/agv-map/domain/normalize'

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

  it('isBackEdge 取值不影响规范化结果（SPEC §4.4、TASK-001 边界路径）', () => {
    // isBackEdge 只保留在原始 DTO 审计信息中，不进入规范化结果。
    // 翻转全部 isBackEdge 后规范化模型应与原结果逐字段相等。
    const baseline = normalizeMap(validPayload())
    const flipped = validPayload()
    flipped.edges[0].isBackEdge = !flipped.edges[0].isBackEdge
    flipped.edges[1].isBackEdge = !flipped.edges[1].isBackEdge
    expect(normalizeMap(flipped)).toEqual(baseline)
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

describe('auditDataIntegrity', () => {
  it('对通过校验的载荷报告零缺陷；端点偏差如实计数但不视为缺陷', () => {
    // validPayload 故意让边端点偏离节点坐标以验证规范化不吸附，因此它通过校验
    // （端点偏差不是校验错误）却仍被完整性审计如实计为端点偏差。
    const integrity = auditDataIntegrity(validPayload())
    expect(integrity.duplicateNodeIdCount).toBe(0)
    expect(integrity.duplicateEdgeIdCount).toBe(0)
    expect(integrity.invalidNodeCoordinateCount).toBe(0)
    expect(integrity.invalidEdgeCoordinateCount).toBe(0)
    expect(integrity.missingNodeReferenceCount).toBe(0)
    expect(integrity.endpointNodeMismatchCount).toBe(2)
    expect(integrity.maxEndpointNodeDistanceM).toBeCloseTo(Math.hypot(5, 5), 10)
  })

  it('逐项计数重复 id、非法坐标、缺失引用与端点偏差（SPEC §4.2）', () => {
    // 注入各类缺陷，验证完整性审计的每条计数路径相互独立、不重复归因。
    const payload: RawMapPayload = {
      nodes: [
        { id: 'n1', type: 'node', x: 0, y: 0, angle: null },
        // 重复节点 id（n1）；nodeById 保留首个 (0,0)。
        { id: 'n1', type: 'node', x: 1, y: 1, angle: null },
        // 非法节点坐标（x 非有限）。
        { id: 'n2', type: 'node', x: Number.NaN, y: 2, angle: null },
        { id: 'n3', type: 'work', x: 5, y: 5, angle: 0 },
      ],
      edges: [
        {
          id: 'e1',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 5,
          ey: 5,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          snodeId: 'n1',
          enodeId: 'n3',
          isBackEdge: false,
        },
        // 重复边 id（e1）；终端点 (6,6) 与 n3 (5,5) 偏差 √2，计入端点偏差。
        {
          id: 'e1',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: 6,
          ey: 6,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          snodeId: 'n1',
          enodeId: 'n3',
          isBackEdge: false,
        },
        // 非法边坐标（ex 非有限）；起始引用 missing 不存在，计入缺失引用。
        {
          id: 'e2',
          edgeType: 'LINE',
          sx: 0,
          sy: 0,
          ex: Number.NaN,
          ey: 0,
          cx: null,
          cy: null,
          dx: null,
          dy: null,
          snodeId: 'missing',
          enodeId: 'n3',
          isBackEdge: false,
        },
      ],
      zones: [],
      nodeEdgeGroups: [],
    }

    const integrity = auditDataIntegrity(payload)
    expect(integrity.duplicateNodeIdCount).toBe(1)
    expect(integrity.duplicateEdgeIdCount).toBe(1)
    expect(integrity.invalidNodeCoordinateCount).toBe(1)
    expect(integrity.invalidEdgeCoordinateCount).toBe(1)
    expect(integrity.missingNodeReferenceCount).toBe(1)
    // 仅第二条边存在端点偏差（√2）；第三条边坐标非法，不重复计入端点偏差。
    expect(integrity.endpointNodeMismatchCount).toBe(1)
    expect(integrity.maxEndpointNodeDistanceM).toBeCloseTo(Math.SQRT2, 10)
  })
})
