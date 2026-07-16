import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_PATH_RIBBON_CONFIG,
  type PathRibbonConfig,
} from '../src/features/agv-map/config/geometryConfig'
import type { Point2 } from '../src/features/agv-map/domain/domainModel'
import type { PathGeometryPacket } from '../src/features/agv-map/domain/renderPacket'
import { groupLanes } from '../src/features/agv-map/geometry/laneGrouping'
import { GeometryCompileError, type SampledEdge } from '../src/features/agv-map/geometry/pathSampling'
import { compilePathGeometry, validatePathGeometry } from '../src/features/agv-map/geometry/pathRibbon'
import { computeMapSpace } from '../src/features/agv-map/geometry/worldCoords'
import { typedArrayBytesEqual } from './helpers/typedArrayBytes'
import { cubicAt } from './helpers/curveGeometry'

/** 构造采样边工厂。 */
function sampledEdge(id: string, source: string, target: string, points: Point2[]): SampledEdge {
  return { edgeId: id, sourceNodeId: source, targetNodeId: target, path: { points } }
}

/** 沿 x 轴的水平直线段。 */
function horizontalLine(length: number, yOffset = 0): Point2[] {
  return [
    { x: 0, y: yOffset },
    { x: length, y: yOffset },
  ]
}

/** 原点地图空间，便于断言世界坐标等价于 (x, h, -y)。 */
function originSpace() {
  return computeMapSpace([{ x: 0, y: 0 }], [])
}

/** 取第 edgeIdx 条边的顶点区间对应的世界位置对（近/远首点）。 */
function edgeFirstVertices(
  geometry: { positions: Float32Array; edgeVertexRanges: Uint32Array },
  edgeIdx: number,
): { near: [number, number, number]; far: [number, number, number] } {
  const start = geometry.edgeVertexRanges[edgeIdx * 2]
  const near: [number, number, number] = [
    geometry.positions[start * 3],
    geometry.positions[start * 3 + 1],
    geometry.positions[start * 3 + 2],
  ]
  const far: [number, number, number] = [
    geometry.positions[(start + 1) * 3],
    geometry.positions[(start + 1) * 3 + 1],
    geometry.positions[(start + 1) * 3 + 2],
  ]
  return { near, far }
}

describe('compilePathGeometry — 基础布局', () => {
  it('单向边沿自身中心线对称展开，带宽 0.22 m、离地 0.015 m', () => {
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', horizontalLine(10))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )

    // 单向边 2 点 → 2 横截面 → 4 顶点 → 2 三角形（6 索引）。
    expect(geometry.positions.length).toBe(4 * 3)
    expect(geometry.indices.length).toBe(6)
    expect(geometry.edgeVertexRanges).toEqual(new Uint32Array([0, 4]))

    const { near, far } = edgeFirstVertices(geometry, 0)
    // 中心线沿 +X，左法线 +Y；近侧 (0,-0.11,0.015→世界 z=0.11)、远侧 (0,0.11→z=-0.11)。
    // expandNear=-0.11、expandFar=+0.11；世界 z = -y。
    expect(near[0]).toBeCloseTo(0, 10)
    // Float32 存储精度约 1e-9，使用 6 位小数容差。
    expect(near[1]).toBeCloseTo(DEFAULT_PATH_RIBBON_CONFIG.ribbonHeightM, 6)
    expect(near[2]).toBeCloseTo(0.11, 6)
    expect(far[0]).toBeCloseTo(0, 10)
    expect(far[2]).toBeCloseTo(-0.11, 6)
  })

  it('双向边两条车道分居共享中心线两侧，中心间距 0.36 m', () => {
    const groups = groupLanes(
      [
        sampledEdge('e1', 'a', 'b', horizontalLine(10)),
        sampledEdge('e2', 'b', 'a', [...horizontalLine(10)].reverse()),
      ],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry, edgeIds } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )

    expect(edgeIds).toEqual(['e1', 'e2'])
    // 两条车道各 4 顶点，共 8 顶点。
    expect(geometry.positions.length).toBe(8 * 3)
    expect(geometry.edgeVertexRanges).toEqual(new Uint32Array([0, 4, 4, 8]))

    // 用每条车道首横截面两侧顶点的 z 均值作为车道中心。
    // 规范方向 e1：offsetSign +1 → 两侧 z ∈ {-0.29,-0.07}，中心 -0.18。
    const e1 = edgeFirstVertices(geometry, 0)
    const e1Center = (e1.near[2] + e1.far[2]) / 2
    expect(Math.min(e1.near[2], e1.far[2])).toBeCloseTo(-(0.18 + 0.11), 6)
    expect(Math.max(e1.near[2], e1.far[2])).toBeCloseTo(-(0.18 - 0.11), 6)
    expect(e1Center).toBeCloseTo(-0.18, 6)
    // 反方向 e2：offsetSign -1 → 两侧 z ∈ {0.07,0.29}，中心 +0.18。
    const e2 = edgeFirstVertices(geometry, 1)
    const e2Center = (e2.near[2] + e2.far[2]) / 2
    expect(Math.min(e2.near[2], e2.far[2])).toBeCloseTo(0.18 - 0.11, 6)
    expect(Math.max(e2.near[2], e2.far[2])).toBeCloseTo(0.18 + 0.11, 6)
    expect(e2Center).toBeCloseTo(0.18, 6)
    // 两条车道中心间距 = 0.36 m。
    expect(Math.abs(e1Center - e2Center)).toBeCloseTo(0.36, 6)
  })
})

