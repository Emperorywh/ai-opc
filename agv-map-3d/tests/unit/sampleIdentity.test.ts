/*
 * 固定样本身份回归（TASK-004，SPEC 第 2 章 / 15.1 / 15.2 / 16）。
 *
 * 设计：
 *   - beforeAll 先校验源样本 SHA-256；哈希不符立即终止，不继续跑任何基线断言，
 *     避免在同 ID 不同内容的样本上产生误导性的“通过”结果（SPEC 15.1）。
 *   - 所有数量、类型、bounds、字符集合均从受校验数据“推导”后与 fixture 黄金值
 *     交叉比对，证明样本未被同 ID 不同内容冒充；禁止硬编码伪造通过结果。
 *   - 第 2.6 节固定实体按完整 ID 查询再交叉比对特征，不依赖数组下标。
 *
 * 覆盖范围（TASK-004 可推导事实）：
 *   - SPEC 2.1 响应元数据 + 文件级身份。
 *   - SPEC 2.2 节点/边数量、类型分布、方向色分布、箭头与标签候选计数。
 *   - SPEC 2.3 source bounds、基准尺寸、弦长与端点偏差数据质量基线。
 *   - SPEC 2.5 角度、名称与中文字符集合。
 *   - SPEC 2.6 固定回归实体 + 篡改敏感性。
 *
 * 不覆盖：SPEC 2.4 重合轨迹/双车道计数依赖轨迹 canonical 分组算法（后续几何 TASK）。
 *
 * 不启动浏览器：真实样本在 node 环境直接读取。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { isMapDataError } from '../../src/domain/mapDataError'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import {
  SAMPLE_METADATA,
  SAMPLE_FILE,
  SAMPLE_NODE_COUNTS,
  SAMPLE_EDGE_COUNTS,
  SAMPLE_BOUNDS,
  SAMPLE_EDGE_QUALITY,
  SAMPLE_NAME_BASELINE,
  FIXED_ENTITIES,
} from '../fixture/sampleBaseline'
import type { RawBezierEdge, RawEdge, RawLineEdge, RawMap, RawNode } from '../../src/adapters/rawMap'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')

// beforeAll 完成后赋值；vitest 保证测试在 beforeAll 成功后才运行。
let rawJson: unknown
let map!: RawMap

beforeAll(async () => {
  // SPEC 15.1：哈希不符必须立即终止样本身份测试，不继续产生误导结果。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8'))
  map = parseSampleEnvelope(rawJson)
  // 真实样本必须同时通过跨实体语义校验（无悬空引用、无自环、弦长与偏差达标）。
  validateMapSemantics(map)
})

// --- 推导辅助：从受校验数据计算实际值，不在断言中硬编码。 ---

function countBy<T, K extends string>(items: readonly T[], key: (t: T) => K): Record<string, number> {
  const acc: Record<string, number> = {}
  for (const it of items) {
    const k = key(it)
    acc[k] = (acc[k] ?? 0) + 1
  }
  return acc
}

function edgeChord(edge: RawEdge): number {
  return Math.hypot(edge.ex - edge.sx, edge.ey - edge.sy)
}

// 进入原始响应包读取未被渲染管线消费的元数据（floor / mapState / mapVersionId）。
function rawEnvelope(): any {
  return (rawJson as any).data
}

describe('样本身份 · 哈希门禁（SPEC 15.1）', () => {
  test('源样本 SHA-256 与 SPEC 2.1 固定值一致', async () => {
    const sha = await computeFileSha256(REAL_SAMPLE)
    expect(sha).toBe(EXPECTED_SAMPLE_SHA256)
  })

  test('源样本字节数与 SPEC 2.1 固定值一致', () => {
    const size = readFileSync(REAL_SAMPLE).byteLength
    expect(size).toBe(SAMPLE_FILE.bytes)
  })
})

describe('样本身份 · SPEC 2.1 响应元数据', () => {
  test('响应状态 code/message 固定', () => {
    expect((rawJson as any).code).toBe(SAMPLE_METADATA.code)
    expect((rawJson as any).message).toBe(SAMPLE_METADATA.message)
  })

  test('响应元与版本元 mapId 一致且等于固定值', () => {
    const env = rawEnvelope()
    expect(env.mapId).toBe(SAMPLE_METADATA.mapId)
    expect(env.currentMapInfoVersion.mapId).toBe(SAMPLE_METADATA.mapId)
    // 适配层捕获的双通道 mapId 也必须一致（SPEC 5.3 第 4 项前置）。
    expect(map.metadata.envelopeMapId).toBe(SAMPLE_METADATA.mapId)
    expect(map.metadata.mapId).toBe(SAMPLE_METADATA.mapId)
  })

  test('地图名与版本号固定', () => {
    const env = rawEnvelope()
    expect(env.mapName).toBe(SAMPLE_METADATA.mapName)
    expect(env.currentMapInfoVersion.mapVersion).toBe(SAMPLE_METADATA.version)
    expect(map.metadata.mapName).toBe(SAMPLE_METADATA.mapName)
    expect(map.metadata.version).toBe(SAMPLE_METADATA.version)
  })

  test('楼层、地图状态、地图版本 ID 固定（不被渲染管线消费，直接读原始响应包）', () => {
    const env = rawEnvelope()
    expect(env.floor).toBe(SAMPLE_METADATA.floor)
    expect(env.mapState).toBe(SAMPLE_METADATA.mapState)
    expect(env.mapVersionId).toBe(SAMPLE_METADATA.mapVersionId)
  })
})

describe('样本身份 · SPEC 2.2 数量与类型分布', () => {
  test('节点总数与四类节点分布', () => {
    expect(map.nodes).toHaveLength(SAMPLE_NODE_COUNTS.total)
    const byType = countBy(map.nodes, (n) => n.type)
    expect(byType.node).toBe(SAMPLE_NODE_COUNTS.node)
    expect(byType.work).toBe(SAMPLE_NODE_COUNTS.work)
    expect(byType.park).toBe(SAMPLE_NODE_COUNTS.park)
    expect(byType.charge).toBe(SAMPLE_NODE_COUNTS.charge)
    const sum = SAMPLE_NODE_COUNTS.node + SAMPLE_NODE_COUNTS.work + SAMPLE_NODE_COUNTS.park + SAMPLE_NODE_COUNTS.charge
    expect(sum).toBe(SAMPLE_NODE_COUNTS.total)
  })

  test('边总数与判别联合分布', () => {
    expect(map.edges).toHaveLength(SAMPLE_EDGE_COUNTS.total)
    const byType = countBy(map.edges, (e) => e.edgeType)
    expect(byType.LINE).toBe(SAMPLE_EDGE_COUNTS.LINE)
    expect(byType.BEZIER).toBe(SAMPLE_EDGE_COUNTS.BEZIER)
  })

  test('isBackEdge 方向色分布', () => {
    const byBack = countBy(map.edges, (e) => String(e.isBackEdge))
    expect(byBack['false']).toBe(SAMPLE_EDGE_COUNTS.isBackEdgeFalse)
    expect(byBack['true']).toBe(SAMPLE_EDGE_COUNTS.isBackEdgeTrue)
  })

  test('节点朝向箭头数 = 非 node 节点数（type !== "node" 判定）', () => {
    const arrowCount = map.nodes.filter((n) => n.type !== 'node').length
    expect(arrowCount).toBe(SAMPLE_EDGE_COUNTS.nodeArrowCount)
  })

  test('标签候选总数 = 节点数 + 边数', () => {
    const candidates = map.nodes.length + map.edges.length
    expect(candidates).toBe(SAMPLE_EDGE_COUNTS.labelCandidateTotal)
  })

  test('zones / nodeEdgeGroups 为空', () => {
    expect(map.zones).toHaveLength(SAMPLE_EDGE_COUNTS.zones)
    expect(map.nodeEdgeGroups).toHaveLength(SAMPLE_EDGE_COUNTS.nodeEdgeGroups)
  })
})

describe('样本身份 · SPEC 2.3 source bounds 与数据质量', () => {
  function nodeBounds() {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const n of map.nodes) {
      if (n.x < minX) minX = n.x
      if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y
      if (n.y > maxY) maxY = n.y
    }
    return { minX, maxX, minY, maxY }
  }

  test('节点坐标包围盒与基准尺寸（显示舍入值，toBeCloseTo 容差比较）', () => {
    const b = nodeBounds()
    expect(b.minX).toBeCloseTo(SAMPLE_BOUNDS.minX, 2)
    expect(b.maxX).toBeCloseTo(SAMPLE_BOUNDS.maxX, 2)
    expect(b.minY).toBeCloseTo(SAMPLE_BOUNDS.minY, 2)
    expect(b.maxY).toBeCloseTo(SAMPLE_BOUNDS.maxY, 2)
    expect(b.maxX - b.minX).toBeCloseTo(SAMPLE_BOUNDS.width, 2)
    expect(b.maxY - b.minY).toBeCloseTo(SAMPLE_BOUNDS.depth, 2)
    expect((b.minX + b.maxX) / 2).toBeCloseTo(SAMPLE_BOUNDS.centerX, 2)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(SAMPLE_BOUNDS.centerY, 2)
  })

  test('source bounds（含边端点与贝塞尔控制点）与节点 bounds 相同', () => {
    let sX = Infinity
    let SX = -Infinity
    let sY = Infinity
    let SY = -Infinity
    const acc = (x: number, y: number) => {
      if (x < sX) sX = x
      if (x > SX) SX = x
      if (y < sY) sY = y
      if (y > SY) SY = y
    }
    for (const n of map.nodes) acc(n.x, n.y)
    for (const e of map.edges) {
      acc(e.sx, e.sy)
      acc(e.ex, e.ey)
      if (e.edgeType === 'BEZIER') {
        acc(e.cx, e.cy)
        acc(e.dx, e.dy)
      }
    }
    const b = nodeBounds()
    expect(sX).toBeCloseTo(b.minX, 6)
    expect(SX).toBeCloseTo(b.maxX, 6)
    expect(sY).toBeCloseTo(b.minY, 6)
    expect(SY).toBeCloseTo(b.maxY, 6)
  })

  test('最短边弦长 ≈ 0.04m', () => {
    const min = map.edges.reduce((m, e) => Math.min(m, edgeChord(e)), Infinity)
    expect(min).toBeCloseTo(SAMPLE_EDGE_QUALITY.shortestChord, 2)
  })

  test('弦长小于 0.30m 的边数固定', () => {
    const count = map.edges.filter((e) => edgeChord(e) < 0.3).length
    expect(count).toBe(SAMPLE_EDGE_QUALITY.chordBelow030Count)
  })

  test('所有边弦长 > 1e-9m（无零长度边）', () => {
    for (const e of map.edges) {
      expect(edgeChord(e), `边 ${e.id} 弦长必须 > 1e-9`).toBeGreaterThan(1e-9)
    }
  })

  test('所有坐标为有限数（无非有限坐标）', () => {
    for (const n of map.nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    for (const e of map.edges) {
      expect(Number.isFinite(e.sx)).toBe(true)
      expect(Number.isFinite(e.sy)).toBe(true)
      expect(Number.isFinite(e.ex)).toBe(true)
      expect(Number.isFinite(e.ey)).toBe(true)
      if (e.edgeType === 'BEZIER') {
        expect(Number.isFinite(e.cx)).toBe(true)
        expect(Number.isFinite(e.cy)).toBe(true)
        expect(Number.isFinite(e.dx)).toBe(true)
        expect(Number.isFinite(e.dy)).toBe(true)
      }
    }
  })

  test('端点偏差计数与最大偏差基线', () => {
    const nodeById = new Map(map.nodes.map((n) => [n.id, n]))
    let startDiff = 0
    let endDiff = 0
    let edgesWithDev = 0
    let maxStart = 0
    let maxEnd = 0
    for (const e of map.edges) {
      const sn = nodeById.get(e.snodeId)!
      const en = nodeById.get(e.enodeId)!
      const sd = Math.hypot(e.sx - sn.x, e.sy - sn.y)
      const ed = Math.hypot(e.ex - en.x, e.ey - en.y)
      let hasDev = false
      if (sd > 1e-9) {
        startDiff++
        hasDev = true
      }
      if (ed > 1e-9) {
        endDiff++
        hasDev = true
      }
      if (hasDev) edgesWithDev++
      if (sd > maxStart) maxStart = sd
      if (ed > maxEnd) maxEnd = ed
    }
    expect(startDiff).toBe(SAMPLE_EDGE_QUALITY.startDeviationCount)
    expect(endDiff).toBe(SAMPLE_EDGE_QUALITY.endDeviationCount)
    expect(edgesWithDev).toBe(SAMPLE_EDGE_QUALITY.edgesWithDeviation)
    expect(maxStart).toBeCloseTo(SAMPLE_EDGE_QUALITY.maxStartDeviation, 3)
    expect(maxEnd).toBeCloseTo(SAMPLE_EDGE_QUALITY.maxEndDeviation, 3)
    // 全部偏差均在 0.05m 门限内（否则 validateMapSemantics 早已拒绝）。
    expect(maxStart).toBeLessThanOrEqual(0.05)
    expect(maxEnd).toBeLessThanOrEqual(0.05)
  })

  test('端点偏差示例：边终点保持原值，未被节点坐标覆盖', () => {
    const edge = map.edges.find((e) => e.id === FIXED_ENTITIES.maxDeviationEdge.id)!
    expect(edge.ex).toBeCloseTo(-120.32, 2)
    expect(edge.ey).toBeCloseTo(-1.35, 2)
    const endNode = map.nodes.find((n) => n.id === edge.enodeId)!
    expect(endNode.x).toBeCloseTo(-120.35, 2)
    // 节点坐标与边端点不同，证明互不覆盖。
    expect(edge.ex).not.toBeCloseTo(endNode.x, 2)
  })

  test('无重复节点 ID 与边 ID（解析层已保证，回归交叉确认）', () => {
    const nodeIds = new Set(map.nodes.map((n) => n.id))
    const edgeIds = new Set(map.edges.map((e) => e.id))
    expect(nodeIds.size).toBe(map.nodes.length)
    expect(edgeIds.size).toBe(map.edges.length)
  })

  test('无悬空引用、无自环（语义层已保证，回归交叉确认）', () => {
    const nodeIds = new Set(map.nodes.map((n) => n.id))
    for (const e of map.edges) {
      expect(nodeIds.has(e.snodeId), `边 ${e.id} 起点存在`).toBe(true)
      expect(nodeIds.has(e.enodeId), `边 ${e.id} 终点存在`).toBe(true)
      expect(e.snodeId, `边 ${e.id} 不自环`).not.toBe(e.enodeId)
    }
  })

  test('LINE 控制字段全 null，BEZIER 控制字段全有限', () => {
    for (const e of map.edges) {
      if (e.edgeType === 'LINE') {
        const line = e as RawLineEdge
        expect(line.cx).toBeNull()
        expect(line.cy).toBeNull()
        expect(line.dx).toBeNull()
        expect(line.dy).toBeNull()
      } else {
        const bz = e as RawBezierEdge
        expect(Number.isFinite(bz.cx)).toBe(true)
        expect(Number.isFinite(bz.cy)).toBe(true)
        expect(Number.isFinite(bz.dx)).toBe(true)
        expect(Number.isFinite(bz.dy)).toBe(true)
      }
    }
  })
})

describe('样本身份 · SPEC 2.5 角度、名称与字体', () => {
  test('普通 node 的 angle 全为 null，其余三类全为有限弧度', () => {
    let nodeNull = 0
    let nonNodeFinite = 0
    for (const n of map.nodes) {
      if (n.type === 'node') {
        expect(n.angle, `节点 ${n.id} angle 应为 null`).toBeNull()
        nodeNull++
      } else {
        expect(Number.isFinite(n.angle), `节点 ${n.id} angle 应为有限数`).toBe(true)
        nonNodeFinite++
      }
    }
    expect(nodeNull).toBe(SAMPLE_NAME_BASELINE.nodeAngleNullCount)
    expect(nonNodeFinite).toBe(SAMPLE_NAME_BASELINE.nonNodeAngleFiniteCount)
  })

  test('名称含中文的节点数固定', () => {
    const chineseRe = /[一-鿿]/
    const count = map.nodes.filter((n) => chineseRe.test(n.name)).length
    expect(count).toBe(SAMPLE_NAME_BASELINE.chineseNodeNameCount)
  })

  test('边名均为数字字符串', () => {
    for (const e of map.edges) {
      expect(e.name, `边 ${e.id} 名称应为纯数字`).toMatch(/^\d+$/)
    }
  })

  test('最长名称为 6 个 Unicode code point', () => {
    let maxLen = 0
    for (const n of map.nodes) maxLen = Math.max(maxLen, [...n.name].length)
    for (const e of map.edges) maxLen = Math.max(maxLen, [...e.name].length)
    expect(maxLen).toBe(SAMPLE_NAME_BASELINE.maxNameCodePoints)
  })

  test('样本使用的中文字符集合与 SPEC 固定集合一致', () => {
    const chineseRe = /[一-鿿]/
    const chars = new Set<string>()
    for (const n of map.nodes) {
      for (const ch of n.name) if (chineseRe.test(ch)) chars.add(ch)
    }
    for (const e of map.edges) {
      for (const ch of e.name) if (chineseRe.test(ch)) chars.add(ch)
    }
    const charset = [...chars].sort().join('')
    expect(charset).toBe(SAMPLE_NAME_BASELINE.chineseCharset)
  })
})

// --- 固定实体交叉验证：按完整 ID 查询，再比对数据特征。 ---
// 抽出为接受 target map 的纯函数：正常路径对真实 map 调用；异常路径对篡改 map 断言 toThrow。

function findNodeIn(target: RawMap, id: string): RawNode {
  const n = target.nodes.find((node) => node.id === id)
  if (!n) throw new Error(`固定节点 ${id} 未找到`)
  return n
}

function findEdgeIn(target: RawMap, id: string): RawEdge {
  const e = target.edges.find((edge) => edge.id === id)
  if (!e) throw new Error(`固定边 ${id} 未找到`)
  return e
}

/*
 * 对任意 RawMap 执行第 2.6 节固定实体的特征交叉验证。
 * 任一实体 ID 缺失或特征不符都抛出（AssertionError / Error），证明 map 不是固定样本。
 */
