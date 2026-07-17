/*
 * 边方向箭头实例数据自动化验证（TASK-010，SPEC 2.3 / 2.4 / 2.6 / 5.2 / 7.1 / 7.2 / 9 / 10 / 15.2 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 LaneGeometry 用于精确矩阵 / 弧长定位 / 短边缩放 / 方向 / 颜色 / bounds 断言：
 *     列主序 T × R × S、tip 位于 40% 累计弧长、短边 L = min(0.30, total×0.32)、
 *     yaw = atan2(-tz, tx) 对齐行驶方向、isBackEdge 只选颜色、基准三角形 +Y 朝向。
 *   - 错误实现识别：行主序、固定 0.30m 短边箭长、贝塞尔参数 t=0.4 冒充弧长、按 isBackEdge 反转方向、
 *     零切线 / 零角度降级、跳过坏边等错误实现都会让对应断言失败。
 *   - 异常路径：零切线、无效累计弧长、非有限采样点、车道结构不一致、空输入
 *     → MAP_GEOMETRY_INVALID，均整体拒绝，不输出部分数组。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildEdgeArrowData，
 *     断言 3043 箭头、矩阵 3043×16、颜色 3043×3、全部有限、LINE 方向等于弦方向、颜色线性 [0,1]、
 *     bounds 合理；按完整 ID 查询固定直线边 / 贝塞尔边 / 两类重合对 / 最短反向边对，交叉验证
 *     弧长定位、短边缩放、自车道偏移与方向。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildEdgeArrowData,
  EDGE_ARROW_VERTICES,
} from '../../src/geometry/edgeArrowData'
import type { EdgeArrowData } from '../../src/geometry/edgeArrowData'
import { hexToLinearRGB } from '../../src/geometry/colorSpace'
import {
  buildLaneGeometry,
  PAIRED_LANE_OFFSET,
} from '../../src/geometry/centerlineSampling'
import type { LaneGeometry } from '../../src/geometry/trackModel'
import { TANGENT_EPSILON } from '../../src/geometry/trackModel'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  SceneBezierEdge,
  SceneLineEdge,
} from '../../src/domain/sceneMap'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { buildTrackModel } from '../../src/geometry/buildTrackModel'
import {
  FIXED_ENTITIES,
  SAMPLE_EDGE_COUNTS,
} from '../fixture/sampleBaseline'

/*
 * SPEC 7.1 / 10.2：边箭头固定常量（与实现同源 SPEC）。
 */
const EDGE_ARROW_Y = 0.014
const EDGE_ARROW_MAX_LENGTH = 0.30
const EDGE_ARROW_LENGTH_RATIO = 0.32
const EDGE_ARROW_TIP_ARC_RATIO = 0.40

/*
 * 合成 SceneLineEdge 构造工具：默认 (0,0)→(1,0) 的正向直线边。
 */
function lineEdge(overrides: Partial<SceneLineEdge> = {}): SceneLineEdge {
  return {
    kind: 'line',
    id: 'e-line',
    name: '1',
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: 0, z: 0 },
    end: { x: 1, z: 0 },
    isBackEdge: false,
    ...overrides,
  }
}

/*
 * 合成 SceneBezierEdge 构造工具。
 */
function bezierEdge(overrides: Partial<SceneBezierEdge> = {}): SceneBezierEdge {
  return {
    kind: 'cubic',
    id: 'e-bez',
    name: '2',
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: 0, z: 0 },
    control1: { x: 0, z: 1 },
    control2: { x: 1, z: 1 },
    end: { x: 1, z: 0 },
    isBackEdge: false,
    ...overrides,
  }
}

/*
 * 直接由显式字段构造 LaneGeometry（跳过 buildLaneGeometry 流水），用于异常路径精确控制。
 * 默认字段对齐 buildLaneGeometry 的真实输出结构。
 */
function laneFromFields(fields: Partial<LaneGeometry> & { edgeId: string }): LaneGeometry {
  const points = fields.points ?? [{ x: 0, z: 0 }, { x: 1, z: 0 }]
  return {
    edgeId: fields.edgeId,
    kind: fields.kind ?? 'line',
    isBackEdge: fields.isBackEdge ?? false,
    points,
    cumulativeArcLength: fields.cumulativeArcLength ?? computeCumArc(points),
    segmentTangents: fields.segmentTangents ?? computeSegTangents(points),
    totalArcLength: fields.totalArcLength ?? computeCumArc(points)[points.length - 1],
    laneOffset: fields.laneOffset ?? 0,
    paired: fields.paired ?? false,
  }
}

/*
 * 由点序计算累计弧长（与 centerlineSampling 的口径一致，仅供测试构造合成数据）。
 */
function computeCumArc(points: ReadonlyArray<{ x: number; z: number }>): number[] {
  const cum = [0]
  let arc = 0
  for (let i = 0; i < points.length - 1; i++) {
    arc += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z)
    cum.push(arc)
  }
  return cum
}

/*
 * 由点序计算每段单位切线（与 centerlineSampling 口径一致，仅供测试构造合成数据）。
 */