describe('compilePathGeometry — 弧长与流向', () => {
  it('单向边 pathU 从 0 单调递增，flowDirection 恒 +1', () => {
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', horizontalLine(10))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 首横截面 pathU=0、末横截面 pathU=10；中间单调不减。
    expect(geometry.pathU[0]).toBe(0)
    expect(geometry.pathU[geometry.pathU.length - 1]).toBeCloseTo(10, 10)
    for (let i = 1; i < geometry.pathU.length; i += 1) {
      expect(geometry.pathU[i]).toBeGreaterThanOrEqual(geometry.pathU[i - 1])
    }
    for (let i = 0; i < geometry.flowDirections.length; i += 1) {
      expect(geometry.flowDirections[i]).toBe(1)
    }
  })

  it('双向边共享规范弧长坐标，规范车道流向 +1、反方向车道流向 -1', () => {
    const groups = groupLanes(
      [
        sampledEdge('e1', 'a', 'b', horizontalLine(10)),
        sampledEdge('e2', 'b', 'a', [...horizontalLine(10)].reverse()),
      ],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 规范车道 e1 占顶点 [0,4)，反方向 e2 占 [4,8)。
    // 两条车道共享中心线，pathU 序列应完全一致。
    for (let i = 0; i < 4; i += 1) {
      expect(geometry.pathU[i]).toBeCloseTo(geometry.pathU[i + 4], 10)
    }
    // e1 流向 +1、e2 流向 -1。
    for (let i = 0; i < 4; i += 1) expect(geometry.flowDirections[i]).toBe(1)
    for (let i = 4; i < 8; i += 1) expect(geometry.flowDirections[i]).toBe(-1)
  })

  it('贝塞尔折线的 pathU 按各段长度累计，端点弧长为曲线总长', () => {
    // 一条折线中心线：0,0 → 3,4 → 6,8，段长 5 + 5 = 10。
    const polyline = [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 6, y: 8 },
    ]
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', polyline)],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 找到最大 pathU（末横截面），应等于折线总长 10。
    const maxU = geometry.pathU.reduce((m, v) => (v > m ? v : m), 0)
    expect(maxU).toBeCloseTo(10, 10)
  })
})

