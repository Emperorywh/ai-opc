/**
 * 南海诸岛 2D 标准附图准备层测试（TASK-019 验证方式 1、2）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import src/lib/south-china-sea-inset（领域准备层）、
 * src/lib/projection（projectToInset / projectToMercator / projectToWorld / MAIN_MAP_CENTER —— 复算与
 * 跨投影一致性断言）、src/lib/political-red-line（共享红线扫描）、src/geo-contracts
 * （validatePoliticalBoundary 契约校验 + political-catalog SPEC §6 红线点名真值）、
 * src/config/south-china-sea-inset（生产四至 / viewBox / 样式不变量）。不依赖浏览器 / React / Three.js——
 * 准备层是纯函数，可在 Node 内完整断言红线完整性（十段含台湾东侧段、点名岛礁均在）、(u,v) 落在 [0,1]²、
 * 与主图共享同一墨卡托、各类失败路径（缺段 / 缺点 / 空契约 / 越界），无需启动 WebGL
 * （人工视觉验收留给 TASK-019 验证方式 4、5）。
 *
 * 覆盖（TASK-019 验证方式 1、2）：
 * - 红线完整性：生产资产 10 段全被消费（segmentIndex 1..10，含台湾东侧第 10 段）、点名岛礁
 *   （钓鱼岛 / 赤尾屿 / 曾母暗沙）均在点位中、全部 (u,v) 落在 [0,1]²。
 * - 同一坐标与主图投影结果一致：附图 (u,v) 严格等于 projectToInset（忠实复用，无第二套投影）；
 *   并跨投影交叉验证——由 (u,v) 重建的墨卡托与由主图 projectToWorld 重建的墨卡托一致（二者都等于
 *   projectToMercator(lon,lat)，证明主图与附图来自同一墨卡托结果，仅视口映射不同）。
 * - 失败路径：删台湾东侧段 / 删点名岛礁 / 空契约 / 越界四至 → 各自稳定 code 抛错，不产出残缺附图
 *   （TASK-019 验证方式 2「不能静默显示残缺图」）。
 * - 配置不变量：四至自洽、含全部十段线与岛礁；viewBox 高度按墨卡托比例派生；样式 / 文案有限非空。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  prepareSouthChinaSeaInset,
  SouthChinaSeaInsetPrepError,
} from '../src/lib/south-china-sea-inset'
import { collectPoliticalRedLineGaps } from '../src/lib/political-red-line'
import {
  MAIN_MAP_CENTER,
  projectToInset,
  projectToMercator,
  projectToWorld,
} from '../src/lib/projection'
import { SOUTH_CHINA_SEA_INSET_CONFIG, SOUTH_CHINA_SEA_INSET_EXTENT } from '../src/config/south-china-sea-inset'
import {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
} from '../src/geo-contracts/political-catalog'
import {
  validatePoliticalBoundary,
  type IslandOrReefPointFeature,
  type PoliticalBoundaryContract,
  type PoliticalBoundaryFeature,
} from '../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 加载生产政治边界资产并经契约校验，返回 PoliticalBoundaryContract。 */
function loadProductionContract(): PoliticalBoundaryContract {
  const assetPath = resolve(projectRoot, 'public', 'geo', 'china-political-boundary.json')
  const payload: unknown = JSON.parse(readFileSync(assetPath, 'utf-8'))
  const outcome = validatePoliticalBoundary(payload)
  expect(outcome.ok, '生产政治边界资产应通过契约校验').toBe(true)
  return payload as PoliticalBoundaryContract
}

/** 深拷贝生产契约，避免篡改污染。 */
function cloneContract(contract: PoliticalBoundaryContract): PoliticalBoundaryContract {
  return JSON.parse(JSON.stringify(contract)) as PoliticalBoundaryContract
}

/** 断言两个数值在给定绝对容差内相等。 */
function expectAlmostEqual(actual: number, expected: number, tolerance: number, note = ''): void {
  expect(Math.abs(actual - expected), `期望 ${actual} ≈ ${expected}（容差 ${tolerance}）${note}`).toBeLessThanOrEqual(tolerance)
}

