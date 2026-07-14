import { describe, expect, it } from 'vitest'
import type { Point2 } from '../src/features/agv-map/domain/domainModel'
import { GeometryCompileError } from '../src/features/agv-map/geometry/pathSampling'
import type { SampledPath } from '../src/features/agv-map/geometry/pathSampling'
import { computeMapSpace, mapToWorld } from '../src/features/agv-map/geometry/worldCoords'

function sampled(points: Point2[]): SampledPath {
  return { points }
}

describe('mapToWorld', () => {
  it('map(x, y) → world(x - centerX, height, -(y - centerY))', () => {
    const space = computeMapSpace([{ x: 10, y: -4 }], [])
    const world = mapToWorld({ x: 11, y: -1 }, space, 0.5)
    expect(world.x).toBeCloseTo(1, 10)
    expect(world.z).toBeCloseTo(-3, 10)
    expect(world.y).toBe(0.5)
  })

  it('默认高度为 0', () => {
    const space = computeMapSpace([{ x: 0, y: 0 }], [])
    expect(mapToWorld({ x: 0, y: 0 }, space).y).toBe(0)
  })

  it('1 world unit = 1 m：地图 1 m 偏移对应世界 1 单位', () => {
    const space = computeMapSpace([{ x: 0, y: 0 }], [])
    const a = mapToWorld({ x: 0, y: 0 }, space)
    const b = mapToWorld({ x: 1, y: 0 }, space)
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(1, 10)
  })

  it('中心点映射到世界原点', () => {
    const space = computeMapSpace(
      [
        { x: -2, y: -2 },
        { x: 2, y: 2 },
      ],
      [],
    )
    const w = mapToWorld(space.center, space)
    // 几何原点；-(0) 产生 -0，用模长判定避免有符号零歧义。
    expect(Math.hypot(w.x, w.y, w.z)).toBe(0)
  })

  it('z 轴取反：地图 +Y 对应世界 -Z', () => {
    const space = computeMapSpace([{ x: 0, y: 0 }], [])
    expect(mapToWorld({ x: 0, y: 5 }, space).z).toBeCloseTo(-5, 10)
  })
})

describe('computeMapSpace — 联合边界中心', () => {
  it('由节点与采样点联合 AABB 计算中心', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    ]
    const samples = [
      sampled([
        { x: -2, y: 0 },
        { x: 12, y: 0 },
      ]),
    ]
    const space = computeMapSpace(nodes, samples)
    // 联合 x：[-2, 12]；联合 y：[0, 4]
    expect(space.center.x).toBeCloseTo(5, 10)
    expect(space.center.y).toBeCloseTo(2, 10)
  })

  it('采样点扩展节点边界：中心随采样点变化', () => {
    const nodes = [
      { x: 0, y: 0 },
      { x: 2, y: 2 },
    ]
    const withoutSamples = computeMapSpace(nodes, [])
    const withSamples = computeMapSpace(nodes, [sampled([{ x: 100, y: 100 }])])
    expect(withSamples.center.x).toBeGreaterThan(withoutSamples.center.x)
    expect(withSamples.center.y).toBeGreaterThan(withoutSamples.center.y)
  })

  it('仅有节点时中心来自节点 AABB', () => {
    const space = computeMapSpace(
      [
        { x: -5, y: 1 },
        { x: 3, y: 7 },
      ],
      [],
    )
    expect(space.center).toEqual({ x: -1, y: 4 })
  })

  it('仅有采样点时中心来自采样点 AABB', () => {
    const space = computeMapSpace(
      [],
      [sampled([{ x: -6, y: 2 }, { x: 4, y: 8 }])],
    )
    expect(space.center).toEqual({ x: -1, y: 5 })
  })

  it('两组同时为空抛出几何错误', () => {
    expect(() => computeMapSpace([], [])).toThrow(GeometryCompileError)
    try {
      computeMapSpace([], [])
    } catch (error) {
      expect((error as GeometryCompileError).code).toBe('EMPTY_COMPUTE_BOUNDS')
    }
  })

  it('确定性：相同输入产生字节级一致中心', () => {
    const nodes = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: -1, y: 5 },
    ]
    const samples = [sampled([{ x: 0, y: 0 }, { x: 6, y: 6 }])]
    const a = computeMapSpace(nodes, samples)
    const b = computeMapSpace(nodes, samples)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })
})
