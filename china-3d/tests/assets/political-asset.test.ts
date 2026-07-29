/**
 * 生产政治边界补充资产测试（TASK-004，SPEC §6 红线）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/verify-assets 深度校验函数、
 * src/geo-contracts 契约层（含 political-catalog 红线点名真值）。直接读取 public/geo 下
 * 已交付的生产政治边界资产（china-political-boundary.json + provenance），证明十段线
 * （含台湾东侧第 10 段）/ 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）/ 点名争议区
 * （藏南 / 阿克赛钦）/ 坐标范围 / 非官方审图来源 / 审计锚点全部成立；并验证删台湾东侧段、
 * 删钓鱼岛、删赤尾屿、删南海岛礁名、删争议区修正等篡改路径被确定性发现。
 *
 * 注意：篡改类用例一律在内存深拷贝副本上构造，绝不改写 public/ 下的正式资产。
 *
 * 政治红线边界（本测试不越权声称）：
 * 自动校验只覆盖 SPEC §6 点名必备项；南海诸岛完整岛礁名录、九段线/争议区几何顶点与国标逐点
 * 一致性属人工核对（docs/political-review-record.md），不在自动化测试断言范围内。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPoliticalAsset } from '../../scripts/verify-assets/political-deep'
import {
  EXPECTED_NINE_DASH_SEGMENT_COUNT,
  REQUIRED_DISPUTED_REGIONS,
  REQUIRED_ISLAND_NAMES,
  REQUIRED_NINE_DASH_SEGMENT_INDICES,
  TAIWAN_EAST_SEGMENT_INDEX,
} from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const POLITICAL_PATH = 'public/geo/china-political-boundary.json'
const PROVENANCE_PATH = 'public/geo/china-political-boundary.provenance.json'
const SOURCES_PATH = 'public/geo/data-sources.json'

/** 生产资产载荷：政治边界（对象 + 原始文本）+ 审计 sidecar + 生产来源注册表。模块级缓存。 */
interface ProductionAsset {
  readonly political: Record<string, unknown>
  readonly politicalText: string
  readonly provenance: Record<string, unknown>
  readonly sources: unknown
}

function loadProductionAsset(): ProductionAsset {
  return {
    political: JSON.parse(readFileSync(resolve(projectRoot, POLITICAL_PATH), 'utf-8')) as Record<string, unknown>,
    politicalText: readFileSync(resolve(projectRoot, POLITICAL_PATH), 'utf-8'),
    provenance: JSON.parse(readFileSync(resolve(projectRoot, PROVENANCE_PATH), 'utf-8')) as Record<string, unknown>,
    sources: JSON.parse(readFileSync(resolve(projectRoot, SOURCES_PATH), 'utf-8')),
  }
}

const asset = loadProductionAsset()

/** 深拷贝政治边界载荷，避免篡改污染模块级缓存（与 provinces-asset / places-asset 同构）。 */
function clonePolitical(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(asset.political)) as Record<string, unknown>
}

type PoliticalFeature = {
  type: string
  segmentIndex?: number
  name?: string
  targetRegion?: string
  coordinates?: Array<{ lon: number; lat: number }>
  coordinate?: { lon: number; lat: number }
}

/** 从（可能被篡改的）载荷中取 features 数组的可变引用。 */
function featuresOf(payload: Record<string, unknown>): PoliticalFeature[] {
  return payload.features as PoliticalFeature[]
}

