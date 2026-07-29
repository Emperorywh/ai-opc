/**
 * 地形高程编码/解码与 terrain-meta 契约测试（SPEC §5.1、§7.1）。
 *
 * 覆盖：
 * - encodeElevationToUint16 / decodeUint16ToElevation 在 [-1500m, 9000m] 区间内
 *   roundtrip 一致（量化步长 ≈0.16m 内），浅水负高程保留不钳到 0。
 * - clamp-to-range：低于 -1500m 截断到码 0、高于 9000m 截断到码 65535。
 * - 非有限输入 / 区间倒置 / 非法码值显式抛错，不静默产出脏数据。
 * - terrain-meta 契约校验：合法载荷通过；缺失 CRS、8 位位深、区间倒置、未知版本
 *   等确定性失败。
 */

import { describe, expect, it } from 'vitest'
import {
  CHINA_TERRAIN_ELEVATION_ENCODING,
  UINT16_MAX_CODE,
  decodeUint16ToElevation,
  encodeElevationToUint16,
  validateTerrainMeta,
  type TerrainMetaContract,
} from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

const { minValueMeters: MIN_H, maxValueMeters: MAX_H } = CHINA_TERRAIN_ELEVATION_ENCODING
/** 量化步长（米）：(9000 − (−1500)) / 65535 ≈ 0.16m。 */
const QUANTIZATION_STEP = (MAX_H - MIN_H) / UINT16_MAX_CODE

describe('16 位高程编码（SPEC §5.1：[-1500m, 9000m] 线性映射）', () => {
  it('规范编码常量即 SPEC 冻结值：[-1500, 9000]、16 位、clamp-to-range', () => {
    expect(MIN_H).toBe(-1500)
    expect(MAX_H).toBe(9000)
    expect(CHINA_TERRAIN_ELEVATION_ENCODING.bitDepth).toBe(16)
    expect(CHINA_TERRAIN_ELEVATION_ENCODING.encoding).toBe('linear-unsigned-integer')
    expect(CHINA_TERRAIN_ELEVATION_ENCODING.outOfRangePolicy).toBe('clamp-to-range')
  })

  it('区间端点映射到码端点：-1500m→0、9000m→65535', () => {
    expect(encodeElevationToUint16(MIN_H, MIN_H, MAX_H)).toBe(0)
    expect(encodeElevationToUint16(MAX_H, MIN_H, MAX_H)).toBe(UINT16_MAX_CODE)
    expect(decodeUint16ToElevation(0, MIN_H, MAX_H)).toBe(MIN_H)
    expect(decodeUint16ToElevation(UINT16_MAX_CODE, MIN_H, MAX_H)).toBe(MAX_H)
  })

  it('海平面 0m 映射到区间内的确定码值（线性公式）', () => {
    const expected = Math.round(((0 - MIN_H) / (MAX_H - MIN_H)) * UINT16_MAX_CODE)
    expect(encodeElevationToUint16(0, MIN_H, MAX_H)).toBe(expected)
    expect(encodeElevationToUint16(0, MIN_H, MAX_H)).toBe(9362)
  })
})

describe('编码/解码 roundtrip（含负高程保留）', () => {
  const samples = [-1500, -1000, -200, -50, -0.5, 0, 100, 884.8, 4000, 8848.86, 9000]

  for (const meters of samples) {
    it(`${meters}m 编码再解码，误差 ≤ 半个量化步长`, () => {
      const code = encodeElevationToUint16(meters, MIN_H, MAX_H)
      expect(Number.isInteger(code)).toBe(true)
      expect(code).toBeGreaterThanOrEqual(0)
      expect(code).toBeLessThanOrEqual(UINT16_MAX_CODE)
      const restored = decodeUint16ToElevation(code, MIN_H, MAX_H)
      expect(Math.abs(restored - meters)).toBeLessThanOrEqual(QUANTIZATION_STEP / 2 + 1e-9)
    })
  }

  it('浅水负高程（-200m）保留为合法低位编码，不被钳到 0（SPEC §3.5 大陆架）', () => {
    const code = encodeElevationToUint16(-200, MIN_H, MAX_H)
    expect(code).toBeGreaterThan(0)
    const restored = decodeUint16ToElevation(code, MIN_H, MAX_H)
    expect(restored).toBeLessThan(0)
    expect(Math.abs(restored - -200)).toBeLessThanOrEqual(QUANTIZATION_STEP / 2 + 1e-9)
  })
})