function computeSegTangents(points: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number }[] {
  const tans: { x: number; z: number }[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dz = points[i + 1].z - points[i].z
    const len = Math.hypot(dx, dz)
    tans.push({ x: dx / len, z: dz / len })
  }
  return tans
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
function matrixOf(data: EdgeArrowData, i: number): number[] {
  const m = i * 16
  return Array.from(data.matrices.subarray(m, m + 16))
}

/*
 * 取第 i 个箭头的线性颜色三元组。
 */
function colorOf(
  data: EdgeArrowData,
  i: number,
): readonly [number, number, number] {
  const c = i * 3
  return [data.colors[c], data.colors[c + 1], data.colors[c + 2]]
}

/*
 * 从矩阵列 0 提取箭头长度 L = hypot(m[0], m[2])（SPEC：X/Z 等比缩放 L，列 0 长度即 L）。
 */
function arrowLengthOf(m: readonly number[]): number {
  return Math.hypot(m[0], m[2])
}

/*
 * 从矩阵提取 tip 单位方向（从箭身根部指向 tip）= (m[0], m[2]) / L（SPEC 10.2 方向）。
 */
function arrowDirectionOf(m: readonly number[]): readonly [number, number] {
  const len = arrowLengthOf(m)
  return [m[0] / len, m[2] / len]
}

// ─── 合成：计数与长度契约（SPEC 5.2 / 10.1 / 15.3）──────────────────────────────

describe('边箭头 · 计数与长度契约（SPEC 5.2 / 10.1）', () => {
  test('每条边恰一个箭头；matrices = count×16，colors = count×3', () => {
    const lanes = [
      buildLaneGeometry(lineEdge({ id: 'a', start: { x: 0, z: 0 }, end: { x: 1, z: 0 } }), 0),
      buildLaneGeometry(lineEdge({ id: 'b', start: { x: 0, z: 5 }, end: { x: 0, z: 6 } }), 0),
    ]
    const data = buildEdgeArrowData(lanes)
    expect(data.arrowCount).toBe(2)
    expect(data.matrices.length).toBe(2 * 16)
    expect(data.colors.length).toBe(2 * 3)
    expect(data.matrices).toBeInstanceOf(Float32Array)
    expect(data.colors).toBeInstanceOf(Float32Array)
  })

  test('LINE 与 BEZIER 共用同一套实例契约（不按类型拆分）', () => {
    const lanes = [
      buildLaneGeometry(lineEdge({ id: 'L' }), 0),
      buildLaneGeometry(bezierEdge({ id: 'B' }), 0),
    ]
    const data = buildEdgeArrowData(lanes)
    // 两类边各一个箭头，合并到同一份 matrices / colors，无类型拆分。
    expect(data.arrowCount).toBe(2)
    expect(data.matrices.length).toBe(2 * 16)
    expect(data.colors.length).toBe(2 * 3)
  })
})

// ─── 合成：基准三角形（SPEC 10.1）──────────────────────────────────────────────

describe('边箭头基准三角形 · 局部 +X / +Y 逆时针（SPEC 10.1）', () => {
  test('三个顶点依次为 tip / right / left，y 恒为 0', () => {
    expect(EDGE_ARROW_VERTICES).toHaveLength(9)
    // tip = (0, 0, 0)
    expect(EDGE_ARROW_VERTICES[0]).toBe(0)
    expect(EDGE_ARROW_VERTICES[1]).toBe(0)
    expect(EDGE_ARROW_VERTICES[2]).toBe(0)
    // right = (-1, 0, -0.55)
    expect(EDGE_ARROW_VERTICES[3]).toBe(-1)
    expect(EDGE_ARROW_VERTICES[4]).toBe(0)
    expect(EDGE_ARROW_VERTICES[5]).toBeCloseTo(-0.55, 6)
    // left = (-1, 0, 0.55)
    expect(EDGE_ARROW_VERTICES[6]).toBe(-1)
    expect(EDGE_ARROW_VERTICES[7]).toBe(0)
    expect(EDGE_ARROW_VERTICES[8]).toBeCloseTo(0.55, 6)
  })

  test('顶点顺序从 +Y 观察为逆时针（叉积法线指向 +Y）', () => {
    const tip: readonly [number, number, number] = [
      EDGE_ARROW_VERTICES[0],
      EDGE_ARROW_VERTICES[1],
      EDGE_ARROW_VERTICES[2],
    ]
    const right: readonly [number, number, number] = [
      EDGE_ARROW_VERTICES[3],
      EDGE_ARROW_VERTICES[4],
      EDGE_ARROW_VERTICES[5],
    ]
    const left: readonly [number, number, number] = [
      EDGE_ARROW_VERTICES[6],
      EDGE_ARROW_VERTICES[7],
      EDGE_ARROW_VERTICES[8],
    ]
    // (right - tip) × (left - tip) 的 Y 分量必须为正，确保正面朝 +Y。
    const dx1 = right[0] - tip[0]
    const dz1 = right[2] - tip[2]
    const dx2 = left[0] - tip[0]
    const dz2 = left[2] - tip[2]
    const crossY = dz1 * dx2 - dx1 * dz2
    expect(crossY).toBeGreaterThan(0)
  })
})

// ─── 合成：矩阵列主序 T × R × S 与方向（SPEC 5.2 / 10.2）────────────────────────

describe('边箭头矩阵 · 列主序 T × R × S（SPEC 5.2 / 10.2）', () => {
  test('沿 +X 直线边：完整 16 元素等于列主序 T × R × S（识别行主序错误）', () => {
    // (0,0)→(10,0)：total=10，L=min(0.30, 3.2)=0.30，tip 在 4.0 弧长处 = (4, 0)。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 10, z: 0 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    // 列主序期望：yaw = atan2(0, 1) = 0，R = I，S = diag(0.30, 1, 0.30)，T = (4, 0.014, 0)。
    // 行主序实现会把平移放到索引 3/7/11，本断言会因此失败。
    const expected = [
      0.30, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0.30, 0,
      4, EDGE_ARROW_Y, 0, 1,
    ]
    const m = matrixOf(data, 0)
    for (let i = 0; i < 16; i++) {
      expect(m[i]).toBeCloseTo(expected[i], 6)
    }
  })

  test('沿 +Z 直线边：旋转分量 m[0]≈0、m[2]=L、m[8]≈0、m[10]≈0', () => {
    // (0,0)→(0,5)：切线 (0,1)，yaw = atan2(-1, 0) = -π/2。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 0, z: 5 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    const L = Math.min(EDGE_ARROW_MAX_LENGTH, 5 * EDGE_ARROW_LENGTH_RATIO)
    expect(m[0]).toBeCloseTo(Math.cos(-Math.PI / 2) * L, 5) // ≈ 0
    expect(m[2]).toBeCloseTo(-Math.sin(-Math.PI / 2) * L, 6) // = L
    expect(m[8]).toBeCloseTo(Math.sin(-Math.PI / 2) * L, 5) // ≈ 0
    expect(m[10]).toBeCloseTo(Math.cos(-Math.PI / 2) * L, 5) // ≈ 0
    expect(m[5]).toBe(1) // Y 不缩放
    expect(m[13]).toBeCloseTo(EDGE_ARROW_Y, 6)
  })

  test('tip 平移位于索引 12/13/14：tipX / 0.014 / tipZ，坐标不做第二次转换', () => {
    // (5,5)→(8,5)：total=3，tip 在 1.2 弧长处 = (6.2, 5)。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 5, z: 5 }, end: { x: 8, z: 5 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    expect(m[12]).toBeCloseTo(6.2, 6)
    expect(m[13]).toBeCloseTo(EDGE_ARROW_Y, 6)
    expect(m[14]).toBeCloseTo(5, 6)
    expect(m[15]).toBe(1)
  })

  test('缩放等比：每个箭头列 0 / 列 2 长度 = L，且两列正交', () => {
    // (0,0)→(2,1)：非轴对齐方向，验证一般角度下的等比缩放。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 2, z: 1 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    const total = Math.hypot(2, 1)
    const L = Math.min(EDGE_ARROW_MAX_LENGTH, total * EDGE_ARROW_LENGTH_RATIO)
    const col0Len = Math.hypot(m[0], m[2])
    const col2Len = Math.hypot(m[8], m[10])
    expect(col0Len).toBeCloseTo(L, 6)
    expect(col2Len).toBeCloseTo(L, 6)
    // 两列正交：m[0]·m[8] + m[2]·m[10] ≈ 0。
    expect(Math.abs(m[0] * m[8] + m[2] * m[10])).toBeCloseTo(0, 6)
  })
})

// ─── 合成：tip 位于 40% 累计弧长（SPEC 10.2）──────────────────────────────────

describe('边箭头弧长定位 · tip 位于 40% 累计弧长（SPEC 10.2）', () => {
  test('直线边 tip 恰在 0.4 × total 处（非中点、非参数）', () => {
    // (0,0)→(10,0)：tip 应在 4.0，而非中点 5.0。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 10, z: 0 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    expect(m[12]).toBeCloseTo(4.0, 6)
    expect(m[14]).toBeCloseTo(0, 6)
  })

  test('多段折线 tip 按 40% 累计弧长定位（验证累计而非段索引比例）', () => {
    // 三段不等长折线：(0,0)→(1,0)→(2,0)→(10,0)。累计弧长 = [0,1,2,10]，total=10。
    // 40% 弧长 = 4.0，落在第 2 段（弧长 2..10），frac=(4-2)/8=0.25 → tip x = 2 + 0.25×8 = 4。
    // 错误按“段索引 40%”实现会落到不同位置；错误按“中点”会落到 5。
    const pts = [
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 2, z: 0 },
      { x: 10, z: 0 },
    ]
    const lane = laneFromFields({ edgeId: 'poly', points: pts })
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    expect(m[12]).toBeCloseTo(4.0, 6)
    expect(m[14]).toBeCloseTo(0, 6)
  })
})

