import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANE_GROUPING_CONFIG,
  DEFAULT_NODE_DIMENSIONS_CONFIG,
  DEFAULT_PATH_RIBBON_CONFIG,
  DEFAULT_SAMPLING_CONFIG,
} from '../src/features/agv-map/config/geometryConfig'
import { normalizeMap } from '../src/features/agv-map/domain/normalize'
import type { RawMapAsset, RawMapPayload, RawNodeType } from '../src/features/agv-map/domain/rawDto'
import { extractMapPayload, validateRawMap } from '../src/features/agv-map/domain/validation'
import { compileRenderPacket } from '../src/features/agv-map/geometry/sceneCompile'
import { mapToWorld, computeMapSpace } from '../src/features/agv-map/geometry/worldCoords'
import { computeNodePlacement, NODE_MATRIX_FLOATS } from '../src/features/agv-map/geometry/nodeInstances'
import { sampleEdges } from '../src/features/agv-map/geometry/pathSampling'

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
  throw new Error('V76 载荷校验未通过，无法进入场景编译集成测试')
}

const model = normalizeMap(payload)

const packet = compileRenderPacket(model, {
  sampling: DEFAULT_SAMPLING_CONFIG,
  laneGrouping: DEFAULT_LANE_GROUPING_CONFIG,
  ribbon: DEFAULT_PATH_RIBBON_CONFIG,
  nodeDimensions: DEFAULT_NODE_DIMENSIONS_CONFIG,
})

describe('V76 场景编译 — 节点实例（SPEC §7.2、TASK-005）', () => {
  it('编译结果包含 1768 个节点，四类分别为 1304/389/11/64，无跳过', () => {
    const expected: Record<RawNodeType, number> = { node: 1304, work: 389, charge: 11, park: 64 }
    let total = 0
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const p = packet.nodeInstances[type]
      expect(p.count, `类型 ${type}`).toBe(expected[type])
      expect(p.matrices.length).toBe(p.count * NODE_MATRIX_FLOATS)
      total += p.count
    }
    expect(total).toBe(1768)
    expect(packet.report.nodeCount).toBe(1768)
  })

  it('全部矩阵分量为有限值', () => {
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const m = packet.nodeInstances[type].matrices
      for (let i = 0; i < m.length; i += 1) {
        expect(Number.isFinite(m[i]), `${type} 矩阵分量 #${i}`).toBe(true)
      }
    }
  })

  it('底部贴地：中心 Y 与自身几何半高一致', () => {
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const halfHeight = DEFAULT_NODE_DIMENSIONS_CONFIG.byType[type].sizeYM / 2
      const m = packet.nodeInstances[type].matrices
      for (let i = 0; i < packet.nodeInstances[type].count; i += 1) {
        // 列主序 elements[13] 为平移 Y。
        expect(m[i * NODE_MATRIX_FLOATS + 13]).toBeCloseTo(halfHeight, 6)
      }
    }
  })

  it('普通节点旋转恒等（前向恒为 +X），方向性节点前向为单位向量', () => {
    const nodeM = packet.nodeInstances.node.matrices
    for (let i = 0; i < packet.nodeInstances.node.count; i += 1) {
      const o = i * NODE_MATRIX_FLOATS
      expect(nodeM[o + 0]).toBeCloseTo(1, 6) // cos0 = 1
      expect(nodeM[o + 2]).toBeCloseTo(0, 6) // -sin0 = 0
    }
    for (const type of ['work', 'charge', 'park'] as const) {
      const m = packet.nodeInstances[type].matrices
      for (let i = 0; i < packet.nodeInstances[type].count; i += 1) {
        const o = i * NODE_MATRIX_FLOATS
        const len = Math.hypot(m[o + 0], m[o + 1], m[o + 2])
        expect(len).toBeCloseTo(1, 6)
      }
    }
  })
})

