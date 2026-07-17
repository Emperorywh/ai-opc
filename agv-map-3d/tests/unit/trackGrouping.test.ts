/*
 * 精确反向轨迹分组自动化验证（TASK-006，SPEC 2.4 / 5.3 第 13 项 / 9.2 / 15.2 / 16）。
 *
 * 设计：
 *   - 合成 SceneEdge 集合用于精确数值与异常路径：canonical 匹配、双精度确认、
 *     三重、同向重复、混合类型与拓扑反向但几何不反向。
 *   - 不启动浏览器：只调用纯函数 groupCoincidentTracks，不接触 Three / React。
 *   - 不依赖数组下标：成对关系与计数由几何特征与 ID 集合断言。
 */
import { describe, test, expect } from 'vitest'
import { groupCoincidentTracks } from '../../src/geometry/trackGrouping'
import { TRACK_MATCH_EPSILON } from '../../src/geometry/trackModel'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import type {
  SceneBezierEdge,
  SceneLineEdge,
} from '../../src/domain/sceneMap'

function line(
  id: string,
  sx: number,
  sz: number,
  ex: number,
  ez: number,
  isBackEdge = false,
): SceneLineEdge {
  return {
    kind: 'line',
    id,
    name: id,
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: sx, z: sz },
    end: { x: ex, z: ez },
    isBackEdge,
  }
}

