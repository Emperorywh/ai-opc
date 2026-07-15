import { describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLING_CONFIG } from '../src/features/agv-map/config/geometryConfig'
import type { DirectedEdge, DirectedPath, Point2 } from '../src/features/agv-map/domain/domainModel'
import {
  GeometryCompileError,
  sampleEdges,
  samplePath,
  type SampledEdge,
} from '../src/features/agv-map/geometry/pathSampling'
import { denseCurve, distToPolyline } from './helpers/curveGeometry'

/** 直线路径工厂。 */
function line(start: Point2, end: Point2): DirectedPath {
  return { kind: 'line', start, end }
}

/** 三次贝塞尔路径工厂。 */
function bezier(p0: Point2, p1: Point2, p2: Point2, p3: Point2): DirectedPath {
  return { kind: 'cubic-bezier', start: p0, control1: p1, control2: p2, end: p3 }
}

describe('samplePath — 直线', () => {
  it('只产生有序的起点和终点', () => {
    const sampled = samplePath(line({ x: 1, y: 2 }, { x: 5, y: -3 }), DEFAULT_SAMPLING_CONFIG)
    expect(sampled.points).toEqual([{ x: 1, y: 2 }, { x: 5, y: -3 }])
  })

  it('端点顺序沿 source → target', () => {
    const sampled = samplePath(line({ x: 9, y: 9 }, { x: -1, y: -1 }), DEFAULT_SAMPLING_CONFIG)
    expect(sampled.points[0]).toEqual({ x: 9, y: 9 })
    expect(sampled.points[sampled.points.length - 1]).toEqual({ x: -1, y: -1 })
  })
})

describe('samplePath — 三次贝塞尔', () => {
  it('完整保留首尾端点', () => {
    const p0 = { x: 0, y: 0 }
    const p3 = { x: 10, y: 3 }
    const sampled = samplePath(bezier(p0, { x: 2, y: 8 }, { x: 8, y: -5 }, p3), DEFAULT_SAMPLING_CONFIG)
    expect(sampled.points[0]).toEqual(p0)
    expect(sampled.points[sampled.points.length - 1]).toEqual(p3)
    expect(sampled.points.length).toBeGreaterThanOrEqual(2)
  })

  it('所有采样点精确位于曲线上', () => {
    const p0 = { x: 0, y: 0 }
    const p1 = { x: 1, y: 4 }
    const p2 = { x: 9, y: -4 }
    const p3 = { x: 12, y: 2 }
    const sampled = samplePath(bezier(p0, p1, p2, p3), DEFAULT_SAMPLING_CONFIG)
    const curve = denseCurve(p0, p1, p2, p3)
    // de Casteljau 切分点恒在曲线上，采样点到真实曲线距离应在数值零附近。
    for (const pt of sampled.points) {
      expect(distToPolyline(pt, curve)).toBeLessThan(1e-6)
    }
  })

  it('相邻采样点弦长不超过 0.25 m', () => {
    const sampled = samplePath(
      bezier({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 15, y: -10 }, { x: 20, y: 0 }),
      DEFAULT_SAMPLING_CONFIG,
    )
    for (let i = 1; i < sampled.points.length; i += 1) {
      const d = Math.hypot(
        sampled.points[i].x - sampled.points[i - 1].x,
        sampled.points[i].y - sampled.points[i - 1].y,
      )
      // 终止条件以 ≤ maxChord 判定，允许等于；留微小数值容差。
      expect(d).toBeLessThanOrEqual(0.25 + 1e-9)
    }
  })

  it('相邻采样点距离严格大于 0', () => {
    const sampled = samplePath(
      bezier({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 0 }),
      DEFAULT_SAMPLING_CONFIG,
    )
    for (let i = 1; i < sampled.points.length; i += 1) {
      const dx = sampled.points[i].x - sampled.points[i - 1].x
      const dy = sampled.points[i].y - sampled.points[i - 1].y
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0)
    }
  })

  it('折线对曲线的逼近误差不超过平坦度阈值', () => {
    const p0 = { x: -3, y: 2 }
    const p1 = { x: 0, y: 12 }
    const p2 = { x: 10, y: -8 }
    const p3 = { x: 7, y: 4 }
    const sampled = samplePath(bezier(p0, p1, p2, p3), DEFAULT_SAMPLING_CONFIG)
    const polyline = sampled.points
    for (const pt of denseCurve(p0, p1, p2, p3)) {
      expect(distToPolyline(pt, polyline)).toBeLessThanOrEqual(0.01 + 1e-9)
    }
  })

  it('最大递归深度约束生效：深度 0 时只产生首尾两点', () => {
    const sampled = samplePath(
      bezier({ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 15, y: -10 }, { x: 20, y: 0 }),
      { ...DEFAULT_SAMPLING_CONFIG, maxRecursionDepth: 0 },
    )
    expect(sampled.points).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }])
  })

  it('采样方向沿 source → target：调换首尾得到反向点序', () => {
    const forward = samplePath(
      bezier({ x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }, { x: 4, y: 0 }),
      DEFAULT_SAMPLING_CONFIG,
    )
    const backward = samplePath(
      bezier({ x: 4, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 0, y: 0 }),
      DEFAULT_SAMPLING_CONFIG,
    )
    expect(forward.points[0]).toEqual({ x: 0, y: 0 })
    expect(forward.points[forward.points.length - 1]).toEqual({ x: 4, y: 0 })
    expect(backward.points[0]).toEqual({ x: 4, y: 0 })
    // 反向采样的点序恰为正向的反转。
    expect(backward.points).toEqual([...forward.points].reverse())
  })
})

