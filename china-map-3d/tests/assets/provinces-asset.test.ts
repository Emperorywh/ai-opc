/**
 * 生产省级边界资产测试（TASK-004 验证方式 1、3）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/verify-assets 深度校验函数、
 * scripts/provinces 34 省目录真值与 src/geo-contracts 契约层。直接读取 public/geo 下已交付的
 * 生产省级边界资产（目录 + 几何 + provenance），证明 34 省 / 港澳台 / 目录-几何双射 / 真值一致 /
 * 环闭合 / 坐标范围 / 来源审计全部成立；并验证删台湾、重复标识等篡改路径被确定性发现。
 *
 * 注意：篡改类用例一律在内存深拷贝副本上构造，绝不改写 public/ 下的正式资产（TASK-004 验证方式 3：
 * 「不得改动正式资产验证异常路径」）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyProvincesAsset } from '../../scripts/verify-assets/provinces-deep'
import {
  EXPECTED_PROVINCE_COUNT,
  PROVINCE_CATALOG,
  REQUIRED_POLITICAL_IDS,
} from '../../scripts/provinces/province-catalog'
import { validateAdministrativeGeometry } from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const DIRECTORY_PATH = 'public/geo/china-provinces-directory.json'
const GEOMETRY_PATH = 'public/geo/china-provinces-geometry.json'
const PROVENANCE_PATH = 'public/geo/china-provinces.provenance.json'
const SOURCES_PATH = 'public/geo/data-sources.json'

/** 生产资产载荷：目录 + 几何（对象 + 原始文本）+ 来源 + 审计 sidecar。模块级缓存，避免每个用例重读 2.7MB。 */
interface ProductionAsset {
  readonly directory: Record<string, unknown>
  readonly geometry: Record<string, unknown>
  readonly sources: unknown
  readonly provenance: Record<string, unknown>
  readonly directoryText: string
  readonly geometryText: string
}

function loadProductionAsset(): ProductionAsset {
  return {
    directory: JSON.parse(readFileSync(resolve(projectRoot, DIRECTORY_PATH), 'utf-8')) as Record<string, unknown>,
    geometry: JSON.parse(readFileSync(resolve(projectRoot, GEOMETRY_PATH), 'utf-8')) as Record<string, unknown>,
    sources: JSON.parse(readFileSync(resolve(projectRoot, SOURCES_PATH), 'utf-8')),
    provenance: JSON.parse(readFileSync(resolve(projectRoot, PROVENANCE_PATH), 'utf-8')) as Record<string, unknown>,
    directoryText: readFileSync(resolve(projectRoot, DIRECTORY_PATH), 'utf-8'),
    geometryText: readFileSync(resolve(projectRoot, GEOMETRY_PATH), 'utf-8'),
  }
}

const asset = loadProductionAsset()

/** 深拷贝目录 / 几何，避免篡改污染模块级缓存。 */
function cloneDirectory(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(asset.directory)) as Record<string, unknown>
}
function cloneGeometry(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(asset.geometry)) as Record<string, unknown>
}