function bezier(
  id: string,
  s: [number, number],
  c1: [number, number],
  c2: [number, number],
  e: [number, number],
  isBackEdge = false,
): SceneBezierEdge {
  return {
    kind: 'cubic',
    id,
    name: id,
    startNodeId: 'n1',
    endNodeId: 'n2',
    start: { x: s[0], z: s[1] },
    control1: { x: c1[0], z: c1[1] },
    control2: { x: c2[0], z: c2[1] },
    end: { x: e[0], z: e[1] },
    isBackEdge,
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

describe('精确反向分组 · LINE canonical 匹配（SPEC 9.2）', () => {
  test('两条 LINE 精确反向 → 成对，唯一轨迹数 = 1', () => {
    const g = groupCoincidentTracks([
      line('A', 0, 0, 1, 1),
      line('B', 1, 1, 0, 0),
    ])
    expect(g.pairedTrackCount).toBe(1)
    expect(g.pairedEdgeCount).toBe(2)
    expect(g.uniqueTrackCount).toBe(1)
    expect(g.linePairCount).toBe(1)
    expect(g.cubicPairCount).toBe(0)
    expect(g.pairedEdgeIds.has('A')).toBe(true)
    expect(g.pairedEdgeIds.has('B')).toBe(true)
    expect(g.pairs).toHaveLength(1)
    expect(g.pairs[0].kind).toBe('line')
  })

  test('两条 LINE 同向不重合 → 互不相干，各自单边', () => {
    const g = groupCoincidentTracks([
      line('A', 0, 0, 1, 0),
      line('B', 5, 5, 6, 5),
    ])
    expect(g.pairedTrackCount).toBe(0)
    expect(g.uniqueTrackCount).toBe(2)
  })
})

describe('精确反向分组 · BEZIER canonical 匹配（SPEC 9.2）', () => {
  test('两条 BEZIER 按 [S,C1,C2,E] 反序列精确重合 → 成对', () => {
    // A: S(0,0) C1(0,1) C2(1,1) E(1,0)。
    // 反向 B 必须为 [E,C2,C1,S] = S(1,0) C1(1,1) C2(0,1) E(0,0)。
    const g = groupCoincidentTracks([
      bezier('A', [0, 0], [0, 1], [1, 1], [1, 0]),
      bezier('B', [1, 0], [1, 1], [0, 1], [0, 0]),
    ])
    expect(g.pairedTrackCount).toBe(1)
    expect(g.cubicPairCount).toBe(1)
    expect(g.linePairCount).toBe(0)
    expect(g.pairs[0].kind).toBe('cubic')
  })

  test('BEZIER 控制点不精确反序（拓扑反向但几何不反向）→ 不成组', () => {
    // A 标准曲线；B 端点反向但 C1/C2 互换错误 → 与 A 反序列逐项差 > EPS。
    const g = groupCoincidentTracks([
      bezier('A', [0, 0], [0, 1], [1, 1], [1, 0]),
      // 反序列应为 S(1,0) C1(1,1) C2(0,1) E(0,0)；这里故意把 C1/C2 改为 (0.5,1)/(0.5,1)。
      bezier('B', [1, 0], [0.5, 1], [0.5, 1], [0, 0]),
    ])
    expect(g.pairedTrackCount).toBe(0)
    expect(g.uniqueTrackCount).toBe(2)
  })
})

describe('精确反向分组 · 双精度确认（SPEC 9.2 / 任务约束）', () => {
  test('落在同桶但原始误差 > 1e-6 → 不得误分组', () => {
    // 构造两条 BEZIER：canonical 控制点的 cell 多重集相同（→ 同无向桶），
    // 但反序列逐项最大差远大于 EPS（控制点排列为既非正向也非反向）。
    // A: S(0,0) C1(0,1) C2(1,1) E(1,0)。
    // B: S(0,0) C1(1,1) C2(0,1) E(1,0) —— 控制点 C1/C2 互换，cell 多重集相同，
    //    但与 A 的正向 / 反向序列都不重合。
    const g = groupCoincidentTracks([
      bezier('A', [0, 0], [0, 1], [1, 1], [1, 0]),
      bezier('B', [0, 0], [1, 1], [0, 1], [1, 0]),
    ])
    // 同桶候选，但原始双精度确认失败 → 不得成组。
    expect(g.pairedTrackCount).toBe(0)
    expect(g.uniqueTrackCount).toBe(2)
  })

  test('反序列逐项差小于 1e-6 容差内 → 成组（量化 key 命中同 cell）', () => {
    // 选远离 cell 边界的扰动：1e-7（cell(0)=0、cell(1e-7)=round(0.1)=0，同 cell）。
    // A=(0,0)→(1,0)；B=(1,0)→(1e-7,0)，反序列逐项最大差 = 1e-7 < EPS。
    const delta = 1e-7
    const g = groupCoincidentTracks([
      line('A', 0, 0, 1, 0),
      line('B', 1, 0, delta, 0),
    ])
    expect(g.pairedTrackCount).toBe(1)
    expect(delta).toBeLessThan(TRACK_MATCH_EPSILON)
  })
})

describe('精确反向分组 · isBackEdge 隔离（SPEC 2.4 / 任务约束）', () => {
  test('isBackEdge 不影响成组：false/false、false/true、true/true 均按几何成组', () => {
    const ff = groupCoincidentTracks([
      line('A', 0, 0, 1, 0, false),
      line('B', 1, 0, 0, 0, false),
    ])
    expect(ff.pairedTrackCount).toBe(1)

    const ft = groupCoincidentTracks([
      line('A', 0, 0, 1, 0, false),
      line('B', 1, 0, 0, 0, true),
    ])
    expect(ft.pairedTrackCount).toBe(1)

    const tt = groupCoincidentTracks([
      line('A', 0, 0, 1, 0, true),
      line('B', 1, 0, 0, 0, true),
    ])
    expect(tt.pairedTrackCount).toBe(1)
  })
})

describe('精确反向分组 · 异常路径（SPEC 5.3 第 13 项 / 9.2 / 14.1）', () => {
  test('同向重复轨迹 → MAP_GEOMETRY_INVALID', () => {
    const err = captureError(() =>
      groupCoincidentTracks([
        line('A', 0, 0, 1, 0),
        line('B', 0, 0, 1, 0),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.message).toMatch(/同向重复/)
    }
  })

  test('三重轨迹 → MAP_GEOMETRY_INVALID', () => {
    // 三条边共享同一物理轨迹（A 正向、B/C 反向）→ B、C 同向重复也会先触发；
    // 这里直接构造三条互相精确反向重合是不可达的（第三条必然与某一条同向）。
    // 改为验证三条相同 forward 边必然触发同向重复或三重错误（任一 MAP_GEOMETRY_INVALID 即可）。
    const err = captureError(() =>
      groupCoincidentTracks([
        line('A', 0, 0, 1, 0),
        line('B', 0, 0, 1, 0),
        line('C', 0, 0, 1, 0),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('三重轨迹：A 正向 + B 反向 + C 反向 → B/C 同向重复触发错误', () => {
    // A=(0,0)→(1,0)；B=(1,0)→(0,0)；C=(1,0)→(0,0)。
    // A 与 B 精确反向；A 与 C 精确反向；B 与 C 同向重复 → 必然报错。
    const err = captureError(() =>
      groupCoincidentTracks([
        line('A', 0, 0, 1, 0),
        line('B', 1, 0, 0, 0),
        line('C', 1, 0, 0, 0),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
    }
  })

  test('混合 LINE/BEZIER 同物理轨迹 → MAP_GEOMETRY_INVALID', () => {
    // LINE 沿 +X 从 (0,0) 到 (3,0)；BEZIER 控制点全部在该线段上 → 同物理轨迹。
    const err = captureError(() =>
      groupCoincidentTracks([
        line('L', 0, 0, 3, 0),
        bezier('Z', [0, 0], [1, 0], [2, 0], [3, 0]),
      ]),
    ) as Error
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) {
      expect(err.code).toBe(MapErrorCode.MAP_GEOMETRY_INVALID)
      expect(err.message).toMatch(/混合/)
    }
  })

  test('LINE 与 BEZIER 仅共享端点但路径不同 → 不报混合错误', () => {
    // LINE 直线，BEZIER 弯曲远离直线 → 不是同轨迹。
    const g = groupCoincidentTracks([
      line('L', 0, 0, 3, 0),
      bezier('Z', [0, 0], [1, 2], [2, 2], [3, 0]),
    ])
    expect(g.pairedTrackCount).toBe(0)
    expect(g.uniqueTrackCount).toBe(2)
  })

  test('异常路径不输出部分分组', () => {
    expect(() =>
      groupCoincidentTracks([
        line('A', 0, 0, 1, 0),
        line('B', 0, 0, 1, 0),
      ]),
    ).toThrow()
  })
})

describe('精确反向分组 · 计数与诊断（SPEC 2.4 / 5.2）', () => {
  test('混合单边与成对：唯一轨迹数 = 成对组数 + 单边数', () => {
    const g = groupCoincidentTracks([
      line('A', 0, 0, 1, 0),
      line('B', 1, 0, 0, 0),
      line('C', 5, 5, 6, 6),
    ])
    expect(g.pairedTrackCount).toBe(1)
    expect(g.pairedEdgeCount).toBe(2)
    // 1 成对组 + 1 单边（C）。
    expect(g.uniqueTrackCount).toBe(2)
  })

  test('空输入：零成对、零唯一轨迹', () => {
    const g = groupCoincidentTracks([])
    expect(g.pairedTrackCount).toBe(0)
    expect(g.uniqueTrackCount).toBe(0)
    expect(g.pairs).toEqual([])
  })
})
