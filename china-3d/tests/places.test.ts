/**
 * 地点目录契约测试（SPEC §3.7、§5.5）。
 *
 * 覆盖：合法载荷（省名锚点 + 省级行政中心，含人工校正说明）通过校验；
 * 越界经纬度、未知角色、空校正说明、畸形 adminId、重复地点 id 确定性失败。
 */

import { describe, it } from 'vitest'
import { validatePlaceDirectory } from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

/** 合法载荷：省名锚点（广东，几何中心落海人工校正）+ 省级行政中心（广州）+ 省名锚点（台湾）。 */
function makeLegalPlaceDirectory() {
  return {
    kind: 'place-directory',
    version: '1.0.0',
    crs: 'EPSG:4326',
    entries: [
      {
        id: 'place-gd-anchor',
        adminId: 'CN-440000',
        role: 'provinceNameAnchor',
        name: '广东',
        coordinate: { lon: 113.4, lat: 23.3 },
        anchorAdjustmentNote: '省几何中心受南海岛屿拉扯偏南，人工北移至珠江口北岸。',
      },
      {
        id: 'place-gd-capital',
        adminId: 'CN-440000',
        role: 'administrativeCapital',
        name: '广州',
        coordinate: { lon: 113.2644, lat: 23.1291 },
      },
      {
        id: 'place-tw-anchor',
        adminId: 'CN-710000',
        role: 'provinceNameAnchor',
        name: '台湾',
        coordinate: { lon: 120.9, lat: 23.7 },
      },
    ],
    source: { sourceId: 'src-project-capitals' },
  }
}

describe('地点目录契约', () => {
  it('合法载荷（含人工校正说明）通过校验', () => {
    expectValid(validatePlaceDirectory(makeLegalPlaceDirectory()))
  })

  it('越界经纬度时确定性失败', () => {
    const payload = makeLegalPlaceDirectory()
    payload.entries[1].coordinate = { lon: 300, lat: 23 }
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'coordinate.longitude-out-of-range',
    ])
  })

  it('未知角色时确定性失败', () => {
    const payload = makeLegalPlaceDirectory()
    payload.entries[0].role = 'cityCenter'
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.unknown-role',
    ])
  })

  it('给出空校正说明时确定性失败（禁止隐式偏移）', () => {
    const payload = makeLegalPlaceDirectory()
    payload.entries[0].anchorAdjustmentNote = '   '
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.anchor-note-empty',
    ])
  })

  it('畸形 adminId 时确定性失败', () => {
    const payload = makeLegalPlaceDirectory()
    payload.entries[0].adminId = 'XX-??'
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.admin-id-malformed',
    ])
  })

  it('重复地点 id 时确定性失败', () => {
    const payload = makeLegalPlaceDirectory()
    payload.entries[1].id = payload.entries[0].id
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.duplicate-id',
    ])
  })

  it('坐标参考系缺失/错误时确定性失败', () => {
    const payload = makeLegalPlaceDirectory() as unknown as Record<string, unknown>
    delete payload.crs
    expectInvalidContainingCodes(validatePlaceDirectory(payload), ['crs.missing'])
  })
})