describe('compilePathGeometry — 折角 miter/bevel', () => {
  /** 构造一个给定折角的等长两段折线，折点位于原点。angle 为偏离直线的半角（弧度）。 */
  function bentPath(angle: number, segLen = 5): Point2[] {
    // 入向 t1 角度 -angle、出向 t2 角度 +angle，转角 = 2*angle，关于 +x 对称。
    // point0 = origin - segLen·t1，point2 = origin + segLen·t2。
    return [
      { x: -segLen * Math.cos(angle), y: segLen * Math.sin(angle) },
      { x: 0, y: 0 },
      { x: segLen * Math.cos(angle), y: segLen * Math.sin(angle) },
    ]
  }

  it('温和折角使用 miter：折点只产生一份横截面', () => {
    // 折角 60°（半角 30°），miter 比例 = 1/cos(30°) ≈ 1.155 < 2。
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', bentPath(Math.PI / 6))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 3 原始点全部 miter/端点 → 3 横截面 → 6 顶点 → 2 Quad = 4 三角形 = 12 索引。
    expect(geometry.positions.length).toBe(6 * 3)
    expect(geometry.indices.length).toBe(12)
  })

  it('尖锐折角切换为 bevel：折点产生两份横截面，无尖刺', () => {
    // 折角接近 180°（半角 85°），miter 比例 = 1/cos(85°) ≈ 11.47 > 2，触发 bevel。
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', bentPath((85 * Math.PI) / 180))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 折点贡献 2 份横截面 → 总 4 横截面 → 8 顶点 → 3 Quad = 6 三角形 = 18 索引。
    expect(geometry.positions.length).toBe(8 * 3)
    expect(geometry.indices.length).toBe(18)
    // 全部位置有限（无 NaN/Infinity 尖刺）。
    for (let i = 0; i < geometry.positions.length; i += 1) {
      expect(Number.isFinite(geometry.positions[i])).toBe(true)
    }
  })

  it('bevel 缝合无裂缝：相邻横截面 Quad 索引连续覆盖全部顶点', () => {
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', bentPath((85 * Math.PI) / 180))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 每个顶点至少被一个三角形引用（无缝隙）。
    const referenced = new Set<number>()
    for (let i = 0; i < geometry.indices.length; i += 1) {
      referenced.add(geometry.indices[i])
    }
    const vertexCount = geometry.positions.length / 3
    for (let v = 0; v < vertexCount; v += 1) {
      expect(referenced.has(v), `顶点 ${v} 未被任何三角形引用`).toBe(true)
    }
  })

  it('miter 上限参数生效：调低阈值使温和折角也走 bevel', () => {
    const strictRibbon: PathRibbonConfig = {
      ...DEFAULT_PATH_RIBBON_CONFIG,
      miterLimitRatio: 1.05, // 30° 半角比例 ≈ 1.155 也会超过。
    }
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', bentPath(Math.PI / 6))],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      strictRibbon,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 折点切到 bevel → 4 横截面 → 8 顶点。
    expect(geometry.positions.length).toBe(8 * 3)
  })
})

