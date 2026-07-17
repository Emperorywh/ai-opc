/*
 * Ribbon 三角化与合并自动化验证（TASK-007，SPEC 7.1 / 7.2 / 9.3 / 9.4 / 15.2 / 15.3 / 16）。
 *
 * 设计：
 *   - 合成 LaneGeometry 用于精确数值与绕序断言：quad 两个三角形 +Y 朝向、
 *     左 / 右转弯 bevel 补片交换外侧点后仍 +Y 朝向、butt cap 不越端点、双车道 0.06m 间距。
 *   - 异常路径：清理后少于 2 点、非有限坐标、非有限颜色 → MAP_GEOMETRY_INVALID，不输出部分 ribbon。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 buildRibbonGeometry，
 *     断言合并顶点数固定 48,669、单份连续数组、全部有限、颜色线性 [0,1]、bounds 合理。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRibbonGeometry, RIBBON_HALF_WIDTH } from '../../src/geometry/ribbonGeometry'
import { hexToLinearRGB } from '../../src/geometry/colorSpace'
import {
  buildLaneGeometry,
  PAIRED_LANE_OFFSET,
} from '../../src/geometry/centerlineSampling'
import type { LaneGeometry } from '../../src/geometry/trackModel'
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

/*
 * 合成 LaneGeometry 构造工具：直接给定偏移后中心线点序与 isBackEdge，
 * 跳过 buildLaneGeometry 的采样 / 偏移流水，使绕序与几何断言可精确控制。
 */
function laneFromPoints(
  edgeId: string,
  points: ReadonlyArray<{ x: number; z: number }>,
  isBackEdge: boolean,
): LaneGeometry {
  return {
    edgeId,
    kind: 'line',
    isBackEdge,
    points: points.map((p) => ({ x: p.x, z: p.z })),
    cumulativeArcLength: [],
    segmentTangents: [],
    totalArcLength: 0,
    laneOffset: 0,
    paired: false,
  }
}

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
 * 从 ribbon positions 中取第 vi 个顶点的 (x, y, z)。
 */
function vertex(positions: Float32Array, vi: number): [number, number, number] {
  return [positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]]
}

/*
 * 三角形 (V0, V1, V2) 的叉积法线 y 分量（SPEC 9.4：从 +Y 观察为逆时针时 y > 0）。
 * 推导：(V1-V0) × (V2-V0) 的 y 分量 = dz1*dx2 - dx1*dz2。
 */
function crossY(
  v0: readonly [number, number, number],
  v1: readonly [number, number, number],
  v2: readonly [number, number, number],
): number {
  const dx1 = v1[0] - v0[0]
  const dz1 = v1[2] - v0[2]
  const dx2 = v2[0] - v0[0]
  const dz2 = v2[2] - v0[2]
  return dz1 * dx2 - dx1 * dz2
}

describe('ribbon 合并策略 · 单份连续结果（SPEC 9.4 / 15.3）', () => {
  test('多条边合并为一份 positions / colors，长度 = vertexCount × 3', () => {
    const tracks: LaneGeometry[] = [
      laneFromPoints('A', [{ x: 0, z: 0 }, { x: 1, z: 0 }], false),
      laneFromPoints('B', [{ x: 0, z: 5 }, { x: 0, z: 6 }], true),
    ]
    const ribbon = buildRibbonGeometry(tracks)
    // 两条 LINE：各 1 段 quad = 6 顶点，无内部点 → 共 12 顶点。
    expect(ribbon.vertexCount).toBe(12)
    expect(ribbon.positions.length).toBe(12 * 3)
    expect(ribbon.colors.length).toBe(12 * 3)
    expect(ribbon.positions).toBeInstanceOf(Float32Array)
    expect(ribbon.colors).toBeInstanceOf(Float32Array)
  })

  test('y 分量恒为 0（几何层只表达 x-z 平面 ribbon）', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('A', [{ x: 0, z: 0 }, { x: 2, z: 0 }], false),
    ])
    for (let i = 0; i < ribbon.vertexCount; i++) {
      expect(ribbon.positions[i * 3 + 1]).toBe(0)
    }
    expect(ribbon.bounds.minY).toBe(0)
    expect(ribbon.bounds.maxY).toBe(0)
  })
})

