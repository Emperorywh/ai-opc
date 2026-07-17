/*
 * 中心线方向性采样、切线、弧长与车道偏移自动化验证（TASK-006，SPEC 9.1 / 9.3 / 9.4 / 10.2 / 15.2）。
 *
 * 设计：
 *   - 合成 SceneEdge 用于精确数值与异常路径：LINE 2 点、BEZIER 33 点/32 段、
 *     左法线方向、车道偏移距离、零切线与 U 形折返。
 *   - 不启动浏览器：只调用纯函数，不接触 Three / React。
 *   - 不依赖数组下标：成对与几何关系由坐标特征断言。
 */
import { describe, test, expect } from 'vitest'
import {
  buildLaneGeometry,
  sampleCenterline,
  PAIRED_LANE_OFFSET,
} from '../../src/geometry/centerlineSampling'
import {
  BEZIER_POINT_COUNT,
  BEZIER_SEGMENTS,
  TANGENT_EPSILON,
} from '../../src/geometry/trackModel'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  SceneBezierEdge,
  SceneLineEdge,
} from '../../src/domain/sceneMap'

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

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出异常，但未抛出')
}

describe('中心线方向性采样 · 固定点数（SPEC 9.1）', () => {
  test('LINE 固定 2 个中心线点 [S,E]', () => {
    const pts = sampleCenterline(lineEdge())
    expect(pts).toHaveLength(2)
    expect(pts[0]).toEqual({ x: 0, z: 0 })
    expect(pts[1]).toEqual({ x: 1, z: 0 })
  })

  test('BEZIER 固定 33 个点 / 32 段，t = i/32', () => {
    const e = bezierEdge()
    const pts = sampleCenterline(e)
    expect(pts).toHaveLength(BEZIER_POINT_COUNT)
    expect(BEZIER_POINT_COUNT).toBe(33)
    expect(BEZIER_SEGMENTS).toBe(32)
    // 端点严格等于控制点端点。
    expect(pts[0]).toEqual(e.start)
    expect(pts[32]).toEqual(e.end)
    // t=0.5 的中点：标准三次贝塞尔（S=(0,0), C1=(0,1), C2=(1,1), E=(1,0)）。
    const t = 0.5
    const mt = 1 - t
    // 各控制点坐标代入：x 仅 C2/E 贡献，z 仅 C1/C2 贡献。
    const expectMidX = 3 * mt * t * t * 1 + t * t * t * 1
    const expectMidZ = 3 * mt * mt * t * 1 + 3 * mt * t * t * 1
    expect(pts[16].x).toBeCloseTo(expectMidX, 10)
    expect(pts[16].z).toBeCloseTo(expectMidZ, 10)
  })

  test('采样点序保持 start → end，不受 isBackEdge 影响', () => {
    const fwd = sampleCenterline(lineEdge({ isBackEdge: false }))
    const back = sampleCenterline(lineEdge({ isBackEdge: true }))
    // isBackEdge 不改变点序。
    expect(fwd).toEqual(back)
    expect(fwd[0]).toEqual({ x: 0, z: 0 })
    expect(fwd[1]).toEqual({ x: 1, z: 0 })
  })
})

describe('车道几何 · 左法线与车道偏移（SPEC 9.3）', () => {
  test('单边 laneOffset = 0：偏移后中心线与原中心线重合', () => {
    const lane = buildLaneGeometry(lineEdge(), 0)
    expect(lane.laneOffset).toBe(0)
    expect(lane.paired).toBeUndefined()
    expect(lane.points[0]).toEqual({ x: 0, z: 0 })
    expect(lane.points[1]).toEqual({ x: 1, z: 0 })
  })

  test('LINE 沿 +X 行驶时左法线指向 +Z，成对偏移 0.03m 落在 +Z 侧', () => {
    // 切线 (1,0)，左法线 (-0, 1) = (0,1) → 偏移到 +Z 侧。
    const lane = buildLaneGeometry(lineEdge(), PAIRED_LANE_OFFSET)
    expect(lane.laneOffset).toBeCloseTo(0.03, 10)
    expect(lane.points[0].x).toBeCloseTo(0, 10)
    expect(lane.points[0].z).toBeCloseTo(0.03, 10)
    expect(lane.points[1].x).toBeCloseTo(1, 10)
    expect(lane.points[1].z).toBeCloseTo(0.03, 10)
  })

  test('反向 LINE 的左法线相反，成对中心线相距 0.06m', () => {
    // 正向边 A：(0,0)→(1,0)，偏移 +Z 0.03。
    const a = buildLaneGeometry(lineEdge({ id: 'A' }), PAIRED_LANE_OFFSET)
    // 反向边 B：(1,0)→(0,0)，切线 (-1,0)，左法线 (0,-1) → 偏移 -Z 0.03。
    const b = buildLaneGeometry(
      lineEdge({
        id: 'B',
        start: { x: 1, z: 0 },
        end: { x: 0, z: 0 },
      }),
      PAIRED_LANE_OFFSET,
    )
    // 两条中心线在 Z 方向相距 0.06m。
    const aMidZ = (a.points[0].z + a.points[1].z) / 2
    const bMidZ = (b.points[0].z + b.points[1].z) / 2
    expect(Math.abs(aMidZ - bMidZ)).toBeCloseTo(0.06, 10)
    // 两条边各自保持行驶方向：A 朝 +X，B 朝 -X。
    const aDir = a.segmentTangents[0]
    const bDir = b.segmentTangents[0]
    expect(aDir.x).toBeCloseTo(1, 6)
    expect(bDir.x).toBeCloseTo(-1, 6)
  })

  test('BEZIER 成对偏移后内部点沿各自局部左法线移动 0.03m', () => {
    // 用一条对称贝塞尔验证偏移后曲线在容差内与原曲线平行（法向距离 ≈ 0.03）。
    const e = bezierEdge()
    const lane = buildLaneGeometry(e, PAIRED_LANE_OFFSET)
    const original = sampleCenterline(e)
    expect(lane.points).toHaveLength(BEZIER_POINT_COUNT)
    // 每个偏移点与对应原采样点的距离应接近 0.03（左法线单位偏移）。
    for (let i = 0; i < BEZIER_POINT_COUNT; i++) {
      const d = Math.hypot(
        lane.points[i].x - original[i].x,
        lane.points[i].z - original[i].z,
      )
      expect(d).toBeCloseTo(PAIRED_LANE_OFFSET, 6)
    }
  })
})

