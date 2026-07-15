import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_PATH_RIBBON_CONFIG,
  DEFAULT_SAMPLING_CONFIG,
} from '../src/features/agv-map/config/geometryConfig'
import { normalizeMap } from '../src/features/agv-map/domain/normalize'
import type { RawMapAsset, RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { extractMapPayload, validateRawMap } from '../src/features/agv-map/domain/validation'
import { sampleEdges } from '../src/features/agv-map/geometry/pathSampling'
import { groupLanes } from '../src/features/agv-map/geometry/laneGrouping'
import { compilePathGeometry, validatePathGeometry } from '../src/features/agv-map/geometry/pathRibbon'
import { computeMapSpace } from '../src/features/agv-map/geometry/worldCoords'
import { typedArrayBytesEqual } from './helpers/typedArrayBytes'

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
  throw new Error('V76 载荷校验未通过，无法进入扁带集成测试')
}

const model = normalizeMap(payload)
const sampled = sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG)
const groups = groupLanes(sampled, DEFAULT_LANE_GROUPING_CONFIG)
const space = computeMapSpace(
  model.nodes.map((n) => n.position),
  sampled.map((s) => s.path),
)

const compiled = compilePathGeometry(
  groups,
  space,
  DEFAULT_PATH_RIBBON_CONFIG,
  DEFAULT_LANE_GROUPING_CONFIG,
)

describe('V76 路径扁带编译计数（SPEC §7.5、TASK-004）', () => {
  it('保留 3045 条有向边的顶点区间', () => {
    expect(compiled.edgeIds).toHaveLength(3045)
    expect(compiled.geometry.edgeVertexRanges.length).toBe(3045 * 2)
  })

  it('全部 3045 条 edgeId 唯一覆盖原始有向边', () => {
    const ids = new Set(compiled.edgeIds)
    expect(ids.size).toBe(3045)
    const modelIds = new Set(model.edges.map((e) => e.id))
    expect(ids).toEqual(modelIds)
  })

  it('所有车道合并为单一缓冲（非零位置/索引）', () => {
    expect(compiled.geometry.positions.length).toBeGreaterThan(0)
    expect(compiled.geometry.indices.length).toBeGreaterThan(0)
    // 每条边至少 4 顶点（LINE 2 点 × 2 顶点）。
    for (let e = 0; e < 3045; e += 1) {
      const start = compiled.geometry.edgeVertexRanges[e * 2]
      const end = compiled.geometry.edgeVertexRanges[e * 2 + 1]
      expect(end - start).toBeGreaterThanOrEqual(4)
    }
  })
})

