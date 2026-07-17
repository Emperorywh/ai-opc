/*
 * 节点朝向箭头实例数据自动化验证（TASK-009，SPEC 2.2 / 2.5 / 5.2 / 7.1 / 7.2 / 8.2 / 12.1 / 15.2 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 SceneNode 用于精确矩阵 / 方向 / 颜色 / bounds 断言：列主序 T × R × S、
 *     平移位于 12/13/14、三个基准角度 0/+π/2/-π/2 分别指向 +X/-Z/+Z、WCAG 黑白择色、
 *     真实变换后顶点的紧致 bounds。
 *   - 错误实现识别：行主序、预旋转顶点、Y 被半径缩放、固定 0.30m / 默认角度、
 *     把普通节点 null 角度替换为零等错误实现都会让对应断言失败。
 *   - 异常路径：未知箭头类型 → MAP_ENTITY_INVALID；作业节点 angle 为 null / 非有限、
 *     坐标非有限、矩阵 / 颜色非有限 → MAP_GEOMETRY_INVALID；均整体拒绝，不输出部分数组。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildNodeArrowData，
 *     断言 464 箭头、矩阵 464×16、颜色 464×3、全部有限、方向单位化、bounds 合理；
 *     按完整 ID 查询中文充电节点，交叉验证场景平移、半径缩放与 WCAG 对比色。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildNodeArrowData,
  NODE_ARROW_VERTICES,
} from '../../src/geometry/nodeArrowData'
import type { NodeArrowData } from '../../src/geometry/nodeArrowData'
import {
  contrastRatio,
  hexToLinearRGB,
} from '../../src/geometry/colorSpace'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type { SceneMap, SceneNode } from '../../src/domain/sceneMap'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import {
  FIXED_ENTITIES,
  SAMPLE_EDGE_COUNTS,
  SAMPLE_NODE_COUNTS,
} from '../fixture/sampleBaseline'

/*
 * SPEC 7.1 / 8.2：箭头实例半径（work/park/charge 均为 0.15m）；与实现常量同源 SPEC。
 */
const NODE_ARROW_RADIUS = 0.15
const NODE_ARROW_Y = 0.066

/*
 * SPEC 7.2：箭头承载类型的节点基色 hex（WCAG 对比度的基色输入）。
 */
const NODE_BASE_HEX = {
  work: '#2196F3',
  park: '#F44336',
  charge: '#8BC34A',
} as const

const ARROW_BLACK_HEX = '#111111'
const ARROW_WHITE_HEX = '#FFFFFF'

/*
 * 合成 SceneNode 构造工具：默认普通节点 angle = null，便于覆盖普通节点路径。
 * 字段缺省时回退到合法默认值；测试通过 overrides 注入所需类型 / 坐标 / angle。
 */
function sceneNode(overrides: Partial<SceneNode> & { id: string }): SceneNode {
  return {
    id: overrides.id,
    name: overrides.name ?? 'n',
    type: overrides.type ?? 'node',
    position: overrides.position ?? { x: 0, z: 0 },
    angle: overrides.angle ?? null,
  }
}

/*
 * 捕获预期抛出的异常；未抛出时失败，便于在断言里复用。
 */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出异常，但未抛出')
}

/*
 * 取第 i 个箭头的 16 元素矩阵（列主序）。
 */
function matrixOf(data: NodeArrowData, i: number): number[] {
  const m = i * 16
  return Array.from(data.matrices.subarray(m, m + 16))
}

/*
 * 取第 i 个箭头的线性颜色三元组。
 */
function colorOf(
  data: NodeArrowData,
  i: number,
): readonly [number, number, number] {
  const c = i * 3
  return [data.colors[c], data.colors[c + 1], data.colors[c + 2]]
}

/*
 * 用列主序 16 元素矩阵变换点 (x, y, z)（M · v，v 为列向量）。
 * 用于验证箭头方向：x' = m[0]x + m[4]y + m[8]z + m[12]；z' = m[2]x + m[6]y + m[10]z + m[14]。
 */