describe('生产省级边界资产深度不变量（TASK-004 验证方式 1）', () => {
  it('生产资产通过深度校验', () => {
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: asset.geometry,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      directoryText: asset.directoryText,
      geometryText: asset.geometryText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
  })

  it('恰好 34 个唯一省级行政区，与目录真值数量一致', () => {
    const entries = asset.directory.entries as Array<{ id: string }>
    const features = asset.geometry.features as Array<{ adminId: string }>
    expect(entries.length).toBe(EXPECTED_PROVINCE_COUNT)
    expect(features.length).toBe(EXPECTED_PROVINCE_COUNT)
    expect(PROVINCE_CATALOG.length).toBe(EXPECTED_PROVINCE_COUNT)
    // 标识唯一（无重复）。
    expect(new Set(entries.map((e) => e.id)).size).toBe(EXPECTED_PROVINCE_COUNT)
    expect(new Set(features.map((f) => f.adminId)).size).toBe(EXPECTED_PROVINCE_COUNT)
  })

  it('港、澳、台均在目录与几何中（SPEC §6 红线最小集）', () => {
    const entries = asset.directory.entries as Array<{ id: string }>
    const features = asset.geometry.features as Array<{ adminId: string }>
    for (const id of REQUIRED_POLITICAL_IDS) {
      expect(entries.some((e) => e.id === id)).toBe(true)
      expect(features.some((f) => f.adminId === id)).toBe(true)
    }
  })

  it('类型构成正确：23 省 / 5 自治区 / 4 直辖市 / 2 特别行政区', () => {
    const entries = asset.directory.entries as Array<{ type: string }>
    const tally = entries.reduce(
      (acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1
        return acc
      },
      {} as Record<string, number>,
    )
    expect(tally.province).toBe(23)
    expect(tally.autonomousRegion).toBe(5)
    expect(tally.municipality).toBe(4)
    expect(tally.specialAdministrativeRegion).toBe(2)
  })

  it('每个目录条目的 id / name / type 与目录真值精确一致', () => {
    const entries = asset.directory.entries as Array<{ id: string; name: string; type: string }>
    const byId = new Map(PROVINCE_CATALOG.map((e) => [e.id, e]))
    for (const entry of entries) {
      const truth = byId.get(entry.id)
      expect(truth, `目录条目 ${entry.id} 应在真值表中`).toBeDefined()
      expect(entry.name).toBe(truth!.name)
      expect(entry.type).toBe(truth!.type)
    }
  })

  it('多多边形覆盖岛屿 / 飞地行政区（海南、台湾、香港均为 MultiPolygon）', () => {
    const features = asset.geometry.features as Array<{
      adminId: string
      geometry: { type: string; polygons?: unknown[] }
    }>
    const byId = new Map(features.map((f) => [f.adminId, f]))
    // 海南、台湾、香港均为多岛 / 多块行政区，DataV 以 MultiPolygon 表达，多边形数 > 1。
    for (const id of ['CN-460000', 'CN-710000', 'CN-810000']) {
      const f = byId.get(id)!
      expect(f.geometry.type).toBe('MultiPolygon')
      expect((f.geometry.polygons?.length ?? 0)).toBeGreaterThan(1)
    }
  })

  it('所有环闭合（首尾点重合）且坐标落在中国主图 [72,3,136,54]', () => {
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: asset.geometry,
    })
    expect(outcome.ok).toBe(true)
    // 抽样四至由深度校验复算，须落在中国主图范围内（含余量）。
    expect(outcome.samples.observedWest).toBeGreaterThanOrEqual(72)
    expect(outcome.samples.observedEast).toBeLessThanOrEqual(136)
    expect(outcome.samples.observedSouth).toBeGreaterThanOrEqual(3)
    expect(outcome.samples.observedNorth).toBeLessThanOrEqual(54)
  })
})

