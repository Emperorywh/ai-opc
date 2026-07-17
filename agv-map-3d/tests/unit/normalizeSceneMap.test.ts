/*
 * 一次性坐标转换自动化验证（TASK-005，SPEC 2.3 / 5.2 / 6.1 / 6.2 / 15.2 / 16）。
 *
 * 设计：
 *   - 真实样本走完整可信链 parse → validate → normalize，校验 origin 推导、场景居中、
 *     一米一世界单位、端点事实来源与三个固定坐标例子。
 *   - 单次转换不变量通过“逐实体断言 scene 坐标恰等于 toScenePoint(raw, transform)
 *     的一次应用”证明：重复取负、重复平移、把 z 再解释为地图 y 或写入前舍入的实现
 *     都会使该断言失败。
 *   - 合成 RawMap 用于精确数值与异常路径：非有限坐标、退化 source bounds、绕过可信输入。
 *   - 不可变性：SceneMap 与 RawMap 不共享可变引用。
 *
 * 不启动浏览器：真实样本在 node 环境直接读取；不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import {
  normalizeSceneMap,
  toScenePoint,
  computeSourceBounds,
  buildMapTransform,
} from '../../src/adapters/normalizeSceneMap'
import { MapDataError, MapErrorCode, isMapDataError } from '../../src/domain/mapDataError'
import type {
  MapTransform,
  SceneBezierEdge,
  SceneEdge,
  SceneLineEdge,
  SceneMap,
  SceneNode,
} from '../../src/domain/sceneMap'
import type {
  RawBezierEdge,
  RawEdge,
  RawLineEdge,
  RawMap,
  RawNode,
} from '../../src/adapters/rawMap'
import {
  SAMPLE_BOUNDS,
  FIXED_ENTITIES,
} from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// beforeAll 完成后赋值；vitest 保证测试在 beforeAll 成功后才运行。
let rawMap!: RawMap
let sceneMap!: SceneMap

beforeAll(() => {
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  rawMap = parseSampleEnvelope(rawJson)
  // 实体级语义必须先通过，才可交给一次性坐标转换（SPEC 数据流）。
  validateMapSemantics(rawMap)
  sceneMap = normalizeSceneMap(rawMap)
})

// --- 测试夹具：合成 RawMap 构造器，用于精确数值与异常路径。 ---

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
  metadata?: Partial<RawMap['metadata']>
} = {}): RawMap {
  const nodes = args.nodes ?? [
    makeNode({ id: 'n1', x: 0, y: 0 }),
    makeNode({ id: 'n2', x: 1, y: 0, name: 'B' }),
  ]
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
    zones: [],
    nodeEdgeGroups: [],
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

// 在 scene map 中按 ID 查找节点 / 边（不依赖数组下标）。
function findSceneNode(id: string): SceneNode {
  const n = sceneMap.nodes.find((node) => node.id === id)
  if (!n) throw new Error(`场景节点 ${id} 未找到`)
  return n
}
function findSceneEdge(id: string): SceneEdge {
  const e = sceneMap.edges.find((edge) => edge.id === id)
  if (!e) throw new Error(`场景边 ${id} 未找到`)
  return e
}

describe('一次性坐标转换 · 真实样本 origin 推导（SPEC 6.1）', () => {
  test('source bounds 由全部节点、边端点与贝塞尔控制点计算', () => {
    // 直接在 rawMap 上推导 source bounds，并与 SceneMap 保留的诊断 bounds 深度相等。
    const bounds = computeSourceBounds(rawMap)
    expect(bounds).toStrictEqual(sceneMap.sourceBounds)
    expect(bounds.minX).toBeCloseTo(SAMPLE_BOUNDS.minX, 2)
    expect(bounds.maxX).toBeCloseTo(SAMPLE_BOUNDS.maxX, 2)
    expect(bounds.minY).toBeCloseTo(SAMPLE_BOUNDS.minY, 2)
    expect(bounds.maxY).toBeCloseTo(SAMPLE_BOUNDS.maxY, 2)
  })

  test('场景原点（绝对世界）推导为 (-81.82, 0, -12.54)', () => {
    // absoluteWorldOriginX = bounds 中心 mapX；absoluteWorldOriginZ = -(bounds 中心 mapY)。
    expect(sceneMap.transform.absoluteWorldOriginX).toBeCloseTo(SAMPLE_BOUNDS.centerX, 2)
    expect(sceneMap.transform.absoluteWorldOriginX).toBeCloseTo(-81.82, 2)
    expect(sceneMap.transform.absoluteWorldOriginZ).toBeCloseTo(-SAMPLE_BOUNDS.centerY, 2)
    expect(sceneMap.transform.absoluteWorldOriginZ).toBeCloseTo(-12.54, 2)
  })

  test('原点由 bounds 派生，禁止魔法数：buildMapTransform 与 normalizeSceneMap 一致', () => {
    const expected = buildMapTransform(computeSourceBounds(rawMap))
    expect(sceneMap.transform.absoluteWorldOriginX).toBeCloseTo(expected.absoluteWorldOriginX, 10)
    expect(sceneMap.transform.absoluteWorldOriginZ).toBeCloseTo(expected.absoluteWorldOriginZ, 10)
  })
})

describe('一次性坐标转换 · 三个固定坐标例子（SPEC 6.2）', () => {
  test('普通节点 (0.16,-21.29) → (81.98,33.83)', () => {
    const raw = rawMap.nodes.find((n) => n.id === FIXED_ENTITIES.normalNode.id)!
    const sn = findSceneNode(FIXED_ENTITIES.normalNode.id)
    // 单次转换：scene 坐标恰等于 toScenePoint 的一次应用。
    expect(sn.position).toEqual(toScenePoint(raw.x, raw.y, sceneMap.transform))
    // SPEC 6.2 固定显示值（toBeCloseTo 容差比较，不在领域数据中取整）。
    expect(sn.position.x).toBeCloseTo(81.98, 2)
    expect(sn.position.z).toBeCloseTo(33.83, 2)
  })

  test('中文充电节点 (-139.35,13.60) → (-57.53,-1.06)', () => {
    const raw = rawMap.nodes.find((n) => n.id === FIXED_ENTITIES.chineseChargeNode.id)!
    const sn = findSceneNode(FIXED_ENTITIES.chineseChargeNode.id)
    expect(sn.position).toEqual(toScenePoint(raw.x, raw.y, sceneMap.transform))
    expect(sn.position.x).toBeCloseTo(-57.53, 2)
    expect(sn.position.z).toBeCloseTo(-1.06, 2)
  })

  test('直线起点 (-1.82,-21.30) → (80.00,33.84)', () => {
    const raw = rawMap.edges.find((e) => e.id === FIXED_ENTITIES.lineEdge.id)!
    const se = findSceneEdge(FIXED_ENTITIES.lineEdge.id) as SceneLineEdge
    expect(se.kind).toBe('line')
    // 边端点使用边自身坐标（非引用节点），且只经 toScenePoint 一次。
    expect(se.start).toEqual(toScenePoint(raw.sx, raw.sy, sceneMap.transform))
    expect(se.start.x).toBeCloseTo(80.0, 2)
    expect(se.start.z).toBeCloseTo(33.84, 2)
  })
})

describe('一次性坐标转换 · 场景居中与一米一世界单位（SPEC 6.1）', () => {
  // 由场景节点 + 边端点 + 贝塞尔控制点推导场景坐标 bounds（与 source bounds 同口径）。
  function sceneBounds() {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    const acc = (x: number, z: number) => {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    for (const n of sceneMap.nodes) acc(n.position.x, n.position.z)
    for (const e of sceneMap.edges) {
      acc(e.start.x, e.start.z)
      acc(e.end.x, e.end.z)
      if (e.kind === 'cubic') {
        acc(e.control1.x, e.control1.z)
        acc(e.control2.x, e.control2.z)
      }
    }
    return { minX, maxX, minZ, maxZ }
  }

  test('转换后 bounds 以原点为中心', () => {
    const b = sceneBounds()
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 2)
    expect((b.minZ + b.maxZ) / 2).toBeCloseTo(0, 2)
  })

  test('转换后基准范围 ≈ sceneX ∈ [-83.92,83.92]、sceneZ ∈ [-37.66,37.66]', () => {
    const b = sceneBounds()
    expect(b.minX).toBeCloseTo(-83.92, 2)
    expect(b.maxX).toBeCloseTo(83.92, 2)
    expect(b.minZ).toBeCloseTo(-37.66, 2)
    expect(b.maxZ).toBeCloseTo(37.66, 2)
  })

  test('一米仍等于一个世界单位：宽度与深度不变（等距变换）', () => {
    const b = sceneBounds()
    const sb = sceneMap.sourceBounds
    // 重心平移 + y→-z 翻转均为等距变换，宽深不改变。
    expect(b.maxX - b.minX).toBeCloseTo(sb.maxX - sb.minX, 6)
    expect(b.maxZ - b.minZ).toBeCloseTo(sb.maxY - sb.minY, 6)
  })

  test('两节点间距离在转换前后保持（无尺度畸变）', () => {
    const a = rawMap.nodes.find((n) => n.id === FIXED_ENTITIES.normalNode.id)!
    const b = rawMap.nodes.find((n) => n.id === FIXED_ENTITIES.chineseChargeNode.id)!
    const mapDist = Math.hypot(a.x - b.x, a.y - b.y)
    const sa = findSceneNode(FIXED_ENTITIES.normalNode.id).position
    const sb = findSceneNode(FIXED_ENTITIES.chineseChargeNode.id).position
    const sceneDist = Math.hypot(sa.x - sb.x, sa.z - sb.z)
    expect(sceneDist).toBeCloseTo(mapDist, 6)
  })
})

describe('一次性坐标转换 · 边端点事实来源（SPEC 2.3 / 6.1）', () => {
  test('最大端点偏差样例转换后差异保持，证明未用节点坐标覆盖', () => {
    // 固定偏差边：边终点 (-120.32,-1.35)，引用节点 (-120.35,-1.35)，地图系偏差 0.030m。
    const rawEdge = rawMap.edges.find((e) => e.id === FIXED_ENTITIES.maxDeviationEdge.id)!
    const rawNode = rawMap.nodes.find((n) => n.id === rawEdge.enodeId)!
    const mapDev = Math.hypot(rawEdge.ex - rawNode.x, rawEdge.ey - rawNode.y)
    expect(mapDev).toBeCloseTo(0.03, 2)

    const se = findSceneEdge(FIXED_ENTITIES.maxDeviationEdge.id) as SceneLineEdge
    const sn = findSceneNode(rawEdge.enodeId)
    // 场景系偏差必须与地图系偏差一致（等距变换）。
    const sceneDev = Math.hypot(se.end.x - sn.position.x, se.end.z - sn.position.z)
    expect(sceneDev).toBeCloseTo(mapDev, 6)
    expect(sceneDev).toBeCloseTo(0.03, 2)
    // 边端点没有被节点坐标覆盖：二者在场景系中仍不同。
    expect(se.end.x).not.toBe(sn.position.x)
  })

  test('贝塞尔边控制点使用边自身坐标一次性转换', () => {
    const raw = rawMap.edges.find((e) => e.id === FIXED_ENTITIES.bezierEdge.id) as RawBezierEdge
    const se = findSceneEdge(FIXED_ENTITIES.bezierEdge.id) as SceneBezierEdge
    expect(se.kind).toBe('cubic')
    expect(se.start).toEqual(toScenePoint(raw.sx, raw.sy, sceneMap.transform))
    expect(se.control1).toEqual(toScenePoint(raw.cx, raw.cy, sceneMap.transform))
    expect(se.control2).toEqual(toScenePoint(raw.dx, raw.dy, sceneMap.transform))
    expect(se.end).toEqual(toScenePoint(raw.ex, raw.ey, sceneMap.transform))
  })
})

describe('一次性坐标转换 · 单次转换不变量（SPEC 6.2）', () => {
  test('每个场景节点坐标恰等于 toScenePoint 的一次应用', () => {
    // 该断言会因重复取负、重复平移、把 z 当作地图 y 或写入前舍入的实现而失败。
    const t = sceneMap.transform
    expect(sceneMap.nodes.length).toBe(rawMap.nodes.length)
    for (let i = 0; i < rawMap.nodes.length; i++) {
      const raw = rawMap.nodes[i]
      const sn = sceneMap.nodes[i]
      expect(sn.position).toEqual(toScenePoint(raw.x, raw.y, t))
      // 节点元数据不被坐标转换影响。
      expect(sn.id).toBe(raw.id)
      expect(sn.name).toBe(raw.name)
      expect(sn.type).toBe(raw.type)
      expect(sn.angle).toBe(raw.angle)
    }
  })

  test('每条场景边端点与控制点恰等于 toScenePoint 的一次应用', () => {
    const t = sceneMap.transform
    expect(sceneMap.edges.length).toBe(rawMap.edges.length)
    for (let i = 0; i < rawMap.edges.length; i++) {
      const raw = rawMap.edges[i]
      const se = sceneMap.edges[i]
      expect(se.start).toEqual(toScenePoint(raw.sx, raw.sy, t))
      expect(se.end).toEqual(toScenePoint(raw.ex, raw.ey, t))
      expect(se.id).toBe(raw.id)
      expect(se.startNodeId).toBe(raw.snodeId)
      expect(se.endNodeId).toBe(raw.enodeId)
      expect(se.isBackEdge).toBe(raw.isBackEdge)
      if (raw.edgeType === 'LINE') {
        expect(se.kind).toBe('line')
      } else {
        const bz = se as SceneBezierEdge
        expect(bz.kind).toBe('cubic')
        expect(bz.control1).toEqual(toScenePoint(raw.cx, raw.cy, t))
        expect(bz.control2).toEqual(toScenePoint(raw.dx, raw.dy, t))
      }
    }
  })

  test('原始地图 y 不穿透到场景坐标：场景点只有 x/z', () => {
    // 结构性证据：ScenePoint 只含 x/z，节点位置不含任何 mapY 残留字段。
    const sn = sceneMap.nodes[0]
    expect(Object.keys(sn.position).sort()).toEqual(['x', 'z'])
  })

  test('合成地图精确数值：验证轴映射方向（非交换、非双取负）', () => {
    // 构造已知 bounds 的合成地图，断言精确场景坐标，捕获任何轴交换或重复变换。
    const map = makeRawMap({
      nodes: [
        makeNode({ id: 'n1', x: 0, y: 0 }),
        makeNode({ id: 'n2', x: 10, y: 0, name: 'B' }),
        makeNode({ id: 'n3', x: 0, y: 10, name: 'C', type: 'work', angle: 0.5 }),
      ],
      edges: [
        makeLineEdge({ id: 'e1', snodeId: 'n1', enodeId: 'n2', sx: 0, sy: 0, ex: 10, ey: 0 }),
        makeBezierEdge({
          id: 'e2',
          snodeId: 'n1',
          enodeId: 'n3',
          sx: 0,
          sy: 0,
          cx: 0,
          cy: 4,
          dx: 6,
          dy: 10,
          ex: 0,
          ey: 10,
        }),
      ],
    })
    // source bounds: x∈[0,10], y∈[0,10]（节点/端点/控制点均在范围内）。
    // 中心 mapX=5, mapY=5 → origin={X:5, Z:-5}。
    const sm = normalizeSceneMap(map)
    expect(sm.transform.absoluteWorldOriginX).toBeCloseTo(5, 10)
    expect(sm.transform.absoluteWorldOriginZ).toBeCloseTo(-5, 10)

    // n1(0,0) → sceneX=0-5=-5, sceneZ=-0-(-5)=5。
    expect(sm.nodes[0].position.x).toBeCloseTo(-5, 10)
    expect(sm.nodes[0].position.z).toBeCloseTo(5, 10)
    // n3(0,10) → sceneX=-5, sceneZ=-10+5=-5。
    expect(sm.nodes[2].position.x).toBeCloseTo(-5, 10)
    expect(sm.nodes[2].position.z).toBeCloseTo(-5, 10)

    // 贝塞尔控制点 (0,4) → scene(-5, 1)；(6,10) → scene(1, -5)。
    const bz = sm.edges[1] as SceneBezierEdge
    expect(bz.kind).toBe('cubic')
    expect(bz.control1.x).toBeCloseTo(-5, 10)
    expect(bz.control1.z).toBeCloseTo(1, 10)
    expect(bz.control2.x).toBeCloseTo(1, 10)
    expect(bz.control2.z).toBeCloseTo(-5, 10)
  })
})

describe('一次性坐标转换 · 元数据与诊断（SPEC 5.2 / 6.2）', () => {
  test('元数据只读下沉，envelopeMapId 不形成第二套身份来源', () => {
    expect(sceneMap.metadata.mapId).toBe(rawMap.metadata.mapId)
    expect(sceneMap.metadata.mapName).toBe(rawMap.metadata.mapName)
    expect(sceneMap.metadata.version).toBe(rawMap.metadata.version)
    // SceneMapMetadata 不保留 envelopeMapId（仅用于 TASK-004 全链路校验）。
    expect(Object.keys(sceneMap.metadata).sort()).toEqual(['mapId', 'mapName', 'version'])
  })

  test('source bounds 与 transform 作为只读诊断信息保留', () => {
    expect(Object.keys(sceneMap.sourceBounds).sort()).toEqual(['maxX', 'maxY', 'minX', 'minY'])
    expect(Object.keys(sceneMap.transform).sort()).toEqual([
      'absoluteWorldOriginX',
      'absoluteWorldOriginZ',
    ])
  })

  test('全部场景坐标为有限数（不输出 NaN/Infinity）', () => {
    for (const n of sceneMap.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true)
      expect(Number.isFinite(n.position.z)).toBe(true)
    }
    for (const e of sceneMap.edges) {
      expect(Number.isFinite(e.start.x)).toBe(true)
      expect(Number.isFinite(e.start.z)).toBe(true)
      expect(Number.isFinite(e.end.x)).toBe(true)
      expect(Number.isFinite(e.end.z)).toBe(true)
      if (e.kind === 'cubic') {
        expect(Number.isFinite(e.control1.x)).toBe(true)
        expect(Number.isFinite(e.control1.z)).toBe(true)
        expect(Number.isFinite(e.control2.x)).toBe(true)
        expect(Number.isFinite(e.control2.z)).toBe(true)
      }
    }
  })
})

describe('一次性坐标转换 · 不可变性（SPEC 5.2 / 6.2）', () => {
  test('SceneMap 与 RawMap 不共享节点 / 边集合引用', () => {
    expect(sceneMap.nodes).not.toBe(rawMap.nodes)
    expect(sceneMap.edges).not.toBe(rawMap.edges)
    expect(sceneMap.nodes[0]).not.toBe(rawMap.nodes[0])
    expect(sceneMap.nodes[0].position).not.toBe(rawMap.nodes[0])
  })

  test('转换后修改原始 RawMap 不影响 SceneMap（深隔离）', () => {
    const map = makeRawMap()
    const sm = normalizeSceneMap(map)
    const before = { x: sm.nodes[0].position.x, z: sm.nodes[0].position.z }
    // 运行时改写 RawMap 字段（readonly 仅编译期约束），SceneMap 必须不受影响。
    ;(map.nodes[0] as { x: number }).x = 999
    expect(sm.nodes[0].position.x).toBe(before.x)
    expect(sm.nodes[0].position.z).toBe(before.z)
  })
})

describe('一次性坐标转换 · 异常路径（SPEC 5.3 / 14.1）', () => {
  test('节点含非有限坐标 → MAP_GEOMETRY_INVALID（不输出 NaN）', () => {
    const map = makeRawMap({
      nodes: [
        makeNode({ id: 'n1', x: 0, y: 0 }),
        makeNode({ id: 'n2', x: Number.NaN, y: 0, name: 'B' }),
      ],
    })
    const err = captureError(() => normalizeSceneMap(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.jsonPath).toContain('nodes')
    expect(err.message).toMatch(/[一-鿿]/)
  })

  test('边端点含 Infinity → MAP_GEOMETRY_INVALID', () => {
    const map = makeRawMap({
      edges: [
        makeLineEdge({
          snodeId: 'n1',
          enodeId: 'n2',
          sx: 0,
          sy: 0,
          ex: Number.POSITIVE_INFINITY,
          ey: 0,
        }),
      ],
    })
    const err = captureError(() => normalizeSceneMap(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
  })

  test('贝塞尔控制点含非有限数 → MAP_GEOMETRY_INVALID', () => {
    const map = makeRawMap({
      edges: [
        makeBezierEdge({
          snodeId: 'n1',
          enodeId: 'n2',
          sx: 0,
          sy: 0,
          cx: Number.NaN,
          cy: 0,
          dx: 0.6,
          dy: 0,
          ex: 1,
          ey: 0,
        }),
      ],
    })
    const err = captureError(() => normalizeSceneMap(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
  })

  test('退化 source bounds（空节点且空边）→ MAP_GEOMETRY_INVALID', () => {
    const map = makeRawMap({ nodes: [], edges: [] })
    const err = captureError(() => normalizeSceneMap(map))
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.message).toMatch(/退化/)
  })

  test('computeSourceBounds 对非有限坐标稳定失败（绕过可信输入的兜底）', () => {
    // 直接调用 computeSourceBounds，证明即便绕过 normalizeSceneMap 编排，
    // 非有限坐标仍以 MAP_GEOMETRY_INVALID 明确失败，不返回 NaN bounds。
    const err = captureError(() =>
      computeSourceBounds(
        makeRawMap({
          nodes: [makeNode({ id: 'n1', x: Number.NaN, y: 0 })],
        }),
      ),
    )
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
  })

  test('buildMapTransform 对 (minX+maxX) 溢出为 Infinity 的 bounds 稳定失败', () => {
    // MAX_VALUE 自身有限，但相加溢出为 Infinity，中心非有限 → 必须明确失败。
    const err = captureError(() =>
      buildMapTransform({
        minX: Number.MAX_VALUE,
        maxX: Number.MAX_VALUE,
        minY: 0,
        maxY: 0,
      }),
    )
    expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    expect(err.message).toMatch(/场景原点非有限|溢出/)
  })

  test('toScenePoint 不校验 origin 有限性，但 origin 由 buildMapTransform 保证有限', () => {
    // 契约说明：toScenePoint 是纯转换，不重复校验；调用方负责 origin 有限。
    // 这里验证正常调用产出有限、精确的坐标。
    const origin: MapTransform = { absoluteWorldOriginX: 5, absoluteWorldOriginZ: -5 }
    expect(toScenePoint(0, 0, origin)).toEqual({ x: -5, z: 5 })
    expect(toScenePoint(10, 10, origin)).toEqual({ x: 5, z: -5 })
  })
})

describe('一次性坐标转换 · 整体拒绝（无部分输出）', () => {
  test('任一坐标非有限时，normalizeSceneMap 整体失败，不返回部分 SceneMap', () => {
    const map = makeRawMap({
      nodes: [
        makeNode({ id: 'n1', x: 0, y: 0 }),
        makeNode({ id: 'n2', x: 1, y: 0, name: 'B' }),
        makeNode({ id: 'n3', x: Number.NaN, y: 0, name: 'C' }),
      ],
    })
    expect(() => normalizeSceneMap(map)).toThrow(MapDataError)
  })
})
