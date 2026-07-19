/**
 * 生产地点目录资产测试（TASK-005 验证方式 1、2、3）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/verify-assets 深度校验函数、
 * scripts/places 34 省 × 2 角色领域真值与 src/geo-contracts 契约层。直接读取 public/geo 下已交付的
 * 生产地点目录资产（china-places.json + provenance）与省级目录 / 几何，证明 34 省 × (1 锚点 + 1 行政中心) /
 * 港澳台 / 真值一致 / 坐标范围 / 点落入对应省域 / 来源审计全部成立；并验证缺失省会、重复关联、
 * 越界坐标、未知行政区、点落省域外等篡改路径被确定性发现。
 *
 * 注意：篡改类用例一律在内存深拷贝副本上构造，绝不改写 public/ 下的正式资产（TASK-005 验证方式 3：
 * 「在测试副本中制造...预期验证失败」）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPlacesAsset } from '../../scripts/verify-assets/places-deep'
import {
  EXPECTED_PLACE_ENTRY_COUNT,
  EXPECTED_PLACE_PROVINCE_COUNT,
  PLACE_CATALOG,
  REQUIRED_POLITICAL_PLACE_IDS,
} from '../../scripts/places/place-catalog'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const PLACES_PATH = 'public/geo/china-places.json'
const PROVENANCE_PATH = 'public/geo/china-places.provenance.json'
const PROVINCE_DIRECTORY_PATH = 'public/geo/china-provinces-directory.json'
const PROVINCE_GEOMETRY_PATH = 'public/geo/china-provinces-geometry.json'
const SOURCES_PATH = 'public/geo/data-sources.json'

/** 生产资产载荷：地点目录（对象 + 原始文本）+ 省级目录 / 几何 + 来源 + 审计 sidecar。模块级缓存，避免每个用例重读。 */
interface ProductionAsset {
  readonly places: Record<string, unknown>
  readonly placesText: string
  readonly provinceDirectory: unknown
  readonly provinceGeometry: Record<string, unknown>
  readonly sources: unknown
  readonly provenance: Record<string, unknown>
}

function loadProductionAsset(): ProductionAsset {
  return {
    places: JSON.parse(readFileSync(resolve(projectRoot, PLACES_PATH), 'utf-8')) as Record<string, unknown>,
    placesText: readFileSync(resolve(projectRoot, PLACES_PATH), 'utf-8'),
    provinceDirectory: JSON.parse(readFileSync(resolve(projectRoot, PROVINCE_DIRECTORY_PATH), 'utf-8')),
    provinceGeometry: JSON.parse(readFileSync(resolve(projectRoot, PROVINCE_GEOMETRY_PATH), 'utf-8')) as Record<string, unknown>,
    sources: JSON.parse(readFileSync(resolve(projectRoot, SOURCES_PATH), 'utf-8')),
    provenance: JSON.parse(readFileSync(resolve(projectRoot, PROVENANCE_PATH), 'utf-8')) as Record<string, unknown>,
  }
}

const asset = loadProductionAsset()

/** 深拷贝地点目录，避免篡改污染模块级缓存。 */
function clonePlaces(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(asset.places)) as Record<string, unknown>
}

type PlaceEntry = {
  id: string
  adminId: string
  role: string
  name: string
  coordinate: { lon: number; lat: number }
  anchorAdjustmentNote?: string
}

/** 从（可能被篡改的）地点目录中取 entries 数组的可变引用，便于测试改写。 */
function entriesOf(places: Record<string, unknown>): PlaceEntry[] {
  return places.entries as PlaceEntry[]
}

