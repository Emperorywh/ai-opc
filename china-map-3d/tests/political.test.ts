/**
 * 政治边界补充数据契约测试。
 * 覆盖正常路径与确定性失败：重复段序号、空岛礁名、缺失修正依据。
 * 注：完整红线核对（十段、必需岛礁是否齐全）由下游政治边界完整性 TASK 负责。
 */

import { describe, it } from 'vitest'
import { validatePoliticalBoundary } from '../src/geo-contracts'
import { loadFixture } from './_helpers'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

describe('政治边界补充数据契约', () => {
  it('合法夹具（含九段线、岛礁、争议区修正）通过校验', () => {
    const payload = loadFixture(['legal', 'political-boundary.json'])
    expectValid(validatePoliticalBoundary(payload))
  })

  it('重复段序号时确定性失败', () => {
    const payload = {
      kind: 'political-boundary',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        { type: 'nineDashLineSegment', segmentIndex: 1, coordinates: [{ lon: 117, lat: 6 }, { lon: 116, lat: 5 }] },
        { type: 'nineDashLineSegment', segmentIndex: 1, coordinates: [{ lon: 115, lat: 4 }, { lon: 114, lat: 3 }] },
      ],
      source: { sourceId: 'src-project-political' },
    }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.segment-index-duplicate',
    ])
  })

  it('岛礁缺名称时确定性失败', () => {
    const payload = {
      kind: 'political-boundary',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        { type: 'islandOrReefPoint', name: '', coordinate: { lon: 112, lat: 3.5 } },
      ],
      source: { sourceId: 'src-project-political' },
    }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.island-name-empty',
    ])
  })

  it('争议区修正缺依据时确定性失败', () => {
    const payload = {
      kind: 'political-boundary',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [
        {
          type: 'disputedBoundaryCorrection',
          targetRegion: '藏南',
          geometry: { type: 'Polygon', rings: [[{ lon: 92, lat: 27 }, { lon: 97, lat: 27 }, { lon: 95, lat: 29 }]] },
          basis: '',
        },
      ],
      source: { sourceId: 'src-project-political' },
    }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.basis-empty',
    ])
  })

  it('未知要素类型时确定性失败', () => {
    const payload = {
      kind: 'political-boundary',
      version: '1.0.0',
      crs: 'EPSG:4326',
      features: [{ type: 'maritimeRoute', coordinates: [] }],
      source: { sourceId: 'src-project-political' },
    }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.unknown-feature-type',
    ])
  })
})