describe('资产级篡改确定性失败（TASK-004 验证方式 3）', () => {
  it('删除台湾省目录条目后校验失败并指出 CN-710000 缺失', () => {
    const tampered = cloneDirectory()
    tampered.entries = (tampered.entries as Array<{ id: string }>).filter((e) => e.id !== 'CN-710000')
    const outcome = verifyProvincesAsset({
      directory: tampered,
      geometry: asset.geometry,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    // 政治红线锚点命中（目录缺台湾）。
    expect(codes).toContain('provinces-asset.missing-political-id')
    // 数量、双射、id 集合一并暴露。
    expect(codes).toContain('provinces-asset.directory-count')
    expect(codes).toContain('provinces-asset.bijection-mismatch')
    expect(codes).toContain('provinces-asset.id-set-mismatch')
    // 错误消息具体指出缺失项。
    expect(outcome.errors.some((e) => e.message.includes('CN-710000'))).toBe(true)
  })

  it('删除台湾省几何要素后校验失败并指出 CN-710000 缺失', () => {
    const tampered = cloneGeometry()
    tampered.features = (tampered.features as Array<{ adminId: string }>).filter(
      (f) => f.adminId !== 'CN-710000',
    )
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: tampered,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    expect(codes).toContain('provinces-asset.missing-political-id')
    expect(codes).toContain('provinces-asset.geometry-count')
    expect(codes).toContain('provinces-asset.bijection-mismatch')
  })

  it('目录中重复一个行政区标识后契约校验确定性失败（admin-directory.duplicate-id）', () => {
    const tampered = cloneDirectory()
    const entries = tampered.entries as Array<{ id: string; name: string; type: string }>
    // 复制北京条目造成重复 id。
    const beijing = entries.find((e) => e.id === 'CN-110000')!
    entries.push({ ...beijing })
    const outcome = verifyProvincesAsset({
      directory: tampered,
      geometry: asset.geometry,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    // 契约原始错误码被保留（与 terrain-deep 同构），便于精确断言。
    expect(outcome.errors.map((e) => e.code)).toContain('admin-directory.duplicate-id')
  })

  it('几何中重复一个 adminId 后契约校验确定性失败（admin-geometry.duplicate-admin-id）', () => {
    const tampered = cloneGeometry()
    const features = tampered.features as Array<{ adminId: string; geometry: unknown }>
    const guangdong = features.find((f) => f.adminId === 'CN-440000')!
    features.push({ ...guangdong, geometry: JSON.parse(JSON.stringify(guangdong.geometry)) })
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: tampered,
      sourcesRegistry: asset.sources,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('admin-geometry.duplicate-admin-id')
  })

  it('目录条目字段被篡改（改名）后校验指出与真值不符', () => {
    const tampered = cloneDirectory()
    const entries = tampered.entries as Array<{ id: string; name: string }>
    const tw = entries.find((e) => e.id === 'CN-710000')!
    tw.name = '被篡改的名称'
    const outcome = verifyProvincesAsset({ directory: tampered, geometry: asset.geometry })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('provinces-asset.entry-field-mismatch')
  })

  it('环未闭合（尾点偏移）被深度校验发现', () => {
    const tampered = cloneGeometry()
    const features = tampered.features as Array<{
      adminId: string
      geometry: { type: string; polygons?: Array<{ rings?: Array<Array<{ lon: number; lat: number }>> }> }
    }>
    // 把澳门第一个环的尾点偏移，破坏闭合。
    const mo = features.find((f) => f.adminId === 'CN-820000')!
    const ring = mo.geometry.polygons![0].rings![0]
    const last = ring[ring.length - 1]
    ring[ring.length - 1] = { lon: last.lon + 0.01, lat: last.lat + 0.01 }
    const outcome = verifyProvincesAsset({ directory: asset.directory, geometry: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('provinces-asset.ring-not-closed')
  })

  it('坐标越界（纬度超 54）被深度校验发现', () => {
    const tampered = cloneGeometry()
    const features = tampered.features as Array<{
      adminId: string
      geometry: { type: string; polygons?: Array<{ rings?: Array<Array<{ lon: number; lat: number }>> }> }
    }>
    const mo = features.find((f) => f.adminId === 'CN-820000')!
    const ring = mo.geometry.polygons![0].rings![0]
    // 把首尾点纬度抬到 70：契约层纬度合法（≤90）通过，但超出中国主图北界 54，
    // 故由资产级 coordinate-out-of-extent 命中（而非契约层 coordinate.latitude-out-of-range）。
    ring[0] = { lon: ring[0].lon, lat: 70 }
    ring[ring.length - 1] = { lon: ring[0].lon, lat: 70 }
    const outcome = verifyProvincesAsset({ directory: asset.directory, geometry: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('provinces-asset.coordinate-out-of-extent')
  })
})

describe('审计 sidecar 完整性闭环（provenance.integrity 防篡改锚点）', () => {
  it('生产资产的 provenance.integrity 与复算全部一致（SHA-256 / 数量统计）', () => {
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: asset.geometry,
      sourcesRegistry: asset.sources,
      provenance: asset.provenance,
      directoryText: asset.directoryText,
      geometryText: asset.geometryText,
    })
    expect(outcome.ok, outcome.errors.map((e) => e.message).join('; ')).toBe(true)
    const integrity = asset.provenance.integrity as Record<string, unknown>
    expect(integrity.directorySha256).toEqual(expect.any(String))
    expect(integrity.geometrySha256).toEqual(expect.any(String))
    expect(integrity.sourcePayloadSha256).toEqual(expect.any(String))
    expect(integrity.featureCount).toBe(EXPECTED_PROVINCE_COUNT)
  })

  it('篡改 geometrySha256 后校验发现不一致', () => {
    const tamperedProv = JSON.parse(JSON.stringify(asset.provenance)) as Record<string, unknown>
    const integrity = tamperedProv.integrity as { geometrySha256: string }
    integrity.geometrySha256 = '0'.repeat(64)
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: asset.geometry,
      provenance: tamperedProv,
      directoryText: asset.directoryText,
      geometryText: asset.geometryText,
    })
    expect(outcome.ok).toBe(false)
    const shaErrors = outcome.errors.filter((e) => e.path === '$.provenance.integrity.geometrySha256')
    expect(shaErrors.length).toBe(1)
  })

  it('审计声明了 sha256 但未提供原始文本时校验报缺口错误', () => {
    const outcome = verifyProvincesAsset({
      directory: asset.directory,
      geometry: asset.geometry,
      provenance: asset.provenance,
      // 故意不传 directoryText / geometryText。
    })
    expect(outcome.ok).toBe(false)
    const paths = outcome.errors.map((e) => e.path)
    expect(paths).toContain('$.provenance.integrity.directorySha256')
    expect(paths).toContain('$.provenance.integrity.geometrySha256')
  })
})

describe('契约层接纳内环（带洞多边形）结构（TASK-004：测试覆盖内环）', () => {
  /**
   * DataV 生产数据恰好无内环（中国省级边界无飞地洞），但契约层与深度校验都必须正确处理内环——
   * 未来 TASK 补全争议区或飞地时会出现带洞多边形。此用例证明：
   * - 契约校验接纳 Polygon 的 rings[1..] 内环；
   * - 深度校验的环闭合 / 坐标范围检查遍历内环（内环未闭合会被发现）。
   */
  it('契约校验接纳带内环的 Polygon，且深度校验遍历内环闭合性', () => {
    const geometry = {
      kind: 'administrative-geometry',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        {
          adminId: 'CN-440000',
          geometry: {
            type: 'Polygon',
            rings: [
              // 外环。
              [
                { lon: 110, lat: 20 },
                { lon: 118, lat: 20 },
                { lon: 118, lat: 26 },
                { lon: 110, lat: 26 },
                { lon: 110, lat: 20 },
              ],
              // 内环（洞），首尾重合。
              [
                { lon: 112, lat: 22 },
                { lon: 114, lat: 22 },
                { lon: 114, lat: 24 },
                { lon: 112, lat: 24 },
                { lon: 112, lat: 22 },
              ],
            ],
          },
        },
      ],
      source: { sourceId: 'src-datav-provinces' },
    }
    // 契约层接纳内环。
    expect(validateAdministrativeGeometry(geometry).ok).toBe(true)
    // 深度校验：内环闭合时该几何通过环闭合检查（结构合法、坐标在范围内、目录含 CN-440000）。
    const directory = {
      kind: 'administrative-directory',
      version: '1.0.0',
      entries: [{ id: 'CN-440000', name: '广东省', type: 'province' }],
      source: { sourceId: 'src-datav-provinces' },
    }
    const okOutcome = verifyProvincesAsset({ directory, geometry })
    expect(okOutcome.errors.some((e) => e.code === 'provinces-asset.ring-not-closed')).toBe(false)

    // 把内环尾点偏移，深度校验必须发现内环未闭合。
    const broken = JSON.parse(JSON.stringify(geometry)) as typeof geometry
    const innerRing = broken.features[0].geometry.rings[1]
    innerRing[innerRing.length - 1] = { lon: 113, lat: 23 }
    const brokenOutcome = verifyProvincesAsset({ directory, geometry: broken })
    expect(brokenOutcome.errors.map((e) => e.code)).toContain('provinces-asset.ring-not-closed')
  })
})
