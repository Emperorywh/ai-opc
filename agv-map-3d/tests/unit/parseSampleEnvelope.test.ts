/*
 * 未知输入解析边界自动化验证（TASK-003，SPEC 2.1 / 5.1 / 5.3 / 14.1 / 15.2）。
 *
 * 覆盖：
 *   - 正常路径：固定真实样本从唯一提取路径成功解析；数量、类型、元数据与 SPEC 2.2 对齐。
 *   - 正常路径：合成 envelope 的四类节点与两类边被正确判别；额外业务元数据被丢弃。
 *   - 响应包异常（MAP_ENVELOPE_INVALID）：根值、code/message、提取路径、mapJson 形态、
 *     集合字段非数组、地图元数据字段。
 *   - 实体字段异常（MAP_ENTITY_INVALID）：未知类型、空/类型错误的必需字符串、
 *     布尔类型错误、数字字符串/NaN/Infinity、angle 规则、LINE 非空控制点、
 *     BEZIER 部分空控制点、判别联合形态、ID 唯一性。
 *   - 每种失败都得到对应稳定 code、准确 JSON path、可用实体 ID 与中文消息，绝不返回部分结果。
 *
 * 不启动浏览器：所有用例在 node 环境内构造内存数据或读取固定源样本。
 */
import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MapDataError, MapErrorCode, isMapDataError } from '../../src/domain/mapDataError'
import { parseSampleEnvelope, parseRawNode, parseRawEdge } from '../../src/adapters/parseSampleEnvelope'
import type { RawNode } from '../../src/adapters/rawMap'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// --- 测试夹具构造器：以最小合法形态起步，按用例覆盖单字段构造异常。 ---

function baseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'node-1',
    name: 'A1',
    type: 'node',
    mapId: 'map-1',
    x: 0,
    y: 0,
    angle: null,
    // 额外业务元数据：必须被解析边界丢弃，不进入 RawNode。
    actions: [{ type: 'noop' }],
    userDefinedProperties: { foo: 'bar' },
    highPrecision: null,
    ...overrides,
  }
}

function workNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseNode({ id: 'work-1', type: 'work', angle: 1.5708, ...overrides })
}

function baseLineEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'edge-1',
    name: '100',
    mapId: 'map-1',
    snodeId: 'node-1',
    enodeId: 'node-2',
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
    cost: 1.0,
    loadType: 0,
    actions: [],
    ...overrides,
  }
}

function baseBezierEdge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseLineEdge({
    id: 'edge-bezier',
    edgeType: 'BEZIER',
    cx: 0.3,
    cy: 0,
    dx: 0.6,
    dy: 0,
    ...overrides,
  })
}

/*
 * 包裹 mapJson 为完整响应包；version 元数据默认合法，可被覆盖以构造元数据异常。
 * 集合字段缺省为空数组，调用方按用例填入 nodes/edges。
 */