describe('ribbon quad 绕序 · 从 +Y 观察为逆时针（SPEC 9.4 第 4 项）', () => {
  test('沿 +X 段两个三角形叉积法线均指向 +Y', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('A', [{ x: 0, z: 0 }, { x: 2, z: 0 }], false),
    ])
    // 单段 quad：前 3 顶点为三角形 A，紧接 3 顶点为三角形 B。
    const tA0 = vertex(ribbon.positions, 0)
    const tA1 = vertex(ribbon.positions, 1)
    const tA2 = vertex(ribbon.positions, 2)
    const tB0 = vertex(ribbon.positions, 3)
    const tB1 = vertex(ribbon.positions, 4)
    const tB2 = vertex(ribbon.positions, 5)
    expect(crossY(tA0, tA1, tA2)).toBeGreaterThan(0)
    expect(crossY(tB0, tB1, tB2)).toBeGreaterThan(0)
  })

  test('沿 +Z 段（任意方向）两个三角形叉积法线均指向 +Y', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('A', [{ x: 0, z: 0 }, { x: 0, z: 3 }], false),
    ])
    expect(crossY(vertex(ribbon.positions, 0), vertex(ribbon.positions, 1), vertex(ribbon.positions, 2))).toBeGreaterThan(0)
    expect(crossY(vertex(ribbon.positions, 3), vertex(ribbon.positions, 4), vertex(ribbon.positions, 5))).toBeGreaterThan(0)
  })
})

describe('ribbon bevel 补片 · 左右转弯交换外侧点后仍 +Y（SPEC 9.4 第 5 项）', () => {
  test('左转弯：bevel 补片叉积法线指向 +Y', () => {
    // P0=(0,0) → P1=(1,0) → P2=(1,1)：+X 转 +Z，左转。
    const ribbon = buildRibbonGeometry([
      laneFromPoints('L', [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], false),
    ])
    // 2 段 quad = 12 顶点，1 个内部点 bevel = 3 顶点 → bevel 位于末 3 顶点。
    expect(ribbon.vertexCount).toBe(15)
    const b0 = vertex(ribbon.positions, 12)
    const b1 = vertex(ribbon.positions, 13)
    const b2 = vertex(ribbon.positions, 14)
    expect(crossY(b0, b1, b2)).toBeGreaterThan(0)
  })

  test('右转弯：bevel 补片叉积法线指向 +Y（验证交换外侧点）', () => {
    // P0=(0,0) → P1=(1,0) → P2=(1,-1)：+X 转 -Z，右转；必须交换外点才 +Y。
    const ribbon = buildRibbonGeometry([
      laneFromPoints('R', [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: -1 }], false),
    ])
    expect(ribbon.vertexCount).toBe(15)
    const b0 = vertex(ribbon.positions, 12)
    const b1 = vertex(ribbon.positions, 13)
    const b2 = vertex(ribbon.positions, 14)
    expect(crossY(b0, b1, b2)).toBeGreaterThan(0)
  })

  test('bevel 补片中心点等于折线内部点', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('L', [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], false),
    ])
    // bevel 第二个顶点为中心点 P1=(1,0)。
    const center = vertex(ribbon.positions, 13)
    expect(center[0]).toBeCloseTo(1, 10)
    expect(center[2]).toBeCloseTo(0, 10)
  })
})