function transformPoint(
  m: readonly number[],
  point: readonly [number, number, number],
): readonly [number, number, number] {
  const [x, y, z] = point
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/*
 * 取箭头 tip（局部 (0.5, 0, 0)）经矩阵变换后的场景点；方向 = tip 相对节点中心的偏移。
 */
function tipDirection(m: readonly number[]): readonly [number, number, number] {
  const tip = transformPoint(m, [0.5, 0, 0])
  return [tip[0] - m[12], tip[1] - m[13], tip[2] - m[14]]
}

/*
 * 判断线性颜色三元组是否近似等于候选（容差吸收 Float32 typed array 与 float64 差异）。
 * colors 写入 Float32Array 后回读为 float32；候选来自 hexToLinearRGB 的 float64，
 * 直接字符串比较会因末位精度差异失败，故用 1e-6 容差逐分量比较。
 */
function colorEquals(
  col: readonly [number, number, number],
  candidate: readonly [number, number, number],
  tolerance = 1e-6,
): boolean {
  return (
    Math.abs(col[0] - candidate[0]) <= tolerance &&
    Math.abs(col[1] - candidate[1]) <= tolerance &&
    Math.abs(col[2] - candidate[2]) <= tolerance
  )
}

// ─── 合成：计数、长度与 typed array 契约（SPEC 5.2 / 8.2 / 15.3）──────────────

describe('节点箭头 · 计数与长度契约（SPEC 5.2 / 8.2）', () => {
  test('只为 work/park/charge 生成箭头；普通节点不产生箭头', () => {
    const nodes = [
      sceneNode({ id: 'a', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'b', type: 'work', position: { x: 1, z: 1 }, angle: 0 }),
      sceneNode({ id: 'c', type: 'park', position: { x: 2, z: 2 }, angle: 0 }),
      sceneNode({ id: 'd', type: 'charge', position: { x: 3, z: 3 }, angle: 0 }),
    ]
    const data = buildNodeArrowData(nodes)
    // 4 个节点中只有 3 个作业节点产生箭头。
    expect(data.arrowCount).toBe(3)
    expect(data.matrices.length).toBe(3 * 16)
    expect(data.colors.length).toBe(3 * 3)
    expect(data.matrices).toBeInstanceOf(Float32Array)
    expect(data.colors).toBeInstanceOf(Float32Array)
  })

  test('空节点集合：arrowCount = 0，typed array 为空，bounds 为 null', () => {
    const data = buildNodeArrowData([])
    expect(data.arrowCount).toBe(0)
    expect(data.matrices.length).toBe(0)
    expect(data.colors.length).toBe(0)
    expect(data.bounds).toBeNull()
  })

  test('全普通节点集合：arrowCount = 0，不把 null 角度当成箭头', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'n1', type: 'node', position: { x: 0, z: 0 } }),
      sceneNode({ id: 'n2', type: 'node', position: { x: 1, z: 1 } }),
    ])
    expect(data.arrowCount).toBe(0)
    expect(data.matrices.length).toBe(0)
    expect(data.colors.length).toBe(0)
    expect(data.bounds).toBeNull()
  })
})

// ─── 合成：基准三角形（SPEC 8.2）──────────────────────────────────────────────