/** 在契约中按名查找岛礁点位要素（断言存在）。 */
function findIsland(contract: PoliticalBoundaryContract, name: string): IslandOrReefPointFeature {
  const feature = contract.features.find(
    (f): f is Extract<PoliticalBoundaryFeature, { type: 'islandOrReefPoint' }> =>
      f.type === 'islandOrReefPoint' && f.name === name,
  )
  expect(feature, `契约应含岛礁点位「${name}」`).toBeDefined()
  return feature!
}

describe('红线完整性：十段含台湾东侧段、点名岛礁均在（TASK-019 验证方式 1）', () => {
  it('生产政治资产经附图准备后恰好产出 10 段十段线，段序号 1..10 全在', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    expect(result.lines.length).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    const indices = new Set(result.lines.map((line) => line.segmentIndex))
    for (const index of REQUIRED_NINE_DASH_SEGMENT_INDICES) {
      expect(indices.has(index), `段序号 ${index} 应在附图准备产物中`).toBe(true)
    }
  })

  it('台湾东侧段（segmentIndex=10）被独立消费（SPEC §6 红线「含台湾东侧那段」）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    const taiwanEast = result.lines.find((line) => line.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)
    expect(taiwanEast, '台湾东侧段必须被附图消费').toBeDefined()
    expect(taiwanEast!.uvPolyline.length, '台湾东侧段应含至少 2 个顶点').toBeGreaterThanOrEqual(2)
  })

  it('十段线按段独立组织（10 段各自一个折线），不合并为单条连续折线', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    expect(result.lines.length).toBe(10)
    for (const line of result.lines) {
      expect(line.uvPolyline.length, `段 ${line.segmentIndex} 应含至少 2 个顶点`).toBeGreaterThanOrEqual(2)
    }
  })

  it('SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在附图点位中', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    const names = new Set(result.points.map((point) => point.name))
    for (const name of REQUIRED_ISLAND_NAMES) {
      expect(names.has(name), `点名岛礁「${name}」应在附图点位中`).toBe(true)
    }
  })

  it('全部十段线顶点与岛礁点位的 (u,v) 落在 [0,1]²（附图四至含全部红线要素）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    for (const line of result.lines) {
      for (const vertex of line.uvPolyline) {
        expect(vertex.u).toBeGreaterThanOrEqual(0)
        expect(vertex.u).toBeLessThanOrEqual(1)
        expect(vertex.v).toBeGreaterThanOrEqual(0)
        expect(vertex.v).toBeLessThanOrEqual(1)
      }
    }
    for (const point of result.points) {
      expect(point.u).toBeGreaterThanOrEqual(0)
      expect(point.u).toBeLessThanOrEqual(1)
      expect(point.v).toBeGreaterThanOrEqual(0)
      expect(point.v).toBeLessThanOrEqual(1)
    }
  })
})

