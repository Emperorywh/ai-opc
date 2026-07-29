/**
 * 跨契约引用核对测试（统一验证入口的一部分）。
 * 验证 sourceId / adminId 引用能否正确解析，以及孤儿引用能否被确定性发现。
 */

import { describe, expect, it } from 'vitest'
import {
  readContractKind,
  validateContractBundle,
  validateContractByKind,
} from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

/** 组装一套最小但完整的合法契约包（内联载荷，避免夹具与生产资产耦合）。 */
function makeLegalBundle() {
  return {
    sources: {
      kind: 'data-source-registry',
      version: '1.0.0',
      sources: [
        {
          id: 'src-datav-provinces',
          name: 'DataV 省级边界',
          originUrl: 'https://example.invalid/datav',
          kind: 'administrativeBoundary',
          isOfficialSurvey: false,
          version: 'v3',
          license: 'DataV 条款',
          disclaimer: '非官方审图数据，仅供内部展示。',
        },
      ],
    },
    administrativeDirectory: {
      kind: 'administrative-directory',
      version: '1.0.0',
      entries: [{ id: 'CN-440000', name: '广东省', type: 'province' }],
      source: { sourceId: 'src-datav-provinces' },
    },
    administrativeGeometry: {
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
      ],
      source: { sourceId: 'src-datav-provinces' },
    },
    placeDirectory: {
      kind: 'place-directory',
      version: '1.0.0',
      crs: 'EPSG:4326',
      entries: [
        {
          id: 'CN-440000-capital',
          adminId: 'CN-440000',
          role: 'administrativeCapital',
          name: '广州',
          coordinate: { lon: 113.2644, lat: 23.1291 },
        },
      ],
      source: { sourceId: 'src-datav-provinces' },
    },
  }
}

describe('统一验证入口', () => {
  it('每份合法载荷按 kind 分发后均通过', () => {
    const bundle = makeLegalBundle()
    expectValid(validateContractByKind(bundle.sources))
    expectValid(validateContractByKind(bundle.administrativeDirectory))
    expectValid(validateContractByKind(bundle.administrativeGeometry))
    expectValid(validateContractByKind(bundle.placeDirectory))
  })

  it('readContractKind 对已登记 kind 返回字面量，对未知 kind 返回 undefined', () => {
    expect(readContractKind(makeLegalBundle().sources)).toBe('data-source-registry')
    expect(readContractKind({ kind: 'not-a-contract' })).toBeUndefined()
    expect(readContractKind(null)).toBeUndefined()
    expect(readContractKind('data-source-registry')).toBeUndefined()
  })

  it('合法契约包的跨契约引用全部解析通过', () => {
    expectValid(validateContractBundle(makeLegalBundle()))
  })

  it('孤儿 adminId（地点目录引用了目录中不存在的行政区）被确定性拒绝', () => {
    const bundle = makeLegalBundle()
    bundle.placeDirectory = {
      ...bundle.placeDirectory,
      entries: [
        { id: 'p-x', adminId: 'CN-999999', role: 'provinceNameAnchor', name: '未知', coordinate: { lon: 113, lat: 23 } },
      ],
    }
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.unresolved-admin-id',
    ])
  })

  it('孤儿 adminId（行政区几何引用了目录中不存在的行政区）被确定性拒绝', () => {
    const bundle = makeLegalBundle()
    bundle.administrativeGeometry = {
      ...bundle.administrativeGeometry,
      features: [
        {
          adminId: 'CN-999999',
          geometry: bundle.administrativeGeometry.features[0].geometry,
        },
      ],
    }
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.unresolved-admin-id',
    ])
  })

  it('未解析的 sourceId（来源注册表中不存在）被确定性拒绝', () => {
    const bundle = makeLegalBundle()
    bundle.placeDirectory = {
      ...bundle.placeDirectory,
      source: { sourceId: 'src-does-not-exist' },
    }
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.unresolved-source-id',
    ])
  })

  it('缺少来源注册表时引用核对报缺失而非静默放过', () => {
    const bundle = makeLegalBundle() as { sources?: unknown }
    delete bundle.sources
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.missing-source-registry',
    ])
  })

  it('未知 kind 被确定性拒绝，而非静默接受', () => {
    expectInvalidContainingCodes(validateContractByKind({ kind: 'not-a-contract' }), [
      'contract.unknown-kind',
    ])
  })

  it('非对象载荷被确定性拒绝', () => {
    expectInvalidContainingCodes(validateContractByKind(null), ['contract.not-object'])
    expectInvalidContainingCodes(validateContractByKind('{}'), ['contract.not-object'])
  })
})
