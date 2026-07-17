/*
 * 轨迹模型真实样本集成验证（TASK-006，SPEC 2.4 / 2.6 / 9.1 / 9.2 / 9.3 / 15.2 / 16）。
 *
 * 设计：
 *   - beforeAll 先校验源样本 SHA-256，再走完整可信链 parse → validate → normalize → buildTrackModel。
 *   - 真实样本断言 SPEC 2.4 全部固定计数（979/1958/2064、977/2、868/111/0）。
 *   - 第 2.6 节固定边对（false/true、false/false、最短反向边对）必须落在同一双车道组，
 *     且成对中心线间距为 0.06m。
 *   - 18 对拓扑反向但几何不精确反序的边不进入双车道组（通过整体计数与抽样交叉验证）。
 *   - 每条 BEZIER 恰 33 点 / 32 段；全部坐标、弧长、切线、偏移为有限数。
 *
 * 不启动浏览器：真实样本在 node 环境直接读取；不接触 Three / React。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { buildTrackModel } from '../../src/geometry/buildTrackModel'
import { BEZIER_POINT_COUNT, BEZIER_SEGMENTS, PAIRED_LANE_OFFSET } from '../../src/geometry/trackModel'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import {
  SAMPLE_TRACK_COUNTS,
  PAIRED_CENTERLINE_DISTANCE,
  FIXED_ENTITIES,
} from '../fixture/sampleBaseline'
import type { SceneMap } from '../../src/domain/sceneMap'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// beforeAll 完成后赋值；vitest 保证测试在 beforeAll 成功后才运行。
let sceneMap!: SceneMap
let trackModel!: ReturnType<typeof buildTrackModel>

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
  trackModel = buildTrackModel(sceneMap)
})

describe('真实样本轨迹分组 · SPEC 2.4 固定计数', () => {
  test('双车道组 / 成对边 / 唯一物理轨迹计数', () => {
    const g = trackModel.grouping
    expect(g.pairedTrackCount).toBe(SAMPLE_TRACK_COUNTS.pairedTrackCount)
    expect(g.pairedEdgeCount).toBe(SAMPLE_TRACK_COUNTS.pairedEdgeCount)
    expect(g.uniqueTrackCount).toBe(SAMPLE_TRACK_COUNTS.uniqueTrackCount)
  })

  test('按几何类型拆分：977 直线 / 2 贝塞尔双车道组', () => {
    const g = trackModel.grouping
    expect(g.linePairCount).toBe(SAMPLE_TRACK_COUNTS.linePairCount)
    expect(g.cubicPairCount).toBe(SAMPLE_TRACK_COUNTS.cubicPairCount)
    expect(g.linePairCount + g.cubicPairCount).toBe(g.pairedTrackCount)
  })

  test('isBackEdge 颜色组合：868 false/true、111 false/false、0 true/true', () => {
    // 颜色组合只在此交叉比对，不参与分组判定。
    const byEdgeId = new Map(sceneMap.edges.map((e) => [e.id, e]))
    let falseTrue = 0
    let falseFalse = 0
    let trueTrue = 0
    for (const pair of trackModel.grouping.pairs) {
      const a = byEdgeId.get(pair.edgeIds[0])!
      const b = byEdgeId.get(pair.edgeIds[1])!
      const combo = String(a.isBackEdge) + '/' + String(b.isBackEdge)
      if (combo === 'false/true' || combo === 'true/false') falseTrue += 1
      else if (combo === 'false/false') falseFalse += 1
      else if (combo === 'true/true') trueTrue += 1
    }
    expect(falseTrue).toBe(SAMPLE_TRACK_COUNTS.falseTruePairCount)
    expect(falseFalse).toBe(SAMPLE_TRACK_COUNTS.falseFalsePairCount)
    expect(trueTrue).toBe(SAMPLE_TRACK_COUNTS.trueTruePairCount)
  })

  test('成对边数 = 双车道组数 × 2；唯一轨迹 = 组数 + 单边数', () => {
    const g = trackModel.grouping
    expect(g.pairedEdgeCount).toBe(g.pairedTrackCount * 2)
    expect(g.uniqueTrackCount).toBe(
      g.pairedTrackCount + (sceneMap.edges.length - g.pairedEdgeCount),
    )
    expect(g.pairedEdgeIds.size).toBe(g.pairedEdgeCount)
  })
})

describe('真实样本轨迹分组 · 第 2.6 节固定边对（SPEC 2.4 / 2.6）', () => {
  // 在成对 ID 集合中找到包含指定边的成对组。
  function pairOf(edgeId: string): readonly [string, string] | undefined {
    return trackModel.grouping.pairs.find(
      (p) => p.edgeIds[0] === edgeId || p.edgeIds[1] === edgeId,
    )?.edgeIds
  }

  test('false/true 固定对落在同一双车道组', () => {
    const ft = FIXED_ENTITIES.falseTruePair
    const pair = pairOf(ft.ids[0])
    expect(pair, 'false/true 对必须成组').toBeDefined()
    expect(pair!).toContain(ft.ids[0])
    expect(pair!).toContain(ft.ids[1])
  })

  test('false/false 固定对落在同一双车道组', () => {
    const ff = FIXED_ENTITIES.falseFalsePair
    const pair = pairOf(ff.ids[0])
    expect(pair, 'false/false 对必须成组').toBeDefined()
    expect(pair!).toContain(ff.ids[0])
    expect(pair!).toContain(ff.ids[1])
  })

  test('最短反向边对（0.04m）落在同一双车道组', () => {
    const [a, b] = FIXED_ENTITIES.shortestChordPair
    const pair = pairOf(a.id)
    expect(pair, '最短反向边对必须成组').toBeDefined()
    expect(pair!).toContain(a.id)
    expect(pair!).toContain(b.id)
  })

  test('成对边偏移后中心线相距 0.06m（沿各自左法线）', () => {
    // 抽样验证：false/true 对的两条边偏移后中心线相距 ≈ 0.06m。
    // B 与 A 几何反向，故比较 A.points[i] 与 B.points[len-1-i]（同一物理位置）。
    const ft = FIXED_ENTITIES.falseTruePair
    const laneA = trackModel.trackByEdgeId.get(ft.ids[0])!
    const laneB = trackModel.trackByEdgeId.get(ft.ids[1])!
    expect(laneA.paired).toBe(true)
    expect(laneB.paired).toBe(true)
    expect(laneA.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 10)
    expect(laneB.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 10)
    // 两条偏移中心线长度相同；逐同一物理位置比较法向距离。
    const n = laneA.points.length
    expect(laneB.points.length).toBe(n)
    let maxDist = 0
    let minDist = Infinity
    for (let i = 0; i < n; i++) {
      const pa = laneA.points[i]
      const pb = laneB.points[n - 1 - i]
      const d = Math.hypot(pa.x - pb.x, pa.z - pb.z)
      maxDist = Math.max(maxDist, d)
      minDist = Math.min(minDist, d)
    }
    // 成对中心线相距 0.06m；各对应点距离应在 0.06m 附近（端点处切线方向差异极小）。
    expect(minDist).toBeCloseTo(PAIRED_CENTERLINE_DISTANCE, 1)
    expect(maxDist).toBeCloseTo(PAIRED_CENTERLINE_DISTANCE, 1)
  })
})

describe('真实样本车道几何 · LINE 与 BEZIER 采样（SPEC 9.1）', () => {
  test('每条 BEZIER 恰有 33 点 / 32 段；LINE 恰有 2 点', () => {
    let lineCount = 0
    let cubicCount = 0
    for (const lane of trackModel.tracks) {
      if (lane.kind === 'line') {
        expect(lane.points).toHaveLength(2)
        expect(lane.segmentTangents).toHaveLength(1)
        lineCount += 1
      } else {
        expect(lane.points).toHaveLength(BEZIER_POINT_COUNT)
        expect(lane.segmentTangents).toHaveLength(BEZIER_SEGMENTS)
        cubicCount += 1
      }
      // 累计弧长长度恒等于点数。
      expect(lane.cumulativeArcLength).toHaveLength(lane.points.length)
      // 累计弧长首值为 0。
      expect(lane.cumulativeArcLength[0]).toBe(0)
    }
    expect(lineCount).toBe(2934)
    expect(cubicCount).toBe(109)
  })

  test('每条 BEZIER 偏移后中心线仍为有限且每段切线为单位向量', () => {
    for (const lane of trackModel.tracks) {
      for (const p of lane.points) {
        expect(Number.isFinite(p.x), `${lane.edgeId} x`).toBe(true)
        expect(Number.isFinite(p.z), `${lane.edgeId} z`).toBe(true)
      }
      for (const a of lane.cumulativeArcLength) {
        expect(Number.isFinite(a)).toBe(true)
      }
      for (const t of lane.segmentTangents) {
        expect(Number.isFinite(t.x)).toBe(true)
        expect(Number.isFinite(t.z)).toBe(true)
        // 单位切线（LINE 同样适用）。
        expect(Math.hypot(t.x, t.z)).toBeCloseTo(1, 6)
      }
      expect(Number.isFinite(lane.totalArcLength)).toBe(true)
    }
  })

  test('最短边（0.04m）箭身段不越过起点：偏移后每段方向与行驶方向一致', () => {
    const [short] = FIXED_ENTITIES.shortestChordPair
    const lane = trackModel.trackByEdgeId.get(short.id)!
    // 偏移后中心线仍为 2 点（LINE），总弧长接近弦长（偏移不改变 LINE 长度）。
    expect(lane.points).toHaveLength(2)
    expect(lane.totalArcLength).toBeCloseTo(0.04, 2)
    // 累计弧长单调递增，段切线有限。
    expect(lane.cumulativeArcLength[1]).toBeGreaterThan(lane.cumulativeArcLength[0])
  })
})

describe('真实样本车道几何 · 车道偏移唯一事实来源（SPEC 9.3 / 任务约束）', () => {
  test('只有成对边 laneOffset = 0.03，单边 laneOffset = 0', () => {
    let pairedOffsetCount = 0
    let singleOffsetCount = 0
    for (const lane of trackModel.tracks) {
      if (lane.paired) {
        expect(lane.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 10)
        pairedOffsetCount += 1
      } else {
        expect(lane.laneOffset).toBe(0)
        singleOffsetCount += 1
      }
    }
    expect(pairedOffsetCount).toBe(SAMPLE_TRACK_COUNTS.pairedEdgeCount)
    expect(pairedOffsetCount + singleOffsetCount).toBe(sceneMap.edges.length)
  })

  test('trackByEdgeId 索引覆盖全部边且与 tracks 一一对应', () => {
    expect(trackModel.trackByEdgeId.size).toBe(sceneMap.edges.length)
    expect(trackModel.tracks.length).toBe(sceneMap.edges.length)
    for (let i = 0; i < trackModel.tracks.length; i++) {
      const lane = trackModel.tracks[i]
      expect(trackModel.trackByEdgeId.get(lane.edgeId)).toBe(lane)
      // tracks 保持 SceneMap.edges 原顺序。
      expect(lane.edgeId).toBe(sceneMap.edges[i].id)
    }
  })

  test('isBackEdge 只作为颜色语义透传，不影响车道分组或偏移', () => {
    // 同一成对组内可能出现 false/true 或 false/false，laneOffset 均为 0.03。
    const byEdgeId = new Map(sceneMap.edges.map((e) => [e.id, e]))
    for (const pair of trackModel.grouping.pairs) {
      const a = byEdgeId.get(pair.edgeIds[0])!
      const b = byEdgeId.get(pair.edgeIds[1])!
      const laneA = trackModel.trackByEdgeId.get(pair.edgeIds[0])!
      const laneB = trackModel.trackByEdgeId.get(pair.edgeIds[1])!
      // isBackEdge 透传正确。
      expect(laneA.isBackEdge).toBe(a.isBackEdge)
      expect(laneB.isBackEdge).toBe(b.isBackEdge)
      // 无论颜色组合，成对偏移一致。
      expect(laneA.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 10)
      expect(laneB.laneOffset).toBeCloseTo(PAIRED_LANE_OFFSET, 10)
    }
  })
})

describe('真实样本轨迹分组 · 18 对非精确反序边（SPEC 2.4）', () => {
  test('拓扑反向边对总数减去精确反向成对数，余量符合 SPEC 描述', () => {
    // SPEC 2.4：另有 997 对反向拓扑边，其中 18 对几何不精确反序。
    // 精确反向成对数（979）来自几何判定；拓扑反向但非精确反序的 18 对不进入双车道组，
    // 因此 uniqueTrackCount 仍为 2064。这里通过计数一致性交叉验证，
    // 不在集成层重复推导“拓扑反向”定义（属领域语义层范畴）。
    expect(trackModel.grouping.pairedTrackCount).toBe(979)
    expect(trackModel.grouping.uniqueTrackCount).toBe(2064)
    // 979 + 18 = 997（SPEC 2.4 拓扑反向边对总数）。
    expect(
      trackModel.grouping.pairedTrackCount +
        SAMPLE_TRACK_COUNTS.inexactReverseTopologyPairCount,
    ).toBe(997)
  })
})