describe('compilePathGeometry — 平滑曲线（SPEC §7.5、TASK-004 曲线覆盖）', () => {
  /**
   * 对三次贝塞尔等参数采样 count 个点，模拟采样器对 BEZIER 的输出（SPEC §7.3）。
   * 采用平缓 S 曲线（控制点单调递增），相邻段转角远小于 120° bevel 阈值，
   * 使全部内部点使用 miter，便于断言横截面计数。
   */
  function sampleCubicPoints(
    p0: Point2,
    p1: Point2,
    p2: Point2,
    p3: Point2,
    count: number,
  ): Point2[] {
    const pts: Point2[] = []
    for (let i = 0; i < count; i += 1) {
      pts.push(cubicAt(p0, p1, p2, p3, i / (count - 1)))
    }
    return pts
  }

  /** 平缓 S 曲线的 21 点采样。 */
  function smoothCurve(): Point2[] {
    return sampleCubicPoints(
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 7, y: 4 },
      { x: 10, y: 0 },
      21,
    )
  }

  it('平滑曲线全部使用 miter：顶点数 = 2×采样点数，无 bevel 触发', () => {
    const curve = smoothCurve()
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', curve)],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 21 点全部 miter/端点 → 21 横截面 → 42 顶点 → 20 Quad = 40 三角形 = 120 索引。
    expect(geometry.positions.length).toBe(42 * 3)
    expect(geometry.indices.length).toBe(120)
    // 全部位置有限（无 NaN/Infinity）。
    for (let i = 0; i < geometry.positions.length; i += 1) {
      expect(Number.isFinite(geometry.positions[i])).toBe(true)
    }
  })

  it('平滑曲线 pathU 按各段折线长度累计，末值等于折线总长', () => {
    const curve = smoothCurve()
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', curve)],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 首横截面 pathU = 0。
    expect(geometry.pathU[0]).toBe(0)
    // 独立累计折线总长（双精度），与 Float32 存储的末顶点弧长比较（容差 1e-5）。
    let totalLen = 0
    for (let i = 1; i < curve.length; i += 1) {
      totalLen += Math.hypot(curve[i].x - curve[i - 1].x, curve[i].y - curve[i - 1].y)
    }
    expect(Math.abs(geometry.pathU[geometry.pathU.length - 1] - totalLen)).toBeLessThan(1e-5)
    // 全程单调不减。
    for (let i = 1; i < geometry.pathU.length; i += 1) {
      expect(geometry.pathU[i]).toBeGreaterThanOrEqual(geometry.pathU[i - 1] - 1e-9)
    }
  })

  it('平滑曲线全部顶点被引用、索引不越界、流向恒 +1', () => {
    const curve = sampleCubicPoints(
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      { x: 7, y: 4 },
      { x: 10, y: 0 },
      15,
    )
    const groups = groupLanes(
      [sampledEdge('e1', 'a', 'b', curve)],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const vertexCount = geometry.positions.length / 3
    const referenced = new Set<number>()
    for (let i = 0; i < geometry.indices.length; i += 1) {
      expect(geometry.indices[i]).toBeGreaterThanOrEqual(0)
      expect(geometry.indices[i]).toBeLessThan(vertexCount)
      referenced.add(geometry.indices[i])
    }
    for (let v = 0; v < vertexCount; v += 1) {
      expect(referenced.has(v), `顶点 ${v} 未被引用`).toBe(true)
    }
    for (let i = 0; i < geometry.flowDirections.length; i += 1) {
      expect(geometry.flowDirections[i]).toBe(1)
    }
  })
})

