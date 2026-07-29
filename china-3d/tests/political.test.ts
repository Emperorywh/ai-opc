/**
 * 政治边界补充数据契约测试（SPEC §5.3、§6）。
 *
 * 覆盖：合法载荷（九段线分段 + 岛礁点 + 争议区修正）通过校验；
 * 段序号重复/非正整数、折线坐标不足、岛礁名缺失、争议区缺 targetRegion/basis、
 * 未知要素类型、错误 CRS 等确定性失败。
 */

import { describe, it } from 'vitest'
import { validatePoliticalBoundary } from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

/** 合法载荷：两段九段线 + 钓鱼岛/曾母暗沙点位 + 藏南争议区修正。 */
function makeLegalPoliticalBoundary() {
  return {
    kind: 'political-boundary',
    version: '1.0.0',
    crs: 'EPSG:4326',
    features: [
      {
        type: 'nineDashLineSegment',
        segmentIndex: 1,
        coordinates: [
          { lon: 108.1, lat: 21.5 },
          { lon: 109.6, lat: 19.9 },
          { lon: 110.5, lat: 18.2 },
        ],
      },
      {
        type: 'nineDashLineSegment',
        segmentIndex: 10,
        coordinates: [
          { lon: 121.0, lat: 21.9 },
          { lon: 121.5, lat: 22.5 },
        ],
      },
      { type: 'islandOrReefPoint', name: '钓鱼岛', coordinate: { lon: 123.48, lat: 25.74 } },
      { type: 'islandOrReefPoint', name: '曾母暗沙', coordinate: { lon: 112.17, lat: 3.95 } },
      {
        type: 'disputedBoundaryCorrection',
        targetRegion: '藏南',
        geometry: {
          type: 'Polygon',
          rings: [
            [
              { lon: 91.6, lat: 26.8 },
              { lon: 97.4, lat: 26.8 },
              { lon: 97.4, lat: 29.4 },
              { lon: 91.6, lat: 29.4 },
            ],
          ],
        },
        basis: '按中国主张画法，以公开标准地图为蓝本；非官方审图数据。',
      },
    ],
    source: { sourceId: 'src-project-political-supplement' },
  }
}

describe('政治边界补充数据契约', () => {
  it('合法载荷（九段线分段 + 岛礁点 + 争议区修正）通过校验', () => {
    expectValid(validatePoliticalBoundary(makeLegalPoliticalBoundary()))
  })

  it('九段线段序号重复时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[1].segmentIndex = 1
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.segment-index-duplicate',
    ])
  })

  it('九段线段序号非正整数时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[0].segmentIndex = 0
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.segment-index-invalid',
    ])
  })

  it('九段线一段折线少于 2 个坐标时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[0].coordinates = [{ lon: 108.1, lat: 21.5 }]
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.segment-coordinates-too-few',
    ])
  })

  it('岛礁点缺失名称时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[2].name = '  '
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.island-name-empty',
    ])
  })

  it('岛礁点坐标越界时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[3].coordinate = { lon: 112.17, lat: 95 }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'coordinate.latitude-out-of-range',
    ])
  })

  it('争议区修正缺 targetRegion 或 basis 时确定性失败', () => {
    const missingTarget = makeLegalPoliticalBoundary()
    missingTarget.features[4].targetRegion = ''
    expectInvalidContainingCodes(validatePoliticalBoundary(missingTarget), [
      'political-boundary.target-region-empty',
    ])

    const missingBasis = makeLegalPoliticalBoundary()
    missingBasis.features[4].basis = ' '
    expectInvalidContainingCodes(validatePoliticalBoundary(missingBasis), [
      'political-boundary.basis-empty',
    ])
  })

  it('争议区修正几何结构非法时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features[4].geometry = { type: 'LineString', coordinates: [] }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), ['geometry.unknown-type'])
  })

  it('未知要素类型时确定性失败', () => {
    const payload = makeLegalPoliticalBoundary()
    payload.features.push({ type: 'territorialSeaBaseline', coordinates: [] })
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), [
      'political-boundary.unknown-feature-type',
    ])
  })

  it('坐标参考系错误时确定性失败', () => {
    const payload = { ...makeLegalPoliticalBoundary(), crs: 'EPSG:3857' }
    expectInvalidContainingCodes(validatePoliticalBoundary(payload), ['crs.unexpected'])
  })
})