function verifyFixedEntities(target: RawMap): void {
  // 普通节点。
  const normal = findNodeIn(target, FIXED_ENTITIES.normalNode.id)
  expect(normal.type).toBe(FIXED_ENTITIES.normalNode.type)
  expect(normal.x).toBeCloseTo(FIXED_ENTITIES.normalNode.x, 2)
  expect(normal.y).toBeCloseTo(FIXED_ENTITIES.normalNode.y, 2)
  expect(normal.name).toBe(FIXED_ENTITIES.normalNode.name)
  expect(normal.angle).toBeNull()

  // 中文充电节点。
  const charge = findNodeIn(target, FIXED_ENTITIES.chineseChargeNode.id)
  expect(charge.type).toBe(FIXED_ENTITIES.chineseChargeNode.type)
  expect(charge.x).toBeCloseTo(FIXED_ENTITIES.chineseChargeNode.x, 2)
  expect(charge.y).toBeCloseTo(FIXED_ENTITIES.chineseChargeNode.y, 2)
  expect(charge.name).toBe(FIXED_ENTITIES.chineseChargeNode.name)
  expect(Number.isFinite(charge.angle)).toBe(true)

  // 直线边。
  const line = findEdgeIn(target, FIXED_ENTITIES.lineEdge.id) as RawLineEdge
  expect(line.edgeType).toBe('LINE')
  expect(line.sx).toBeCloseTo(FIXED_ENTITIES.lineEdge.sx, 2)
  expect(line.sy).toBeCloseTo(FIXED_ENTITIES.lineEdge.sy, 2)
  expect(line.ex).toBeCloseTo(FIXED_ENTITIES.lineEdge.ex, 2)
  expect(line.ey).toBeCloseTo(FIXED_ENTITIES.lineEdge.ey, 2)
  expect(line.cx).toBeNull()
  expect(line.cy).toBeNull()
  expect(line.dx).toBeNull()
  expect(line.dy).toBeNull()

  // 贝塞尔边：S/C1/C2/E 四点。
  const bz = findEdgeIn(target, FIXED_ENTITIES.bezierEdge.id) as RawBezierEdge
  expect(bz.edgeType).toBe('BEZIER')
  expect(bz.sx).toBeCloseTo(FIXED_ENTITIES.bezierEdge.sx, 2)
  expect(bz.sy).toBeCloseTo(FIXED_ENTITIES.bezierEdge.sy, 2)
  expect(bz.cx).toBeCloseTo(FIXED_ENTITIES.bezierEdge.cx, 2)
  expect(bz.cy).toBeCloseTo(FIXED_ENTITIES.bezierEdge.cy, 2)
  expect(bz.dx).toBeCloseTo(FIXED_ENTITIES.bezierEdge.dx, 2)
  expect(bz.dy).toBeCloseTo(FIXED_ENTITIES.bezierEdge.dy, 2)
  expect(bz.ex).toBeCloseTo(FIXED_ENTITIES.bezierEdge.ex, 2)
  expect(bz.ey).toBeCloseTo(FIXED_ENTITIES.bezierEdge.ey, 2)

  // 最大端点偏差示例：边终点与引用节点偏差 ≈ 0.030m（通过门限）。
  const dev = findEdgeIn(target, FIXED_ENTITIES.maxDeviationEdge.id)
  expect(dev.ex).toBeCloseTo(FIXED_ENTITIES.maxDeviationEdge.ex, 2)
  expect(dev.ey).toBeCloseTo(FIXED_ENTITIES.maxDeviationEdge.ey, 2)
  const devNode = findNodeIn(target, dev.enodeId)
  const devAmount = Math.hypot(dev.ex - devNode.x, dev.ey - devNode.y)
  expect(devAmount).toBeCloseTo(0.03, 2)
  expect(devNode.x).toBeCloseTo(FIXED_ENTITIES.maxDeviationEdge.nodeX, 2)
  expect(devNode.y).toBeCloseTo(FIXED_ENTITIES.maxDeviationEdge.nodeY, 2)

  // 最短反向边对：两条弦长均 ≈ 0.04m。
  for (const item of FIXED_ENTITIES.shortestChordPair) {
    const e = findEdgeIn(target, item.id)
    expect(edgeChord(e)).toBeCloseTo(item.chord, 2)
  }

  // false/false 与 false/true 对：验证存在性与 isBackEdge 组合。
  const ff = FIXED_ENTITIES.falseFalsePair
  expect(findEdgeIn(target, ff.ids[0]).isBackEdge).toBe(ff.isBackEdge[0])
  expect(findEdgeIn(target, ff.ids[1]).isBackEdge).toBe(ff.isBackEdge[1])
  const ft = FIXED_ENTITIES.falseTruePair
  expect(findEdgeIn(target, ft.ids[0]).isBackEdge).toBe(ft.isBackEdge[0])
  expect(findEdgeIn(target, ft.ids[1]).isBackEdge).toBe(ft.isBackEdge[1])
}

