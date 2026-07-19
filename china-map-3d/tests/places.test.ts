/**
 * 地点目录契约测试。
 * 覆盖正常路径与确定性失败：越界经纬度、未知角色、空的校正说明。
 */

import { describe, it } from 'vitest'
import { validatePlaceDirectory } from '../src/geo-contracts'
import { loadFixture } from './_helpers'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

describe('地点目录契约', () => {
  it('合法夹具（含人工校正说明）通过校验', () => {
    const payload = loadFixture(['legal', 'places.json'])
    expectValid(validatePlaceDirectory(payload))
  })

  it('越界经纬度时确定性失败', () => {
    const payload = {
      kind: 'place-directory',
      version: '1.0.0',
      crs: 'EPSG:4326',
      entries: [
        { id: 'p1', adminId: 'CN-GD', role: 'provinceNameAnchor', name: '广东', coordinate: { lon: 300, lat: 23 } },
      ],
      source: { sourceId: 'src-project-capitals' },
    }
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'coordinate.longitude-out-of-range',
    ])
  })

  it('未知角色时确定性失败', () => {
    const payload = {
      kind: 'place-directory',
      version: '1.0.0',
      crs: 'EPSG:4326',
      entries: [
        { id: 'p1', adminId: 'CN-GD', role: 'cityCenter', name: '广东', coordinate: { lon: 113, lat: 23 } },
      ],
      source: { sourceId: 'src-project-capitals' },
    }
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.unknown-role',
    ])
  })

  it('给出空校正说明时确定性失败（禁止隐式偏移）', () => {
    const payload = {
      kind: 'place-directory',
      version: '1.0.0',
      crs: 'EPSG:4326',
      entries: [
        { id: 'p1', adminId: 'CN-GD', role: 'provinceNameAnchor', name: '广东', coordinate: { lon: 113, lat: 23 }, anchorAdjustmentNote: '   ' },
      ],
      source: { sourceId: 'src-project-capitals' },
    }
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.anchor-note-empty',
    ])
  })

  it('未知行政区标识时确定性失败', () => {
    const payload = {
      kind: 'place-directory',
      version: '1.0.0',
      crs: 'EPSG:4326',
      entries: [
        { id: 'p1', adminId: 'XX-??', role: 'provinceNameAnchor', name: '广东', coordinate: { lon: 113, lat: 23 } },
      ],
      source: { sourceId: 'src-project-capitals' },
    }
    expectInvalidContainingCodes(validatePlaceDirectory(payload), [
      'place-directory.admin-id-malformed',
    ])
  })
})
