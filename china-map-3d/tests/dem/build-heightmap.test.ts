/**
 * DEM 高程资产生成流水线测试（TASK-002 验证方式 1–3）。
 *
 * 覆盖：
 * 1. 合法线性 DEM 夹具 → 可解码 16 位结果，像元值与期望高程在重采样容差内一致。
 * 2. 含正高程 / 浅水负高程 / 低于 -1500m 值的夹具 → 分别保真、保留、正确截断。
 * 3. 缺失覆盖范围 / 错误 CRS / 损坏栅格输入 → 确定性失败且不留下半成品。
 * 4. 写盘 ↔ 读回往返一致；产出元数据通过 terrain-meta 契约校验与跨契约来源引用核对。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/dem 可测试核心与 src/geo-contracts 契约层，
 * 不依赖浏览器、Python 或网络。
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DemBuildError,
  PRODUCTION_ELEVATION_RANGE,
  buildHeightmap,
  readHeightmapRaster,
  writeHeightmapAssets,
  type DemTileFixture,
} from '../../scripts/dem/build-heightmap'
import {
  inverseWebMercatorToLonLat,
  projectLonLatToWebMercator,
} from '../../scripts/dem/mercator'
import {
  decodeUint16ToElevation,
  encodeElevationToUint16,
  validateContractBundle,
  validateTerrainMeta,
} from '../../src/geo-contracts'
import { loadFixture } from '../_helpers'
import { expectValid } from '../_assertions'

const ELEV = PRODUCTION_ELEVATION_RANGE

/** 在给定目标列上解码出真实海拔（米），行固定取 0（夹具纬度方向常数，取任意行等价）。 */
function decodePixel(result: { pixels: Uint16Array; width: number }, col: number, row = 0): number {
  const code = result.pixels[row * result.width + col]
  return decodeUint16ToElevation(code, ELEV.minValueMeters, ELEV.maxValueMeters)
}

describe('16 位高程编码（契约层源函数）', () => {
  it('正高程保真、浅水负高程保留、深海截断到下限、超高截断到上限', () => {
    const { minValueMeters: min, maxValueMeters: max } = ELEV
    // 正高程往返保真（16 位量化步长 ≈0.16m，半步 ≤0.08m，容差取 0.5m）。
    expect(decodeUint16ToElevation(encodeElevationToUint16(3000, min, max), min, max)).toBeCloseTo(3000, 0)
    expect(decodeUint16ToElevation(encodeElevationToUint16(6000, min, max), min, max)).toBeCloseTo(6000, 0)
    // 浅水负高程：-200m 落在 [-1500,9000] 区间内，被保留为合法低位编码。
    expect(decodeUint16ToElevation(encodeElevationToUint16(-200, min, max), min, max)).toBeCloseTo(-200, 0)
    // 低于下限 -1500m 的深海值截断到 0 码（解码即下限 -1500m）。
    expect(encodeElevationToUint16(-2000, min, max)).toBe(0)
    expect(decodeUint16ToElevation(encodeElevationToUint16(-2000, min, max), min, max)).toBeCloseTo(-1500, 0)
    // 高于上限 9000m 的值截断到 65535 码（解码即上限 9000m）。
    expect(encodeElevationToUint16(12000, min, max)).toBe(65535)
    expect(decodeUint16ToElevation(encodeElevationToUint16(12000, min, max), min, max)).toBeCloseTo(9000, 0)
  })

  it('区间倒置或非有限高程被拒绝（防御脏数据被当作合法海平面）', () => {
    expect(() => encodeElevationToUint16(0, 100, -100)).toThrow(RangeError)
    expect(() => encodeElevationToUint16(Number.NaN, -1500, 9000)).toThrow(RangeError)
    expect(() => decodeUint16ToElevation(70000, -1500, 9000)).toThrow(RangeError)
  })
})

