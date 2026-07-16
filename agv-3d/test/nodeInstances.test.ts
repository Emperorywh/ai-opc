import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NODE_BASE_WIDTH_M,
  DEFAULT_NODE_DIMENSIONS_CONFIG,
} from '../src/features/agv-map/config/geometryConfig'
import type { MapNode } from '../src/features/agv-map/domain/domainModel'
import type { RawNodeType } from '../src/features/agv-map/domain/rawDto'
import { computeMapSpace } from '../src/features/agv-map/geometry/worldCoords'
import { compileNodeInstances, NODE_MATRIX_FLOATS } from '../src/features/agv-map/geometry/nodeInstances'

const HALF_PI = Math.PI / 2
const PI = Math.PI

/** 构造一个节点的辅助函数，减少测试样板。 */
function node(
  id: string,
  type: RawNodeType,
  x: number,
  y: number,
  angle: number | null,
): MapNode {
  return { id, type, position: { x, y }, angle }
}

/** 取第 index 个矩阵的平移分量（列主序 elements 12/13/14）。 */
function translation(m: Float32Array, index: number): [number, number, number] {
  const o = index * NODE_MATRIX_FLOATS
  return [m[o + 12], m[o + 13], m[o + 14]]
}

/** 取第 index 个矩阵的世界前向（模型 +X 经 TR 后的列 0）。 */
function forward(m: Float32Array, index: number): [number, number, number] {
  const o = index * NODE_MATRIX_FLOATS
  return [m[o + 0], m[o + 1], m[o + 2]]
}

/** 以单节点原点为空间基准，简化世界坐标断言。 */
function originSpace() {
  return computeMapSpace([{ x: 0, y: 0 }], [])
}

describe('compileNodeInstances — 分桶与计数', () => {
  it('按类型分桶且保持输入顺序', () => {
    const nodes = [
      node('a', 'work', 1, 0, 0),
      node('b', 'node', 2, 0, null),
      node('c', 'work', 3, 0, PI),
      node('d', 'charge', 4, 0, 0),
      node('e', 'park', 5, 0, 0),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    expect(compiled.node.count).toBe(1)
    expect(compiled.work.count).toBe(2)
    expect(compiled.charge.count).toBe(1)
    expect(compiled.park.count).toBe(1)
    // work 桶保持输入顺序：a 在 c 之前。
    expect(translation(compiled.work.matrices, 0)[0]).toBeCloseTo(1, 10)
    expect(translation(compiled.work.matrices, 1)[0]).toBeCloseTo(3, 10)
  })

  it('矩阵数组长度 = count × 16', () => {
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'work', 1, 0, 0),
      node('c', 'charge', 2, 0, 0),
      node('d', 'park', 3, 0, 0),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      expect(compiled[type].matrices.length).toBe(compiled[type].count * NODE_MATRIX_FLOATS)
    }
  })

  it('空输入产出四类空包', () => {
    const compiled = compileNodeInstances([], originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      expect(compiled[type].count).toBe(0)
      expect(compiled[type].matrices.length).toBe(0)
    }
  })

  it('不跳过任何节点：总数等于输入', () => {
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'node', 1, 1, null),
      node('c', 'work', 2, 2, 0),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    const total = compiled.node.count + compiled.work.count + compiled.charge.count + compiled.park.count
    expect(total).toBe(nodes.length)
  })
})

describe('compileNodeInstances — 放置与尺寸', () => {
  it('0.5 m 基准宽度：四类节点占地均为 0.5×0.5 m', () => {
    expect(DEFAULT_NODE_BASE_WIDTH_M).toBe(0.5)
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const dim = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type]
      expect(dim.sizeXM).toBe(0.5)
      expect(dim.sizeZM).toBe(0.5)
    }
  })

  it('底部贴地：中心 Y 等于自身几何半高', () => {
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'work', 0, 0, 0),
      node('c', 'charge', 0, 0, 0),
      node('d', 'park', 0, 0, 0),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    const halfHeights: Record<RawNodeType, number> = {
      node: 0.25,
      work: 0.25,
      charge: 0.3,
      park: 0.2,
    }
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const ty = translation(compiled[type].matrices, 0)[1]
      // Float32 存储（如 0.3）存在 ~1e-8 量级表示误差，使用 6 位精度容差。
      expect(ty).toBeCloseTo(halfHeights[type], 6)
    }
  })

  it('世界 X/Z 由 mapToWorld 推导：z 轴取反', () => {
    const space = computeMapSpace([{ x: 10, y: -4 }], [])
    const nodes = [node('a', 'work', 12, -1, 0)]
    const compiled = compileNodeInstances(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG)
    const [tx, , tz] = translation(compiled.work.matrices, 0)
    // world = (12-10, h, -(-1-(-4))) = (2, h, -3)
    expect(tx).toBeCloseTo(2, 10)
    expect(tz).toBeCloseTo(-3, 10)
  })
})