describe('clamp-to-range：越界截断到端点码', () => {
  it('低于 -1500m 的深海值截断到码 0（与下限同码）', () => {
    expect(encodeElevationToUint16(-1500.1, MIN_H, MAX_H)).toBe(0)
    expect(encodeElevationToUint16(-2000, MIN_H, MAX_H)).toBe(0)
    expect(encodeElevationToUint16(-11000, MIN_H, MAX_H)).toBe(0)
    // 截断后解码回下限 -1500m，不溢出、不取模。
    expect(decodeUint16ToElevation(encodeElevationToUint16(-2000, MIN_H, MAX_H), MIN_H, MAX_H)).toBe(MIN_H)
  })

  it('高于 9000m 的值截断到码 65535（与上限同码）', () => {
    expect(encodeElevationToUint16(9000.1, MIN_H, MAX_H)).toBe(UINT16_MAX_CODE)
    expect(encodeElevationToUint16(9500, MIN_H, MAX_H)).toBe(UINT16_MAX_CODE)
    expect(encodeElevationToUint16(12000, MIN_H, MAX_H)).toBe(UINT16_MAX_CODE)
    expect(decodeUint16ToElevation(encodeElevationToUint16(9500, MIN_H, MAX_H), MIN_H, MAX_H)).toBe(MAX_H)
  })
})

describe('编码/解码防御性失败', () => {
  it('非有限高程（NaN/Infinity）显式抛错，不静默落到 0', () => {
    expect(() => encodeElevationToUint16(Number.NaN, MIN_H, MAX_H)).toThrow(RangeError)
    expect(() => encodeElevationToUint16(Number.POSITIVE_INFINITY, MIN_H, MAX_H)).toThrow(RangeError)
    expect(() => encodeElevationToUint16(Number.NEGATIVE_INFINITY, MIN_H, MAX_H)).toThrow(RangeError)
  })

  it('编码区间倒置或退化时显式抛错', () => {
    expect(() => encodeElevationToUint16(0, 9000, -1500)).toThrow(RangeError)
    expect(() => encodeElevationToUint16(0, 100, 100)).toThrow(RangeError)
    expect(() => decodeUint16ToElevation(0, 9000, -1500)).toThrow(RangeError)
  })

  it('非法码值（非整数 / 越界）显式抛错', () => {
    expect(() => decodeUint16ToElevation(-1, MIN_H, MAX_H)).toThrow(RangeError)
    expect(() => decodeUint16ToElevation(65536, MIN_H, MAX_H)).toThrow(RangeError)
    expect(() => decodeUint16ToElevation(100.5, MIN_H, MAX_H)).toThrow(RangeError)
    expect(() => decodeUint16ToElevation(Number.NaN, MIN_H, MAX_H)).toThrow(RangeError)
  })
})

/** 构造一份合法 terrain-meta 载荷（主图范围、4096²、规范编码参数）。 */
function makeLegalTerrainMeta(): TerrainMetaContract {
  return {
    kind: 'terrain-meta',
    version: '1.0.0',
    crs: 'EPSG:3857',
    geographicExtent: { crs: 'EPSG:4326', west: 72, south: 3, east: 136, north: 54 },
    resolution: { widthPixels: 4096, heightPixels: 4096 },
    elevationEncoding: { ...CHINA_TERRAIN_ELEVATION_ENCODING },
    source: { sourceId: 'src-copernicus-dem-glo30' },
  }
}

describe('terrain-meta 契约校验', () => {
  it('合法载荷通过校验', () => {
    expectValid(validateTerrainMeta(makeLegalTerrainMeta()))
  })

  it('缺失/错误坐标系时确定性失败', () => {
    const missing = makeLegalTerrainMeta() as unknown as Record<string, unknown>
    delete missing.crs
    expectInvalidContainingCodes(validateTerrainMeta(missing), ['crs.missing'])

    const wrong = { ...makeLegalTerrainMeta(), crs: 'EPSG:4326' }
    expectInvalidContainingCodes(validateTerrainMeta(wrong), ['crs.unexpected'])
  })

  it('8 位位深被拒绝，以防高程精度丢失', () => {
    const meta = makeLegalTerrainMeta()
    const payload = {
      ...meta,
      elevationEncoding: { ...meta.elevationEncoding, bitDepth: 8 },
    }
    expectInvalidContainingCodes(validateTerrainMeta(payload), ['terrain-meta.bit-depth-not-16'])
  })

  it('高程区间倒置时确定性失败', () => {
    const meta = makeLegalTerrainMeta()
    const payload = {
      ...meta,
      elevationEncoding: { ...meta.elevationEncoding, minValueMeters: 9000, maxValueMeters: -1500 },
    }
    expectInvalidContainingCodes(validateTerrainMeta(payload), ['terrain-meta.elevation-range-inverted'])
  })

  it('未知数据版本时确定性失败', () => {
    const payload = { ...makeLegalTerrainMeta(), version: '9.9.9' }
    expectInvalidContainingCodes(validateTerrainMeta(payload), ['terrain-meta.unknown-version'])
  })

  it('地理范围 west>=east 时确定性失败', () => {
    const meta = makeLegalTerrainMeta()
    const payload = {
      ...meta,
      geographicExtent: { ...meta.geographicExtent, west: 140 },
    }
    expectInvalidContainingCodes(validateTerrainMeta(payload), [
      'terrain-meta.extent-west-not-less-than-east',
    ])
  })
})