describe('生产政治边界资产深度不变量（SPEC §6 红线）', () => {
  it('生产资产通过深度校验（十段线 / 点名岛礁 / 点名争议区 / 坐标范围 / 非官方审图来源 / 审计）', () => {
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      politicalText: asset.politicalText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
  })

  it('恰好 10 段九段线，段序号 1..10 全在（十段画法）', () => {
    const features = featuresOf(asset.political)
    const segments = features.filter((f) => f.type === 'nineDashLineSegment')
    expect(segments.length).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    const indices = new Set(segments.map((f) => f.segmentIndex))
    for (const index of REQUIRED_NINE_DASH_SEGMENT_INDICES) {
      expect(indices.has(index)).toBe(true)
    }
  })

  it('台湾东侧段（segmentIndex=10）在（SPEC §6 红线「含台湾东侧那段」）', () => {
    const features = featuresOf(asset.political)
    const hasTaiwanEast = features.some(
      (f) => f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX,
    )
    expect(hasTaiwanEast).toBe(true)
    // 深度校验抽样也标记。
    const outcome = verifyPoliticalAsset({ political: asset.political })
    expect(outcome.samples.hasTaiwanEastSegment).toBe(true)
  })

  it('SPEC §6 点名岛礁（钓鱼岛 / 赤尾屿 / 曾母暗沙）均在', () => {
    const features = featuresOf(asset.political)
    const names = new Set(
      features.filter((f) => f.type === 'islandOrReefPoint').map((f) => f.name as string),
    )
    for (const name of REQUIRED_ISLAND_NAMES) {
      expect(names.has(name)).toBe(true)
    }
  })

  it('SPEC §6 点名争议区修正（藏南 / 阿克赛钦）均在', () => {
    const features = featuresOf(asset.political)
    const regions = new Set(
      features.filter((f) => f.type === 'disputedBoundaryCorrection').map((f) => f.targetRegion as string),
    )
    for (const region of REQUIRED_DISPUTED_REGIONS) {
      expect(regions.has(region)).toBe(true)
    }
  })

  it('所有坐标落在中国主图 [72,3,136,54]', () => {
    const outcome = verifyPoliticalAsset({ political: asset.political })
    expect(outcome.samples.observedWest).toBeGreaterThanOrEqual(72)
    expect(outcome.samples.observedEast).toBeLessThanOrEqual(136)
    expect(outcome.samples.observedSouth).toBeGreaterThanOrEqual(3)
    expect(outcome.samples.observedNorth).toBeLessThanOrEqual(54)
  })

  it('来源 src-project-political 在生产来源注册表中解析为非官方审图', () => {
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(true)
    const sources = (asset.sources as { sources: Array<{ id: string; isOfficialSurvey: boolean; disclaimer?: string }> }).sources
    const political = sources.find((s) => s.id === 'src-project-political')
    expect(political).toBeDefined()
    expect(political!.isOfficialSurvey).toBe(false)
    expect(political!.disclaimer!.trim().length).toBeGreaterThan(0)
  })
})

