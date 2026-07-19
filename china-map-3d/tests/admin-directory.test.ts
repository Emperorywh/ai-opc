/**
 * 行政区目录契约测试。
 * 覆盖正常路径与确定性失败：重复行政区标识、畸形标识、未知类型。
 */

import { describe, it } from 'vitest'
import { validateAdministrativeDirectory } from '../src/geo-contracts'
import { loadFixture } from './_helpers'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

describe('行政区目录契约', () => {
  it('合法夹具通过校验', () => {
    const payload = loadFixture(['legal', 'admin-directory.json'])
    expectValid(validateAdministrativeDirectory(payload))
  })

  it('重复行政区标识时确定性失败（TASK-001 验证方式 2）', () => {
    const payload = loadFixture(['broken', 'admin-directory-duplicate-id.json'])
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.duplicate-id',
    ])
  })

  it('畸形标识（无 CN- 前缀）时确定性失败', () => {
    const payload = {
      kind: 'administrative-directory',
      version: '1.0.0',
      entries: [{ id: 'GD', name: '广东省', type: 'province' }],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.id-malformed',
    ])
  })

  it('未知行政区类型时确定性失败', () => {
    const payload = {
      kind: 'administrative-directory',
      version: '1.0.0',
      entries: [{ id: 'CN-GD', name: '广东省', type: 'prefecture' }],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.unknown-type',
    ])
  })

  it('空目录被拒绝', () => {
    const payload = {
      kind: 'administrative-directory',
      version: '1.0.0',
      entries: [],
      source: { sourceId: 'src-datav-provinces' },
    }
    expectInvalidContainingCodes(validateAdministrativeDirectory(payload), [
      'admin-directory.empty-entries',
    ])
  })
})