describe('V76 路径扁带几何合法性', () => {
  const { geometry } = compiled

  it('完整数据包通过 validatePathGeometry 契约校验（SPEC §7.5、TASK-004）', () => {
    // 全量 V76 编译产物必须满足输出前的全部属性与索引契约，不抛出任何几何错误。
    expect(() => validatePathGeometry(geometry, compiled.edgeIds.length)).not.toThrow()
  })

  it('全部位置/法线/弧长/流向为有限值', () => {
    for (let i = 0; i < geometry.positions.length; i += 1) {
      expect(Number.isFinite(geometry.positions[i]), `位置 #${i} 非有限`).toBe(true)
    }
    for (let i = 0; i < geometry.normals.length; i += 1) {
      expect(Number.isFinite(geometry.normals[i]), `法线 #${i} 非有限`).toBe(true)
    }
    for (let i = 0; i < geometry.pathU.length; i += 1) {
      expect(Number.isFinite(geometry.pathU[i]), `弧长 #${i} 非有限`).toBe(true)
    }
    for (let i = 0; i < geometry.flowDirections.length; i += 1) {
      expect(
        geometry.flowDirections[i] === 1 || geometry.flowDirections[i] === -1,
        `流向 #${i}=${geometry.flowDirections[i]}`,
      ).toBe(true)
    }
  })

  it('法线恒为地面法线 (0,1,0)', () => {
    for (let v = 0; v < geometry.normals.length / 3; v += 1) {
      expect(geometry.normals[v * 3]).toBe(0)
      expect(geometry.normals[v * 3 + 1]).toBe(1)
      expect(geometry.normals[v * 3 + 2]).toBe(0)
    }
  })

  it('全部顶点 Y 分量等于扁带离地高度 0.015 m', () => {
    const h = DEFAULT_PATH_RIBBON_CONFIG.ribbonHeightM
    for (let v = 0; v < geometry.positions.length / 3; v += 1) {
      // Float32 存储精度约 1e-9，使用 6 位小数容差。
      expect(geometry.positions[v * 3 + 1]).toBeCloseTo(h, 6)
    }
  })

  it('索引不越界', () => {
    const vertexCount = geometry.positions.length / 3
    for (let i = 0; i < geometry.indices.length; i += 1) {
      expect(geometry.indices[i]).toBeGreaterThanOrEqual(0)
      expect(geometry.indices[i]).toBeLessThan(vertexCount)
    }
  })

  it('边顶点区间连续不相交地覆盖全部顶点', () => {
    const vertexCount = geometry.positions.length / 3
    for (let e = 0; e < 3045; e += 1) {
      const start = geometry.edgeVertexRanges[e * 2]
      const end = geometry.edgeVertexRanges[e * 2 + 1]
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeLessThanOrEqual(vertexCount)
      expect(end).toBeGreaterThan(start)
      if (e > 0) {
        expect(start).toBe(geometry.edgeVertexRanges[(e - 1) * 2 + 1])
      }
    }
    expect(geometry.edgeVertexRanges[3045 * 2 - 1]).toBe(vertexCount)
  })

  it('每条车道 pathU 从 0 开始单调不减', () => {
    for (let e = 0; e < 3045; e += 1) {
      const start = geometry.edgeVertexRanges[e * 2]
      const end = geometry.edgeVertexRanges[e * 2 + 1]
      // pathU 每顶点 1 个分量，首顶点弧长恒为 0。
      expect(geometry.pathU[start]).toBe(0)
      for (let v = start; v < end - 1; v += 1) {
        expect(geometry.pathU[v + 1]).toBeGreaterThanOrEqual(geometry.pathU[v] - 1e-9)
      }
    }
  })

  it('每个顶点至少被一个三角形引用（无孤立顶点、无裂缝）', () => {
    const referenced = new Uint8Array(geometry.positions.length / 3)
    for (let i = 0; i < geometry.indices.length; i += 1) {
      referenced[geometry.indices[i]] = 1
    }
    for (let v = 0; v < referenced.length; v += 1) {
      expect(referenced[v], `顶点 ${v} 未被引用`).toBe(1)
    }
  })
})

describe('V76 路径扁带 — 流向与车道布局', () => {
  const { geometry, edgeIds } = compiled

  it('单向边全部顶点 flowDirection = +1', () => {
    const idToIdx = new Map(edgeIds.map((id, i) => [id, i]))
    for (const group of groups) {
      if (group.kind !== 'unidirectional') continue
      const e = idToIdx.get(group.lanes[0].edgeId)!
      const start = geometry.edgeVertexRanges[e * 2]
      const end = geometry.edgeVertexRanges[e * 2 + 1]
      for (let v = start; v < end; v += 1) {
        expect(geometry.flowDirections[v]).toBe(1)
      }
    }
  })

  it('双向组规范车道 +1、反方向车道 -1', () => {
    const idToIdx = new Map(edgeIds.map((id, i) => [id, i]))
    for (const group of groups) {
      if (group.kind !== 'bidirectional') continue
      for (const lane of group.lanes) {
        const e = idToIdx.get(lane.edgeId)!
        const start = geometry.edgeVertexRanges[e * 2]
        const end = geometry.edgeVertexRanges[e * 2 + 1]
        for (let v = start; v < end; v += 1) {
          expect(geometry.flowDirections[v]).toBe(lane.flowDirection)
        }
      }
    }
  })
})

describe('V76 路径扁带 — 确定性', () => {
  it('相同输入与配置两次编译逐字节一致（所有 TypedArray）', () => {
    const again = compilePathGeometry(
      groupLanes(sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG), DEFAULT_LANE_GROUPING_CONFIG),
      space,
      DEFAULT_PATH_RIBBON_CONFIG,
      DEFAULT_LANE_GROUPING_CONFIG,
    )
    // 逐字节比较所有可转移 TypedArray（TASK-004 验证方式）。
    const a = compiled.geometry
    const b = again.geometry
    expect(typedArrayBytesEqual(b.positions, a.positions)).toBe(true)
    expect(typedArrayBytesEqual(b.normals, a.normals)).toBe(true)
    expect(typedArrayBytesEqual(b.pathU, a.pathU)).toBe(true)
    expect(typedArrayBytesEqual(b.flowDirections, a.flowDirections)).toBe(true)
    expect(typedArrayBytesEqual(b.indices, a.indices)).toBe(true)
    expect(typedArrayBytesEqual(b.edgeVertexRanges, a.edgeVertexRanges)).toBe(true)
    expect(again.edgeIds).toEqual(compiled.edgeIds)
  })
})
