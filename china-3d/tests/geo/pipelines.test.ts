/**
 * 地理资产生产管线测试（TASK-004）。
 *
 * 覆盖三条生产管线的确定性：
 * - scripts/places/build-places.ts：重产输出与已交付资产逐字节一致（证明资产确由管线产出、
 *   未漂移），且「每省恰两条」为结构不变量。
 * - scripts/political/build-political.ts：重产输出与已交付资产逐字节一致，且产出契约通过
 *   契约校验与红线扫描（十段含台湾东侧段）。
 * - scripts/provinces/fetch-datav-provinces.ts 的离线装配核心 assembleFromDataV：
 *   34 省按 adcode 对齐、九段线要素（100000_JD）被过滤、缺 adcode / 重复 adcode 被记录、
 *   缺省（如台湾）时确定性失败——不触网（网络取数路径由实际生产运行验证）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/ 生产模块与 src/ 契约层，
 * 读取 public/geo 已交付资产做比对。不改写任何正式资产。
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlaceDirectoryContract } from '../../scripts/places/build-places'
import {
  EXPECTED_PLACE_ENTRY_COUNT,
  PLACE_CATALOG,
} from '../../scripts/places/place-catalog'
import { buildPoliticalBoundaryContract } from '../../scripts/political/build-political'
import { assembleFromDataV } from '../../scripts/provinces/fetch-datav-provinces'
import { PROVINCE_CATALOG } from '../../scripts/provinces/province-catalog'
import { collectPoliticalRedLineGaps } from '../../src/lib/political-red-line'
import {
  CHINA_ADMINISTRATIVE_DIRECTORY,
  validatePlaceDirectory,
  validatePoliticalBoundary,
} from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

function readAssetText(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf-8')
}

describe('地点目录生产管线（build-places）', () => {
  it('重产输出与已交付 china-places.json 逐字节一致（资产未漂移）', () => {
    const rebuilt = `${JSON.stringify(buildPlaceDirectoryContract(), null, 2)}\n`
    expect(rebuilt).toBe(readAssetText('public/geo/china-places.json'))
  })

  it('重产输出通过契约校验，且每省恰两条（结构不变量）', () => {
    const contract = buildPlaceDirectoryContract()
    expect(validatePlaceDirectory(contract).ok).toBe(true)
    expect(contract.entries.length).toBe(EXPECTED_PLACE_ENTRY_COUNT)
    // 每个 catalog 条目恰展开为 1 锚点 + 1 行政中心。
    for (const province of PLACE_CATALOG) {
      const pair = contract.entries.filter((e) => e.adminId === province.id)
      expect(pair.length).toBe(2)
      expect(pair.map((e) => e.role).sort()).toEqual(['administrativeCapital', 'provinceNameAnchor'])
    }
  })
})

describe('政治边界生产管线（build-political）', () => {
  it('重产输出与已交付 china-political-boundary.json 逐字节一致（资产未漂移）', () => {
    const rebuilt = `${JSON.stringify(buildPoliticalBoundaryContract(), null, 2)}\n`
    expect(rebuilt).toBe(readAssetText('public/geo/china-political-boundary.json'))
  })

  it('重产 SHA-256 与审计 sidecar 声明一致（防篡改锚点闭环）', () => {
    const rebuilt = `${JSON.stringify(buildPoliticalBoundaryContract(), null, 2)}\n`
    const sha256 = createHash('sha256').update(rebuilt, 'utf-8').digest('hex')
    const provenance = JSON.parse(readAssetText('public/geo/china-political-boundary.provenance.json')) as {
      integrity: { politicalSha256: string }
    }
    expect(sha256).toBe(provenance.integrity.politicalSha256)
  })

  it('重产输出通过契约校验，且红线扫描无缺项（十段含台湾东侧段）', () => {
    const contract = buildPoliticalBoundaryContract()
    expect(validatePoliticalBoundary(contract).ok).toBe(true)
    const gaps = collectPoliticalRedLineGaps(contract)
    expect(gaps.segmentCount).toBe(10)
    expect(gaps.missingSegmentIndices).toEqual([])
    expect(gaps.taiwanEastSegmentPresent).toBe(true)
    expect(gaps.missingIslandNames).toEqual([])
  })
})

describe('省级目录离线视图（province-catalog 派生自契约层规范目录）', () => {
  it('34 条视图与契约层 CHINA_ADMINISTRATIVE_DIRECTORY 一一对应，adcode 由 id 派生', () => {
    expect(PROVINCE_CATALOG.length).toBe(CHINA_ADMINISTRATIVE_DIRECTORY.length)
    for (let i = 0; i < PROVINCE_CATALOG.length; i++) {
      const view = PROVINCE_CATALOG[i]
      const truth = CHINA_ADMINISTRATIVE_DIRECTORY[i]
      expect(view.id).toBe(truth.id)
      expect(view.name).toBe(truth.name)
      expect(view.type).toBe(truth.type)
      expect(`CN-${view.adcode}`).toBe(truth.id)
    }
  })
})

/** 构造一个覆盖全部 34 省 adcode 的最小 DataV FeatureCollection（每省一个三角闭合环）。 */
function makeSyntheticDataV(): { type: string; features: unknown[] } {
  const features = PROVINCE_CATALOG.map((entry) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [80.0, 30.0],
          [81.0, 30.0],
          [80.5, 31.0],
          [80.0, 30.0],
        ],
      ],
    },
    properties: { adcode: entry.adcode, name: entry.name, level: 'province' },
  }))
  return { type: 'FeatureCollection', features }
}