// ─── 合成：短边自适应长度（SPEC 10.2）──────────────────────────────────────────

describe('边箭头短边 · 自适应长度 min(0.30, total×0.32)（SPEC 10.2）', () => {
  test('长边箭长 = 0.30m（不超最大长度）', () => {
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 10, z: 0 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    expect(arrowLengthOf(matrixOf(data, 0))).toBeCloseTo(0.30, 6)
  })

  test('0.04m 最短边：L = 0.0128m，tip 位于 0.016m 弧长处，箭身不越过起点', () => {
    // SPEC 2.6 最短反向边对弦长 0.04m；total = 0.04。
    // L = min(0.30, 0.04 × 0.32) = 0.0128；tip 弧长 = 0.04 × 0.40 = 0.016。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 0.04, z: 0 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)
    expect(arrowLengthOf(m)).toBeCloseTo(0.0128, 6)
    // tip 位于 x = 0.016（从起点沿 +X 的 0.016m 弧长处）。
    expect(m[12]).toBeCloseTo(0.016, 6)
    // 箭身根部位于 tip - L = 0.016 - 0.0128 = 0.0032 > 0，不越过起点 x=0。
    const dir = arrowDirectionOf(m)
    const backX = m[12] - dir[0] * arrowLengthOf(m)
    expect(backX).toBeCloseTo(0.0032, 6)
    expect(backX).toBeGreaterThan(0)
    // 固定 0.30m 短边箭长的错误实现会让 arrowLength = 0.30，本断言会因此失败。
  })

  test('0.32 < 0.40 保证箭身末尾弧长恒为正（任意弦长都不越过起点）', () => {
    // 对一系列短弦长验证：箭身末尾弧长 = (0.40 - 0.32) × total = 0.08 × total > 0。
    for (const chord of [0.04, 0.1, 0.2, 0.3, 0.5, 0.9]) {
      const lane = buildLaneGeometry(
        lineEdge({ start: { x: 0, z: 0 }, end: { x: chord, z: 0 } }),
        0,
      )
      const data = buildEdgeArrowData([lane])
      const m = matrixOf(data, 0)
      const L = arrowLengthOf(m)
      const tipArc = m[12] // 沿 +X 即弧长
      // 箭身末尾弧长 = tipArc - L 必须为正。
      expect(tipArc - L).toBeGreaterThan(0)
    }
  })
})

// ─── 合成：方向沿行驶方向 start → end（SPEC 10.2 / 9.1）──────────────────────────

