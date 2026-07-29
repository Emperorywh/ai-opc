/**
 * SPEC §6 政治边界红线聚合断言（TASK-004）。
 *
 * 本文件把「红线校验通过」的全部点名项集中在一个视图里，跨三份生产资产逐项断言：
 * - china-political-boundary.json：九段线十段画法（含台湾东侧段）、钓鱼岛 / 赤尾屿、
 *   藏南 / 阿克赛钦按中国主张画法；
 * - china-provinces-directory.json / china-provinces-geometry.json：台湾省、香港、澳门
 *   作为省级行政区齐备（含几何）；
 * - china-places.json：台湾省行政中心为台北、港澳行政中心齐备。
 *
 * 同时单测共享红线扫描 collectPoliticalRedLineGaps（src/lib/political-red-line.ts）：
 * 缺段 / 缺台湾东侧段 / 缺点名岛礁时如实报告缺项——它是资产深度校验与未来运行时消费
 * 的唯一红线扫描实现。
 *
 * 数据来源声明断言（SPEC §8）：data-sources.json 必须含 DataV 非官方审图声明与项目补全
 * 数据免责声明，且全部来源 isOfficialSurvey=false。
 *
 * 覆盖边界（诚实声明）：自动化只覆盖 SPEC §6 点名必备项；完整岛礁名录与顶点级国标一致性
 * 属人工核对（docs/political-review-record.md）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectPoliticalRedLineGaps } from '../../src/lib/political-red-line'
import {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_DISPUTED_REGIONS,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
  validatePoliticalBoundary,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

function loadJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf-8')) as Record<string, unknown>
}

const political = loadJson('public/geo/china-political-boundary.json')
const provinceDirectory = loadJson('public/geo/china-provinces-directory.json')
const provinceGeometry = loadJson('public/geo/china-provinces-geometry.json')
const places = loadJson('public/geo/china-places.json')
const dataSources = loadJson('public/geo/data-sources.json')

type PoliticalFeature = {
  type: string
  segmentIndex?: number
  name?: string
  targetRegion?: string
  basis?: string
}

function politicalFeatures(): PoliticalFeature[] {
  return political.features as PoliticalFeature[]
}

describe('红线：九段线为十段画法（含台湾东侧段）', () => {
  it('恰好 10 段、段序号 1..10 全在、第 10 段为台湾东侧段', () => {
    const segments = politicalFeatures().filter((f) => f.type === 'nineDashLineSegment')
    expect(segments.length).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    expect(EXPECTED_NINE_DASH_SEGMENT_COUNT).toBe(10)
    const indices = new Set(segments.map((f) => f.segmentIndex))
    expect(indices.size).toBe(10)
    for (const index of REQUIRED_NINE_DASH_SEGMENT_INDICES) {
      expect(indices.has(index)).toBe(true)
    }
    // 台湾东侧段独立锚点：segmentIndex=10 必须存在，且契约层常量锁定为 10。
    expect(TAIWAN_EAST_SEGMENT_INDEX).toBe(10)
    expect(indices.has(TAIWAN_EAST_SEGMENT_INDEX)).toBe(true)
    // 台湾东侧段坐标应位于台湾本岛以东（经度 > 121°E）。
    const taiwanEast = segments.find((f) => f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)!
    const coords = (taiwanEast as unknown as { coordinates: Array<{ lon: number }> }).coordinates
    for (const c of coords) {
      expect(c.lon).toBeGreaterThan(121)
    }
    // 共享红线扫描在生产资产上报告「无缺项」。
    const gaps = collectPoliticalRedLineGaps(political as unknown as PoliticalBoundaryContract)
    expect(gaps.segmentCount).toBe(10)
    expect(gaps.missingSegmentIndices).toEqual([])
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
  })
})

describe('红线：钓鱼岛 / 赤尾屿等附属岛屿点位', () => {
  it('钓鱼岛、赤尾屿、曾母暗沙均在，且坐标落在合理海区', () => {
    const points = politicalFeatures().filter((f) => f.type === 'islandOrReefPoint')
    const byName = new Map(points.map((f) => [f.name, f]))
    for (const name of REQUIRED_ISLAND_NAMES) {
      expect(byName.has(name), `缺少点名岛礁 ${name}`).toBe(true)
    }
    const diaoyu = byName.get('钓鱼岛') as unknown as { coordinate: { lon: number; lat: number } }
    expect(diaoyu.coordinate.lon).toBeGreaterThan(123)
    expect(diaoyu.coordinate.lon).toBeLessThan(124)
    expect(diaoyu.coordinate.lat).toBeGreaterThan(25)
    expect(diaoyu.coordinate.lat).toBeLessThan(26)
    const zengmu = byName.get('曾母暗沙') as unknown as { coordinate: { lon: number; lat: number } }
    // 曾母暗沙是中国领土最南标志（≈ 3.58°N，SPEC §3.3）。
    expect(zengmu.coordinate.lat).toBeGreaterThan(3)
    expect(zengmu.coordinate.lat).toBeLessThan(4)
  })
})

describe('红线：藏南与阿克赛钦按中国主张画法', () => {
  it('两处争议区修正均在，附可追溯 basis，范围落在中国主张区域', () => {
    const corrections = politicalFeatures().filter((f) => f.type === 'disputedBoundaryCorrection')
    const byRegion = new Map(corrections.map((f) => [f.targetRegion, f]))
    for (const region of REQUIRED_DISPUTED_REGIONS) {
      expect(byRegion.has(region), `缺少点名争议区 ${region}`).toBe(true)
      const correction = byRegion.get(region)!
      // basis 必须声明「按中国主张画法」且标注非官方审图（可追溯，不可悄悄写成官方数据）。
      expect(correction.basis).toContain('中国主张')
      expect(correction.basis).toContain('非官方审图')
    }
    // 藏南修正范围应在藏南一带（约 92–97°E / 27–29.5°N）。
    const zangnan = byRegion.get('藏南') as unknown as {
      geometry: { rings: Array<Array<{ lon: number; lat: number }>> }
    }
    const zangnanLons = zangnan.geometry.rings[0].map((c) => c.lon)
    const zangnanLats = zangnan.geometry.rings[0].map((c) => c.lat)
    expect(Math.min(...zangnanLons)).toBeGreaterThanOrEqual(91)
    expect(Math.max(...zangnanLons)).toBeLessThanOrEqual(98)
    expect(Math.min(...zangnanLats)).toBeGreaterThanOrEqual(26.5)
    expect(Math.max(...zangnanLats)).toBeLessThanOrEqual(30)
    // 阿克赛钦修正范围应在阿克赛钦一带（约 78–80°E / 34.5–36°N）。
    const aksai = byRegion.get('阿克赛钦') as unknown as {
      geometry: { rings: Array<Array<{ lon: number; lat: number }>> }
    }
    const aksaiLons = aksai.geometry.rings[0].map((c) => c.lon)
    expect(Math.min(...aksaiLons)).toBeGreaterThanOrEqual(77)
    expect(Math.max(...aksaiLons)).toBeLessThanOrEqual(81)
  })
})

describe('红线：台湾省与台北、港澳齐备', () => {
  it('台湾省 / 香港 / 澳门均在省级目录与几何中', () => {
    const entries = provinceDirectory.entries as Array<{ id: string; name: string; type: string }>
    const features = provinceGeometry.features as Array<{ adminId: string }>
    const required = [
      { id: 'CN-710000', name: '台湾省', type: 'province' },
      { id: 'CN-810000', name: '香港特别行政区', type: 'specialAdministrativeRegion' },
      { id: 'CN-820000', name: '澳门特别行政区', type: 'specialAdministrativeRegion' },
    ]
    for (const item of required) {
      const entry = entries.find((e) => e.id === item.id)
      expect(entry, `目录缺 ${item.id}`).toBeDefined()
      expect(entry!.name).toBe(item.name)
      expect(entry!.type).toBe(item.type)
      expect(features.some((f) => f.adminId === item.id), `几何缺 ${item.id}`).toBe(true)
    }
  })

  it('台湾省行政中心为台北，港澳行政中心齐备', () => {
    const entries = places.entries as Array<{ adminId: string; role: string; name: string }>
    const twCapital = entries.find((e) => e.adminId === 'CN-710000' && e.role === 'administrativeCapital')
    expect(twCapital).toBeDefined()
    expect(twCapital!.name).toBe('台北')
    const hk = entries.find((e) => e.adminId === 'CN-810000' && e.role === 'administrativeCapital')
    const mo = entries.find((e) => e.adminId === 'CN-820000' && e.role === 'administrativeCapital')
    expect(hk).toBeDefined()
    expect(mo).toBeDefined()
  })
})

describe('共享红线扫描 collectPoliticalRedLineGaps（唯一扫描实现）', () => {
  /** 生产资产已通过契约校验，作为合法基准载荷。 */
  function clonePolitical(): PoliticalBoundaryContract {
    return JSON.parse(JSON.stringify(political)) as PoliticalBoundaryContract
  }

  it('生产资产契约校验通过且扫描无缺项', () => {
    expect(validatePoliticalBoundary(political).ok).toBe(true)
    const gaps = collectPoliticalRedLineGaps(political as unknown as PoliticalBoundaryContract)
    expect(gaps.segmentCount).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    expect(gaps.missingSegmentIndices).toEqual([])
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
    expect(gaps.missingIslandNames).toEqual([])
  })

  it('删除台湾东侧段后扫描报告缺段且台湾东侧段不在', () => {
    const tampered = clonePolitical()
    ;(tampered as { features: PoliticalFeature[] }).features = (
      tampered.features as unknown as PoliticalFeature[]
    ).filter((f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX)) as never
    const gaps = collectPoliticalRedLineGaps(tampered)
    expect(gaps.segmentCount).toBe(9)
    expect(gaps.missingSegmentIndices).toEqual([TAIWAN_EAST_SEGMENT_INDEX])
    expect(gaps.taiwanEastSegmentPresent).toBe(false)
  })

  it('删除点名岛礁后扫描如实报告缺失名称', () => {
    const tampered = clonePolitical()
    ;(tampered as { features: PoliticalFeature[] }).features = (
      tampered.features as unknown as PoliticalFeature[]
    ).filter(
      (f) => !(f.type === 'islandOrReefPoint' && (f.name === '钓鱼岛' || f.name === '曾母暗沙')),
    ) as never
    const gaps = collectPoliticalRedLineGaps(tampered)
    expect(gaps.missingIslandNames).toEqual(['钓鱼岛', '曾母暗沙'])
  })

  it('争议区修正不参与红线点名扫描（其完整性由资产深度校验把关）', () => {
    const tampered = clonePolitical()
    ;(tampered as { features: PoliticalFeature[] }).features = (
      tampered.features as unknown as PoliticalFeature[]
    ).filter((f) => f.type !== 'disputedBoundaryCorrection') as never
    const gaps = collectPoliticalRedLineGaps(tampered)
    // 扫描结果与争议区无关：段 / 岛礁缺项均不受删除争议区影响。
    expect(gaps.missingSegmentIndices).toEqual([])
    expect(gaps.missingIslandNames).toEqual([])
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
  })
})