describe('compileNodeInstances — 朝向约定（SPEC §6.2）', () => {
  /**
   * TASK-009 方向路径 / SPEC §6.2：对三类方向性节点（work/charge/park）逐一应用
   * 0、π/2、−π/2、π 的实例变换，验证模型 +X 经 TR 矩阵映射到正确的世界方向。
   *
   * 三类方向性节点共用同一 writeNodeMatrix（类型无关），此处对三类都穷举四基准角，
   * 使自动化验证直接匹配 TASK-009 与 SPEC §6.2 的文字要求，而非仅凭"类型无关"的等价推理。
   * forward() 取矩阵列 0（模型 +X 基向量变换后的世界方向），即形状尖端的世界朝向。
   */
  it('三类方向性节点 × 四基准角：模型 +X 经实例矩阵映射到正确世界方向', () => {
    const cases: Array<{ angle: number; expected: [number, number, number] }> = [
      { angle: 0, expected: [1, 0, 0] }, // 地图 +X → 世界 +X
      { angle: HALF_PI, expected: [0, 0, -1] }, // 地图 +Y → 世界 -Z
      { angle: -HALF_PI, expected: [0, 0, 1] }, // 地图 -Y → 世界 +Z
      { angle: PI, expected: [-1, 0, 0] }, // 地图 -X → 世界 -X
    ]
    for (const type of ['work', 'charge', 'park'] as const) {
      for (const { angle, expected } of cases) {
        const nodes = [node('x', type, 0, 0, angle)]
        const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
        const fwd = forward(compiled[type].matrices, 0)
        for (let i = 0; i < 3; i += 1) {
          expect(fwd[i], `${type} angle=${angle} 分量 ${i}`).toBeCloseTo(expected[i], 10)
        }
      }
    }
  })

  it('普通节点无方向性：旋转恒等、前向恒为 +X', () => {
    // 普通节点 angle 为 null；即便人为给有限值也不应影响放置（兜底视作 0）。
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'node', 1, 0, null),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    for (let i = 0; i < 2; i += 1) {
      const fwd = forward(compiled.node.matrices, i)
      // 用 toBeCloseTo 避免 -0 与 0 的严格相等歧义（rotationY=0 时 -sin0 = -0）。
      expect(fwd[0]).toBeCloseTo(1, 6)
      expect(fwd[1]).toBeCloseTo(0, 6)
      expect(fwd[2]).toBeCloseTo(0, 6)
    }
  })
})

describe('compileNodeInstances — 矩阵格式', () => {
  it('纯 TR 矩阵：三个列向量单位长度（无缩放）', () => {
    const nodes = [node('w', 'work', 5, 7, HALF_PI / 3)]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    const m = compiled.work.matrices
    // 列 0、列 1、列 2 的 3D 长度均应为 1（Float32 存储带来 ~1e-8 误差，用 6 位精度）。
    const len = (col: number) =>
      Math.hypot(m[col * 4 + 0], m[col * 4 + 1], m[col * 4 + 2])
    expect(len(0)).toBeCloseTo(1, 6)
    expect(len(1)).toBeCloseTo(1, 6)
    expect(len(2)).toBeCloseTo(1, 6)
    // 末行恒为 (0,0,0,1)。
    expect(m[3]).toBe(0)
    expect(m[7]).toBe(0)
    expect(m[11]).toBe(0)
    expect(m[15]).toBe(1)
  })

  it('全部矩阵分量为有限值', () => {
    const nodes = [
      node('a', 'work', -100, 200, PI / 6),
      node('b', 'charge', 1e3, -1e3, -PI / 4),
      node('c', 'park', 0, 0, PI),
    ]
    const compiled = compileNodeInstances(nodes, originSpace(), DEFAULT_NODE_DIMENSIONS_CONFIG)
    for (const type of ['work', 'charge', 'park'] as const) {
      for (let i = 0; i < compiled[type].matrices.length; i += 1) {
        expect(Number.isFinite(compiled[type].matrices[i])).toBe(true)
      }
    }
  })
})

describe('compileNodeInstances — 确定性', () => {
  it('相同输入与配置两次编译字节级一致', () => {
    const nodes = [
      node('a', 'node', 0, 0, null),
      node('b', 'work', 3, 4, 1.2),
      node('c', 'charge', -5, 6, -0.7),
      node('d', 'park', 2, -8, PI),
    ]
    const space = computeMapSpace(
      nodes.map((n) => n.position),
      [],
    )
    const a = compileNodeInstances(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG)
    const b = compileNodeInstances(nodes, space, DEFAULT_NODE_DIMENSIONS_CONFIG)
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      expect(a[type].count).toBe(b[type].count)
      expect(a[type].matrices.length).toBe(b[type].matrices.length)
      for (let i = 0; i < a[type].matrices.length; i += 1) {
        expect(a[type].matrices[i]).toBe(b[type].matrices[i])
      }
    }
  })
})
