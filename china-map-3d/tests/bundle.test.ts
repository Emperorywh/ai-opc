/**
 * 跨契约引用核对测试（统一验证入口的一部分）。
 * 验证 sourceId / adminId 引用能否正确解析，以及孤儿引用能否被确定性发现。
 */

import { describe, it } from 'vitest'
import { validateContractBundle, validateContractByKind } from '../src/geo-contracts'
import { loadFixture } from './_helpers'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

function loadLegalBundle() {
  return {
    sources: loadFixture(['legal', 'data-sources.json']),
    administrativeDirectory: loadFixture(['legal', 'admin-directory.json']),
    administrativeGeometry: loadFixture(['legal', 'admin-geometry.json']),
    placeDirectory: loadFixture(['legal', 'places.json']),
    politicalBoundary: loadFixture(['legal', 'political-boundary.json']),
    terrainMeta: loadFixture(['legal', 'terrain.meta.json']),
  }
}

describe('统一验证入口', () => {
  it('每份合法夹具按 kind 分发后均通过', () => {
    const bundle = loadLegalBundle()
    expectValid(validateContractByKind(bundle.sources))
    expectValid(validateContractByKind(bundle.administrativeDirectory))
    expectValid(validateContractByKind(bundle.administrativeGeometry))
    expectValid(validateContractByKind(bundle.placeDirectory))
    expectValid(validateContractByKind(bundle.politicalBoundary))
    expectValid(validateContractByKind(bundle.terrainMeta))
  })

  it('合法契约包的跨契约引用全部解析通过', () => {
    expectValid(validateContractBundle(loadLegalBundle()))
  })

  it('孤儿 adminId（地点目录引用了目录中不存在的行政区）被确定性拒绝', () => {
    const bundle = loadLegalBundle()
    bundle.placeDirectory = {
      ...(bundle.placeDirectory as object),
      entries: [
        { id: 'p-x', adminId: 'CN-XX', role: 'provinceNameAnchor', name: '未知', coordinate: { lon: 113, lat: 23 } },
      ],
    }
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.unresolved-admin-id',
    ])
  })

  it('未解析的 sourceId（来源注册表中不存在）被确定性拒绝', () => {
    const bundle = loadLegalBundle()
    bundle.terrainMeta = {
      ...(bundle.terrainMeta as object),
      source: { sourceId: 'src-does-not-exist' },
    }
    expectInvalidContainingCodes(validateContractBundle(bundle), [
      'bundle.unresolved-source-id',
    ])
  })

  it('未知 kind 被确定性拒绝，而非静默接受', () => {
    expectInvalidContainingCodes(validateContractByKind({ kind: 'not-a-contract' }), [
      'contract.unknown-kind',
    ])
  })
})