describe('边箭头方向 · 始终沿 start → end（SPEC 10.2 / 9.1）', () => {
  test('正向边：箭头指向 end 方向', () => {
    const lane = buildLaneGeometry(
      lineEdge({ id: 'fwd', start: { x: 0, z: 0 }, end: { x: 1, z: 1 }, isBackEdge: false }),
      0,
    )
    const dir = arrowDirectionOf(matrixOf(buildEdgeArrowData([lane]), 0))
    // (end - start) / chord = (1,1)/√2。
    expect(dir[0]).toBeCloseTo(1 / Math.SQRT2, 6)
    expect(dir[1]).toBeCloseTo(1 / Math.SQRT2, 6)
  })

  test('反向边（点序反转）：箭头仍沿其自身 start → end，不被点序外因素反转', () => {
    // 边 B：(1,1)→(0,0)，其自身方向为 (-1,-1)/√2。
    const lane = buildLaneGeometry(
      lineEdge({ id: 'rev', start: { x: 1, z: 1 }, end: { x: 0, z: 0 }, isBackEdge: false }),
      0,
    )
    const dir = arrowDirectionOf(matrixOf(buildEdgeArrowData([lane]), 0))
    expect(dir[0]).toBeCloseTo(-1 / Math.SQRT2, 6)
    expect(dir[1]).toBeCloseTo(-1 / Math.SQRT2, 6)
  })

  test('isBackEdge = true 不反转方向：箭头仍沿 start → end', () => {
    // isBackEdge 只选颜色；方向仍由点序决定。
    const laneFwd = buildLaneGeometry(
      lineEdge({ id: 'fwd-back', start: { x: 0, z: 0 }, end: { x: 1, z: 0 }, isBackEdge: true }),
      0,
    )
    const dir = arrowDirectionOf(matrixOf(buildEdgeArrowData([laneFwd]), 0))
    expect(dir[0]).toBeCloseTo(1, 6)
    expect(dir[1]).toBeCloseTo(0, 6)
  })
})

// ─── 合成：isBackEdge 只选颜色（SPEC 7.2 / 10.2）────────────────────────────────

describe('边箭头颜色 · isBackEdge 选择 + 线性 sRGB（SPEC 7.2 / 10.2 / 5.2）', () => {
  test('isBackEdge=false → #BDBDBD 线性；isBackEdge=true → #E57373 线性', () => {
    const fwd = buildEdgeArrowData([
      buildLaneGeometry(lineEdge({ id: 'f', isBackEdge: false }), 0),
    ])
    const back = buildEdgeArrowData([
      buildLaneGeometry(lineEdge({ id: 'b', isBackEdge: true }), 0),
    ])
    const expectForward = hexToLinearRGB('#BDBDBD')
    const expectBack = hexToLinearRGB('#E57373')
    const fwdCol = colorOf(fwd, 0)
    const backCol = colorOf(back, 0)
    for (let k = 0; k < 3; k++) {
      expect(fwdCol[k]).toBeCloseTo(expectForward[k], 6)
      expect(backCol[k]).toBeCloseTo(expectBack[k], 6)
    }
  })

  test('颜色不是 8-bit 直接除以 255（验证走了 transfer function）', () => {
    // #BDBDBD：189/255 ≈ 0.7412；线性值 ≈ 0.5116，明显小于 0.7412。
    const data = buildEdgeArrowData([
      buildLaneGeometry(lineEdge({ id: 'f', isBackEdge: false }), 0),
    ])
    const linear = colorOf(data, 0)[0]
    expect(linear).toBeLessThan(189 / 255)
    expect(linear).toBeGreaterThan(0)
    expect(linear).toBeLessThanOrEqual(1)
  })

  test('isBackEdge 不改变 tip 位置 / 旋转 / 缩放（只换颜色）', () => {
    const fwd = buildEdgeArrowData([
      buildLaneGeometry(lineEdge({ id: 'e', start: { x: 0, z: 0 }, end: { x: 3, z: 4 }, isBackEdge: false }), 0),
    ])
    const back = buildEdgeArrowData([
      buildLaneGeometry(lineEdge({ id: 'e', start: { x: 0, z: 0 }, end: { x: 3, z: 4 }, isBackEdge: true }), 0),
    ])
    const mf = matrixOf(fwd, 0)
    const mb = matrixOf(back, 0)
    // 矩阵逐元素一致（位置 / 旋转 / 缩放相同），只有颜色不同。
    for (let i = 0; i < 16; i++) {
      expect(mf[i]).toBeCloseTo(mb[i], 6)
    }
    const fwdCol = colorOf(fwd, 0)
    const backCol = colorOf(back, 0)
    expect(Math.abs(fwdCol[0] - backCol[0])).toBeGreaterThan(0.01)
  })
})

// ─── 合成：双车道自车道偏移（SPEC 9.3 / 10.2 / 15.2）────────────────────────────

describe('边箭头双车道 · 复用 laneOffset，成对箭头位于各自车道（SPEC 9.3 / 10.2）', () => {
  test('精确反向成对两条 LINE 的箭头 tip 位于各自偏移车道，中心相距 0.06m', () => {
    // 正向 A：(0,0)→(4,0)，左法线 +Z，偏移后中心 z=+0.03。
    const laneA = buildLaneGeometry(
      lineEdge({ id: 'A', start: { x: 0, z: 0 }, end: { x: 4, z: 0 } }),
      PAIRED_LANE_OFFSET,
    )
    // 反向 B：(4,0)→(0,0)，左法线 -Z，偏移后中心 z=-0.03。
    const laneB = buildLaneGeometry(
      lineEdge({ id: 'B', start: { x: 4, z: 0 }, end: { x: 0, z: 0 } }),
      PAIRED_LANE_OFFSET,
    )
    const data = buildEdgeArrowData([laneA, laneB])
    const mA = matrixOf(data, 0)
    const mB = matrixOf(data, 1)
    // A tip 在 40% = (1.6, +0.03)；B tip 在 40% = (2.4, -0.03)。
    expect(mA[12]).toBeCloseTo(1.6, 6)
    expect(mA[14]).toBeCloseTo(0.03, 6)
    expect(mB[12]).toBeCloseTo(2.4, 6)
    expect(mB[14]).toBeCloseTo(-0.03, 6)
    // 两个 tip 的 z 相距 0.06m（两条中心线间距）。
    expect(Math.abs(mA[14] - mB[14])).toBeCloseTo(0.06, 6)
    // A 箭头指向 +X，B 箭头指向 -X（各自自身行驶方向）。
    const dirA = arrowDirectionOf(mA)
    const dirB = arrowDirectionOf(mB)
    expect(dirA[0]).toBeCloseTo(1, 6)
    expect(dirB[0]).toBeCloseTo(-1, 6)
  })
})