describe('节点箭头基准三角形 · 局部 +X / +Y 逆时针（SPEC 8.2）', () => {
  test('三个顶点依次为 tip / back-left / back-right，y 恒为 0', () => {
    expect(NODE_ARROW_VERTICES).toHaveLength(9)
    // tip = (0.5, 0, 0)
    expect(NODE_ARROW_VERTICES[0]).toBeCloseTo(0.5, 6)
    expect(NODE_ARROW_VERTICES[1]).toBe(0)
    expect(NODE_ARROW_VERTICES[2]).toBe(0)
    // back-left = (0, 0, -0.5)
    expect(NODE_ARROW_VERTICES[3]).toBe(0)
    expect(NODE_ARROW_VERTICES[4]).toBe(0)
    expect(NODE_ARROW_VERTICES[5]).toBeCloseTo(-0.5, 6)
    // back-right = (0, 0, 0.5)
    expect(NODE_ARROW_VERTICES[6]).toBe(0)
    expect(NODE_ARROW_VERTICES[7]).toBe(0)
    expect(NODE_ARROW_VERTICES[8]).toBeCloseTo(0.5, 6)
  })

  test('顶点顺序从 +Y 观察为逆时针（叉积法线指向 +Y）', () => {
    const tip: readonly [number, number, number] = [
      NODE_ARROW_VERTICES[0],
      NODE_ARROW_VERTICES[1],
      NODE_ARROW_VERTICES[2],
    ]
    const b1: readonly [number, number, number] = [
      NODE_ARROW_VERTICES[3],
      NODE_ARROW_VERTICES[4],
      NODE_ARROW_VERTICES[5],
    ]
    const b2: readonly [number, number, number] = [
      NODE_ARROW_VERTICES[6],
      NODE_ARROW_VERTICES[7],
      NODE_ARROW_VERTICES[8],
    ]
    // (b1 - tip) × (b2 - tip) 的 Y 分量必须为正，确保正面朝 +Y。
    const ax = b1[0] - tip[0]
    const az = b1[2] - tip[2]
    const bx = b2[0] - tip[0]
    const bz = b2[2] - tip[2]
    const crossY = -(ax * bz - az * bx) // 二维叉积 ax·bz - az·bx 的符号等价于 +Y 法线方向
    expect(crossY).toBeGreaterThan(0)
  })
})

// ─── 合成：三个基准角度方向（SPEC 8.2 / 2.5）──────────────────────────────────

describe('节点箭头方向 · 三个基准角度（SPEC 8.2 / 2.5）', () => {
  test('angle = 0 → tip 指向 +X', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: 0 }),
    ])
    const dir = tipDirection(matrixOf(data, 0))
    // dx > 0、dz ≈ 0 → +X。预旋转顶点的错误实现会让方向偏离 +X。
    expect(dir[0]).toBeGreaterThan(0)
    expect(dir[1]).toBe(0)
    expect(dir[2]).toBeCloseTo(0, 6)
  })

  test('angle = +π/2 → tip 指向 -Z（不与 Math.PI/2 做精确相等判断）', () => {
    // 使用 Math.PI / 2 数值（样本中存在近似值而非精确常量），验证 cos/sin 数值映射。
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: Math.PI / 2,
      }),
    ])
    const dir = tipDirection(matrixOf(data, 0))
    expect(dir[0]).toBeCloseTo(0, 6) // dx ≈ 0
    expect(dir[2]).toBeLessThan(0) // dz < 0 → -Z
    // tip 场景偏移 = -Z 方向 radius/2。
    expect(dir[2]).toBeCloseTo(-NODE_ARROW_RADIUS / 2, 6)
  })

  test('angle = -π/2 → tip 指向 +Z', () => {
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: -Math.PI / 2,
      }),
    ])
    const dir = tipDirection(matrixOf(data, 0))
    expect(dir[0]).toBeCloseTo(0, 6)
    expect(dir[2]).toBeGreaterThan(0) // dz > 0 → +Z
    expect(dir[2]).toBeCloseTo(NODE_ARROW_RADIUS / 2, 6)
  })

  test('angle = π → tip 指向 -X（验证一般角度，非仅特殊常量）', () => {
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: Math.PI,
      }),
    ])
    const dir = tipDirection(matrixOf(data, 0))
    expect(dir[0]).toBeLessThan(0) // -X
    expect(dir[2]).toBeCloseTo(0, 6)
  })

  test('近似 π/2 不被当成精确常量：偏移 ε 后方向随之变化', () => {
    // 样本存在近似 π/2；实现必须用数值 cos/sin，ε 偏移应让 dx 偏离 0。
    const eps = 1e-3
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: Math.PI / 2 + eps,
      }),
    ])
    const dir = tipDirection(matrixOf(data, 0))
    // sin(π/2 + ε) ≈ cos(ε) ≈ 1；cos(π/2 + ε) ≈ -sin(ε) ≈ -ε < 0。
    // dx = cos·r/2 < 0（精确相等判断会误判 dx = 0，本断言识别该错误）。
    expect(dir[0]).toBeLessThan(0)
    expect(dir[2]).toBeLessThan(0)
  })
})

