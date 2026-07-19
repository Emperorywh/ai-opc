/**
 * 离线字体子集覆盖校验测试（TASK-016 验证方式 2）。
 * 覆盖：合法清单通过、缺字明确失败（coverage-incomplete + 缺失列表）、结构非法各类失败码。
 */

import { describe, it, expect } from 'vitest'
import {
  extractCharactersFromStrings,
  validateLabelFontCoverage,
  type LabelFontManifest,
} from '../src/lib/label-font'

function makeManifest(overrides: Partial<LabelFontManifest> = {}): LabelFontManifest {
  return {
    kind: 'label-font-manifest',
    version: '1.0.0',
    fontFile: 'china-labels-font.subset.ttf',
    characters: ['北', '京', '天', '津', '钓', '鱼', '岛'],
    sourceStrings: { placeNames: ['北京', '天津'], islandNames: ['钓鱼岛'] },
    integrity: { fontSha256: 'a'.repeat(64), characterCount: 7, fontByteLength: 100 },
    disclaimer: '非官方审图数据，仅供内部展示。',
    ...overrides,
  }
}

describe('extractCharactersFromStrings', () => {
  it('排序去重提取字符', () => {
    const chars = extractCharactersFromStrings(['北京', '天津', '北京'])
    expect(chars).toEqual(['京', '北', '天', '津']) // 按码点升序
    expect(new Set(chars).size).toBe(chars.length)
  })
})

describe('validateLabelFontCoverage：合法 / 覆盖 / 结构失败', () => {
  it('清单覆盖全部字符串时通过', () => {
    const outcome = validateLabelFontCoverage(makeManifest(), ['北京', '天津', '钓鱼岛'])
    expect(outcome.ok).toBe(true)
  })

  it('缺一个必需汉字 → coverage-incomplete + 缺失列表', () => {
    // 清单缺「鱼」。
    const manifest = makeManifest({ characters: ['北', '京', '天', '津', '钓', '岛'] })
    const outcome = validateLabelFontCoverage(manifest, ['钓鱼岛'])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      expect(outcome.missingCharacters).toEqual(['鱼'])
      expect(outcome.message).toContain('鱼')
    }
  })

  it('删除任一必需汉字（多字）→ 缺失列表列出全部缺失', () => {
    const manifest = makeManifest({ characters: ['北', '京'] })
    const outcome = validateLabelFontCoverage(manifest, ['北京', '天津', '钓鱼岛'])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      expect(outcome.missingCharacters?.sort()).toEqual(['岛', '津', '天', '钓', '鱼'].sort())
    }
  })

  it('清单非对象 → manifest-not-object', () => {
    const outcome = validateLabelFontCoverage(null, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.manifest-not-object')
  })

  it('kind 错误 → manifest-wrong-kind', () => {
    const outcome = validateLabelFontCoverage({ ...makeManifest(), kind: 'other' }, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.manifest-wrong-kind')
  })

  it('characters 空 → characters-empty', () => {
    const outcome = validateLabelFontCoverage(makeManifest({ characters: [] }), [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.characters-empty')
  })

  it('character 多码点项 → character-not-string', () => {
    const outcome = validateLabelFontCoverage(makeManifest({ characters: ['北京'] }), [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.character-not-string')
  })

  it('sourceStrings 缺失 → source-strings-missing', () => {
    const outcome = validateLabelFontCoverage({ ...makeManifest(), sourceStrings: undefined as never }, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.source-strings-missing')
  })

  it('integrity 缺失 → integrity-missing', () => {
    const outcome = validateLabelFontCoverage({ ...makeManifest(), integrity: undefined as never }, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.integrity-missing')
  })

  it('disclaimer 空 → disclaimer-empty', () => {
    const outcome = validateLabelFontCoverage({ ...makeManifest(), disclaimer: '  ' }, [])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('label-font.disclaimer-empty')
  })
})