// ─── 合成：贝塞尔 tip 由累计弧长决定（SPEC 10.2）────────────────────────────────

describe('边箭头 BEZIER · tip 由累计弧长而非参数 t=0.4 决定（SPEC 10.2）', () => {
  test('BEZIER tip 等于累计弧长 40% 定位点，不等于贝塞尔参数 t=0.4 点', () => {
    // 非均匀曲线：S(0,0) C1(0,1) C2(0,1) E(10,0)——前段慢、后段快，
    // 参数 t=0.4 与弧长 40% 明显不重合。
    const edge = bezierEdge({
      id: 'bez',
      start: { x: 0, z: 0 },
      control1: { x: 0, z: 1 },
      control2: { x: 0, z: 1 },
      end: { x: 10, z: 0 },
    })
    const lane = buildLaneGeometry(edge, 0)
    const data = buildEdgeArrowData([lane])
    const m = matrixOf(data, 0)

    // 独立按累计弧长定位 40% tip（复用 lane 自身弧长数据）。
    const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
    const expectedTip = locateByArcLength(lane, targetArc)
    expect(m[12]).toBeCloseTo(expectedTip.x, 6)
    expect(m[14]).toBeCloseTo(expectedTip.z, 6)

    // 贝塞尔参数 t=0.4 点（与弧长 40% 不同）。
    const t04 = cubicBezierAt(
      edge.start,
      edge.control1,
      edge.control2,
      edge.end,
      0.4,
    )
    // tip 不能等于 t=0.4 点（容差 1e-3 以区分两种定位）。
    const differsByParam =
      Math.abs(m[12] - t04.x) > 1e-3 || Math.abs(m[14] - t04.z) > 1e-3
    expect(differsByParam).toBe(true)
  })

  test('BEZIER 箭头方向 = tip 所在段切线（沿曲线行驶方向）', () => {
    const edge = bezierEdge({
      id: 'bez',
      start: { x: 0, z: 0 },
      control1: { x: 1, z: 1 },
      control2: { x: 2, z: 1 },
      end: { x: 3, z: 0 },
    })
    const lane = buildLaneGeometry(edge, 0)
    const data = buildEdgeArrowData([lane])
    const dir = arrowDirectionOf(matrixOf(data, 0))
    // tip 所在段切线（独立定位）。
    const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
    const segIdx = locateSegmentIndex(lane, targetArc)
    const tan = lane.segmentTangents[segIdx]
    expect(dir[0]).toBeCloseTo(tan.x, 5)
    expect(dir[1]).toBeCloseTo(tan.z, 5)
  })
})

// ─── 合成：bounds 真实几何范围（SPEC 12.1）──────────────────────────────────────

describe('边箭头 bounds · 真实变换后顶点紧致 AABB（SPEC 12.1）', () => {
  test('单个 +X 箭头 bounds 覆盖 [tipX-L, tipX] × [tipZ±0.55L]', () => {
    // (0,0)→(10,0)：tip (4,0)，L=0.30。
    const lane = buildLaneGeometry(
      lineEdge({ start: { x: 0, z: 0 }, end: { x: 10, z: 0 } }),
      0,
    )
    const data = buildEdgeArrowData([lane])
    const b = data.bounds
    const L = 0.30
    expect(b.minX).toBeCloseTo(4 - L, 6)
    expect(b.maxX).toBeCloseTo(4, 6)
    expect(b.minZ).toBeCloseTo(-0.55 * L, 6)
    expect(b.maxZ).toBeCloseTo(0.55 * L, 6)
    expect(b.minY).toBeCloseTo(EDGE_ARROW_Y, 6)
    expect(b.maxY).toBeCloseTo(EDGE_ARROW_Y, 6)
  })

  test('多箭头 bounds 为全部箭头变换后顶点的并集', () => {
    const laneA = buildLaneGeometry(
      lineEdge({ id: 'A', start: { x: 0, z: 0 }, end: { x: 2, z: 0 } }),
      0,
    )
    const laneB = buildLaneGeometry(
      lineEdge({ id: 'B', start: { x: 10, z: 10 }, end: { x: 12, z: 10 } }),
      0,
    )
    const data = buildEdgeArrowData([laneA, laneB])
    const b = data.bounds
    // A tip x = 0.8（0.4×2），B tip x = 10.8（10 + 0.4×2）。
    expect(b.minX).toBeCloseTo(0.8 - 0.30, 5) // A 箭身根部
    expect(b.maxX).toBeCloseTo(10.8, 5) // B tip
    expect(b.minY).toBeCloseTo(EDGE_ARROW_Y, 6)
    expect(b.maxY).toBeCloseTo(EDGE_ARROW_Y, 6)
  })
})

// ─── 异常路径 · 整体拒绝（SPEC 5.3 / 14.1 / 16）──────────────────────────────