describe('DataV 装配核心（assembleFromDataV，离线确定性）', () => {
  it('34 省按 adcode 对齐为目录 + 几何（一一对应、按 adcode 升序）', () => {
    const result = assembleFromDataV(makeSyntheticDataV() as never)
    expect(result.directoryEntries.length).toBe(34)
    expect(result.geometryFeatures.length).toBe(34)
    expect(result.directoryEntries[0].id).toBe('CN-110000')
    expect(result.directoryEntries[33].id).toBe('CN-820000')
    // 几何坐标被转为契约命名字段 {lon,lat}。
    const first = result.geometryFeatures[0].geometry
    expect(first.type).toBe('Polygon')
    if (first.type === 'Polygon') {
      expect(first.rings[0][0]).toEqual({ lon: 80.0, lat: 30.0 })
    }
  })

  it('九段线要素（adcode=100000_JD）被过滤，不进入省级资产', () => {
    const collection = makeSyntheticDataV()
    collection.features.push({
      type: 'Feature',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[[[121.0, 21.0], [122.0, 21.0], [121.5, 22.0], [121.0, 21.0]]]],
      },
      properties: { adchar: 'JD', adcode: '100000_JD', name: '' },
    })
    const result = assembleFromDataV(collection as never)
    expect(result.directoryEntries.length).toBe(34)
    expect(result.geometryFeatures.length).toBe(34)
    expect(result.geometryFeatures.some((f) => f.adminId === 'CN-100000')).toBe(false)
  })

  it('缺 adcode 与重复 adcode 的要素被记录到 skippedFeatures', () => {
    const collection = makeSyntheticDataV()
    collection.features.push({ type: 'Feature', geometry: null, properties: { name: '无码' } })
    collection.features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[[80.0, 30.0], [81.0, 30.0], [80.5, 31.0], [80.0, 30.0]]]],
      },
      properties: { adcode: 110000, name: '北京重复', level: 'province' },
    })
    const result = assembleFromDataV(collection as never)
    expect(result.directoryEntries.length).toBe(34)
    const reasons = result.skippedFeatures.map((s) => s.reason)
    expect(reasons.some((r) => r.includes('缺 adcode'))).toBe(true)
    expect(reasons.some((r) => r.includes('重复'))).toBe(true)
  })

  it('DataV 缺台湾省几何时确定性失败（不得产出残缺资产）', () => {
    const collection = makeSyntheticDataV()
    collection.features = collection.features.filter((f) => {
      const adcode = (f as { properties: { adcode: number } }).properties.adcode
      return adcode !== 710000
    })
    expect(() => assembleFromDataV(collection as never)).toThrowError(/台湾/)
  })
})