describe('DEM 高程流水线 · 正常路径', () => {
  it('合法线性 DEM 夹具产出可解码 16 位结果，像元值与期望高程在容差内一致（重采样正确性）', () => {
    const input = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    // 目标 16×4；夹具在经度方向线性、纬度方向常数，双线性重采样对线性函数精确还原。
    const result = buildHeightmap(input, {
      targetResolution: { width: 16, height: 4 },
      sourceId: 'src-copernicus-dem',
    })
    expect(result.pixels.length).toBe(16 * 4)
    expect(result.width).toBe(16)
    expect(result.height).toBe(4)
    expect(result.meta.elevationEncoding.bitDepth).toBe(16)

    // 采样内部目标列（避开边缘像元夹断），期望 = 5000*(lon-72)/64，容差 0.5m。
    const expected = (lon: number) => (5000 * (lon - 72)) / 64
    const lonAt = (col: number) => 72 + (col + 0.5) * ((136 - 72) / 16)
    for (const col of [1, 4, 7, 10, 14]) {
      expect(decodePixel(result, col)).toBeCloseTo(expected(lonAt(col)), 0)
    }
  })

  it('纬度方向线性 DEM 夹具：双线性纬度插值分支与墨卡托 y 均匀→纬度非均匀逆向投影均精确还原（补 fy 分支覆盖）', () => {
    const input = loadFixture(['dem', 'legal-lat-ramp-tile.json']) as DemTileFixture
    // 源 height=4、目标 height=8：目标行落在源行之间，强制 fy/ty 纬度插值分支被真正执行。
    // 旧夹具纬度方向两行同值，ty 恒为 0、纬度插值与逆向投影均未被覆盖；本用例补齐该缺口。
    const targetWidth = 4
    const targetHeight = 8
    const result = buildHeightmap(input, {
      targetResolution: { width: targetWidth, height: targetHeight },
      sourceId: 'src-copernicus-dem',
    })

    const { west, east, south, north } = input.bounds
    const latSpan = north - south
    // 源像元中心纬度上下界：双线性在 [southCenter, northCenter] 内对线性函数精确，外侧夹到边界像元。
    const cellLat = latSpan / input.height
    const northCenter = north - 0.5 * cellLat
    const southCenter = south + 0.5 * cellLat

    // 目标栅格在 EPSG:3857 下逐像元中心反算纬度：墨卡托 y 均匀 → 纬度非均匀（高纬被拉伸）。
    const midLon = (west + east) / 2
    const yMax = projectLonLatToWebMercator(midLon, north).y
    const yMin = projectLonLatToWebMercator(midLon, south).y
    const dy = (yMax - yMin) / targetHeight
    const midX = projectLonLatToWebMercator(midLon, north).x
    // 夹具高程 = 1000*(lat - south)/latSpan（南端 0m、北端 1000m，关于纬度严格线性）。
    const expectedAtLat = (lat: number) => (1000 * (lat - south)) / latSpan

    let exercisedInterpolation = false
    for (let row = 0; row < targetHeight; row++) {
      const y = yMax - (row + 0.5) * dy
      const { lat } = inverseWebMercatorToLonLat(midX, y)
      // 跳过边缘夹断行（纬度落在源像元中心范围之外，会被夹到边界像元，非线性精确）。
      if (lat <= southCenter || lat >= northCenter) continue
      exercisedInterpolation = true
      // 夹具经度方向常数，取任意列（列 0）解码；双线性对线性函数精确还原。
      expect(decodePixel(result, 0, row)).toBeCloseTo(expectedAtLat(lat), 0)
    }
    // 守卫：必须至少有一行真正走了纬度插值分支，否则测试退化为旧「纬度常数」夹具的等价物。
    expect(exercisedInterpolation).toBe(true)
  })

  it('产出元数据通过 terrain-meta 契约校验，且来源引用在合法来源注册表中可解析', () => {
    const input = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    const result = buildHeightmap(input, {
      targetResolution: { width: 8, height: 4 },
      sourceId: 'src-copernicus-dem',
    })
    expectValid(validateTerrainMeta(result.meta))
    const sources = loadFixture(['legal', 'data-sources.json'])
    expectValid(validateContractBundle({ sources, terrainMeta: result.meta }))
  })

  it('写盘后读回与内存一致；落盘元数据通过契约校验（往返 + 不留半成品）', () => {
    const input = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    const result = buildHeightmap(input, {
      targetResolution: { width: 16, height: 4 },
      sourceId: 'src-copernicus-dem',
    })
    const tmp = mkdtempSync(join(tmpdir(), 'dem-roundtrip-'))
    try {
      const { rasterPath, metaPath } = writeHeightmapAssets(result, tmp, 'china-heightmap')
      const files = readdirSync(tmp)
      expect(files).toContain('china-heightmap.r16')
      expect(files).toContain('china-heightmap.meta.json')

      const readBack = readHeightmapRaster(rasterPath, 16, 4)
      expect(Array.from(readBack)).toEqual(Array.from(result.pixels))

      const metaOnDisk = JSON.parse(readFileSync(metaPath, 'utf-8')) as unknown
      expectValid(validateTerrainMeta(metaOnDisk))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('writeHeightmapAssets 自动创建不存在的嵌套输出目录，与 Python os.makedirs 行为对齐', () => {
    const input = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    const result = buildHeightmap(input, {
      targetResolution: { width: 4, height: 2 },
      sourceId: 'src-copernicus-dem',
    })
    const tmp = mkdtempSync(join(tmpdir(), 'dem-mkdir-'))
    try {
      // --out 指向尚不存在的嵌套子目录；缺省（不自动创建）会以 ENOENT 崩溃且报错信息不佳。
      const nestedOut = join(tmp, 'a', 'b', 'c')
      const { rasterPath, metaPath } = writeHeightmapAssets(result, nestedOut, 'china-heightmap')
      const files = readdirSync(nestedOut)
      expect(files).toContain('china-heightmap.r16')
      expect(files).toContain('china-heightmap.meta.json')
      expect(rasterPath).toBe(join(nestedOut, 'china-heightmap.r16'))
      expect(metaPath).toBe(join(nestedOut, 'china-heightmap.meta.json'))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('DEM 高程流水线 · 截断与负高程保留', () => {
  it('正高程保真、浅水负高程保留、低于 -1500m 值截断到下限（TASK-002 验证方式 2）', () => {
    const input = loadFixture(['dem', 'clamp-tile.json']) as DemTileFixture
    // 目标 4 列：每列双线性采样落在成对等值的输入列上，结果精确可断言。
    const result = buildHeightmap(input, {
      targetResolution: { width: 4, height: 2 },
      sourceId: 'src-copernicus-dem',
    })
    // 目标列 0 ← +3000m（保真）。
    expect(decodePixel(result, 0)).toBeCloseTo(3000, 0)
    // 目标列 1 ← -200m（浅水负高程保留）。
    expect(decodePixel(result, 1)).toBeCloseTo(-200, 0)
    // 目标列 2 ← -2000m（低于下限，截断到 -1500m）。
    expect(decodePixel(result, 2)).toBeCloseTo(-1500, 0)
    // 目标列 3 ← +6000m（保真）。
    expect(decodePixel(result, 3)).toBeCloseTo(6000, 0)
  })
})

describe('DEM 高程流水线 · 确定性失败（TASK-002 验证方式 3）', () => {
  /**
   * 坏输入必须在「写盘之前」被拒绝。这里用一个临时目录包裹「构建 + 写盘」组合，
   * 断言抛出 DemBuildError 且临时目录为空（无半成品）。
   */
  function expectBuildRejectsAndLeavesNoArtifact(
    fixtureSegments: string[],
    expectedCode: string,
  ): void {
    const input = loadFixture(fixtureSegments) as DemTileFixture
    const tmp = mkdtempSync(join(tmpdir(), 'dem-broken-'))
    try {
      let caught: unknown
      try {
        const result = buildHeightmap(input, {
          targetResolution: { width: 4, height: 4 },
          sourceId: 'src-copernicus-dem',
        })
        writeHeightmapAssets(result, tmp, 'should-not-exist')
      } catch (cause) {
        caught = cause
      }
      expect(caught).toBeInstanceOf(DemBuildError)
      expect((caught as DemBuildError).code).toBe(expectedCode)
      // 关键不变量：失败不留任何看似有效的半成品文件。
      expect(readdirSync(tmp)).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  it('缺失覆盖范围时确定性失败且不留下半成品', () => {
    expectBuildRejectsAndLeavesNoArtifact(['dem', 'broken-coverage.json'], 'dem-input.coverage')
  })

  it('错误 CRS 时确定性失败且不留下半成品', () => {
    expectBuildRejectsAndLeavesNoArtifact(['dem', 'broken-crs.json'], 'dem-input.crs')
  })

  it('损坏栅格（values 长度不匹配）时确定性失败且不留下半成品', () => {
    expectBuildRejectsAndLeavesNoArtifact(['dem', 'broken-raster.json'], 'dem-input.raster-integrity')
  })

  it('格式错误被确定性拒绝（输入侧 format 校验分支）', () => {
    const base = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    const wrongFormat = { ...base, format: 'something-else' } as DemTileFixture
    let caught: unknown
    try {
      buildHeightmap(wrongFormat)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(DemBuildError)
    expect((caught as DemBuildError).code).toBe('dem-input.format')
  })

  it('自相矛盾的四至被确定性拒绝（输入侧 bounds 校验分支）', () => {
    const base = loadFixture(['dem', 'legal-ramp-tile.json']) as DemTileFixture
    const invertedBounds = {
      ...base,
      bounds: { west: 136, south: 54, east: 72, north: 3 },
    } as DemTileFixture
    let caught: unknown
    try {
      buildHeightmap(invertedBounds)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(DemBuildError)
    expect((caught as DemBuildError).code).toBe('dem-input.bounds')
  })
})