describe('ribbon butt cap · 不越过端点（SPEC 9.4 第 6 项）', () => {
  test('直线段 ribbon x 范围恰好 [0, 2]，不延长中心线', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('A', [{ x: 0, z: 0 }, { x: 2, z: 0 }], false),
    ])
    expect(ribbon.bounds.minX).toBeCloseTo(0, 10)
    expect(ribbon.bounds.maxX).toBeCloseTo(2, 10)
    expect(ribbon.bounds.minZ).toBeCloseTo(-RIBBON_HALF_WIDTH, 10)
    expect(ribbon.bounds.maxZ).toBeCloseTo(RIBBON_HALF_WIDTH, 10)
  })

  test('首段 startLeft / startRight 即原起点 ± 半宽法线，无越界帽', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('A', [{ x: 5, z: 5 }, { x: 7, z: 5 }], false),
    ])
    // startLeft / startRight = (5,5) ± (0, 0.025) → (5, 5.025) 与 (5, 4.975)。
    // positions 为 Float32（SPEC 6.2 写入 typed array 时转换），容差按 Float32 精度取 5 位。
    const v0 = vertex(ribbon.positions, 0) // 三角形 A 第一顶点 = startLeft
    expect(v0[0]).toBeCloseTo(5, 5)
    expect(v0[2]).toBeCloseTo(5 + RIBBON_HALF_WIDTH, 5)
    const v2 = vertex(ribbon.positions, 2) // 三角形 A 第三顶点 = startRight
    expect(v2[0]).toBeCloseTo(5, 5)
    expect(v2[2]).toBeCloseTo(5 - RIBBON_HALF_WIDTH, 5)
  })
})

describe('ribbon 颜色 · isBackEdge 选择 + 线性 sRGB（SPEC 7.2 / 9.4 / 5.2）', () => {
  test('isBackEdge=false → #BDBDBD 线性；isBackEdge=true → #E57373 线性', () => {
    const forward = buildRibbonGeometry([
      laneFromPoints('F', [{ x: 0, z: 0 }, { x: 1, z: 0 }], false),
    ])
    const back = buildRibbonGeometry([
      laneFromPoints('B', [{ x: 0, z: 0 }, { x: 1, z: 0 }], true),
    ])
    const expectForward = hexToLinearRGB('#BDBDBD')
    const expectBack = hexToLinearRGB('#E57373')
    // 每条边全部顶点同色；抽检首顶点 RGB。
    expect(forward.colors[0]).toBeCloseTo(expectForward[0], 6)
    expect(forward.colors[1]).toBeCloseTo(expectForward[1], 6)
    expect(forward.colors[2]).toBeCloseTo(expectForward[2], 6)
    expect(back.colors[0]).toBeCloseTo(expectBack[0], 6)
    expect(back.colors[1]).toBeCloseTo(expectBack[1], 6)
    expect(back.colors[2]).toBeCloseTo(expectBack[2], 6)
  })

  test('颜色不是 8-bit 直接除以 255（验证走了 transfer function）', () => {
    // #BDBDBD：189/255 = 0.7412；线性值 ≈ 0.5116，明显小于 0.7412。
    const ribbon = buildRibbonGeometry([
      laneFromPoints('F', [{ x: 0, z: 0 }, { x: 1, z: 0 }], false),
    ])
    const linear = ribbon.colors[0]
    expect(linear).toBeLessThan(189 / 255)
    expect(linear).toBeGreaterThan(0)
    expect(linear).toBeLessThanOrEqual(1)
  })

  test('全部颜色分量位于线性 [0,1] 区间', () => {
    const ribbon = buildRibbonGeometry([
      laneFromPoints('F', [{ x: 0, z: 0 }, { x: 1, z: 0 }], false),
      laneFromPoints('B', [{ x: 0, z: 3 }, { x: 1, z: 3 }], true),
    ])
    for (let i = 0; i < ribbon.colors.length; i++) {
      expect(ribbon.colors[i]).toBeGreaterThanOrEqual(0)
      expect(ribbon.colors[i]).toBeLessThanOrEqual(1)
      expect(Number.isFinite(ribbon.colors[i])).toBe(true)
    }
  })
})