describe('车道几何 · 切线与累计弧长（SPEC 10.2）', () => {
  test('LINE 总弧长等于端点距离，累计弧长首值为 0', () => {
    const lane = buildLaneGeometry(
      lineEdge({
        start: { x: 0, z: 0 },
        end: { x: 3, z: 4 },
      }),
      0,
    )
    expect(lane.totalArcLength).toBeCloseTo(5, 10)
    expect(lane.cumulativeArcLength[0]).toBe(0)
    expect(lane.cumulativeArcLength[1]).toBeCloseTo(5, 10)
    expect(lane.cumulativeArcLength).toHaveLength(lane.points.length)
    expect(lane.segmentTangents).toHaveLength(lane.points.length - 1)
    // 切线 (0.6, 0.8)。
    expect(lane.segmentTangents[0].x).toBeCloseTo(0.6, 6)
    expect(lane.segmentTangents[0].z).toBeCloseTo(0.8, 6)
  })

  test('BEZIER 累计弧长严格单调递增，段切线为单位向量', () => {
    const lane = buildLaneGeometry(bezierEdge(), 0)
    for (let i = 1; i < lane.cumulativeArcLength.length; i++) {
      expect(lane.cumulativeArcLength[i]).toBeGreaterThan(
        lane.cumulativeArcLength[i - 1],
      )
    }
    for (const t of lane.segmentTangents) {
      expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 6)
    }
    expect(lane.cumulativeArcLength).toHaveLength(BEZIER_POINT_COUNT)
    expect(lane.segmentTangents).toHaveLength(BEZIER_SEGMENTS)
  })
})

describe('车道几何 · 全部输出有限（SPEC 16）', () => {
  test('BEZIER 全部点、弧长、切线均为有限数', () => {
    const lane = buildLaneGeometry(bezierEdge(), PAIRED_LANE_OFFSET)
    for (const p of lane.points) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
    }
    for (const a of lane.cumulativeArcLength) {
      expect(Number.isFinite(a)).toBe(true)
    }
    for (const t of lane.segmentTangents) {
      expect(Number.isFinite(t.x)).toBe(true)
      expect(Number.isFinite(t.z)).toBe(true)
    }
    expect(Number.isFinite(lane.totalArcLength)).toBe(true)
  })
})

describe('车道几何 · 异常路径（SPEC 5.3 第 10 项 / 9.3 / 14.1）', () => {
  test('采样段长度 < 1e-9（零切线）→ MAP_GEOMETRY_INVALID', () => {
    // LINE 端点几乎重合但通过弦长校验：采样段为零切线。
    const eps = TANGENT_EPSILON / 10
    const err = captureError(() =>
      buildLaneGeometry(
        lineEdge({
          start: { x: 0, z: 0 },
          end: { x: eps, z: 0 },
        }),
        0,
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.entityId).toBe('e-line')
    }
  })

  test('BEZIER 内部 U 形折返（相邻切线和 < 1e-9）→ MAP_GEOMETRY_INVALID', () => {
    // 构造一条在某内部点折返的“曲线”：使用采样函数直接构造退化中心线不可行，
    // 改为构造控制点使采样在内部产生近零段。这里用尖点贝塞尔：C1=C2 重合于中点附近，
    // 使相邻段切线接近反向、和接近零。
    // S=(0,0), C1=(1,0), C2=(1,0), E=(0,0)（首尾重合，整体退化为去而复返）。
    const err = captureError(() =>
      buildLaneGeometry(
        bezierEdge({
          start: { x: 0, z: 0 },
          control1: { x: 1, z: 0 },
          control2: { x: 1, z: 0 },
          end: { x: 0, z: 0 },
        }),
        0,
      ),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('零切线错误不输出部分车道几何', () => {
    expect(() =>
      buildLaneGeometry(
        lineEdge({ end: { x: 0, z: 0 } }),
        0,
      ),
    ).toThrow()
  })
})