describe('V76 场景编译 — 编译报告（SPEC §5.2、TASK-005）', () => {
  it('稳定给出 1768 节点、3045 有向车道、998 双向组、1049 单向边', () => {
    expect(packet.report.nodeCount).toBe(1768)
    expect(packet.report.edgeLaneCount).toBe(3045)
    expect(packet.report.bidirectionalGroupCount).toBe(998)
    expect(packet.report.unpairedEdgeCount).toBe(1049)
  })

  it('edgeLaneCount = 2 × 双向组 + 单向边', () => {
    const { edgeLaneCount, bidirectionalGroupCount, unpairedEdgeCount } = packet.report
    expect(edgeLaneCount).toBe(2 * bidirectionalGroupCount + unpairedEdgeCount)
  })
})

describe('V76 场景编译 — 渲染边界（SPEC §6.3、TASK-005）', () => {
  const { renderBounds } = packet

  it('全部边界分量为有限值', () => {
    for (const v of [...renderBounds.min, ...renderBounds.max]) {
      expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('min 不大于 max，且覆盖真实地图尺度（非退化）', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(renderBounds.min[i]).toBeLessThan(renderBounds.max[i])
    }
    // V76 地图尺度为数十米量级；X/Z 跨度均应大于 10 m。
    expect(renderBounds.max[0] - renderBounds.min[0]).toBeGreaterThan(10)
    expect(renderBounds.max[2] - renderBounds.min[2]).toBeGreaterThan(10)
    // Y 底部贴地、顶部为最高节点 0.6 m。
    expect(renderBounds.min[1]).toBeCloseTo(0, 6)
    expect(renderBounds.max[1]).toBeCloseTo(0.6, 6)
  })

  it('包含全部路径扁带顶点', () => {
    const { positions } = packet.pathGeometry
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]
      const y = positions[i + 1]
      const z = positions[i + 2]
      expect(x).toBeGreaterThanOrEqual(renderBounds.min[0])
      expect(x).toBeLessThanOrEqual(renderBounds.max[0])
      expect(y).toBeGreaterThanOrEqual(renderBounds.min[1])
      expect(y).toBeLessThanOrEqual(renderBounds.max[1])
      expect(z).toBeGreaterThanOrEqual(renderBounds.min[2])
      expect(z).toBeLessThanOrEqual(renderBounds.max[2])
    }
  })

  it('包含全部节点足迹（中心 ± 旋转后 XZ 半 extents）', () => {
    // 用与 compileRenderPacket 内部一致的方式重建地图空间基准。
    const sampled = sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG)
    const space = computeMapSpace(
      model.nodes.map((n) => n.position),
      sampled.map((s) => s.path),
    )
    for (const n of model.nodes) {
      const p = computeNodePlacement(n, space, DEFAULT_NODE_DIMENSIONS_CONFIG)
      const hxBase = p.dimensions.sizeXM / 2
      const hzBase = p.dimensions.sizeZM / 2
      const cos = Math.abs(Math.cos(p.rotationY))
      const sin = Math.abs(Math.sin(p.rotationY))
      const halfX = hxBase * cos + hzBase * sin
      const halfZ = hxBase * sin + hzBase * cos
      expect(p.worldX - halfX).toBeGreaterThanOrEqual(renderBounds.min[0] - 1e-6)
      expect(p.worldX + halfX).toBeLessThanOrEqual(renderBounds.max[0] + 1e-6)
      expect(p.worldZ - halfZ).toBeGreaterThanOrEqual(renderBounds.min[2] - 1e-6)
      expect(p.worldZ + halfZ).toBeLessThanOrEqual(renderBounds.max[2] + 1e-6)
      // Y：底部 ≥ 0、顶部 ≤ 最高节点。
      expect(p.dimensions.sizeYM).toBeLessThanOrEqual(renderBounds.max[1] + 1e-6)
    }
  })

  it('不只是节点坐标：renderBounds 严格包含节点坐标 AABB', () => {
    // 计算仅节点世界坐标点的 AABB（不含尺寸、不含路径）。
    const space = computeMapSpace(
      model.nodes.map((n) => n.position),
      [],
    )
    let nMinX = Infinity, nMinZ = Infinity, nMaxX = -Infinity, nMaxZ = -Infinity
    for (const n of model.nodes) {
      const w = mapToWorld(n.position, space)
      if (w.x < nMinX) nMinX = w.x
      if (w.x > nMaxX) nMaxX = w.x
      if (w.z < nMinZ) nMinZ = w.z
      if (w.z > nMaxZ) nMaxZ = w.z
    }
    // renderBounds 必须包含节点坐标 AABB（因节点尺寸只往外扩）。
    expect(renderBounds.min[0]).toBeLessThanOrEqual(nMinX)
    expect(renderBounds.max[0]).toBeGreaterThanOrEqual(nMaxX)
    expect(renderBounds.min[2]).toBeLessThanOrEqual(nMinZ)
    expect(renderBounds.max[2]).toBeGreaterThanOrEqual(nMaxZ)
    // renderBounds 应严格大于节点坐标 AABB（含路径扁带 + 车道偏移 + 节点尺寸）。
    const renderSpanX = renderBounds.max[0] - renderBounds.min[0]
    const nodeSpanX = nMaxX - nMinX
    expect(renderSpanX).toBeGreaterThan(nodeSpanX)
  })

  it('扁带宽度与车道偏移进入边界：renderBounds.X 跨度比节点坐标宽出至少带宽量级', () => {
    // 双车道偏移 0.18 m + 半带宽 0.11 m，单侧最大扩展 0.29 m。
    // 节点坐标 AABB 外扩量应至少达到半带宽（0.11 m）级别。
    const space = computeMapSpace(
      model.nodes.map((n) => n.position),
      [],
    )
    let nMinX = Infinity, nMaxX = -Infinity
    for (const n of model.nodes) {
      const w = mapToWorld(n.position, space)
      if (w.x < nMinX) nMinX = w.x
      if (w.x > nMaxX) nMaxX = w.x
    }
    const leftExpansion = nMinX - renderBounds.min[0]
    const rightExpansion = renderBounds.max[0] - nMaxX
    // 至少一侧外扩超过半带宽 0.11 m 的一定比例。
    expect(Math.max(leftExpansion, rightExpansion)).toBeGreaterThan(0.1)
  })
})

