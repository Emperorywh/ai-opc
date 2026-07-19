/**
 * 数据来源注册表契约测试。
 * 重点验证非官方审图红线：非官方来源必须附带非空免责声明。
 */

import { describe, it } from 'vitest'
import { validateDataSourceRegistry } from '../src/geo-contracts'
import { loadFixture } from './_helpers'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

describe('数据来源注册表契约', () => {
  it('合法夹具通过校验', () => {
    const payload = loadFixture(['legal', 'data-sources.json'])
    expectValid(validateDataSourceRegistry(payload))
  })

  it('非官方审图来源缺免责声明时确定性失败（SPEC §8 红线）', () => {
    const payload = {
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
        },
      ],
    }
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.non-official-without-disclaimer',
    ])
  })

  it('重复来源 id 时确定性失败', () => {
    const payload = {
      kind: 'data-source-registry',
      version: '1.0.0',
      sources: [
        { id: 'dup', name: 'A', originUrl: 'u', kind: 'digitalElevationModel', isOfficialSurvey: false, version: '1', license: 'L', disclaimer: 'D' },
        { id: 'dup', name: 'B', originUrl: 'u', kind: 'digitalElevationModel', isOfficialSurvey: false, version: '1', license: 'L', disclaimer: 'D' },
      ],
    }
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.duplicate-id',
    ])
  })
})