// ─── 合成：矩阵列主序 T × R × S（SPEC 5.2 / 8.2）──────────────────────────────

describe('节点箭头矩阵 · 列主序 T × R × S（SPEC 5.2 / 8.2）', () => {
  test('angle = 0 矩阵完整 16 元素等于列主序 T × R × S（识别行主序错误）', () => {
    // 位置 (5, 7)、type work → radius 0.15、angle 0。
    const data = buildNodeArrowData([
      sceneNode({ id: 'w', type: 'work', position: { x: 5, z: 7 }, angle: 0 }),
    ])
    // 列主序期望：R = I（angle 0），S = diag(0.15, 1, 0.15)，T = (5, 0.066, 7)。
    // 行主序实现会把平移放到索引 3/7/11，本断言会因此失败。
    const expected = [
      0.15, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0.15, 0,
      5, NODE_ARROW_Y, 7, 1,
    ]
    const m = matrixOf(data, 0)
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(expected[i], 6)
    }
  })

  test('angle = π/2 矩阵旋转分量：m[0]=0、m[2]=-r、m[8]=r、m[10]=0', () => {
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: Math.PI / 2,
      }),
    ])
    const m = matrixOf(data, 0)
    expect(m[0]).toBeCloseTo(0, 6) // cos(π/2)·r ≈ 0
    expect(m[2]).toBeCloseTo(-NODE_ARROW_RADIUS, 6) // -sin(π/2)·r = -r
    expect(m[8]).toBeCloseTo(NODE_ARROW_RADIUS, 6) // sin(π/2)·r = r
    expect(m[10]).toBeCloseTo(0, 6) // cos(π/2)·r ≈ 0
    // 缩放 / 平移分量不受旋转影响。
    expect(m[5]).toBe(1) // Y 不缩放
    expect(m[13]).toBeCloseTo(NODE_ARROW_Y, 6)
  })

  test('Y 缩放恒为 1：三类作业节点 Y 仍不缩放（不被半径缩放）', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: 0.3 }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 }, angle: -0.3 }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 }, angle: 1.2 }),
    ])
    // Y 被半径缩放的错误实现会让 m[5] = 0.15；这里三类都必须为 1。
    expect(matrixOf(data, 0)[5]).toBe(1)
    expect(matrixOf(data, 1)[5]).toBe(1)
    expect(matrixOf(data, 2)[5]).toBe(1)
  })

  test('平移位于索引 12/13/14：sceneX / 0.066 / sceneZ，坐标不做第二次转换', () => {
    // 位置 (12.34, -56.78)；矩阵平移必须逐位等于输入场景坐标（重复转换会让本断言失败）。
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 12.34, z: -56.78 },
        angle: 0,
      }),
    ])
    const m = matrixOf(data, 0)
    expect(m[12]).toBeCloseTo(12.34, 5)
    expect(m[13]).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(m[14]).toBeCloseTo(-56.78, 5)
    expect(m[15]).toBe(1)
  })

  test('缩放等比：每个箭头旋转列长度 = radius（正交且未被错误拉伸）', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: 0.7 }),
    ])
    const m = matrixOf(data, 0)
    // 列 0 长度 = sqrt(m[0]² + m[2]²) = radius；列 2 长度 = sqrt(m[8]² + m[10]²) = radius。
    const col0Len = Math.hypot(m[0], m[2])
    const col2Len = Math.hypot(m[8], m[10])
    expect(col0Len).toBeCloseTo(NODE_ARROW_RADIUS, 6)
    expect(col2Len).toBeCloseTo(NODE_ARROW_RADIUS, 6)
    // 两列正交：m[0]·m[8] + m[2]·m[10] ≈ 0。
    expect(Math.abs(m[0] * m[8] + m[2] * m[10])).toBeCloseTo(0, 6)
  })
})