describe('数据来源声明（SPEC §8：非官方审图免责声明）', () => {
  interface SourceDecl {
    id: string
    name: string
    isOfficialSurvey: boolean
    disclaimer?: string
  }

  function sources(): SourceDecl[] {
    return dataSources.sources as SourceDecl[]
  }

  it('全部来源均标记 isOfficialSurvey=false 且附非空免责声明', () => {
    const decls = sources()
    expect(decls.length).toBeGreaterThanOrEqual(4)
    for (const decl of decls) {
      expect(decl.isOfficialSurvey, `${decl.id} 必须为非官方审图`).toBe(false)
      expect(decl.disclaimer, `${decl.id} 必须附免责声明`).toBeDefined()
      expect(decl.disclaimer!.trim().length).toBeGreaterThan(0)
    }
  })

  it('DataV 来源含非官方审图声明并指明已知缺陷（不含九段线 / 岛礁、争议区非国标）', () => {
    const datav = sources().find((s) => s.id === 'src-datav-provinces')!
    expect(datav).toBeDefined()
    expect(datav.disclaimer).toContain('非官方审图数据')
    expect(datav.disclaimer).toContain('九段线')
    expect(datav.disclaimer).toContain('南海岛礁')
    expect(datav.disclaimer).toContain('争议区')
    expect(datav.disclaimer).toContain('审图号')
  })

  it('项目补全数据来源含免责声明（九段线 / 岛礁 / 争议区，非官方审图）', () => {
    const politicalSrc = sources().find((s) => s.id === 'src-project-political')!
    expect(politicalSrc).toBeDefined()
    expect(politicalSrc.disclaimer).toContain('非自然资源主管部门官方审图数据')
    expect(politicalSrc.disclaimer).toContain('台湾东侧段')
    expect(politicalSrc.disclaimer).toContain('藏南')
    expect(politicalSrc.disclaimer).toContain('阿克赛钦')
    expect(politicalSrc.disclaimer).toContain('审图号')
    // 项目维护的省会目录同样携带免责声明。
    const capitals = sources().find((s) => s.id === 'src-project-capitals')!
    expect(capitals.disclaimer).toContain('非官方审图数据')
  })
})
