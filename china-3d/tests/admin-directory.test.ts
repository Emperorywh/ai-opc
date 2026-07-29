/**
 * 省级行政区目录契约与规范 34 目录测试（SPEC §2、§6）。
 *
 * 覆盖：
 * - 规范目录 CHINA_ADMINISTRATIVE_DIRECTORY 恰好 34 条、id 唯一、通过契约校验；
 *   台湾省/香港特别行政区/澳门特别行政区在列（SPEC §6 红线）。
 * - 类型构成符合 23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区。
 * - 校验器确定性失败：重复标识、畸形标识、未知类型、空目录。
 */

import { describe, expect, it } from 'vitest'
import {
  CHINA_ADMINISTRATIVE_DIRECTORY,
  EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT,
  validateAdministrativeDirectory,
  type AdministrativeDirectoryContract,
} from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

function asContract(entries: readonly unknown[]): AdministrativeDirectoryContract {
  return {
    kind: 'administrative-directory',
    version: '1.0.0',
    entries: entries as AdministrativeDirectoryContract['entries'],
    source: { sourceId: 'src-datav-provinces' },
  }
}

describe('规范 34 省级行政区目录（SPEC §2、§6）', () => {
  it('恰好 34 条，与 EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT 一致', () => {
    expect(EXPECTED_PROVINCIAL_ADMINISTRATIVE_COUNT).toBe(34)
    expect(CHINA_ADMINISTRATIVE_DIRECTORY).toHaveLength(34)
  })

  it('目录整体通过契约校验，且 id 全局唯一', () => {
    expectValid(validateAdministrativeDirectory(asContract(CHINA_ADMINISTRATIVE_DIRECTORY)))
    const ids = CHINA_ADMINISTRATIVE_DIRECTORY.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('台湾省、香港特别行政区、澳门特别行政区在列（红线）', () => {
    const byId = new Map(CHINA_ADMINISTRATIVE_DIRECTORY.map((entry) => [entry.id, entry]))
    expect(byId.get('CN-710000')).toStrictEqual({ id: 'CN-710000', name: '台湾省', type: 'province' })
    expect(byId.get('CN-810000')).toStrictEqual({
      id: 'CN-810000',
      name: '香港特别行政区',
      type: 'specialAdministrativeRegion',
    })
    expect(byId.get('CN-820000')).toStrictEqual({
      id: 'CN-820000',
      name: '澳门特别行政区',
      type: 'specialAdministrativeRegion',
    })
  })

  it('类型构成：23 省 + 5 自治区 + 4 直辖市 + 2 特别行政区', () => {
    const counts = new Map<string, number>()
    for (const entry of CHINA_ADMINISTRATIVE_DIRECTORY) {
      counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1)
    }
    expect(counts.get('province')).toBe(23)
    expect(counts.get('autonomousRegion')).toBe(5)
    expect(counts.get('municipality')).toBe(4)
    expect(counts.get('specialAdministrativeRegion')).toBe(2)
  })

  it('id 与 GB/T 2260 省级 adcode 对齐（北京 CN-110000 … 澳门 CN-820000）', () => {
    const ids = new Set(CHINA_ADMINISTRATIVE_DIRECTORY.map((entry) => entry.id))
    for (const expected of [
      'CN-110000', 'CN-120000', 'CN-130000', 'CN-140000', 'CN-150000',
      'CN-210000', 'CN-220000', 'CN-230000',
      'CN-310000', 'CN-320000', 'CN-330000', 'CN-340000', 'CN-350000', 'CN-360000', 'CN-370000',
      'CN-410000', 'CN-420000', 'CN-430000', 'CN-440000', 'CN-450000', 'CN-460000',
      'CN-500000', 'CN-510000', 'CN-520000', 'CN-530000', 'CN-540000',
      'CN-610000', 'CN-620000', 'CN-630000', 'CN-640000', 'CN-650000',
      'CN-710000', 'CN-810000', 'CN-820000',
    ]) {
      expect(ids.has(expected), `缺少 ${expected}`).toBe(true)
    }
  })
})

describe('行政区目录校验器', () => {
  it('重复行政区标识时确定性失败', () => {
    const payload = asContract([
      { id: 'CN-440000', name: '广东省', type: 'province' },
      { id: 'CN-440000', name: '广东省', type: 'province' },
    ])
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.duplicate-id',
    ])
  })

  it('畸形标识（无 CN- 前缀）时确定性失败', () => {
    const payload = asContract([{ id: '440000', name: '广东省', type: 'province' }])
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.id-malformed',
    ])
  })

  it('未知行政区类型时确定性失败', () => {
    const payload = asContract([{ id: 'CN-440000', name: '广东省', type: 'prefecture' }])
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.unknown-type',
    ])
  })

  it('空目录被拒绝', () => {
    expectInvalidContainingCodes(validateAdministrativeDirectory(asContract([])), [
      'admin-directory.empty-entries',
    ])
  })
})