describe('ribbon 双车道 · 0.06m 中心间距与 0.01m 可见间隔（SPEC 9.3 / 9.4 / 15.2）', () => {
  test('精确反向成对两条 LINE 各自偏移 0.03m，ribbon 边缘保留 0.01m 间隔', () => {
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
    const ribbonA = buildRibbonGeometry([laneA])
    const ribbonB = buildRibbonGeometry([laneB])

    // A 中心 z=0.03，半宽 0.025 → z ∈ [0.005, 0.055]。
    expect(ribbonA.bounds.minZ).toBeCloseTo(0.03 - RIBBON_HALF_WIDTH, 10)
    expect(ribbonA.bounds.maxZ).toBeCloseTo(0.03 + RIBBON_HALF_WIDTH, 10)
    // B 中心 z=-0.03 → z ∈ [-0.055, -0.005]。
    expect(ribbonB.bounds.minZ).toBeCloseTo(-0.03 - RIBBON_HALF_WIDTH, 10)
    expect(ribbonB.bounds.maxZ).toBeCloseTo(-0.03 + RIBBON_HALF_WIDTH, 10)

    // 两条中心线相距 0.06m；内侧边缘间隔 0.01m。
    const centerA = (ribbonA.bounds.minZ + ribbonA.bounds.maxZ) / 2
    const centerB = (ribbonB.bounds.minZ + ribbonB.bounds.maxZ) / 2
    expect(Math.abs(centerA - centerB)).toBeCloseTo(0.06, 10)
    const innerGap = ribbonA.bounds.minZ - ribbonB.bounds.maxZ
    expect(innerGap).toBeCloseTo(0.01, 10)
  })
})