describe('V76 场景编译 — 确定性与一致性（TASK-005）', () => {
  it('相同输入与配置两次编译：节点矩阵、路径顶点、边界、报告字节级一致', () => {
    const again = compileRenderPacket(model, {
      sampling: DEFAULT_SAMPLING_CONFIG,
      laneGrouping: DEFAULT_LANE_GROUPING_CONFIG,
      ribbon: DEFAULT_PATH_RIBBON_CONFIG,
      nodeDimensions: DEFAULT_NODE_DIMENSIONS_CONFIG,
    })
    // 节点矩阵
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      const a = packet.nodeInstances[type].matrices
      const b = again.nodeInstances[type].matrices
      expect(b.length).toBe(a.length)
      for (let i = 0; i < a.length; i += 1) {
        expect(b[i]).toBe(a[i])
      }
    }
    // 路径顶点
    const pa = packet.pathGeometry.positions
    const pb = again.pathGeometry.positions
    expect(pb.length).toBe(pa.length)
    for (let i = 0; i < pa.length; i += 1) {
      expect(pb[i]).toBe(pa[i])
    }
    // 边界
    expect(JSON.stringify(again.renderBounds)).toEqual(JSON.stringify(packet.renderBounds))
    // 报告
    expect(again.report).toEqual(packet.report)
  })

  it('RenderPacket 使用可转移 TypedArray（非普通数组）', () => {
    expect(packet.nodeInstances.node.matrices).toBeInstanceOf(Float32Array)
    expect(packet.pathGeometry.positions).toBeInstanceOf(Float32Array)
    expect(packet.pathGeometry.indices).toBeInstanceOf(Uint32Array)
    // ArrayBuffer 可转移，大地图交接不复制缓冲。
    expect(packet.nodeInstances.node.matrices.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('节点实例总数 × 矩阵浮点数等于矩阵缓冲总长度', () => {
    let totalFloats = 0
    for (const type of ['node', 'work', 'charge', 'park'] as const) {
      totalFloats += packet.nodeInstances[type].matrices.length
    }
    expect(totalFloats).toBe(1768 * NODE_MATRIX_FLOATS)
  })
})
