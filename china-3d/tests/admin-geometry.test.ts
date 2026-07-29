/**
 * 行政区几何契约测试（SPEC §5.2）。
 *
 * 覆盖：合法载荷（单多边形 + 多多边形）通过校验；
 * 非法经纬度、重复 adminId、未知几何类型、缺失/错误 CRS、环点数不足、
 * 错误 kind、空 features 等确定性失败。
 */

import { describe, it } from 'vitest'
import { validateAdministrativeGeometry } from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

/** 合法载荷：一个 Polygon（广东）+ 一个 MultiPolygon（海南，含岛屿）。 */
function makeLegalGeometry() {
  return {
    kind: 'administrative-geometry',
    version: '1.0.0',
    crs: 'EPSG:4326',
    features: [
      {
        adminId: 'CN-440000',
        geometry: {
          type: 'Polygon',
          rings: [
            [
              { lon: 109.6, lat: 20.2 },
              { lon: 117.3, lat: 20.2 },
              { lon: 117.3, lat: 25.5 },
              { lon: 109.6, lat: 25.5 },
              { lon: 109.6, lat: 20.2 },
            ],
          ],
        },
      },
      {
        adminId: 'CN-460000',
        geometry: {
          type: 'MultiPolygon',
          polygons: [
            {
              rings: [
                [
                  { lon: 108.7, lat: 18.2 },
                  { lon: 111.1, lat: 18.2 },
                  { lon: 111.1, lat: 20.1 },
                  { lon: 108.7, lat: 20.1 },
                  { lon: 108.7, lat: 18.2 },
                ],
              ],
            },
            {
              rings: [
                [
                  { lon: 112.3, lat: 16.8 },
                  { lon: 112.4, lat: 16.8 },
                  { lon: 112.4, lat: 16.9 },
                  { lon: 112.3, lat: 16.9 },
                  { lon: 112.3, lat: 16.8 },
                ],
              ],
            },
          ],
        },
      },
    ],
    source: { sourceId: 'src-datav-provinces' },
  }
}

describe('行政区几何契约', () => {
  it('合法载荷（含多多边形与岛屿）通过校验', () => {
    expectValid(validateAdministrativeGeometry(makeLegalGeometry()))
  })

  it('非法经纬度时确定性失败', () => {
    const payload = makeLegalGeometry()
    payload.features[0].geometry.rings[0][0] = { lon: 200, lat: 20.2 }
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'coordinate.longitude-out-of-range',
    ])
  })

  it('重复 adminId 时确定性失败', () => {
    const payload = makeLegalGeometry()
    payload.features.push(JSON.parse(JSON.stringify(payload.features[0])))
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'admin-geometry.duplicate-admin-id',
    ])
  })

  it('未知几何类型时确定性失败', () => {
    const payload = makeLegalGeometry()
    ;(payload.features[0] as { geometry: unknown }).geometry = { type: 'LineString', coordinates: [] }
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'geometry.unknown-type',
    ])
  })

  it('缺失 CRS 时确定性失败', () => {
    const payload = makeLegalGeometry() as Record<string, unknown>
    delete payload.crs
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), ['crs.missing'])
  })

  it('错误 CRS（非 EPSG:4326）时确定性失败', () => {
    const payload = makeLegalGeometry() as Record<string, unknown>
    payload.crs = 'EPSG:3857'
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), ['crs.unexpected'])
  })

  it('环点数不足时确定性失败', () => {
    const payload = makeLegalGeometry()
    payload.features[0].geometry.rings[0] = [
      { lon: 109.6, lat: 20.2 },
      { lon: 117.3, lat: 20.2 },
    ]
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'ring.too-few-points',
    ])
  })

  it('错误 kind 与空 features 时确定性失败', () => {
    const payload = makeLegalGeometry() as Record<string, unknown>
    payload.kind = 'not-a-geometry'
    payload.features = []
    expectInvalidContainingCodes(validateAdministrativeGeometry(payload), [
      'admin-geometry.wrong-kind',
      'admin-geometry.empty-features',
    ])
  })
})