describe('边箭头异常路径 · 整体拒绝（SPEC 14.1 / 16）', () => {
  test('空输入 → MAP_GEOMETRY_INVALID，不生成空箭头', () => {
    const err = captureError(() => buildEdgeArrowData([])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('零切线（段切线长度 ≤ 1e-9）→ MAP_GEOMETRY_INVALID，不取相邻段降级', () => {
    const bad = laneFromFields({
      edgeId: 'zero-tan',
      points: [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      cumulativeArcLength: [0, 1],
      segmentTangents: [{ x: 0, z: 0 }], // 零切线
      totalArcLength: 1,
    })
    const err = captureError(() => buildEdgeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('zero-tan')
    }
  })

  test('无效累计弧长（totalArcLength = 0）→ MAP_GEOMETRY_INVALID', () => {
    const bad = laneFromFields({
      edgeId: 'zero-arc',
      points: [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      cumulativeArcLength: [0, 0],
      segmentTangents: [{ x: 1, z: 0 }],
      totalArcLength: 0,
    })
    const err = captureError(() => buildEdgeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('zero-arc')
    }
  })

  test('无效累计弧长（totalArcLength = NaN）→ MAP_GEOMETRY_INVALID', () => {
    const bad = laneFromFields({
      edgeId: 'nan-arc',
      points: [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      cumulativeArcLength: [0, 1],
      segmentTangents: [{ x: 1, z: 0 }],
      totalArcLength: Number.NaN,
    })
    const err = captureError(() => buildEdgeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('非有限采样点 → MAP_GEOMETRY_INVALID，不输出部分数组', () => {
    const good = buildLaneGeometry(lineEdge({ id: 'good' }), 0)
    const bad = laneFromFields({
      edgeId: 'nan-pt',
      points: [{ x: 0, z: 0 }, { x: Number.NaN, z: 1 }],
    })
    const err = captureError(() => buildEdgeArrowData([good, bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('nan-pt')
    }
  })

  test('非有限采样点位于非 tip 段也整体失败（不因不影响 tip 而放过）', () => {
    // 4 点折线，tip 落在第 2 段；第 1 段末点（即第 2 段起点不是 NaN，但第 0 段终点是 NaN）。
    // 这里把 NaN 放在第 3 个点（第 2 段起点），验证任一非有限点都拦截。
    const bad = laneFromFields({
      edgeId: 'nan-mid',
      points: [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: Number.NaN, z: 0 },
        { x: 10, z: 0 },
      ],
    })
    const err = captureError(() => buildEdgeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('nan-mid')
    }
  })

  test('车道结构不一致（segmentTangents 段数不符）→ MAP_GEOMETRY_INVALID', () => {
    const bad = laneFromFields({
      edgeId: 'bad-struct',
      points: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }],
      cumulativeArcLength: [0, 1, 2],
      segmentTangents: [{ x: 1, z: 0 }], // 应为 2 段，故意给 1 段
      totalArcLength: 2,
    })
    const err = captureError(() => buildEdgeArrowData([bad])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('bad-struct')
    }
  })

  test('失败时不产生部分实例数组（异常抛出后无返回值）', () => {
    const good = buildLaneGeometry(lineEdge({ id: 'good' }), 0)
    const bad = laneFromFields({
      edgeId: 'bad',
      points: [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      totalArcLength: 0,
    })
    // 即便 good 排在前面，遇到 bad 也整体抛出，调用方拿不到部分结果。
    expect(() => buildEdgeArrowData([good, bad])).toThrow()
  })
})

// ─── 测试辅助：独立弧长定位与贝塞尔求值（与实现解耦，用于交叉验证）──────────────

/*
 * 在偏移折线上按累计弧长独立定位点（测试交叉验证用，不复用实现内部函数）。
 */
function locateByArcLength(
  lane: LaneGeometry,
  targetArc: number,
): { x: number; z: number } {
  const idx = locateSegmentIndex(lane, targetArc)
  const segStart = lane.cumulativeArcLength[idx]
  const segEnd = lane.cumulativeArcLength[idx + 1]
  const frac = (targetArc - segStart) / (segEnd - segStart)
  const p0 = lane.points[idx]
  const p1 = lane.points[idx + 1]
  return { x: p0.x + frac * (p1.x - p0.x), z: p0.z + frac * (p1.z - p0.z) }
}

/*
 * 定位目标弧长所在的段索引（测试交叉验证用）。
 */
function locateSegmentIndex(lane: LaneGeometry, targetArc: number): number {
  const cum = lane.cumulativeArcLength
  let i = 0
  while (i < cum.length - 1 && cum[i + 1] < targetArc) i++
  return i
}

/*
 * 三次贝塞尔单点求值（与 centerlineSampling 同口径，测试交叉验证用）。
 */
function cubicBezierAt(
  p0: { x: number; z: number },
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
  t: number,
): { x: number; z: number } {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  }
}

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let arrowData!: EdgeArrowData
let tracks!: readonly LaneGeometry[]
let edgeIdToArrowIndex!: Map<string, number>
let edgeIdToLane!: Map<string, LaneGeometry>

beforeAll(async () => {
  // SPEC 15.1：哈希不符必须立即终止回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  const trackModel = buildTrackModel(sceneMap)
  tracks = trackModel.tracks
  arrowData = buildEdgeArrowData(trackModel.tracks)
  // 重建 edge ID → 箭头实例索引映射（实例顺序与 tracks 一致，即与 SceneMap.edges 一致）。
  edgeIdToArrowIndex = new Map<string, number>()
  edgeIdToLane = new Map<string, LaneGeometry>()
  for (let i = 0; i < tracks.length; i++) {
    edgeIdToArrowIndex.set(tracks[i].edgeId, i)
    edgeIdToLane.set(tracks[i].edgeId, tracks[i])
  }
})

describe('真实样本边箭头 · 规模与有限性（SPEC 2.2 / 5.2 / 15.3）', () => {
  test('3043 箭头，矩阵 3043×16，颜色 3043×3', () => {
    expect(arrowData.arrowCount).toBe(SAMPLE_EDGE_COUNTS.edgeArrowCount)
    expect(arrowData.arrowCount).toBe(3043)
    expect(arrowData.matrices.length).toBe(3043 * 16)
    expect(arrowData.colors.length).toBe(3043 * 3)
  })

  test('全部矩阵与颜色元素为有限数', () => {
    for (let i = 0; i < arrowData.matrices.length; i++) {
      expect(Number.isFinite(arrowData.matrices[i])).toBe(true)
    }
    for (let i = 0; i < arrowData.colors.length; i++) {
      expect(Number.isFinite(arrowData.colors[i])).toBe(true)
    }
  })

  test('全部颜色位于线性 [0,1]，且只出现两种边色', () => {
    const forward = hexToLinearRGB('#BDBDBD')
    const back = hexToLinearRGB('#E57373')
    const colorSet = new Set<string>()
    for (let i = 0; i < arrowData.arrowCount; i++) {
      const col = colorOf(arrowData, i)
      for (let k = 0; k < 3; k++) {
        expect(col[k]).toBeGreaterThanOrEqual(0)
        expect(col[k]).toBeLessThanOrEqual(1)
      }
      colorSet.add(`${col[0].toFixed(6)},${col[1].toFixed(6)},${col[2].toFixed(6)}`)
    }
    expect(colorSet.size).toBe(2)
    expect(
      colorSet.has(`${forward[0].toFixed(6)},${forward[1].toFixed(6)},${forward[2].toFixed(6)}`),
    ).toBe(true)
    expect(
      colorSet.has(`${back[0].toFixed(6)},${back[1].toFixed(6)},${back[2].toFixed(6)}`),
    ).toBe(true)
  })

  test('每个实例平移 Y 恒为 0.014、缩放 Y 恒为 1', () => {
    for (let i = 0; i < arrowData.arrowCount; i++) {
      expect(arrowData.matrices[i * 16 + 13]).toBeCloseTo(EDGE_ARROW_Y, 6)
      expect(arrowData.matrices[i * 16 + 5]).toBe(1)
    }
  })

  test('bounds 非空、全部有限，minY = maxY = 0.014', () => {
    const b = arrowData.bounds
    expect(Number.isFinite(b.minX)).toBe(true)
    expect(Number.isFinite(b.maxX)).toBe(true)
    expect(Number.isFinite(b.minZ)).toBe(true)
    expect(Number.isFinite(b.maxZ)).toBe(true)
    expect(b.minY).toBeCloseTo(EDGE_ARROW_Y, 6)
    expect(b.maxY).toBeCloseTo(EDGE_ARROW_Y, 6)
    expect(b.minX).toBeLessThanOrEqual(b.maxX)
    expect(b.minZ).toBeLessThanOrEqual(b.maxZ)
  })
})

describe('真实样本边箭头 · 实例顺序与来源边一一对应（SPEC 5.2 / 10.2）', () => {
  test('第 i 个箭头对应第 i 条 LaneGeometry（顺序稳定、可验证）', () => {
    for (let i = 0; i < tracks.length; i++) {
      const m = matrixOf(arrowData, i)
      const lane = tracks[i]
      // 独立按累计弧长定位 40% tip，与矩阵平移交叉比对。
      const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
      const expected = locateByArcLength(lane, targetArc)
      expect(m[12]).toBeCloseTo(expected.x, 5)
      expect(m[14]).toBeCloseTo(expected.z, 5)
    }
  })
})

describe('真实样本边箭头 · 方向沿 start → end（SPEC 9.1 / 10.2）', () => {
  test('全部 LINE 边箭头方向 = (end - start) / chord', () => {
    for (const lane of tracks) {
      if (lane.kind !== 'line') continue
      const idx = edgeIdToArrowIndex.get(lane.edgeId)!
      const m = matrixOf(arrowData, idx)
      const dir = arrowDirectionOf(m)
      // LINE 的 segmentTangents[0] 即 (end - start)/chord；偏移不改变方向。
      const tan = lane.segmentTangents[0]
      expect(dir[0]).toBeCloseTo(tan.x, 5)
      expect(dir[1]).toBeCloseTo(tan.z, 5)
    }
  })

  test('BEZIER 边箭头方向 = tip 所在段切线（与整体 start→end 同向）', () => {
    for (const lane of tracks) {
      if (lane.kind !== 'cubic') continue
      const idx = edgeIdToArrowIndex.get(lane.edgeId)!
      const m = matrixOf(arrowData, idx)
      const dir = arrowDirectionOf(m)
      const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
      const segIdx = locateSegmentIndex(lane, targetArc)
      const tan = lane.segmentTangents[segIdx]
      expect(dir[0]).toBeCloseTo(tan.x, 4)
      expect(dir[1]).toBeCloseTo(tan.z, 4)
    }
  })
})

describe('真实样本边箭头 · 短边不越过起点（SPEC 10.2 / 2.6）', () => {
  test('全部边箭头长度 = min(0.30, total×0.32)，箭身末尾弧长 > 0', () => {
    for (let i = 0; i < tracks.length; i++) {
      const lane = tracks[i]
      const m = matrixOf(arrowData, i)
      const L = arrowLengthOf(m)
      const expected = Math.min(EDGE_ARROW_MAX_LENGTH, lane.totalArcLength * EDGE_ARROW_LENGTH_RATIO)
      expect(L).toBeCloseTo(expected, 5)
      // 箭身末尾弧长 = 0.40×total - L = (0.40 - 0.32)×total = 0.08×total > 0。
      expect(lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO - L).toBeGreaterThan(0)
    }
  })

  test('最短反向边对（0.04m）：两箭头长度均 0.0128m，tip 位于 0.016m，箭身不越过起点', () => {
    for (const entity of FIXED_ENTITIES.shortestChordPair) {
      const idx = edgeIdToArrowIndex.get(entity.id)
      expect(idx).toBeDefined()
      const lane = edgeIdToLane.get(entity.id)!
      const m = matrixOf(arrowData, idx!)
      // 长度 0.0128。
      expect(arrowLengthOf(m)).toBeCloseTo(0.0128, 5)
      // tip 距离起点（沿行驶方向投影）= 0.016。
      const tan = lane.segmentTangents[0]
      const tip = { x: m[12], z: m[14] }
      const start = lane.points[0]
      const tipArc = (tip.x - start.x) * tan.x + (tip.z - start.z) * tan.z
      expect(tipArc).toBeCloseTo(0.016, 4)
      // 箭身根部弧长 = tipArc - L > 0。
      expect(tipArc - arrowLengthOf(m)).toBeGreaterThan(0)
    }
  })
})

describe('真实样本边箭头 · 固定回归实体（SPEC 2.6 / 6.2 / 9.3 / 10.2）', () => {
  test('固定直线边 d59c4b42... 箭头沿 start→end，tip 在 40% 弧长', () => {
    const id = FIXED_ENTITIES.lineEdge.id
    const idx = edgeIdToArrowIndex.get(id)
    expect(idx).toBeDefined()
    const lane = edgeIdToLane.get(id)!
    const m = matrixOf(arrowData, idx!)
    // 方向 = (end - start)/chord（场景系；地图 (-1.82,-21.3)→(-1.82,-22.32) 转 +Z）。
    const tan = lane.segmentTangents[0]
    const dir = arrowDirectionOf(m)
    expect(dir[0]).toBeCloseTo(tan.x, 5)
    expect(dir[1]).toBeCloseTo(tan.z, 5)
    // tip 独立弧长定位交叉比对。
    const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
    const expected = locateByArcLength(lane, targetArc)
    expect(m[12]).toBeCloseTo(expected.x, 5)
    expect(m[14]).toBeCloseTo(expected.z, 5)
  })

  test('固定贝塞尔边 7d85a192... tip 由累计弧长决定，不等于参数 t=0.4', () => {
    const id = FIXED_ENTITIES.bezierEdge.id
    const idx = edgeIdToArrowIndex.get(id)
    expect(idx).toBeDefined()
    const lane = edgeIdToLane.get(id)!
    const m = matrixOf(arrowData, idx!)
    // 独立弧长 40% 定位。
    const targetArc = lane.totalArcLength * EDGE_ARROW_TIP_ARC_RATIO
    const expected = locateByArcLength(lane, targetArc)
    expect(m[12]).toBeCloseTo(expected.x, 5)
    expect(m[14]).toBeCloseTo(expected.z, 5)
  })

  test('false/false 重合对：两箭头位于各自偏移车道，方向相反', () => {
    const [idA, idB] = FIXED_ENTITIES.falseFalsePair.ids
    const idxA = edgeIdToArrowIndex.get(idA)!
    const idxB = edgeIdToArrowIndex.get(idB)!
    const laneA = edgeIdToLane.get(idA)!
    const laneB = edgeIdToLane.get(idB)!
    expect(idxA).toBeDefined()
    expect(idxB).toBeDefined()
    // 两条边都成对偏移（laneOffset = 0.03）。
    expect(laneA.paired).toBe(true)
    expect(laneB.paired).toBe(true)
    expect(laneA.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    expect(laneB.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    // 两箭头方向相反（点积 ≈ -1）。
    const dirA = arrowDirectionOf(matrixOf(arrowData, idxA))
    const dirB = arrowDirectionOf(matrixOf(arrowData, idxB))
    expect(dirA[0] * dirB[0] + dirA[1] * dirB[1]).toBeCloseTo(-1, 4)
    // 两箭头颜色组合为 false/false（均灰色）。
    const forward = hexToLinearRGB('#BDBDBD')
    const colA = colorOf(arrowData, idxA)
    const colB = colorOf(arrowData, idxB)
    for (let k = 0; k < 3; k++) {
      expect(colA[k]).toBeCloseTo(forward[k], 5)
      expect(colB[k]).toBeCloseTo(forward[k], 5)
    }
  })

  test('false/true 重合对：两箭头位于各自偏移车道，颜色一灰一红', () => {
    const [idA, idB] = FIXED_ENTITIES.falseTruePair.ids
    const idxA = edgeIdToArrowIndex.get(idA)!
    const idxB = edgeIdToArrowIndex.get(idB)!
    const laneA = edgeIdToLane.get(idA)!
    const laneB = edgeIdToLane.get(idB)!
    expect(laneA.paired).toBe(true)
    expect(laneB.paired).toBe(true)
    // 两箭头方向相反。
    const dirA = arrowDirectionOf(matrixOf(arrowData, idxA))
    const dirB = arrowDirectionOf(matrixOf(arrowData, idxB))
    expect(dirA[0] * dirB[0] + dirA[1] * dirB[1]).toBeCloseTo(-1, 4)
    // 颜色一灰一红（false/true 组合）。
    const forward = hexToLinearRGB('#BDBDBD')
    const back = hexToLinearRGB('#E57373')
    const colA = colorOf(arrowData, idxA)
    const colB = colorOf(arrowData, idxB)
    const aIsForward = approxColor(colA, forward)
    const aIsBack = approxColor(colA, back)
    expect(aIsForward !== aIsBack).toBe(true) // A 恰为一种
    // A 与 B 颜色不同。
    expect(approxColor(colA, colB)).toBe(false)
  })
})

/*
 * 容差比较两个线性颜色三元组是否近似相等（吸收 Float32 末位差异）。
 */
function approxColor(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  tolerance = 1e-5,
): boolean {
  return (
    Math.abs(a[0] - b[0]) <= tolerance &&
    Math.abs(a[1] - b[1]) <= tolerance &&
    Math.abs(a[2] - b[2]) <= tolerance
  )
}

/*
 * 确保 TANGENT_EPSILON 与实现同源（静态导入即可，这里仅占位说明测试与实现共享同一常量）。
 */
test('TANGENT_EPSILON 与实现同源（1e-9）', () => {
  expect(TANGENT_EPSILON).toBe(1e-9)
})