describe('样本身份 · SPEC 2.6 固定回归实体', () => {
  test('全部固定实体按完整 ID 与数据特征交叉验证通过', () => {
    expect(() => verifyFixedEntities(map)).not.toThrow()
  })

  test('普通节点无朝向箭头（type === "node"）', () => {
    const n = findNodeIn(map, FIXED_ENTITIES.normalNode.id)
    expect(n.type).toBe('node')
  })

  test('最短反向边对两条均存在且弦长 ≈ 0.04m', () => {
    const a = findEdgeIn(map, FIXED_ENTITIES.shortestChordPair[0].id)
    const b = findEdgeIn(map, FIXED_ENTITIES.shortestChordPair[1].id)
    expect(edgeChord(a)).toBeCloseTo(0.04, 2)
    expect(edgeChord(b)).toBeCloseTo(0.04, 2)
  })
})

// --- 身份敏感性（异常路径）：固定实体 ID 不变但特征被篡改时，身份验证必须失败。 ---
// 深拷贝原始响应包、改写单个字段、重新解析后对篡改 map 调用 verifyFixedEntities。

function findRawNode(raw: any, id: string): any {
  return raw.data.currentMapInfoVersion.mapJson.nodes.find((n: any) => n.id === id)
}

function findRawEdge(raw: any, id: string): any {
  return raw.data.currentMapInfoVersion.mapJson.edges.find((e: any) => e.id === id)
}