describe('资产级篡改确定性失败（SPEC §6 红线防御）', () => {
  it('删除台湾东侧段（segmentIndex=10）后校验失败并指出台湾东侧段缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'nineDashLineSegment' && f.segmentIndex === TAIWAN_EAST_SEGMENT_INDEX),
    )
    const outcome = verifyPoliticalAsset({
      political: tampered,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 台湾东侧段独立硬编码锚点命中。
    expect(codes).toContain('political-asset.taiwan-east-segment-missing')
    // 段数降为 9，且段序号 10 缺失一并暴露。
    expect(codes).toContain('political-asset.nine-dash-segment-count')
    expect(codes).toContain('political-asset.nine-dash-segment-missing')
    expect(outcome.errors.some((e) => e.message.includes('10'))).toBe(true)
  })

  it('删除钓鱼岛后校验失败并指出点名岛礁缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '钓鱼岛'),
    )
    const outcome = verifyPoliticalAsset({ political: tampered, sourcesRegistry: asset.sources })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    expect(codes).toContain('political-asset.island-missing')
    expect(outcome.errors.some((e) => e.message.includes('钓鱼岛'))).toBe(true)
  })

  it('删除赤尾屿后校验失败并指出点名岛礁缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '赤尾屿'),
    )
    const outcome = verifyPoliticalAsset({ political: tampered, sourcesRegistry: asset.sources })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.island-missing')
    expect(outcome.errors.some((e) => e.message.includes('赤尾屿'))).toBe(true)
  })

  it('删除一个南海岛礁名（曾母暗沙）后校验失败并指出点名岛礁缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'islandOrReefPoint' && f.name === '曾母暗沙'),
    )
    const outcome = verifyPoliticalAsset({ political: tampered, sourcesRegistry: asset.sources })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.island-missing')
    expect(outcome.errors.some((e) => e.message.includes('曾母暗沙'))).toBe(true)
  })

  it('删除一项争议区修正（阿克赛钦）后校验失败并指出点名争议区缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'disputedBoundaryCorrection' && f.targetRegion === '阿克赛钦'),
    )
    const outcome = verifyPoliticalAsset({ political: tampered, sourcesRegistry: asset.sources })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.disputed-region-missing')
    expect(outcome.errors.some((e) => e.message.includes('阿克赛钦'))).toBe(true)
  })

  it('删除藏南争议区修正后校验失败并指出点名争议区缺失', () => {
    const tampered = clonePolitical()
    tampered.features = featuresOf(tampered).filter(
      (f) => !(f.type === 'disputedBoundaryCorrection' && f.targetRegion === '藏南'),
    )
    const outcome = verifyPoliticalAsset({ political: tampered, sourcesRegistry: asset.sources })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.disputed-region-missing')
    expect(outcome.errors.some((e) => e.message.includes('藏南'))).toBe(true)
  })

  it('岛礁名被清空后契约校验确定性失败（political-boundary.island-name-empty）', () => {
    const tampered = clonePolitical()
    const diaoyu = featuresOf(tampered).find(
      (f) => f.type === 'islandOrReefPoint' && f.name === '钓鱼岛',
    )! as PoliticalFeature
    diaoyu.name = ''
    const outcome = verifyPoliticalAsset({ political: tampered })
    expect(outcome.ok).toBe(false)
    // 契约原始错误码被保留（与 provinces-deep / places-deep 同构），便于精确断言。
    expect(outcome.errors.map((e) => e.code)).toContain('political-boundary.island-name-empty')
  })

  it('段序号重复时契约校验确定性失败（political-boundary.segment-index-duplicate）', () => {
    const tampered = clonePolitical()
    const features = featuresOf(tampered)
    // 把第 2 段的 segmentIndex 改为 1，造成与第 1 段重复。
    const seg2 = features.find(
      (f) => f.type === 'nineDashLineSegment' && f.segmentIndex === 2,
    )! as PoliticalFeature
    seg2.segmentIndex = 1
    const outcome = verifyPoliticalAsset({ political: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-boundary.segment-index-duplicate')
  })

  it('坐标越界（岛礁经度超 136 东界）被深度校验发现（coordinate-out-of-extent）', () => {
    const tampered = clonePolitical()
    const diaoyu = featuresOf(tampered).find(
      (f) => f.type === 'islandOrReefPoint' && f.name === '钓鱼岛',
    )! as PoliticalFeature
    // 把钓鱼岛经度抬到 140：契约层经度合法（≤180）通过，但超出中国主图东界 136，
    // 故由资产级 coordinate-out-of-extent 命中。
    diaoyu.coordinate = { lon: 140, lat: diaoyu.coordinate!.lat }
    const outcome = verifyPoliticalAsset({ political: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.coordinate-out-of-extent')
  })
})

describe('来源解析与非官方审图红线（SPEC §6 / §8）', () => {
  it('政治来源被误改为官方审图时校验确定性失败（official-survey-violation）', () => {
    // 在内存深拷贝来源注册表，把政治来源误改为 isOfficialSurvey=true（绝不改写正式来源注册表）。
    const tamperedSources = JSON.parse(JSON.stringify(asset.sources)) as {
      sources: Array<{ id: string; isOfficialSurvey: boolean }>
    }
    const political = tamperedSources.sources.find((s) => s.id === 'src-project-political')!
    political.isOfficialSurvey = true
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      sourcesRegistry: tamperedSources,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('political-asset.official-survey-violation')
  })

  it('政治来源缺失时来源引用无法解析（unresolved-source）', () => {
    const tamperedSources = JSON.parse(JSON.stringify(asset.sources)) as {
      sources: Array<{ id: string }>
    }
    tamperedSources.sources = tamperedSources.sources.filter((s) => s.id !== 'src-project-political')
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      sourcesRegistry: tamperedSources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 资产级 unresolved-source 锚点命中 + bundle.unresolved-source-id 一并暴露。
    expect(codes).toContain('political-asset.unresolved-source')
  })
})

describe('审计 sidecar 完整性闭环（provenance.integrity 防篡改锚点）', () => {
  it('生产资产的 provenance.integrity 与复算全部一致（SHA-256 / 数量统计）', () => {
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      politicalText: asset.politicalText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
    const integrity = asset.provenance.integrity as Record<string, unknown>
    expect(integrity.politicalSha256).toEqual(expect.any(String))
    expect(integrity.nineDashSegmentCount).toBe(EXPECTED_NINE_DASH_SEGMENT_COUNT)
    expect(integrity.islandCount).toBeGreaterThanOrEqual(REQUIRED_ISLAND_NAMES.length)
    expect(integrity.disputedRegionCount).toBe(REQUIRED_DISPUTED_REGIONS.length)
  })

  it('篡改 politicalSha256 后校验发现不一致', () => {
    const tamperedProv = JSON.parse(JSON.stringify(asset.provenance)) as Record<string, unknown>
    const integrity = tamperedProv.integrity as { politicalSha256: string }
    integrity.politicalSha256 = '0'.repeat(64)
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      provenance: tamperedProv,
      politicalText: asset.politicalText,
    })
    expect(outcome.ok).toBe(false)
    const shaErrors = outcome.errors.filter((e) => e.path === '$.provenance.integrity.politicalSha256')
    expect(shaErrors.length).toBe(1)
  })

  it('审计声明了 sha256 但未提供原始文本时校验报缺口错误', () => {
    const outcome = verifyPoliticalAsset({
      political: asset.political,
      provenance: asset.provenance,
      // 故意不传 politicalText。
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.path)).toContain('$.provenance.integrity.politicalSha256')
  })
})