describe('ribbon 异常路径 · 整体拒绝（SPEC 9.4 第 1 项 / 14.1 / 16）', () => {
  test('清理后少于 2 个有效点 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildRibbonGeometry([laneFromPoints('A', [{ x: 1, z: 1 }], false)]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('连续重复点清理后不足 2 点 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      buildRibbonGeometry([
        laneFromPoints('A', [{ x: 1, z: 1 }, { x: 1, z: 1 }, { x: 1, z: 1 }], false),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('空输入 → MAP_GEOMETRY_INVALID，不生成空 ribbon', () => {
    const err = captureError(() => buildRibbonGeometry([])) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('非有限坐标 → 构建立即失败', () => {
    const err = captureError(() =>
      buildRibbonGeometry([
        laneFromPoints(
          'A',
          [
            { x: 0, z: 0 },
            { x: Number.NaN, z: 1 },
          ],
          false,
        ),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('3 点折线中间点含 NaN → 构建立即失败（不得被去重静默丢弃）', () => {
    // 回归上一轮 medium 缺口：Math.hypot(NaN,5) = NaN，NaN >= 1e-9 为 false，
    // 若不在去重前校验有限性，中间 NaN 点会被当作重复点丢弃，折线压成 2 点后构建成功。
    // 这里断言该路径必须整体失败，杜绝非有限几何泄漏。
    const err = captureError(() =>
      buildRibbonGeometry([
        laneFromPoints(
          'A',
          [
            { x: 0, z: 0 },
            { x: Number.NaN, z: 5 },
            { x: 10, z: 0 },
          ],
          false,
        ),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('3 点折线末尾点含 NaN → 构建立即失败（不得被去重静默丢弃）', () => {
    // 末尾 NaN 同理：去重时与首点比较得 NaN，会被当作重复点丢弃，剩 2 点构建成功。
    const err = captureError(() =>
      buildRibbonGeometry([
        laneFromPoints(
          'A',
          [
            { x: 0, z: 0 },
            { x: 5, z: 0 },
            { x: Number.NaN, z: 5 },
          ],
          false,
        ),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })
})

describe('ribbon BEZIER · 内部点恒发 bevel，顶点预算匹配（SPEC 9.4 / 9.1）', () => {
  test('33 点 BEZIER：32 段 quad + 31 内部 bevel = 192 + 93 = 285 顶点', () => {
    // 用 buildLaneGeometry 产出真实 33 点偏移中心线（BEZIER）。
    const bez: SceneBezierEdge = {
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
    }
    const lane = buildLaneGeometry(bez, 0)
    expect(lane.points).toHaveLength(33)
    const ribbon = buildRibbonGeometry([lane])
    expect(ribbon.vertexCount).toBe(32 * 6 + 31 * 3)
    expect(ribbon.vertexCount).toBe(285)
  })
})

// ─── 真实样本集成（SPEC 15.1 / 15.3 / 16）──────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

let realRibbon!: ReturnType<typeof buildRibbonGeometry>
let realTracks!: readonly LaneGeometry[]

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
  realTracks = trackModel.tracks
  realRibbon = buildRibbonGeometry(trackModel.tracks)
})

describe('真实样本 ribbon · 合并规模与单份结果（SPEC 9.4 / 15.3）', () => {
  test('全部业务边合并为一份 ribbon，顶点数固定 48,669', () => {
    // 2934 LINE × 6 + 109 BEZIER × 285 = 17,604 + 31,065 = 48,669。
    expect(realTracks).toHaveLength(3043)
    expect(realRibbon.vertexCount).toBe(48669)
    expect(realRibbon.positions.length).toBe(48669 * 3)
    expect(realRibbon.colors.length).toBe(48669 * 3)
  })

  test('positions / colors / bounds 全部为有限数', () => {
    for (let i = 0; i < realRibbon.positions.length; i++) {
      expect(Number.isFinite(realRibbon.positions[i])).toBe(true)
    }
    for (let i = 0; i < realRibbon.colors.length; i++) {
      expect(Number.isFinite(realRibbon.colors[i])).toBe(true)
    }
    const b = realRibbon.bounds
    expect(
      Number.isFinite(b.minX) &&
        Number.isFinite(b.maxX) &&
        Number.isFinite(b.minZ) &&
        Number.isFinite(b.maxZ),
    ).toBe(true)
    expect(b.minY).toBe(0)
    expect(b.maxY).toBe(0)
  })

  test('全部颜色位于线性 [0,1]，且只出现两种边色', () => {
    const forward = hexToLinearRGB('#BDBDBD')
    const back = hexToLinearRGB('#E57373')
    const colorSet = new Set<string>()
    for (let i = 0; i < realRibbon.vertexCount; i++) {
      const r = realRibbon.colors[i * 3]
      const g = realRibbon.colors[i * 3 + 1]
      const b = realRibbon.colors[i * 3 + 2]
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
      // 收敛到 6 位小数后归类，只允许两种边色。
      const key = `${r.toFixed(6)},${g.toFixed(6)},${b.toFixed(6)}`
      colorSet.add(key)
    }
    expect(colorSet.size).toBe(2)
    // 两种颜色确实匹配 SPEC hex 线性化结果。
    expect(
      colorSet.has(`${forward[0].toFixed(6)},${forward[1].toFixed(6)},${forward[2].toFixed(6)}`),
    ).toBe(true)
    expect(
      colorSet.has(`${back[0].toFixed(6)},${back[1].toFixed(6)},${back[2].toFixed(6)}`),
    ).toBe(true)
  })

  test('ribbon bounds 与场景内容范围一致（约 ±84 / ±38）', () => {
    const b = realRibbon.bounds
    // 场景点 x ∈ [-83.92, 83.92]、z ∈ [-37.66, 37.66]；ribbon 额外 ±半宽 + 车道偏移。
    expect(b.minX).toBeLessThan(0)
    expect(b.maxX).toBeGreaterThan(0)
    expect(b.minZ).toBeLessThan(0)
    expect(b.maxZ).toBeGreaterThan(0)
    expect(b.maxX - b.minX).toBeCloseTo(167.84, 0)
    expect(b.maxZ - b.minZ).toBeCloseTo(75.32, 0)
  })

  test('y 分量全部为 0（单份 ribbon 无跨层高度泄漏）', () => {
    for (let i = 0; i < realRibbon.vertexCount; i++) {
      expect(realRibbon.positions[i * 3 + 1]).toBe(0)
    }
  })
})