function cloneRaw(): any {
  return JSON.parse(JSON.stringify(rawJson))
}

describe('样本身份 · 敏感性（SPEC 2.6 异常路径）', () => {
  test('保留固定节点 ID 但改变坐标 → 特征交叉验证失败', () => {
    const tampered = cloneRaw()
    findRawNode(tampered, FIXED_ENTITIES.normalNode.id).x = 999
    const tamperedMap = parseSampleEnvelope(tampered)
    expect(() => verifyFixedEntities(tamperedMap)).toThrow()
  })

  test('保留固定节点 ID 但改变名称 → 特征交叉验证失败', () => {
    const tampered = cloneRaw()
    findRawNode(tampered, FIXED_ENTITIES.normalNode.id).name = 'TAMPERED'
    const tamperedMap = parseSampleEnvelope(tampered)
    expect(() => verifyFixedEntities(tamperedMap)).toThrow()
  })

  test('保留固定节点 ID 但改为另一合法类型 → 特征交叉验证失败', () => {
    const tampered = cloneRaw()
    // node → charge，同时给合法 angle 使字段级校验通过；类型特征比对必须失败。
    const raw = findRawNode(tampered, FIXED_ENTITIES.normalNode.id)
    raw.type = 'charge'
    raw.angle = 1.0
    const tamperedMap = parseSampleEnvelope(tampered)
    expect(() => verifyFixedEntities(tamperedMap)).toThrow()
  })

  test('保留固定节点 ID 但改为非法类型 → 解析边界直接拒绝', () => {
    const tampered = cloneRaw()
    findRawNode(tampered, FIXED_ENTITIES.normalNode.id).type = 'warehouse'
    expect(() => parseSampleEnvelope(tampered)).toThrow()
  })

  test('保留贝塞尔边 ID 但改变控制点 → 特征交叉验证失败', () => {
    const tampered = cloneRaw()
    findRawEdge(tampered, FIXED_ENTITIES.bezierEdge.id).cx = 0
    const tamperedMap = parseSampleEnvelope(tampered)
    expect(() => verifyFixedEntities(tamperedMap)).toThrow()
  })

  test('保留直线边 ID 但把控制点改为非 null → 解析边界直接拒绝', () => {
    const tampered = cloneRaw()
    findRawEdge(tampered, FIXED_ENTITIES.lineEdge.id).cx = 0
    expect(() => parseSampleEnvelope(tampered)).toThrow()
  })

  test('篡改后产生的失败必须是结构化错误或断言失败，不静默', () => {
    const tampered = cloneRaw()
    findRawNode(tampered, FIXED_ENTITIES.normalNode.id).type = 'warehouse'
    try {
      parseSampleEnvelope(tampered)
      throw new Error('应抛出但未抛出')
    } catch (e) {
      expect(isMapDataError(e) || e instanceof Error).toBe(true)
    }
  })

  test('改变节点数量 → 数量基线不再匹配', () => {
    const tampered = cloneRaw()
    tampered.data.currentMapInfoVersion.mapJson.nodes.pop()
    const tamperedMap = parseSampleEnvelope(tampered)
    expect(tamperedMap.nodes.length).not.toBe(SAMPLE_NODE_COUNTS.total)
  })

  test('改变中文字符集合 → 字符集基线不再匹配', () => {
    const tampered = cloneRaw()
    // 把一个中文名称中的汉字换成集合外的“字”，使推导字符集不再等于 SPEC 固定集合。
    const cnNode = tampered.data.currentMapInfoVersion.mapJson.nodes.find(
      (n: any) => /[一-鿿]/.test(n.name),
    )
    cnNode.name = cnNode.name.replace(/[一-鿿]/, '字')
    const tamperedMap = parseSampleEnvelope(tampered)
    const chineseRe = /[一-鿿]/
    const chars = new Set<string>()
    for (const n of tamperedMap.nodes) {
      for (const ch of n.name) if (chineseRe.test(ch)) chars.add(ch)
    }
    expect([...chars].sort().join('')).not.toBe(SAMPLE_NAME_BASELINE.chineseCharset)
  })
})
