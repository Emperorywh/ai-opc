import { describe, expect, it } from 'vitest'
import type { RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import {
  extractMapPayload,
  validateRawMap,
  validateRawMapAsset,
  type ValidationCode,
} from '../src/features/agv-map/domain/validation'

/** 任意字符串字段视图，用于在校验测试中注入非法类型值。 */
type StringView = { id: string; type: string; edgeType: string }

function validPayload(): RawMapPayload {
  return {
    nodes: [
      { id: 'n1', type: 'node', x: 0, y: 0, angle: null },
      { id: 'w1', type: 'work', x: 5, y: 5, angle: 1.2 },
      { id: 'c1', type: 'charge', x: 9, y: 9, angle: 0 },
      { id: 'p1', type: 'park', x: 2, y: 2, angle: -0.5 },
    ],
    edges: [
      {
        id: 'e1',
        edgeType: 'LINE',
        sx: 0,
        sy: 0,
        ex: 5,
        ey: 0,
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
        sx: 5,
        sy: 5,
        ex: 9,
        ey: 9,
        cx: 6,
        cy: 7,
        dx: 8,
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

function codes(payload: unknown): ValidationCode[] {
  return validateRawMap(payload).map((p) => p.code)
}

describe('validateRawMap — 合法数据', () => {
  it('对合法载荷不产生问题', () => {
    expect(validateRawMap(validPayload())).toEqual([])
  })

  it('isBackEdge 取值不影响校验结论', () => {
    const payload = validPayload()
    payload.edges[0].isBackEdge = true
    payload.edges[1].isBackEdge = false
    expect(validateRawMap(payload)).toEqual([])
  })

  it('边端点与节点坐标不一致不报错', () => {
    const payload = validPayload()
    payload.edges[0].sx = 100
    payload.edges[0].sy = 200
    expect(validateRawMap(payload)).toEqual([])
  })
})

describe('validateRawMap — 节点规则', () => {
  it('空节点 id 报 EMPTY_NODE_ID', () => {
    const payload = validPayload()
    payload.nodes[0].id = ''
    expect(codes(payload)).toContain('EMPTY_NODE_ID')
  })

  it('重复节点 id 报 DUPLICATE_NODE_ID', () => {
    const payload = validPayload()
    payload.nodes[1].id = 'n1'
    expect(codes(payload)).toContain('DUPLICATE_NODE_ID')
  })

  it('非法节点类型报 INVALID_NODE_TYPE', () => {
    const payload = validPayload()
    ;(payload.nodes[0] as unknown as StringView).type = 'robot'
    expect(codes(payload)).toContain('INVALID_NODE_TYPE')
  })

  it('非有限节点坐标报 NON_FINITE_NODE_COORDINATE', () => {
    const payload = validPayload()
    payload.nodes[0].x = Number.NaN
    expect(codes(payload)).toContain('NON_FINITE_NODE_COORDINATE')
  })

  it('普通节点 angle 非 null 报 INVALID_NODE_ANGLE', () => {
    const payload = validPayload()
    payload.nodes[0].angle = 0
    expect(codes(payload)).toContain('INVALID_NODE_ANGLE')
  })

  it('方向性节点 angle 为 null 报 INVALID_NODE_ANGLE', () => {
    const payload = validPayload()
    payload.nodes[1].angle = null
    expect(codes(payload)).toContain('INVALID_NODE_ANGLE')
  })

  it('方向性节点 angle 非有限值报 INVALID_NODE_ANGLE', () => {
    const payload = validPayload()
    payload.nodes[1].angle = Number.POSITIVE_INFINITY
    expect(codes(payload)).toContain('INVALID_NODE_ANGLE')
  })
})

describe('validateRawMap — 边规则', () => {
  it('空边 id 报 EMPTY_EDGE_ID', () => {
    const payload = validPayload()
    payload.edges[0].id = ''
    expect(codes(payload)).toContain('EMPTY_EDGE_ID')
  })

  it('重复边 id 报 DUPLICATE_EDGE_ID', () => {
    const payload = validPayload()
    payload.edges[1].id = 'e1'
    expect(codes(payload)).toContain('DUPLICATE_EDGE_ID')
  })

  it('非法边类型报 INVALID_EDGE_TYPE', () => {
    const payload = validPayload()
    ;(payload.edges[0] as unknown as StringView).edgeType = 'ARC'
    expect(codes(payload)).toContain('INVALID_EDGE_TYPE')
  })

  it('非有限边坐标报 NON_FINITE_EDGE_COORDINATE', () => {
    const payload = validPayload()
    payload.edges[0].ex = Number.NaN
    expect(codes(payload)).toContain('NON_FINITE_EDGE_COORDINATE')
  })

  it('零长度直线报 ZERO_LENGTH_LINE', () => {
    const payload = validPayload()
    payload.edges[0].sx = 1
    payload.edges[0].sy = 1
    payload.edges[0].ex = 1
    payload.edges[0].ey = 1
    expect(codes(payload)).toContain('ZERO_LENGTH_LINE')
  })

  it('贝塞尔控制点缺失报 INCOMPLETE_BEZIER_CONTROL', () => {
    const payload = validPayload()
    payload.edges[1].cx = null
    expect(codes(payload)).toContain('INCOMPLETE_BEZIER_CONTROL')
  })

  it('贝塞尔控制点非有限值报 INCOMPLETE_BEZIER_CONTROL', () => {
    const payload = validPayload()
    payload.edges[1].dy = Number.NaN
    expect(codes(payload)).toContain('INCOMPLETE_BEZIER_CONTROL')
  })

  it('缺失节点引用报 MISSING_NODE_REFERENCE', () => {
    const payload = validPayload()
    payload.edges[0].enodeId = 'nope'
    expect(codes(payload)).toContain('MISSING_NODE_REFERENCE')
  })

  it('重复有向节点对报 DUPLICATE_DIRECTED_PAIR', () => {
    const payload = validPayload()
    payload.edges.push({
      id: 'e3',
      edgeType: 'LINE',
      sx: 0,
      sy: 0,
      ex: 5,
      ey: 0,
      cx: null,
      cy: null,
      dx: null,
      dy: null,
      snodeId: 'n1',
      enodeId: 'w1',
      isBackEdge: false,
    })
    expect(codes(payload)).toContain('DUPLICATE_DIRECTED_PAIR')
  })

  it('反向节点对不视为重复', () => {
    const payload = validPayload()
    payload.edges.push({
      id: 'e3',
      edgeType: 'LINE',
      sx: 5,
      sy: 0,
      ex: 0,
      ey: 0,
      cx: null,
      cy: null,
      dx: null,
      dy: null,
      snodeId: 'w1',
      enodeId: 'n1',
      isBackEdge: true,
    })
    expect(validateRawMap(payload)).toEqual([])
  })
})

describe('validateRawMap — 结构规则', () => {
  it('非空 zones 报 NON_EMPTY_ZONES', () => {
    const payload = validPayload()
    payload.zones.push({ id: 'z1' })
    expect(codes(payload)).toContain('NON_EMPTY_ZONES')
  })

  it('非空 nodeEdgeGroups 报 NON_EMPTY_NODE_EDGE_GROUPS', () => {
    const payload = validPayload()
    payload.nodeEdgeGroups.push({ id: 'g1' })
    expect(codes(payload)).toContain('NON_EMPTY_NODE_EDGE_GROUPS')
  })

  it('载荷非对象报 INVALID_PAYLOAD_SHAPE', () => {
    expect(codes(null)).toContain('INVALID_PAYLOAD_SHAPE')
    expect(codes('not an object')).toContain('INVALID_PAYLOAD_SHAPE')
  })

  it('nodes 非数组报 INVALID_PAYLOAD_SHAPE', () => {
    expect(codes({ ...validPayload(), nodes: {} })).toContain('INVALID_PAYLOAD_SHAPE')
  })

  it('一次性收集多条不同问题', () => {
    const payload = validPayload()
    payload.nodes[0].id = ''
    ;(payload.nodes[0] as unknown as StringView).type = 'bad'
    payload.zones.push({})
    payload.edges[0].enodeId = 'missing'
    const result = validateRawMap(payload)
    expect(result.map((p) => p.code)).toEqual(
      expect.arrayContaining([
        'EMPTY_NODE_ID',
        'INVALID_NODE_TYPE',
        'NON_EMPTY_ZONES',
        'MISSING_NODE_REFERENCE',
      ]),
    )
    expect(result.length).toBeGreaterThanOrEqual(4)
  })

  it('每个问题都携带可定位的字段路径', () => {
    const payload = validPayload()
    payload.nodes[2].angle = null
    const result = validateRawMap(payload)
    expect(result.some((p) => p.path === 'nodes[2].angle')).toBe(true)
  })

  it('节点缺失必需数值字段被校验拒绝并定位到字段（TASK-001 异常路径）', () => {
    const payload = validPayload()
    delete (payload.nodes[0] as unknown as Record<string, unknown>).x
    const result = validateRawMap(payload)
    expect(codes(payload)).toContain('NON_FINITE_NODE_COORDINATE')
    expect(result.some((p) => p.path === 'nodes[0].x')).toBe(true)
  })

  it('边缺失必需引用字段被校验拒绝并定位到字段（TASK-001 异常路径）', () => {
    const payload = validPayload()
    delete (payload.edges[0] as unknown as Record<string, unknown>).snodeId
    const result = validateRawMap(payload)
    expect(codes(payload)).toContain('MISSING_NODE_REFERENCE')
    expect(result.some((p) => p.path === 'edges[0].snodeId')).toBe(true)
  })
})

describe('extractMapPayload / validateRawMapAsset', () => {
  it('从完整包装结构中提取载荷', () => {
    const result = extractMapPayload({ data: { currentMapInfoVersion: { mapJson: validPayload() } } })
    expect(result.ok).toBe(true)
  })

  it('包装结构缺失字段时报带路径的问题', () => {
    const result = extractMapPayload({ data: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.problems.some((p) => p.path === 'data.currentMapInfoVersion')).toBe(true)
    }
  })

  it('validateRawMapAsset 合并提取与校验问题', () => {
    const problems = validateRawMapAsset({
      data: { currentMapInfoVersion: { mapJson: { ...validPayload(), zones: [{}] } } },
    })
    expect(problems.map((p) => p.code)).toContain('NON_EMPTY_ZONES')
  })
})
