import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_SAMPLING_CONFIG,
} from '../src/features/agv-map/config/geometryConfig'
import { normalizeMap } from '../src/features/agv-map/domain/normalize'
import type { RawMapAsset, RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { extractMapPayload, validateRawMap } from '../src/features/agv-map/domain/validation'
import { sampleEdges } from '../src/features/agv-map/geometry/pathSampling'
import { groupLanes } from '../src/features/agv-map/geometry/laneGrouping'

// 直接读取根目录 map.json 源文件作为 V76 基线事实来源。
const mapJsonUrl = new URL('../map.json', import.meta.url)
const rawBytes = fs.readFileSync(mapJsonUrl)
const mapAsset = JSON.parse(rawBytes.toString('utf8')) as RawMapAsset

const extraction = extractMapPayload(mapAsset)
if (!extraction.ok) {
  throw new Error(`提取 V76 载荷失败：${extraction.problems.map((p) => p.path).join(', ')}`)
}
const payload = extraction.payload as RawMapPayload
if (validateRawMap(payload).length > 0) {
  throw new Error('V76 载荷校验未通过，无法进入车道分组集成测试')
}

const model = normalizeMap(payload)
const sampled = sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG)
const groups = groupLanes(sampled, DEFAULT_LANE_GROUPING_CONFIG)

describe('V76 车道分组计数（SPEC §4.2、§7.4）', () => {
  it('产生 998 个双向组与 1049 个单向组', () => {
    const bidirectional = groups.filter((g) => g.kind === 'bidirectional')
    const unidirectional = groups.filter((g) => g.kind === 'unidirectional')
    expect(bidirectional).toHaveLength(998)
    expect(unidirectional).toHaveLength(1049)
    expect(groups).toHaveLength(998 + 1049)
  })

  it('共保留 3045 条有向车道记录', () => {
    const laneCount = groups.reduce((sum, g) => sum + g.lanes.length, 0)
    expect(laneCount).toBe(3045)
  })

  it('全部 3045 条 edgeId 唯一覆盖原始有向边', () => {
    const ids = new Set<string>()
    for (const group of groups) {
      for (const lane of group.lanes) {
        expect(ids.has(lane.edgeId), `重复 edgeId：${lane.edgeId}`).toBe(false)
        ids.add(lane.edgeId)
      }
    }
    expect(ids.size).toBe(3045)
    // 与原始模型 edgeId 集合完全一致。
    const modelIds = new Set(model.edges.map((e) => e.id))
    expect(ids).toEqual(modelIds)
  })
})

describe('V76 车道分组布局约束', () => {
  it('双向组中心间距为 0.36 m（偏移符号 +1 / -1）', () => {
    for (const group of groups) {
      if (group.kind !== 'bidirectional') continue
      expect(group.lanes).toHaveLength(2)
      const signs = group.lanes.map((l) => l.offsetSign).sort()
      expect(signs).toEqual([-1, 1])
    }
    // 中心间距 = (1 - (-1)) × LANE_CENTER_OFFSET_M = 2 × 0.18 = 0.36 m。
    const spacing = 2 * DEFAULT_LANE_GROUPING_CONFIG.laneCenterOffsetM
    expect(spacing).toBeCloseTo(0.36, 10)
  })

  it('单向组偏移符号恒为 0，无侧向偏移', () => {
    for (const group of groups) {
      if (group.kind !== 'unidirectional') continue
      expect(group.lanes).toHaveLength(1)
      expect(group.lanes[0].offsetSign).toBe(0)
      expect(group.lanes[0].flowDirection).toBe(1)
    }
  })

  it('双向组规范方向恒为较小节点 ID 指向较大节点 ID', () => {
    for (const group of groups) {
      if (group.kind !== 'bidirectional') continue
      expect(
        group.canonicalSourceNodeId < group.canonicalTargetNodeId,
        `非规范方向：${group.canonicalSourceNodeId} → ${group.canonicalTargetNodeId}`,
      ).toBe(true)
    }
  })

  it('双向组规范方向车道流向 +1、反方向车道流向 -1', () => {
    for (const group of groups) {
      if (group.kind !== 'bidirectional') continue
      const canonical = group.lanes.find((l) => l.offsetSign === 1)
      const anti = group.lanes.find((l) => l.offsetSign === -1)
      expect(canonical?.flowDirection).toBe(1)
      expect(anti?.flowDirection).toBe(-1)
    }
  })
})

describe('V76 车道分组 — 审计标记隔离与确定性', () => {
  it('翻转原始 isBackEdge 后分组结果字节级不变（TASK-003 验收）', () => {
    // isBackEdge 在规范化时被丢弃；翻转后领域模型与采样完全相同，分组必然一致。
    // 该用例端到端验证审计标记不参与车道布局决策。
    const flippedPayload: RawMapPayload = {
      ...payload,
      edges: payload.edges.map((edge) => ({ ...edge, isBackEdge: !edge.isBackEdge })),
    }
    const flippedModel = normalizeMap(flippedPayload)
    const flippedSampled = sampleEdges(flippedModel.edges, DEFAULT_SAMPLING_CONFIG)
    const flippedGroups = groupLanes(flippedSampled, DEFAULT_LANE_GROUPING_CONFIG)
    expect(JSON.stringify(flippedGroups)).toEqual(JSON.stringify(groups))
  })

  it('确定性：两次全量分组字节级一致', () => {
    const again = groupLanes(
      sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG),
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    expect(JSON.stringify(again)).toEqual(JSON.stringify(groups))
  })
})