describe('同一坐标与主图投影结果一致（TASK-019 验证方式 1「同一坐标与主图投影结果一致」）', () => {
  it('附图 (u,v) 严格等于 projectToInset（忠实复用，无第二套投影公式）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    // 岛礁点位：(u,v) 必须等于直接 projectToInset（证明准备层不重写投影）。
    for (const point of result.points) {
      const island = findIsland(contract, point.name)
      const direct = projectToInset(island.coordinate.lon, island.coordinate.lat, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect(direct.ok).toBe(true)
      expect(point.u).toBe(direct.value.u)
      expect(point.v).toBe(direct.value.v)
    }
    // 十段线顶点：逐一对照源契约坐标的 projectToInset。
    for (const line of result.lines) {
      const seg = contract.features.find(
        (f): f is Extract<PoliticalBoundaryFeature, { type: 'nineDashLineSegment' }> =>
          f.type === 'nineDashLineSegment' && f.segmentIndex === line.segmentIndex,
      )!
      expect(seg.coordinates.length).toBe(line.uvPolyline.length)
      for (let i = 0; i < seg.coordinates.length; i++) {
        const direct = projectToInset(seg.coordinates[i].lon, seg.coordinates[i].lat, SOUTH_CHINA_SEA_INSET_EXTENT)
        expect(direct.ok).toBe(true)
        expect(line.uvPolyline[i].u).toBe(direct.value.u)
        expect(line.uvPolyline[i].v).toBe(direct.value.v)
      }
    }
  })

  it('跨投影交叉：附图 (u,v) 与主图 projectToWorld 重建同一墨卡托（同源不同视口映射）', () => {
    const contract = loadProductionContract()
    const result = prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
    // 附图四至西南 / 东北角的墨卡托（用于由 (u,v) 反归一化重建墨卡托）。
    const sw = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.west, SOUTH_CHINA_SEA_INSET_EXTENT.south)
    const ne = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.east, SOUTH_CHINA_SEA_INSET_EXTENT.north)
    const center = projectToMercator(MAIN_MAP_CENTER.lon, MAIN_MAP_CENTER.lat)
    expect(sw.ok && ne.ok && center.ok).toBe(true)
    // 对每个岛礁点位：由附图 (u,v) 重建墨卡托，由主图 world 重建墨卡托，二者应一致。
    for (const point of result.points) {
      const island = findIsland(contract, point.name)
      // 附图路径：(u,v) → 墨卡托（线性反归一化，projectToInset 的数值逆运算）。
      const mxFromInset = sw.value.x + point.u * (ne.value.x - sw.value.x)
      const myFromInset = sw.value.y + point.v * (ne.value.y - sw.value.y)
      // 主图路径：world (x,z) → 墨卡托（中心化反变换，projectToWorld 的数值逆运算）。
      const world = projectToWorld(island.coordinate.lon, island.coordinate.lat)
      expect(world.ok).toBe(true)
      const mxFromWorld = world.value.x + center.value.x
      const myFromWorld = center.value.y - world.value.z
      // 二者都等于 projectToMercator(lon,lat)，容差内一致 → 证明主图与附图共享同一墨卡托结果。
      expectAlmostEqual(mxFromInset, mxFromWorld, 1e-3, `${point.name} 墨卡托 x`)
      expectAlmostEqual(myFromInset, myFromWorld, 1e-3, `${point.name} 墨卡托 y`)
    }
  })
})

describe('红线缺项 / 异常路径：阻断附图准备，不静默显示残缺图（TASK-019 验证方式 2）', () => {
  it('删除台湾东侧段（segmentIndex=10）→ 明确失败', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect.unreachable('删除台湾东侧段应阻断附图准备')
    } catch (e) {
      const code = (e as SouthChinaSeaInsetPrepError).code
      // 三条红线锚点至少命中其一（段数 9、段序号 10 缺、台湾东侧段独立锚点）。
      expect([
        'south-china-sea-inset.taiwan-east-segment-missing',
        'south-china-sea-inset.segment-count-mismatch',
        'south-china-sea-inset.segment-missing',
      ]).toContain(code)
    }
  })

  it('删除钓鱼岛 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '钓鱼岛'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect.unreachable('删除钓鱼岛应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
      expect((e as Error).message).toContain('钓鱼岛')
    }
  })

  it('删除赤尾屿 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '赤尾屿'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect.unreachable('删除赤尾屿应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
    }
  })

  it('删除曾母暗沙 → required-island-missing', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = contract.features.filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '曾母暗沙'),
    )
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect.unreachable('删除曾母暗沙应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.required-island-missing')
    }
  })

  it('features 为空 → empty-features', () => {
    const contract = cloneContract(loadProductionContract())
    contract.features = []
    try {
      prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)
      expect.unreachable('空 features 应阻断附图准备')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.empty-features')
    }
  })

  it('附图四至越界（不含十段线顶点）→ projection-failed', () => {
    const contract = loadProductionContract()
    // 红线完整（生产契约），但四至过窄不含十段线顶点 → 第一段顶点 projectToInset 失败。
    const narrowExtent = { west: 104, south: 0, east: 110, north: 10 }
    try {
      prepareSouthChinaSeaInset(contract, narrowExtent)
      expect.unreachable('越界四至应触发 projection-failed')
    } catch (e) {
      expect((e as SouthChinaSeaInsetPrepError).code).toBe('south-china-sea-inset.projection-failed')
    }
  })
})