// ─── 合成：WCAG 黑白对比色（SPEC 8.2 / 7.2）──────────────────────────────────

describe('节点箭头颜色 · WCAG 黑白择色（SPEC 8.2 / 7.2）', () => {
  test('每个作业类型选择与节点基色对比度更高的候选色，结果稳定', () => {
    const types = ['work', 'park', 'charge'] as const
    for (const t of types) {
      const data = buildNodeArrowData([
        sceneNode({
          id: t,
          type: t,
          position: { x: 0, z: 0 },
          angle: 0,
        }),
      ])
      const contrastBlack = contrastRatio(NODE_BASE_HEX[t], ARROW_BLACK_HEX)
      const contrastWhite = contrastRatio(NODE_BASE_HEX[t], ARROW_WHITE_HEX)
      const expectedHex =
        contrastBlack >= contrastWhite ? ARROW_BLACK_HEX : ARROW_WHITE_HEX
      const expected = hexToLinearRGB(expectedHex)
      const actual = colorOf(data, 0)
      for (let k = 0; k < 3; k++) {
        expect(actual[k]).toBeCloseTo(expected[k], 6)
      }
    }
  })

  test('颜色取值仅在线性黑 / 线性白两态之中', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: 0 }),
      sceneNode({ id: 'p', type: 'park', position: { x: 0, z: 0 }, angle: 0 }),
      sceneNode({ id: 'c', type: 'charge', position: { x: 0, z: 0 }, angle: 0 }),
    ])
    const blackLin = hexToLinearRGB(ARROW_BLACK_HEX)
    const whiteLin = hexToLinearRGB(ARROW_WHITE_HEX)
    for (let i = 0; i < data.arrowCount; i++) {
      const col = colorOf(data, i)
      // 每个箭头颜色必须近似等于线性黑或线性白（容差吸收 Float32 末位差异）。
      expect(
        colorEquals(col, blackLin) || colorEquals(col, whiteLin),
      ).toBe(true)
      // 线性区间 [0,1] 且有限。
      for (let k = 0; k < 3; k++) {
        expect(col[k]).toBeGreaterThanOrEqual(0)
        expect(col[k]).toBeLessThanOrEqual(1)
        expect(Number.isFinite(col[k])).toBe(true)
      }
    }
  })

  test('同类节点多次构造颜色稳定（不依赖实例顺序）', () => {
    const a = buildNodeArrowData([
      sceneNode({ id: 'w1', type: 'work', position: { x: 0, z: 0 }, angle: 0 }),
      sceneNode({ id: 'w2', type: 'work', position: { x: 1, z: 1 }, angle: 1 }),
    ])
    const b = buildNodeArrowData([
      sceneNode({ id: 'w2', type: 'work', position: { x: 1, z: 1 }, angle: 1 }),
      sceneNode({ id: 'w1', type: 'work', position: { x: 0, z: 0 }, angle: 0 }),
    ])
    // 两次构造的 work 颜色必须逐分量一致。
    for (let k = 0; k < 3; k++) {
      expect(colorOf(a, 0)[k]).toBeCloseTo(colorOf(b, 1)[k], 6)
      expect(colorOf(a, 1)[k]).toBeCloseTo(colorOf(b, 0)[k], 6)
    }
  })
})

// ─── 合成：bounds 真实几何范围（SPEC 12.1）────────────────────────────────────