describe('samplePath — 确定性', () => {
  const path = bezier({ x: 0, y: 0 }, { x: 3, y: 9 }, { x: 7, y: -9 }, { x: 11, y: 1 })

  it('相同输入与配置产生字节级稳定输出', () => {
    const a = samplePath(path, DEFAULT_SAMPLING_CONFIG)
    const b = samplePath(path, DEFAULT_SAMPLING_CONFIG)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('结果不受展示状态影响：多次调用恒等', () => {
    const first = JSON.stringify(samplePath(path, DEFAULT_SAMPLING_CONFIG))
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(samplePath(path, DEFAULT_SAMPLING_CONFIG))).toEqual(first)
    }
  })
})

describe('samplePath — 零长度段', () => {
  it('贝塞尔四点重合时抛出可定位几何错误', () => {
    const allSame = bezier({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 })
    try {
      samplePath(allSame, DEFAULT_SAMPLING_CONFIG)
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GeometryCompileError)
      const geo = error as GeometryCompileError
      expect(geo.code).toBe('ZERO_LENGTH_SAMPLE_SEGMENT')
      expect(geo.pointIndex).toBe(1)
      expect(geo.edgeId).toBeUndefined()
    }
  })
})

describe('sampleEdges', () => {
  it('按顺序返回绑定 id 的采样结果', () => {
    const edges: DirectedEdge[] = [
      {
        id: 'e1',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        path: line({ x: 0, y: 0 }, { x: 1, y: 0 }),
      },
      {
        id: 'e2',
        sourceNodeId: 'b',
        targetNodeId: 'c',
        path: bezier({ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 0 }),
      },
    ]
    const result = sampleEdges(edges, DEFAULT_SAMPLING_CONFIG)
    expect(result.map((e) => e.edgeId)).toEqual(['e1', 'e2'])
    expect(result[0].path.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  })

  it('为零长度段补充边 id 后向上抛出', () => {
    const edges: DirectedEdge[] = [
      {
        id: 'good',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        path: line({ x: 0, y: 0 }, { x: 1, y: 0 }),
      },
      {
        id: 'bad',
        sourceNodeId: 'b',
        targetNodeId: 'c',
        path: bezier({ x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }, { x: 7, y: 7 }),
      },
    ]
    try {
      sampleEdges(edges, DEFAULT_SAMPLING_CONFIG)
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(GeometryCompileError)
      expect((error as GeometryCompileError).edgeId).toBe('bad')
      expect((error as GeometryCompileError).code).toBe('ZERO_LENGTH_SAMPLE_SEGMENT')
    }
  })

  it('确定性：批量重复采样结果字节级一致', () => {
    const edges: DirectedEdge[] = [
      {
        id: 'e1',
        sourceNodeId: 'a',
        targetNodeId: 'b',
        path: bezier({ x: 0, y: 0 }, { x: 2, y: 5 }, { x: 6, y: -5 }, { x: 8, y: 0 }),
      },
    ]
    const snapshot = (e: SampledEdge) => JSON.stringify(e)
    const first = sampleEdges(edges, DEFAULT_SAMPLING_CONFIG).map(snapshot)
    expect(sampleEdges(edges, DEFAULT_SAMPLING_CONFIG).map(snapshot)).toEqual(first)
  })
})