describe('与主图政治要素准备共用同一红线扫描单源（不复制扫描逻辑）', () => {
  it('附图准备与共享扫描 collectPoliticalRedLineGaps 对生产契约给出一致缺项（全无缺）', () => {
    const contract = loadProductionContract()
    // 附图准备成功即等价于「扫描无缺项」；这里直接断言共享扫描结果齐全。
    const gaps = collectPoliticalRedLineGaps(contract)
    expect(gaps.segmentCount).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    expect(gaps.missingSegmentIndices).toHaveLength(0)
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
    expect(gaps.missingIslandNames).toHaveLength(0)
    // 附图准备据此成功（不抛）。
    expect(() => prepareSouthChinaSeaInset(contract, SOUTH_CHINA_SEA_INSET_EXTENT)).not.toThrow()
  })
})

describe('配置不变量（TASK-019 验证方式 1：四至自洽、含全部红线要素、比例派生）', () => {
  it('附图四至自洽（west<east、south<north、有限）', () => {
    const { west, south, east, north } = SOUTH_CHINA_SEA_INSET_EXTENT
    expect(Number.isFinite(west) && Number.isFinite(south) && Number.isFinite(east) && Number.isFinite(north)).toBe(true)
    expect(west).toBeLessThan(east)
    expect(south).toBeLessThan(north)
  })

  it('附图四至完整容纳生产资产的全部十段线段与岛礁点位', () => {
    const contract = loadProductionContract()
    const { west, south, east, north } = SOUTH_CHINA_SEA_INSET_EXTENT
    for (const feature of contract.features) {
      if (feature.type === 'nineDashLineSegment') {
        for (const coord of feature.coordinates) {
          expect(coord.lon).toBeGreaterThanOrEqual(west)
          expect(coord.lon).toBeLessThanOrEqual(east)
          expect(coord.lat).toBeGreaterThanOrEqual(south)
          expect(coord.lat).toBeLessThanOrEqual(north)
        }
      } else if (feature.type === 'islandOrReefPoint') {
        const { lon, lat } = feature.coordinate
        expect(lon).toBeGreaterThanOrEqual(west)
        expect(lon).toBeLessThanOrEqual(east)
        expect(lat).toBeGreaterThanOrEqual(south)
        expect(lat).toBeLessThanOrEqual(north)
      }
    }
  })

  it('viewBox 高度按墨卡托比例派生（高度 = 宽度 / 墨卡托宽高比，附图不被拉伸）', () => {
    const sw = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.west, SOUTH_CHINA_SEA_INSET_EXTENT.south)
    const ne = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.east, SOUTH_CHINA_SEA_INSET_EXTENT.north)
    expect(sw.ok && ne.ok).toBe(true)
    const aspect = (ne.value.x - sw.value.x) / (ne.value.y - sw.value.y)
    const expectedHeight = SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth / aspect
    expectAlmostEqual(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight, expectedHeight, 1e-6, 'viewBox 高度')
    // 高度与宽度同号、有限、为正。
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxWidth).toBeGreaterThan(0)
    expect(SOUTH_CHINA_SEA_INSET_CONFIG.viewboxHeight).toBeGreaterThan(0)
  })

  it('样式参数有限、为正；文案非空；配置全部冻结', () => {
    const c = SOUTH_CHINA_SEA_INSET_CONFIG
    expect(c.lineStrokeWidth).toBeGreaterThan(0)
    expect(c.pointRadius).toBeGreaterThan(0)
    expect(c.labelFontSize).toBeGreaterThan(0)
    expect(c.labelOffsetX).toBeGreaterThan(0)
    expect(c.frameStrokeWidth).toBeGreaterThan(0)
    expect(Number.isFinite(c.viewboxWidth)).toBe(true)
    expect(c.lineDash.length).toBeGreaterThan(0)
    expect(c.caption.length).toBeGreaterThan(0)
    expect(c.disclaimer.length).toBeGreaterThan(0)
    // 非审图限制：免责声明如实声明非官方，不填审图号。
    expect(c.disclaimer).toContain('非官方')
    expect(c.disclaimer).toContain('内部展示')
    expect(Object.isFrozen(SOUTH_CHINA_SEA_INSET_CONFIG)).toBe(true)
    expect(Object.isFrozen(SOUTH_CHINA_SEA_INSET_EXTENT)).toBe(true)
  })
})