describe('节点箭头 bounds · 真实变换后顶点紧致 AABB（SPEC 12.1）', () => {
  test('单个箭头 bounds 等于其 3 个变换后顶点的紧致包围盒', () => {
    // 位置 (10, 20)、angle = 0：tip = (10 + 0.075, 0.066, 20)；back 角 z = 20 ± 0.075。
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 10, z: 20 },
        angle: 0,
      }),
    ])
    const bounds = data.bounds!
    expect(bounds.minX).toBeCloseTo(10, 6) // back 角 x = 10；tip x = 10.075 → min 10
    expect(bounds.maxX).toBeCloseTo(10 + NODE_ARROW_RADIUS / 2, 6) // tip x
    expect(bounds.minY).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(bounds.maxY).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(bounds.minZ).toBeCloseTo(20 - NODE_ARROW_RADIUS / 2, 6) // back-left z
    expect(bounds.maxZ).toBeCloseTo(20 + NODE_ARROW_RADIUS / 2, 6) // back-right z
  })

  test('旋转后 bounds 随之改变：angle = π/2 时 tip 落到 -Z', () => {
    const data = buildNodeArrowData([
      sceneNode({
        id: 'w',
        type: 'work',
        position: { x: 0, z: 0 },
        angle: Math.PI / 2,
      }),
    ])
    const bounds = data.bounds!
    // angle = π/2：tip → -Z 方向 0.075（minZ）；back 角 z ≈ 0（maxZ，cos(π/2) ≈ 0）；
    // back 角 ±X 方向 0.075（sin(π/2) = 1）。
    expect(bounds.minZ).toBeCloseTo(-NODE_ARROW_RADIUS / 2, 6)
    expect(bounds.maxZ).toBeCloseTo(0, 6)
    expect(bounds.minX).toBeCloseTo(-NODE_ARROW_RADIUS / 2, 6)
    expect(bounds.maxX).toBeCloseTo(NODE_ARROW_RADIUS / 2, 6)
  })

  test('多箭头 bounds 为全部箭头的并集', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'w1', type: 'work', position: { x: -5, z: -5 }, angle: 0 }),
      sceneNode({ id: 'w2', type: 'work', position: { x: 5, z: 5 }, angle: 0 }),
    ])
    const bounds = data.bounds!
    // 并集 X/Z 范围覆盖两节点 ± 半径影响。
    expect(bounds.minX).toBeCloseTo(-5, 6)
    expect(bounds.maxX).toBeCloseTo(5 + NODE_ARROW_RADIUS / 2, 6)
    expect(bounds.minZ).toBeCloseTo(-5 - NODE_ARROW_RADIUS / 2, 6)
    expect(bounds.maxZ).toBeCloseTo(5 + NODE_ARROW_RADIUS / 2, 6)
    expect(bounds.minY).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(bounds.maxY).toBeCloseTo(NODE_ARROW_Y, 6)
  })

  test('arrowCount = 0 时 bounds 为 null（无几何贡献）', () => {
    const data = buildNodeArrowData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 } }),
    ])
    expect(data.bounds).toBeNull()
  })
})

// ─── 异常路径 · 整体拒绝（SPEC 5.3 / 14.1 / 16）──────────────────────────────

