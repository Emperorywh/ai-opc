/**
 * 地形元数据契约测试。
 * 覆盖正常路径与三类确定性失败：缺失坐标系、错误高程范围、未知数据版本。
 */

import { describe, it } from 'vitest'
import { validateTerrainMeta } from '../src/geo-contracts'
import { loadFixture, loadFixtureText } from './_helpers'
import { expectInvalidContainingCodes, expectInvalidWithCodes, expectValid } from './_assertions'

describe('地形元数据契约', () => {
  it('合法夹具通过校验', () => {
    const payload = loadFixture(['legal', 'terrain.meta.json'])
    expectValid(validateTerrainMeta(payload))
  })

  it('缺失坐标系时确定性失败（TASK-001 验证方式 2）', () => {
    const payload = loadFixture(['broken', 'terrain-missing-crs.json'])
    expectInvalidContainingCodes(validateTerrainMeta(payload), ['crs.missing'])
  })

  it('高程区间倒置时确定性失败（TASK-001 验证方式 2）', () => {
    const payload = loadFixture(['broken', 'terrain-wrong-elevation-range.json'])
    expectInvalidContainingCodes(validateTerrainMeta(payload), [
      'terrain-meta.elevation-range-inverted',
    ])
  })

  it('未知数据版本时确定性失败（TASK-001 验证方式 2）', () => {
    const payload = loadFixture(['broken', 'terrain-unknown-version.json'])
    expectInvalidContainingCodes(validateTerrainMeta(payload), ['terrain-meta.unknown-version'])
  })

  it('8 位位深被拒绝，以防高程精度丢失', () => {
    const text = loadFixtureText(['legal', 'terrain.meta.json']).replace('"bitDepth": 16', '"bitDepth": 8')
    expectInvalidContainingCodes(validateTerrainMeta(JSON.parse(text)), [
      'terrain-meta.bit-depth-not-16',
    ])
  })

  it('CRS 取错值时确定性失败', () => {
    const text = loadFixtureText(['legal', 'terrain.meta.json']).replace(
      '"crs": "EPSG:3857"',
      '"crs": "EPSG:4326"',
    )
    expectInvalidWithCodes(validateTerrainMeta(JSON.parse(text)), ['crs.unexpected'])
  })

  it('地理范围 west>=east 时确定性失败', () => {
    const text = loadFixtureText(['legal', 'terrain.meta.json'])
      .replace('"west": 72', '"west": 140')
    expectInvalidContainingCodes(validateTerrainMeta(JSON.parse(text)), [
      'terrain-meta.extent-west-not-less-than-east',
    ])
  })
})