function envelope(
  mapJson: Record<string, unknown>,
  versionOverrides: Record<string, unknown> = {},
): unknown {
  return {
    code: 200,
    message: 'success',
    timestamp: 1,
    data: {
      mapId: 'map-1',
      mapName: '测试地图',
      currentMapInfoVersion: {
        id: 1,
        mapId: 'map-1',
        mapName: '测试地图',
        mapVersion: 'V1',
        mapJson,
        ...versionOverrides,
      },
    },
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

// 断言中文消息存在且非空（SPEC 14.1：稳定错误码 + 简体中文可读消息）。
function expectChineseMessage(err: MapDataError): void {
  expect(err.message, '错误消息必须为非空中文').toMatch(/[一-鿿]/)
  expect(err.message.length).toBeGreaterThan(0)
}

// --- 构造只含合法节点的最小 mapJson，供异常用例复用。 ---
function mapJsonWith(nodes: unknown[], edges: unknown[] = []): Record<string, unknown> {
  return {
    nodes,
    edges,
    zones: [],
    nodeEdgeGroups: [],
  }
}

describe('解析边界 · 正常路径（TASK-003）', () => {
  test('固定真实样本从唯一提取路径成功解析，数量与类型与 SPEC 2.2 对齐', () => {
    const raw = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const map = parseSampleEnvelope(raw)

    // SPEC 2.2 节点数量。
    expect(map.nodes).toHaveLength(1767)
    const byType = new Map<string, number>()
    for (const n of map.nodes) byType.set(n.type, (byType.get(n.type) ?? 0) + 1)
    expect(byType.get('node')).toBe(1303)
    expect(byType.get('work')).toBe(389)
    expect(byType.get('park')).toBe(64)
    expect(byType.get('charge')).toBe(11)

    // SPEC 2.2 边数量与判别联合。
    expect(map.edges).toHaveLength(3043)
    const byEdge = new Map<string, number>()
    for (const e of map.edges) byEdge.set(e.edgeType, (byEdge.get(e.edgeType) ?? 0) + 1)
    expect(byEdge.get('LINE')).toBe(2934)
    expect(byEdge.get('BEZIER')).toBe(109)

    // SPEC 2.1 地图元数据。
    expect(map.metadata.mapId).toBe('eca3f1d5803247148085688b971c54fb')
    expect(map.metadata.mapName).toBe('中环大地图')
    expect(map.metadata.version).toBe('V1784091415507')

    // zones / nodeEdgeGroups 校验为数组后透传（真实样本为空）。
    expect(Array.isArray(map.zones)).toBe(true)
    expect(Array.isArray(map.nodeEdgeGroups)).toBe(true)
    expect(map.zones).toHaveLength(0)
    expect(map.nodeEdgeGroups).toHaveLength(0)
  })

  test('真实样本：所有 LINE 控制字段为 null，所有 BEZIER 控制字段为有限数', () => {
    const raw = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const map = parseSampleEnvelope(raw)
    for (const edge of map.edges) {
      if (edge.edgeType === 'LINE') {
        expect(edge.cx).toBeNull()
        expect(edge.cy).toBeNull()
        expect(edge.dx).toBeNull()
        expect(edge.dy).toBeNull()
      } else {
        expect(Number.isFinite(edge.cx)).toBe(true)
        expect(Number.isFinite(edge.cy)).toBe(true)
        expect(Number.isFinite(edge.dx)).toBe(true)
        expect(Number.isFinite(edge.dy)).toBe(true)
      }
    }
  })

  test('真实样本：普通 node 的 angle 为 null，其余三类为有限弧度', () => {
    const raw = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const map = parseSampleEnvelope(raw)
    for (const n of map.nodes) {
      if (n.type === 'node') {
        expect(n.angle, `节点 ${n.id} angle 应为 null`).toBeNull()
      } else {
        expect(Number.isFinite(n.angle), `节点 ${n.id} angle 应为有限数`).toBe(true)
      }
    }
  })

  test('真实样本：额外业务元数据不穿透到输出契约', () => {
    const raw = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
    const map = parseSampleEnvelope(raw)
    const sample = map.nodes[0] as Record<string, unknown>
    expect(sample).not.toHaveProperty('actions')
    expect(sample).not.toHaveProperty('userDefinedProperties')
    expect(sample).not.toHaveProperty('highPrecision')
    // 只保留 7 个被消费字段。
    expect(Object.keys(sample).sort()).toEqual(
      ['angle', 'id', 'mapId', 'name', 'type', 'x', 'y'],
    )
  })

  test('合成 envelope：四类节点与两类边被正确判别，业务元数据被丢弃', () => {
    const input = envelope(
      mapJsonWith(
        [
          baseNode({ id: 'n-node' }),
          workNode({ id: 'n-work' }),
          baseNode({ id: 'n-park', type: 'park', angle: 0 }),
          baseNode({ id: 'n-charge', type: 'charge', angle: -1.2 }),
        ],
        [
          baseLineEdge({ id: 'e-line', snodeId: 'n-node', enodeId: 'n-work' }),
          baseBezierEdge({ id: 'e-bezier', snodeId: 'n-work', enodeId: 'n-park' }),
        ],
      ),
    )
    const map = parseSampleEnvelope(input)

    expect(map.nodes).toHaveLength(4)
    expect(map.edges).toHaveLength(2)
    expect(map.nodes.map((n) => n.type).sort()).toEqual(['charge', 'node', 'park', 'work'])
    const line = map.edges.find((e) => e.edgeType === 'LINE')!
    const bezier = map.edges.find((e) => e.edgeType === 'BEZIER')!
    expect(line.cx).toBeNull()
    expect(bezier.cx).toBe(0.3)

    // 业务字段被丢弃。
    const node = map.nodes[0] as RawNode
    expect(node).not.toHaveProperty('actions')
  })
})

describe('解析边界 · 响应包异常 MAP_ENVELOPE_INVALID（TASK-003）', () => {
  test('根值为 null', () => {
    const err = captureError(() => parseSampleEnvelope(null))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toBe('$')
    expectChineseMessage(err)
  })

  test('根值为数组', () => {
    const err = captureError(() => parseSampleEnvelope([1, 2, 3]))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toBe('$')
  })

  test('code 缺失', () => {
    const input = envelope(mapJsonWith([baseNode()]))
    delete (input as Record<string, unknown>).code
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('code')
  })

  test('code 不等于 200', () => {
    const input = envelope(mapJsonWith([baseNode()]))
    ;(input as { code: number }).code = 404
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('code')
  })

  test('code 为数字字符串 200（严格数值相等）', () => {
    const input = envelope(mapJsonWith([baseNode()]))
    ;(input as Record<string, unknown>).code = '200'
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
  })

  test('message 不等于 success', () => {
    const input = envelope(mapJsonWith([baseNode()]))
    ;(input as { message: string }).message = 'failure'
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('message')
  })

  test('提取路径 data 缺失', () => {
    const err = captureError(() =>
      parseSampleEnvelope({ code: 200, message: 'success' }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('data')
  })

  test('提取路径 data 为数组', () => {
    const err = captureError(() =>
      parseSampleEnvelope({ code: 200, message: 'success', data: [] }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('data')
  })

  test('currentMapInfoVersion 缺失', () => {
    const err = captureError(() =>
      parseSampleEnvelope({ code: 200, message: 'success', data: {} }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('currentMapInfoVersion')
  })

  test('mapJson 缺失', () => {
    const err = captureError(() =>
      parseSampleEnvelope({
        code: 200,
        message: 'success',
        data: {
          currentMapInfoVersion: { mapId: 'm', mapName: 'n', mapVersion: 'V1' },
        },
      }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('mapJson')
  })

  test('mapJson 为字符串（禁止二次 JSON.parse）', () => {
    const err = captureError(() =>
      parseSampleEnvelope({
        code: 200,
        message: 'success',
        data: {
          currentMapInfoVersion: {
            mapId: 'm',
            mapName: 'n',
            mapVersion: 'V1',
            mapJson: '{"nodes":[]}',
          },
        },
      }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('mapJson')
  })

  test('mapJson 为数组', () => {
    const err = captureError(() =>
      parseSampleEnvelope({
        code: 200,
        message: 'success',
        data: {
          currentMapInfoVersion: {
            mapId: 'm',
            mapName: 'n',
            mapVersion: 'V1',
            mapJson: [],
          },
        },
      }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
  })

  test('集合字段 nodes 非数组', () => {
    const input = envelope({
      nodes: { not: 'array' },
      edges: [],
      zones: [],
      nodeEdgeGroups: [],
    })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('nodes')
  })

  test('集合字段 edges 缺失', () => {
    const input = envelope({ nodes: [], zones: [], nodeEdgeGroups: [] })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('edges')
  })

  test('集合字段 zones 非数组', () => {
    const input = envelope({
      nodes: [baseNode()],
      edges: [],
      zones: 'not-array',
      nodeEdgeGroups: [],
    })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('zones')
  })

  test('集合字段 nodeEdgeGroups 非数组', () => {
    const input = envelope({
      nodes: [baseNode()],
      edges: [],
      zones: [],
      nodeEdgeGroups: 42,
    })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('nodeEdgeGroups')
  })

  test('地图元数据 mapId 为空字符串', () => {
    const input = envelope(mapJsonWith([baseNode()]), { mapId: '' })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('mapId')
  })

  test('地图元数据 mapName 缺失', () => {
    const input = envelope(mapJsonWith([baseNode()]), { mapName: undefined })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('mapName')
  })

  test('地图元数据 mapVersion 类型错误', () => {
    const input = envelope(mapJsonWith([baseNode()]), { mapVersion: 123 })
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENVELOPE_INVALID)
    expect(err.jsonPath).toContain('mapVersion')
  })
})

describe('解析边界 · 实体字段异常 MAP_ENTITY_INVALID（TASK-003）', () => {
  test('未知节点类型（无默认样式）', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', type: 'warehouse' })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('type')
    expect(err.entityId).toBe('x1')
    expectChineseMessage(err)
  })

  test('节点 id 为空字符串', () => {
    const input = envelope(mapJsonWith([baseNode({ id: '' })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.id')
  })

  test('节点 id 类型错误（数字）', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 42 })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.id')
  })

  test('节点 name 为空字符串', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', name: '' })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.name')
    expect(err.entityId).toBe('x1')
  })

  test('节点 mapId 缺失', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', mapId: undefined })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('mapId')
  })

  test('节点 x 为数字字符串（禁止）', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', x: '1.2' })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.x')
  })

  test('节点 y 为 NaN', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', y: NaN })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.y')
  })

  test('节点 x 为 Infinity', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', x: Infinity })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.x')
  })

  test('普通 node 的 angle 不为 null', () => {
    const input = envelope(mapJsonWith([baseNode({ id: 'x1', type: 'node', angle: 1.5 })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.angle')
    expect(err.entityId).toBe('x1')
  })

  test('work 节点的 angle 为 null（必须有限）', () => {
    const input = envelope(mapJsonWith([workNode({ id: 'x1', angle: null })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.angle')
  })

  test('work 节点的 angle 为 NaN', () => {
    const input = envelope(mapJsonWith([workNode({ id: 'x1', angle: NaN })]))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.angle')
  })

  test('未知边类型', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', edgeType: 'ARC' }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('edgeType')
    expect(err.entityId).toBe('e1')
  })

  test('边 isBackEdge 为字符串（类型错误）', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', isBackEdge: 'true' }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('isBackEdge')
  })

  test('边 sx 为数字字符串', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', sx: '0' }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.sx')
  })

  test('边 snodeId 为空字符串', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', snodeId: '' }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('snodeId')
  })

  test('LINE 边控制字段非空（cx = 0）', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', cx: 0 }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.cx')
    expect(err.entityId).toBe('e1')
  })

  test('LINE 边控制字段为 undefined（必须显式 null）', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseLineEdge({ id: 'e1', cy: undefined }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.cy')
  })

  test('BEZIER 边控制字段为 null', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseBezierEdge({ id: 'e1', cx: null }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.cx')
  })

  test('BEZIER 边控制字段部分为空（cx 有限，cy 为 null）', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseBezierEdge({ id: 'e1', cy: null }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.cy')
  })

  test('BEZIER 边控制字段为 NaN', () => {
    const input = envelope(
      mapJsonWith([baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' })], [
        baseBezierEdge({ id: 'e1', dx: NaN }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('.dx')
  })

  test('节点 ID 重复（第二次出现位置报错）', () => {
    const input = envelope(
      mapJsonWith([
        baseNode({ id: 'dup' }),
        baseNode({ id: 'dup', name: 'B' }),
      ]),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('[1].id')
    expect(err.entityId).toBe('dup')
  })

  test('边 ID 重复', () => {
    const input = envelope(
      mapJsonWith(
        [baseNode({ id: 'n1' }), baseNode({ id: 'n2', name: 'B' }), baseNode({ id: 'n3', name: 'C' })],
        [
          baseLineEdge({ id: 'dup', snodeId: 'n1', enodeId: 'n2' }),
          baseLineEdge({ id: 'dup', snodeId: 'n2', enodeId: 'n3' }),
        ],
      ),
    )
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
    expect(err.jsonPath).toContain('edges[1].id')
    expect(err.entityId).toBe('dup')
  })

  test('边对象本身非对象', () => {
    const input = envelope(mapJsonWith([baseNode()], ['not-an-object']))
    const err = captureError(() => parseSampleEnvelope(input))
    expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
  })
})

describe('解析边界 · 纯逻辑单元（TASK-003，SPEC 15.2）', () => {
  test('parseRawNode：合法 node 返回受校验 RawNode 并丢弃业务字段', () => {
    const node = parseRawNode(baseNode({ id: 'n1' }), '$.nodes[0]') as Record<string, unknown>
    expect(node.id).toBe('n1')
    expect(node.type).toBe('node')
    expect(node.angle).toBeNull()
    expect(node).not.toHaveProperty('actions')
  })

  test('parseRawEdge：LINE 判别联合形态正确', () => {
    const edge = parseRawEdge(baseLineEdge({ id: 'e1' }), '$.edges[0]')
    expect(edge.edgeType).toBe('LINE')
    expect(edge.cx).toBeNull()
    expect(edge.cy).toBeNull()
    expect(edge.dx).toBeNull()
    expect(edge.dy).toBeNull()
  })

  test('parseRawEdge：BEZIER 判别联合形态正确', () => {
    const edge = parseRawEdge(baseBezierEdge({ id: 'e1' }), '$.edges[0]')
    expect(edge.edgeType).toBe('BEZIER')
    expect(edge.cx).toBe(0.3)
    expect(edge.dx).toBe(0.6)
  })

  test('parseRawEdge：LINE 与 BEZIER 是不同判别分支', () => {
    const line = parseRawEdge(baseLineEdge(), '$.edges[0]')
    const bezier = parseRawEdge(baseBezierEdge(), '$.edges[1]')
    expect(line.edgeType).not.toBe(bezier.edgeType)
  })
})