describe('compilePathGeometry — 合并性与逐边定位', () => {
  it('多条边合并为单一缓冲，edgeVertexRanges 逐边不相交覆盖', () => {
    const groups = groupLanes(
      [
        sampledEdge('e1', 'a', 'b', horizontalLine(10)),
        sampledEdge('e2', 'b', 'a', [...horizontalLine(10)].reverse()),
        sampledEdge('e3', 'c', 'd', horizontalLine(4)),
      ],
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const { geometry, edgeIds } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    expect(edgeIds).toEqual(['e1', 'e2', 'e3'])
    // 区间连续、不相交、首尾相接。
    expect(geometry.edgeVertexRanges.length).toBe(6)
    expect(geometry.edgeVertexRanges[0]).toBe(0)
    for (let e = 0; e < edgeIds.length; e += 1) {
      const start = geometry.edgeVertexRanges[e * 2]
      const end = geometry.edgeVertexRanges[e * 2 + 1]
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      if (e > 0) {
        const prevEnd = geometry.edgeVertexRanges[(e - 1) * 2 + 1]
        expect(start).toBe(prevEnd)
      }
    }
    expect(geometry.edgeVertexRanges[5]).toBe(geometry.positions.length / 3)
  })
})

describe('compilePathGeometry — 有限性与确定性', () => {
  const groups = groupLanes(
    [
      sampledEdge('e1', 'a', 'b', horizontalLine(10)),
      sampledEdge('e2', 'b', 'a', [...horizontalLine(10)].reverse()),
      sampledEdge('e3', 'c', 'd', [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
        { x: 6, y: 8 },
      ]),
    ],
    DEFAULT_LANE_GROUPING_CONFIG,
  )

  it('全部位置/法线/弧长/流向/索引均为有限值', () => {
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    for (let i = 0; i < geometry.positions.length; i += 1) {
      expect(Number.isFinite(geometry.positions[i])).toBe(true)
    }
    for (let i = 0; i < geometry.normals.length; i += 1) {
      expect(Number.isFinite(geometry.normals[i])).toBe(true)
    }
    // 法线全部为 (0,1,0)。
    for (let v = 0; v < geometry.normals.length / 3; v += 1) {
      expect(geometry.normals[v * 3]).toBe(0)
      expect(geometry.normals[v * 3 + 1]).toBe(1)
      expect(geometry.normals[v * 3 + 2]).toBe(0)
    }
    for (let i = 0; i < geometry.pathU.length; i += 1) {
      expect(Number.isFinite(geometry.pathU[i])).toBe(true)
    }
    for (let i = 0; i < geometry.flowDirections.length; i += 1) {
      expect(geometry.flowDirections[i] === 1 || geometry.flowDirections[i] === -1).toBe(true)
    }
  })

  it('索引全部在顶点范围内', () => {
    const { geometry } = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    const vertexCount = geometry.positions.length / 3
    for (let i = 0; i < geometry.indices.length; i += 1) {
      expect(geometry.indices[i]).toBeGreaterThanOrEqual(0)
      expect(geometry.indices[i]).toBeLessThan(vertexCount)
    }
  })

  it('相同输入与配置产生字节级稳定输出（逐字节比较所有 TypedArray）', () => {
    const a = compilePathGeometry(
      groups,
      originSpace(),
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    for (let i = 0; i < 5; i += 1) {
      const b = compilePathGeometry(
        groups,
        originSpace(),
        DEFAULT_PATH_RIBBON_CONFIG,
        DEFAULT_LANE_GROUPING_CONFIG,
      )
      // edgeIds 为字符串数组，直接值比较。
      expect(b.edgeIds).toEqual(a.edgeIds)
      // 所有 TypedArray 逐字节比较（TASK-004 验证方式：逐字节比较所有 TypedArray）。
      expect(typedArrayBytesEqual(b.geometry.positions, a.geometry.positions)).toBe(true)
      expect(typedArrayBytesEqual(b.geometry.normals, a.geometry.normals)).toBe(true)
      expect(typedArrayBytesEqual(b.geometry.pathU, a.geometry.pathU)).toBe(true)
      expect(typedArrayBytesEqual(b.geometry.flowDirections, a.geometry.flowDirections)).toBe(true)
      expect(typedArrayBytesEqual(b.geometry.indices, a.geometry.indices)).toBe(true)
      expect(typedArrayBytesEqual(b.geometry.edgeVertexRanges, a.geometry.edgeVertexRanges)).toBe(true)
    }
  })
})

describe('validatePathGeometry — 异常路径拒绝（SPEC §7.5、TASK-004）', () => {
  /**
   * 构造一份最小合法扁带数据包：1 条边、4 顶点（2 横截面）、2 三角形。
   * 各属性长度严格匹配，位置/法线/弧长/流向全部有限，索引与逐边区间均不越界。
   */
  function validPacket(): PathGeometryPacket {
    return {
      positions: new Float32Array([
        0, 0.015, 0,
        0, 0.015, -0.22,
        5, 0.015, 0,
        5, 0.015, -0.22,
      ]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      pathU: new Float32Array([0, 0, 5, 5]),
      flowDirections: new Float32Array([1, 1, 1, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
      edgeVertexRanges: new Uint32Array([0, 4]),
    }
  }

  /** 断言给定数据包以指定错误码抛出 GeometryCompileError。 */
  function expectReject(
    packet: PathGeometryPacket,
    edgeCount: number,
    code: 'INVALID_RIBBON_GEOMETRY' | 'RIBBON_INDEX_OUT_OF_BOUNDS',
  ): void {
    try {
      validatePathGeometry(packet, edgeCount)
      throw new Error('expected validatePathGeometry to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GeometryCompileError)
      expect((error as GeometryCompileError).code).toBe(code)
    }
  }

  it('合法数据包通过校验，不抛出', () => {
    expect(() => validatePathGeometry(validPacket(), 1)).not.toThrow()
  })

  it('属性长度不一致被拒绝（INVALID_RIBBON_GEOMETRY）', () => {
    const base = validPacket()
    // 法线少一个分量。
    expectReject({ ...base, normals: new Float32Array(11) }, 1, 'INVALID_RIBBON_GEOMETRY')
    // 弧长多一个分量。
    expectReject({ ...base, pathU: new Float32Array(5) }, 1, 'INVALID_RIBBON_GEOMETRY')
    // 流向少一个分量。
    expectReject({ ...base, flowDirections: new Float32Array(3) }, 1, 'INVALID_RIBBON_GEOMETRY')
    // 边顶点区间数与边数不匹配（边数=2 但只有 1 条区间）。
    expectReject({ ...base, edgeVertexRanges: new Uint32Array([0, 4]) }, 2, 'INVALID_RIBBON_GEOMETRY')
  })

  it('非有限位置/法线/弧长/流向被拒绝（INVALID_RIBBON_GEOMETRY）', () => {
    const nanPositions = new Float32Array(validPacket().positions)
    nanPositions[0] = Number.NaN
    expectReject({ ...validPacket(), positions: nanPositions }, 1, 'INVALID_RIBBON_GEOMETRY')

    const infNormals = new Float32Array(validPacket().normals)
    infNormals[1] = Number.POSITIVE_INFINITY
    expectReject({ ...validPacket(), normals: infNormals }, 1, 'INVALID_RIBBON_GEOMETRY')

    const nanPathU = new Float32Array(validPacket().pathU)
    nanPathU[2] = Number.NaN
    expectReject({ ...validPacket(), pathU: nanPathU }, 1, 'INVALID_RIBBON_GEOMETRY')

    const infFlow = new Float32Array(validPacket().flowDirections)
    infFlow[0] = Number.NEGATIVE_INFINITY
    expectReject({ ...validPacket(), flowDirections: infFlow }, 1, 'INVALID_RIBBON_GEOMETRY')
  })

  it('索引越界被拒绝（RIBBON_INDEX_OUT_OF_BOUNDS）', () => {
    const base = validPacket()
    // 索引等于顶点数 4（合法范围为 [0,4)）。
    const overIndex = new Uint32Array([0, 1, 4, 1, 3, 2])
    expectReject({ ...base, indices: overIndex }, 1, 'RIBBON_INDEX_OUT_OF_BOUNDS')
    // 索引为 0 时合法，不抛出。
    expect(() => validatePathGeometry({ ...base, indices: new Uint32Array([0]) }, 1)).not.toThrow()
  })

  it('逐边顶点区间非法被拒绝（RIBBON_INDEX_OUT_OF_BOUNDS）', () => {
    const base = validPacket()
    // start >= end（空区间）。
    expectReject({ ...base, edgeVertexRanges: new Uint32Array([2, 2]) }, 1, 'RIBBON_INDEX_OUT_OF_BOUNDS')
    // start > end 的倒序区间同样非法。
    expectReject({ ...base, edgeVertexRanges: new Uint32Array([3, 1]) }, 1, 'RIBBON_INDEX_OUT_OF_BOUNDS')
    // end 超出顶点数。
    expectReject({ ...base, edgeVertexRanges: new Uint32Array([0, 5]) }, 1, 'RIBBON_INDEX_OUT_OF_BOUNDS')
    // 合法区间不抛出。
    expect(() => validatePathGeometry(base, 1)).not.toThrow()
  })
})
