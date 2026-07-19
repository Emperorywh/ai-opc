/**
 * 行政区几何契约测试。
 * 覆盖正常路径与确定性失败：非法经纬度、重复 adminId、未知几何类型、缺失 CRS。
 */

import { describe, it } from 'vitest'
import { validateAdministrativeGeometry } from '../src/geo-contracts'
import { loadFixture, loadFixtureText } from './_helpers'
import { expectInvalidContainingCodes, expectInvalidWithCodes, expectValid } from './_assertions'

describe('行政区几何契约', () => {
  it('合法夹具（含多多边形与岛屿）通过校验', () => {
    const payload = loadFixture(['legal', 'admin-geometry.json'])
    expectValid(validateAdministrativeGeometry(payload))
  })

  it('非法经纬度时确定性失败（TASK-001 验证方式 2）', () => {
    const payload = loadFixture(['broken', 'geometry-illegal-coordinate.json'])
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'coordinate.longitude-out-of-range',
    ])
  })

  it('重复 adminId 时确定性失败', () => {
    const payload = {
      kind: 'administrative-geometry',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        { adminId: 'CN-GD', geometry: { type: 'Polygon', rings: [[{ lon: 1, lat: 1 }, { lon: 2, lat: 1 }, { lon: 1, lat: 2 }]] } },
        { adminId: 'CN-GD', geometry: { type: 'Polygon', rings: [[{ lon: 3, lat: 3 }, { lon: 4, lat: 3 }, { lon: 3, lat: 4 }]] } },
      ],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'admin-geometry.duplicate-admin-id',
    ])
  })

  it('未知几何类型时确定性失败', () => {
    const payload = {
      kind: 'administrative-geometry',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [{ adminId: 'CN-GD', geometry: { type: 'LineString', coordinates: [] } }],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'geometry.unknown-type',
    ])
  })

  it('缺失 CRS 时确定性失败', () => {
    const text = loadFixtureText(['legal', 'admin-geometry.json']).replace(
      /"crs": "EPSG:4326",\n/,
      '',
    )
    expectInvalidWithCodes(validateAdministrativeGeometry(JSON.parse(text)), ['crs.missing'])
  })

  it('环点数不足时确定性失败', () => {
    const payload = {
      kind: 'administrative-geometry',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        { adminId: 'CN-GD', geometry: { type: 'Polygon', rings: [[{ lon: 1, lat: 1 }, { lon: 2, lat: 2 }]] } },
      ],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'ring.too-few-points',
    ])
  })
})
