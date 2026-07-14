import { describe, expect, it } from 'vitest'
import { DEFAULT_NODE_DIMENSIONS_CONFIG } from '../src/features/agv-map/config/geometryConfig'
import type { MapNode } from '../src/features/agv-map/domain/domainModel'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'
import { GeometryCompileError } from '../src/features/agv-map/geometry/pathSampling'
import { computeRenderBounds } from '../src/features/agv-map/geometry/renderBounds'
import { computeMapSpace, mapToWorld } from '../src/features/agv-map/geometry/worldCoords'

function node(
  id: string,
  type: RawNodeType,
  x: number,
  y: number,
  angle: number | null,
): MapNode {
  return { id, type, position: { x, y }, angle }
}

function originSpace() {
  return computeMapSpace([{ x: 0, y: 0 }], [])
}

/** 把 [x0,y0,z0, x1,y1,z0, ...] 折叠为 Float32Array，模拟路径顶点缓冲。 */
function positions(flat: number[]): Float32Array {
  return new Float32Array(flat)
}

describe('computeRenderBounds — 节点贡献', () => {
  it('包含节点中心 ± 半 extents（不只是坐标点）', () => {
    // 单个 work 节点位于原点；占地 0.5×0.5、无旋转。
    const nodes = [node('a', 'work', 0, 0, 0)]
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    const half = 0.25 // 0.5 / 2
    expect(bounds.min[0]).toBeCloseTo(-half, 10)
    expect(bounds.max[0]).toBeCloseTo(half, 10)
    expect(bounds.min[2]).toBeCloseTo(-half, 10)
    expect(bounds.max[2]).toBeCloseTo(half, 10)
  })

  it('旋转节点 XZ 包围盒按 |cos|+|sin| 交叉展开', () => {
    // work 节点占地 0.5×0.5，旋转 π/4 后 XZ 包围盒半 extents = 0.25×(√2/2)×2 = 0.25√2。
    const nodes = [node('a', 'work', 0, 0, Math.PI / 4)]
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    const expected = 0.25 * Math.SQRT2
    expect(bounds.max[0]).toBeCloseTo(expected, 10)
    expect(bounds.min[0]).toBeCloseTo(-expected, 10)
    expect(bounds.max[2]).toBeCloseTo(expected, 10)
    expect(bounds.min[2]).toBeCloseTo(-expected, 10)
  })

  it('Y 范围 [0, 最高节点高度]：底部贴地', () => {
    // charge 最高 0.6 m；含 node(0.5)、charge(0.6)、park(0.4)。
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'charge', 1, 0, 0),
      node('c', 'park', 2, 0, 0),
    ]
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    expect(bounds.min[1]).toBeCloseTo(0, 10)
    expect(bounds.max[1]).toBeCloseTo(0.6, 10)
  })

  it('边界大于仅节点坐标 AABB：含节点尺寸', () => {
    const nodes = [node('a', 'work', 10, 10, 0)]
    const space = computeMapSpace([{ x: 10, y: 10 }], [])
    const bounds = computeRenderBounds(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    // 仅坐标 AABB 为单点 (0,0,0)；含尺寸后 X/Z 扩展 ±0.25。
    expect(bounds.max[0]).toBeGreaterThan(0)
    expect(bounds.min[0]).toBeLessThan(0)
    expect(bounds.max[2]).toBeGreaterThan(0)
    expect(bounds.min[2]).toBeLessThan(0)
  })
})

describe('computeRenderBounds — 路径贡献', () => {
  it('包含全部路径顶点', () => {
    const nodes = [node('a', 'node', 0, 0, null)]
    const path = positions([
      5, 0.015, -3,
      -7, 0.015, 2,
      0, 0.015, 9,
    ])
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    expect(bounds.max[0]).toBeCloseTo(5, 10)
    expect(bounds.min[0]).toBeCloseTo(-7, 10)
    expect(bounds.max[2]).toBeCloseTo(9, 10)
    expect(bounds.min[2]).toBeCloseTo(-3, 10)
  })

  it('扁带离地高度进入 Y 边界', () => {
    const nodes: MapNode[] = []
    const path = positions([0, 0.015, 0])
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    // Float32 存储 0.015 存在 ~1e-9 表示误差，使用 6 位精度容差。
    expect(bounds.min[1]).toBeCloseTo(0.015, 6)
    expect(bounds.max[1]).toBeCloseTo(0.015, 6)
  })

  it('仅路径无节点时仍能计算边界', () => {
    const path = positions([-1, 0, -1, 1, 0, 1])
    const bounds = computeRenderBounds([], originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    expect(bounds.min[0]).toBe(-1)
    expect(bounds.max[0]).toBe(1)
  })
})

describe('computeRenderBounds — 联合与退化', () => {
  it('节点与路径联合 AABB 取并集', () => {
    // 节点位于 (0,0)；路径顶点扩展到更远处。
    const nodes = [node('a', 'work', 0, 0, 0)]
    const path = positions([100, 0.015, 0])
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    expect(bounds.max[0]).toBeCloseTo(100, 10)
    expect(bounds.min[0]).toBeCloseTo(-0.25, 10)
  })

  it('节点与路径同时为空抛出 EMPTY_COMPUTE_BOUNDS', () => {
    expect(() => computeRenderBounds([], originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))).toThrow(
      GeometryCompileError,
    )
    try {
      computeRenderBounds([], originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    } catch (error) {
      expect((error as GeometryCompileError).code).toBe('EMPTY_COMPUTE_BOUNDS')
    }
  })

  it('边界 min 不大于 max', () => {
    const nodes = [
      node('a', 'work', 3, -2, 0.5),
      node('b', 'charge', -4, 5, -1),
    ]
    const path = positions([0, 0.015, 0, 2, 0.015, 2])
    const bounds = computeRenderBounds(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    for (let i = 0; i < 3; i += 1) {
      expect(bounds.min[i]).toBeLessThanOrEqual(bounds.max[i])
    }
  })
})

describe('computeRenderBounds — 确定性', () => {
  it('相同输入两次计算字节级一致', () => {
    const nodes = [
      node('a', 'work', 3, -2, 0.5),
      node('b', 'charge', -4, 5, -1),
      node('c', 'park', 0, 0, Math.PI),
      node('d', 'node', 2, 2, null),
    ]
    const space = computeMapSpace(
      nodes.map((n) => n.position),
      [],
    )
    const path = positions([0, 0.015, 0, 10, 0.015, -10, -5, 0.015, 7])
    const a = computeRenderBounds(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    const b = computeRenderBounds(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG, path)
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('mapToWorld 一致性：世界坐标基准相同', () => {
    const nodes = [node('a', 'work', 8, 6, 0)]
    const space = computeMapSpace([{ x: 1, y: 1 }], [])
    const bounds = computeRenderBounds(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG, positions([]))
    const w = mapToWorld({ x: 8, y: 6 }, space)
    // 节点中心 X/Z 落在 [min, max] 中点。
    expect((bounds.min[0] + bounds.max[0]) / 2).toBeCloseTo(w.x, 10)
    expect((bounds.min[2] + bounds.max[2]) / 2).toBeCloseTo(w.z, 10)
  })
})
