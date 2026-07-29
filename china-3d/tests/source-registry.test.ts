/**
 * 数据来源注册表契约测试（SPEC §8）。
 * 重点验证非官方审图红线：非官方来源必须附带非空免责声明。
 */

import { describe, it } from 'vitest'
import { validateDataSourceRegistry } from '../src/geo-contracts'
import { expectInvalidContainingCodes, expectValid } from './_assertions'

/** 合法载荷：一份非官方来源（含免责声明）。 */
function makeLegalRegistry() {
  return {
    kind: 'data-source-registry',
    version: '1.0.0',
    sources: [
      {
        id: 'src-datav-provinces',
        name: 'DataV 省级边界',
        originUrl: 'https://example.invalid/datav',
        kind: 'administrativeBoundary',
        isOfficialSurvey: false,
        version: 'areas_v3 快照',
        license: 'DataV 条款',
        disclaimer: '非官方审图数据，仅供内部展示。',
      },
    ],
  }
}

describe('数据来源注册表契约', () => {
  it('合法载荷通过校验', () => {
    expectValid(validateDataSourceRegistry(makeLegalRegistry()))
  })

  it('非官方审图来源缺免责声明时确定性失败（SPEC §8 红线）', () => {
    const payload = makeLegalRegistry()
    delete (payload.sources[0] as { disclaimer?: string }).disclaimer
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.non-official-without-disclaimer',
    ])
  })

  it('非官方审图来源免责声明为空白时确定性失败（SPEC §8 红线）', () => {
    const payload = makeLegalRegistry()
    payload.sources[0].disclaimer = '   '
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.non-official-without-disclaimer',
    ])
  })

  it('重复来源 id 时确定性失败', () => {
    const payload = makeLegalRegistry()
    payload.sources.push({ ...payload.sources[0] })
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.duplicate-id',
    ])
  })

  it('未知来源类别时确定性失败', () => {
    const payload = makeLegalRegistry()
    ;(payload.sources[0] as { kind: string }).kind = 'satelliteImagery'
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.unknown-kind',
    ])
  })

  it('isOfficialSurvey 非布尔时确定性失败', () => {
    const payload = makeLegalRegistry()
    ;(payload.sources[0] as { isOfficialSurvey: unknown }).isOfficialSurvey = 'false'
    expectInvalidContainingCodes(validateDataSourceRegistry(payload), [
      'source.is-official-survey-not-boolean',
    ])
  })
})
