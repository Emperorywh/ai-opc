import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLING_CONFIG } from '../src/features/agv-map/config/geometryConfig'
import { normalizeMap } from '../src/features/agv-map/domain/normalize'
import type { RawMapAsset, RawMapPayload } from '../src/features/agv-map/domain/rawDto'
import { extractMapPayload, validateRawMap } from '../src/features/agv-map/domain/validation'
import { sampleEdges } from '../src/features/agv-map/geometry/pathSampling'
import { computeMapSpace, mapToWorld } from '../src/features/agv-map/geometry/worldCoords'

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
  throw new Error('V76 载荷校验未通过，无法进入采样集成测试')
}

const model = normalizeMap(payload)
const sampled = sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG)

describe('V76 路径采样', () => {
  it('全部 3045 条边采样无错误、无零长度段', () => {
    expect(sampled).toHaveLength(3045)
    for (const se of sampled) {
      expect(se.path.points.length).toBeGreaterThanOrEqual(2)
      for (let i = 1; i < se.path.points.length; i += 1) {
        const prev = se.path.points[i - 1]
        const curr = se.path.points[i]
        expect(
          Math.hypot(curr.x - prev.x, curr.y - prev.y),
          `零长度段：edge=${se.edgeId} index=${i}`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('2936 条直线恰产生 2 个采样点', () => {
    const lineCounts = sampled.filter((s) => s.path.points.length === 2)
    let lineEdgeCount = 0
    for (const edge of model.edges) {
      if (edge.path.kind === 'line') lineEdgeCount += 1
    }
    expect(lineEdgeCount).toBe(2936)
    expect(lineCounts).toHaveLength(2936)
  })

  it('109 条贝塞尔首尾端点完整保留', () => {
    for (const edge of model.edges) {
      if (edge.path.kind !== 'cubic-bezier') continue
      const se = sampled.find((s) => s.edgeId === edge.id)
      expect(se, `贝塞尔边 ${edge.id} 缺少采样结果`).toBeDefined()
      if (!se) continue
      const pts = se.path.points
      expect(pts[0]).toEqual(edge.path.start)
      expect(pts[pts.length - 1]).toEqual(edge.path.end)
      // 贝塞尔采样至少需要内部细分点；两端点之外应有多于 0 个中间点。
      expect(pts.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('贝塞尔相邻采样点弦长不超过 0.25 m', () => {
    for (const edge of model.edges) {
      if (edge.path.kind !== 'cubic-bezier') continue
      const se = sampled.find((s) => s.edgeId === edge.id)
      if (!se) continue
      for (let i = 1; i < se.path.points.length; i += 1) {
        const d = Math.hypot(
          se.path.points[i].x - se.path.points[i - 1].x,
          se.path.points[i].y - se.path.points[i - 1].y,
        )
        expect(d, `edge=${edge.id} 弦长超限`).toBeLessThanOrEqual(0.25 + 1e-9)
      }
    }
  })

  it('采样结果字节级稳定：两次全量采样输出一致', () => {
    const first = JSON.stringify(sampled)
    const second = JSON.stringify(sampleEdges(model.edges, DEFAULT_SAMPLING_CONFIG))
    expect(second).toEqual(first)
  })
})

describe('V76 地图中心与世界坐标', () => {
  const space = computeMapSpace(
    model.nodes.map((n) => n.position),
    sampled.map((s) => s.path),
  )

  it('地图中心为有限值', () => {
    expect(Number.isFinite(space.center.x)).toBe(true)
    expect(Number.isFinite(space.center.y)).toBe(true)
  })

  it('地图中心位于节点 AABB 内', () => {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of model.nodes) {
      if (n.position.x < minX) minX = n.position.x
      if (n.position.x > maxX) maxX = n.position.x
      if (n.position.y < minY) minY = n.position.y
      if (n.position.y > maxY) maxY = n.position.y
    }
    expect(space.center.x).toBeGreaterThanOrEqual(minX)
    expect(space.center.x).toBeLessThanOrEqual(maxX)
    expect(space.center.y).toBeGreaterThanOrEqual(minY)
    expect(space.center.y).toBeLessThanOrEqual(maxY)
  })

  it('地图中心确定性：两次计算字节级一致', () => {
    const a = JSON.stringify(space)
    const b = JSON.stringify(
      computeMapSpace(
        model.nodes.map((n) => n.position),
        sampled.map((s) => s.path),
      ),
    )
    expect(b).toEqual(a)
  })

  it('世界坐标映射后中心点落在世界原点', () => {
    const w = mapToWorld(space.center, space)
    // 几何原点；-(0) 产生 -0，用模长判定避免有符号零歧义。
    expect(Math.hypot(w.x, w.y, w.z)).toBe(0)
  })

  it('世界坐标全部为有限值', () => {
    for (const n of model.nodes) {
      const w = mapToWorld(n.position, space)
      expect(Number.isFinite(w.x)).toBe(true)
      expect(Number.isFinite(w.y)).toBe(true)
      expect(Number.isFinite(w.z)).toBe(true)
    }
  })
})