describe('节点箭头异常路径 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('未知箭头类型 → MAP_ENTITY_INVALID，不输出部分数组', () => {
    // 绕过类型边界注入样本不存在的旧类型 warehouse（type !== 'node' 为真，须收敛校验拦截）。
    const bad = {
      id: 'x',
      name: 'x',
      type: 'warehouse',
      position: { x: 0, z: 0 },
      angle: 0,
    } as unknown as SceneNode
    const err = captureError(() => buildNodeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_ENTITY_INVALID)
      expect(err.entityId).toBe('x')
    }
  })

  test('作业节点 angle = null → MAP_GEOMETRY_INVALID（不替换为零）', () => {
    const err = captureError(() =>
      buildNodeArrowData([
        sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: null }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('w')
    }
  })

  test('作业节点 angle = NaN → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeArrowData([
        sceneNode({
          id: 'w',
          type: 'work',
          position: { x: 0, z: 0 },
          angle: Number.NaN,
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('作业节点 angle = Infinity → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildNodeArrowData([
        sceneNode({
          id: 'w',
          type: 'work',
          position: { x: 0, z: 0 },
          angle: Number.POSITIVE_INFINITY,
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('作业节点坐标非有限 → MAP_GEOMETRY_INVALID，不输出部分数组', () => {
    const err = captureError(() =>
      buildNodeArrowData([
        sceneNode({ id: 'w', type: 'work', position: { x: 0, z: 0 }, angle: 0 }),
        sceneNode({
          id: 'bad',
          type: 'park',
          position: { x: Number.NaN, z: 1 },
          angle: 0,
        }),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('bad')
    }
  })

  test('普通节点 angle = null 正常通过，箭头计数不增加', () => {
    // 普通 node 的 angle = null 不得替换为零或当成箭头；作业节点仍正常产生箭头。
    const data = buildNodeArrowData([
      sceneNode({ id: 'n', type: 'node', position: { x: 0, z: 0 }, angle: null }),
      sceneNode({ id: 'w', type: 'work', position: { x: 1, z: 1 }, angle: 0 }),
    ])
    expect(data.arrowCount).toBe(1)
    expect(data.matrices.length).toBe(16)
    expect(data.colors.length).toBe(3)
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let sceneMap!: SceneMap
let arrowData!: NodeArrowData
let nodeIdToArrowIndex!: Map<string, number>

beforeAll(async () => {
  // SPEC 15.1：哈希不符必须立即终止回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  sceneMap = normalizeSceneMap(rawMap)
  arrowData = buildNodeArrowData(sceneMap.nodes)
  // 重建 node ID → 箭头实例索引映射（跳过普通节点，顺序与 buildNodeArrowData 一致）。
  nodeIdToArrowIndex = new Map<string, number>()
  let arrowIdx = 0
  for (const node of sceneMap.nodes) {
    if (node.type !== 'node') {
      nodeIdToArrowIndex.set(node.id, arrowIdx)
      arrowIdx++
    }
  }
})

describe('真实样本节点箭头 · 规模与有限性（SPEC 2.2 / 5.2 / 15.3）', () => {
  test('464 箭头，矩阵 464×16，颜色 464×3', () => {
    expect(arrowData.arrowCount).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
    expect(arrowData.arrowCount).toBe(
      SAMPLE_NODE_COUNTS.work +
        SAMPLE_NODE_COUNTS.park +
        SAMPLE_NODE_COUNTS.charge,
    )
    expect(arrowData.arrowCount).toBe(464)
    expect(arrowData.matrices.length).toBe(464 * 16)
    expect(arrowData.colors.length).toBe(464 * 3)
  })

  test('全部矩阵与颜色元素为有限数', () => {
    for (let i = 0; i < arrowData.matrices.length; i++) {
      expect(Number.isFinite(arrowData.matrices[i])).toBe(true)
    }
    for (let i = 0; i < arrowData.colors.length; i++) {
      expect(Number.isFinite(arrowData.colors[i])).toBe(true)
    }
  })

  test('全部颜色位于线性 [0,1]，且只在线性黑 / 白之中', () => {
    const blackLin = hexToLinearRGB(ARROW_BLACK_HEX)
    const whiteLin = hexToLinearRGB(ARROW_WHITE_HEX)
    for (let i = 0; i < arrowData.arrowCount; i++) {
      const col = colorOf(arrowData, i)
      for (let k = 0; k < 3; k++) {
        expect(col[k]).toBeGreaterThanOrEqual(0)
        expect(col[k]).toBeLessThanOrEqual(1)
      }
      // 容差吸收 Float32 typed array 与 float64 候选的末位差异。
      expect(
        colorEquals(col, blackLin) || colorEquals(col, whiteLin),
      ).toBe(true)
    }
  })

  test('每个实例矩阵平移 Y 恒为 0.066、缩放 Y 恒为 1', () => {
    for (let i = 0; i < arrowData.arrowCount; i++) {
      expect(arrowData.matrices[i * 16 + 13]).toBeCloseTo(NODE_ARROW_Y, 6)
      expect(arrowData.matrices[i * 16 + 5]).toBe(1)
    }
  })

  test('每个实例方向单位化：(m[0]/r, m[2]/r) 长度为 1', () => {
    for (let i = 0; i < arrowData.arrowCount; i++) {
      const m0 = arrowData.matrices[i * 16 + 0]
      const m2 = arrowData.matrices[i * 16 + 2]
      const ux = m0 / NODE_ARROW_RADIUS
      const uz = m2 / NODE_ARROW_RADIUS
      expect(Math.hypot(ux, uz)).toBeCloseTo(1, 6)
    }
  })

  test('bounds 非空、全部有限，minY = maxY = 0.066', () => {
    const bounds = arrowData.bounds!
    expect(bounds).toBeDefined()
    expect(Number.isFinite(bounds.minX)).toBe(true)
    expect(Number.isFinite(bounds.maxX)).toBe(true)
    expect(Number.isFinite(bounds.minZ)).toBe(true)
    expect(Number.isFinite(bounds.maxZ)).toBe(true)
    expect(bounds.minY).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(bounds.maxY).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(bounds.minX).toBeLessThanOrEqual(bounds.maxX)
    expect(bounds.minZ).toBeLessThanOrEqual(bounds.maxZ)
  })
})

describe('真实样本节点箭头 · 平移与节点坐标一致（SPEC 6.2 / 8.2）', () => {
  test('每个箭头平移 X/Z 等于对应作业节点场景坐标（无重复转换）', () => {
    // 逐箭头比对：第 i 个箭头对应第 i 个作业节点（跳过普通节点）。
    let arrowIdx = 0
    for (const node of sceneMap.nodes) {
      if (node.type === 'node') continue
      const m = arrowIdx * 16
      expect(arrowData.matrices[m + 12]).toBeCloseTo(node.position.x, 5)
      expect(arrowData.matrices[m + 14]).toBeCloseTo(node.position.z, 5)
      arrowIdx++
    }
    expect(arrowIdx).toBe(arrowData.arrowCount)
  })
})

describe('真实样本节点箭头 · 固定回归实体（SPEC 2.6 / 6.2 / 7.2 / 8.2）', () => {
  test('中文充电节点 178744a4... 产生 1 个箭头，平移 (-57.53, -1.06)，颜色为 WCAG 择高', () => {
    const id = FIXED_ENTITIES.chineseChargeNode.id
    const idx = nodeIdToArrowIndex.get(id)
    expect(idx).toBeDefined()
    const m = matrixOf(arrowData, idx!)
    // SPEC 6.2 固定场景点：(-57.53, -1.06)。
    expect(m[12]).toBeCloseTo(-57.53, 2)
    expect(m[13]).toBeCloseTo(NODE_ARROW_Y, 6)
    expect(m[14]).toBeCloseTo(-1.06, 2)
    // charge 基色 #8BC34A 的 WCAG 择高结果。
    const contrastBlack = contrastRatio(NODE_BASE_HEX.charge, ARROW_BLACK_HEX)
    const contrastWhite = contrastRatio(NODE_BASE_HEX.charge, ARROW_WHITE_HEX)
    const expectedHex =
      contrastBlack >= contrastWhite ? ARROW_BLACK_HEX : ARROW_WHITE_HEX
    const expected = hexToLinearRGB(expectedHex)
    const col = colorOf(arrowData, idx!)
    for (let k = 0; k < 3; k++) {
      expect(col[k]).toBeCloseTo(expected[k], 6)
    }
    // 方向单位化。
    const ux = m[0] / NODE_ARROW_RADIUS
    const uz = m[2] / NODE_ARROW_RADIUS
    expect(Math.hypot(ux, uz)).toBeCloseTo(1, 6)
  })

  test('普通节点 d0f03a8c... 不产生箭头（不在箭头索引映射中）', () => {
    const id = FIXED_ENTITIES.normalNode.id
    expect(nodeIdToArrowIndex.has(id)).toBe(false)
  })
})