describe('生产地点目录资产深度不变量（TASK-005 验证方式 1、2）', () => {
  it('生产资产通过深度校验（含省域几何包含校验）', () => {
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provinceDirectory: asset.provinceDirectory,
      provinceGeometry: asset.provinceGeometry,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      placesText: asset.placesText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
    // 几何包含校验在提供省级几何时必须实际执行（非「未检却假装通过」）。
    expect(outcome.samples.containmentChecked).toBe(true)
  })

  it('恰好 68 条（34 省 × 2 角色），与领域真值数量一致', () => {
    const entries = entriesOf(asset.places)
    expect(entries.length).toBe(EXPECTED_PLACE_ENTRY_COUNT)
    expect(PLACE_CATALOG.length).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(EXPECTED_PLACE_ENTRY_COUNT).toBe(EXPECTED_PLACE_PROVINCE_COUNT * 2)
    // 地点 id 唯一（无重复）。
    expect(new Set(entries.map((e) => e.id)).size).toBe(EXPECTED_PLACE_ENTRY_COUNT)
  })

  it('每个行政区恰有 1 个锚点 + 1 个行政中心', () => {
    const entries = entriesOf(asset.places)
    const anchors = new Map<string, number>()
    const capitals = new Map<string, number>()
    for (const e of entries) {
      if (e.role === 'provinceNameAnchor') anchors.set(e.adminId, (anchors.get(e.adminId) ?? 0) + 1)
      if (e.role === 'administrativeCapital') capitals.set(e.adminId, (capitals.get(e.adminId) ?? 0) + 1)
    }
    for (const catalog of PLACE_CATALOG) {
      expect(anchors.get(catalog.id) ?? 0).toBe(1)
      expect(capitals.get(catalog.id) ?? 0).toBe(1)
    }
  })

  it('港、澳、台均各有锚点与行政中心（SPEC §6 红线最小集）', () => {
    const entries = entriesOf(asset.places)
    for (const id of REQUIRED_POLITICAL_PLACE_IDS) {
      expect(entries.some((e) => e.adminId === id && e.role === 'provinceNameAnchor')).toBe(true)
      expect(entries.some((e) => e.adminId === id && e.role === 'administrativeCapital')).toBe(true)
    }
  })

  it('台湾省行政中心为台北（SPEC §6、TASK-005 输出「台湾省关联台北点位」）', () => {
    const entries = entriesOf(asset.places)
    const twCapital = entries.find((e) => e.adminId === 'CN-710000' && e.role === 'administrativeCapital')
    expect(twCapital).toBeDefined()
    expect(twCapital!.name).toBe('台北')
    // 台北坐标落在合理区间。
    expect(twCapital!.coordinate.lon).toBeGreaterThan(121)
    expect(twCapital!.coordinate.lon).toBeLessThan(122)
    expect(twCapital!.coordinate.lat).toBeGreaterThan(24.5)
    expect(twCapital!.coordinate.lat).toBeLessThan(25.5)
  })

  it('四个直辖市与港澳均按省级行政区目录完整表达（锚点 + 行政中心）', () => {
    const entries = entriesOf(asset.places)
    // 4 直辖市 + 港 + 澳 = 6 个非省 / 非自治区行政区。
    const municipalAndSar = ['CN-110000', 'CN-120000', 'CN-310000', 'CN-500000', 'CN-810000', 'CN-820000']
    for (const id of municipalAndSar) {
      expect(entries.filter((e) => e.adminId === id).length).toBe(2)
    }
  })

  it('所有坐标落在中国主图 [72,3,136,54]', () => {
    const entries = entriesOf(asset.places)
    for (const e of entries) {
      expect(e.coordinate.lon).toBeGreaterThanOrEqual(72)
      expect(e.coordinate.lon).toBeLessThanOrEqual(136)
      expect(e.coordinate.lat).toBeGreaterThanOrEqual(3)
      expect(e.coordinate.lat).toBeLessThanOrEqual(54)
    }
  })

  it('非校正坐标均落入对应省域，校正锚点附 anchorAdjustmentNote（point-in-polygon）', () => {
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provinceGeometry: asset.provinceGeometry,
    })
    // 不应出现「点落省域外」错误。
    expect(outcome.errors.some((e) => e.code === 'places-asset.point-outside-province')).toBe(false)
    // 人工校正锚点（内蒙古 / 黑龙江 / 甘肃 / 西藏）必须附非空校正说明。
    const adjusted = entriesOf(asset.places).filter((e) => e.anchorAdjustmentNote !== undefined)
    expect(adjusted.length).toBe(outcome.samples.adjustedAnchorCount)
    expect(outcome.samples.adjustedAnchorCount).toBe(4)
    for (const e of adjusted) {
      expect(e.role).toBe('provinceNameAnchor')
      expect(e.anchorAdjustmentNote!.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('资产级篡改确定性失败（TASK-005 验证方式 3）', () => {
  it('删除某省行政中心后校验失败并指出 role-pair 违规与条目数不符', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 删除广东的行政中心。
    tampered.entries = entries.filter((e) => !(e.adminId === 'CN-440000' && e.role === 'administrativeCapital'))
    const outcome = verifyPlacesAsset({
      places: tampered,
      provinceDirectory: asset.provinceDirectory,
      provinceGeometry: asset.provinceGeometry,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 条目数变为 67 ≠ 68。
    expect(codes).toContain('places-asset.entry-count')
    // 广东行政中心数 = 0，违反「每省恰 1 个行政中心」。
    expect(codes).toContain('places-asset.role-pair')
    // 错误消息具体指出广东。
    expect(outcome.errors.some((e) => e.message.includes('CN-440000'))).toBe(true)
  })

  it('重复关联（同一行政区出现两个行政中心）后校验失败', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 复制广东行政中心，换一个新 id 造成「广东有 2 个行政中心」。
    const gdCapital = entries.find((e) => e.adminId === 'CN-440000' && e.role === 'administrativeCapital')!
    entries.push({ ...gdCapital, id: 'CN-440000-capital-dup' })
    const outcome = verifyPlacesAsset({
      places: tampered,
      provinceDirectory: asset.provinceDirectory,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 条目数变为 69 ≠ 68。
    expect(codes).toContain('places-asset.entry-count')
    // 广东行政中心数 = 2，违反「每省恰 1 个行政中心」。
    expect(codes).toContain('places-asset.role-pair')
  })

  it('地点条目 id 重复时契约校验确定性失败（place-directory.duplicate-id）', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 复制北京锚点，保留同一 id 造成重复。
    const bjAnchor = entries.find((e) => e.id === 'CN-110000-anchor')!
    entries.push({ ...bjAnchor })
    const outcome = verifyPlacesAsset({ places: tampered })
    expect(outcome.ok).toBe(false)
    // 契约原始错误码被保留（与 provinces-deep 同构），便于精确断言。
    expect(outcome.errors.map((e) => e.code)).toContain('place-directory.duplicate-id')
  })

  it('越界经纬度（纬度超 54 北界）被深度校验发现（coordinate-out-of-extent）', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 把广东行政中心纬度抬到 60：契约层纬度合法（≤90）通过，但超出中国主图北界 54，
    // 故由资产级 coordinate-out-of-extent 命中（而非契约层 coordinate.latitude-out-of-range）。
    const gdCapital = entries.find((e) => e.adminId === 'CN-440000' && e.role === 'administrativeCapital')!
    gdCapital.coordinate = { lon: gdCapital.coordinate.lon, lat: 60 }
    const outcome = verifyPlacesAsset({ places: tampered, provinceDirectory: asset.provinceDirectory })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('places-asset.coordinate-out-of-extent')
  })

  it('未知行政区标识（不在 34 省真值内）被深度校验发现', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 把广东锚点的 adminId 改成不在 34 真值内的 CN-999999（仍符合 CN- 格式，契约层放行）。
    const gdAnchor = entries.find((e) => e.id === 'CN-440000-anchor')!
    gdAnchor.adminId = 'CN-999999'
    const outcome = verifyPlacesAsset({
      places: tampered,
      provinceDirectory: asset.provinceDirectory,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // adminId 集合与 34 真值不一致（多出 CN-999999、缺少 CN-440000）。
    expect(codes).toContain('places-asset.id-set-mismatch')
    // CN-999999 不在真值内，role-pair 也会报「不在 34 省真值内」。
    expect(codes).toContain('places-asset.role-pair')
    // 跨契约 bundle 也会发现 adminId 解析失败。
    expect(codes).toContain('bundle.unresolved-admin-id')
  })

  it('点位落入其他省域（广东行政中心坐标被改到北京）被包含校验发现', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    // 把广东行政中心坐标挪到北京位置：仍在中国主图范围内、坐标合法，但不在广东几何内。
    const gdCapital = entries.find((e) => e.adminId === 'CN-440000' && e.role === 'administrativeCapital')!
    gdCapital.coordinate = { lon: 116.4074, lat: 39.9042 }
    const outcome = verifyPlacesAsset({
      places: tampered,
      provinceGeometry: asset.provinceGeometry,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('places-asset.point-outside-province')
  })

  it('删除台湾省行政中心后政治红线锚点命中（missing-political-id）', () => {
    const tampered = clonePlaces()
    const entries = entriesOf(tampered)
    tampered.entries = entries.filter((e) => !(e.adminId === 'CN-710000' && e.role === 'administrativeCapital'))
    const outcome = verifyPlacesAsset({
      places: tampered,
      provinceDirectory: asset.provinceDirectory,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 政治红线锚点命中（台湾行政中心缺失）。
    expect(codes).toContain('places-asset.missing-political-id')
    expect(outcome.errors.some((e) => e.message.includes('CN-710000'))).toBe(true)
  })
})

describe('审计 sidecar 完整性闭环（provenance.integrity 防篡改锚点）', () => {
  it('生产资产的 provenance.integrity 与复算全部一致（SHA-256 / 数量统计）', () => {
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provinceDirectory: asset.provinceDirectory,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      placesText: asset.placesText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
    const integrity = asset.provenance.integrity as Record<string, unknown>
    expect(integrity.placesSha256).toEqual(expect.any(String))
    expect(integrity.entryCount).toBe(EXPECTED_PLACE_ENTRY_COUNT)
    expect(integrity.anchorCount).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
    expect(integrity.capitalCount).toBe(EXPECTED_PLACE_PROVINCE_COUNT)
  })

  it('篡改 placesSha256 后校验发现不一致', () => {
    const tamperedProv = JSON.parse(JSON.stringify(asset.provenance)) as Record<string, unknown>
    const integrity = tamperedProv.integrity as { placesSha256: string }
    integrity.placesSha256 = '0'.repeat(64)
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provenance: tamperedProv,
      placesText: asset.placesText,
    })
    expect(outcome.ok).toBe(false)
    const shaErrors = outcome.errors.filter((e) => e.path === '$.provenance.integrity.placesSha256')
    expect(shaErrors.length).toBe(1)
  })

  it('审计声明了 sha256 但未提供原始文本时校验报缺口错误', () => {
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provenance: asset.provenance,
      // 故意不传 placesText。
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.path)).toContain('$.provenance.integrity.placesSha256')
  })
})

describe('未提供省级几何时包含校验状态如实标记（不得「未检却假装通过」）', () => {
  it('未提供 provinceGeometry 时 samples.containmentChecked 为 false 且不报包含错误', () => {
    const outcome = verifyPlacesAsset({
      places: asset.places,
      provinceDirectory: asset.provinceDirectory,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.samples.containmentChecked).toBe(false)
    // 未提供几何时不应产生包含类错误（避免在未知状态下误报）。
    expect(outcome.errors.some((e) => e.code === 'places-asset.point-outside-province')).toBe(false)
  })
})
