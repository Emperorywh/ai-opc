/**
 * 标签字体子集领域逻辑与清单契约单元测试（TASK-005，SPEC §3.7）。
 *
 * 覆盖：
 * - extractCharactersFromStrings：排序去重、空集、按码点（而非 UTF-16 码元）切分。
 * - collectAllLabelDomainStrings / partitionLabelDomainStrings：从地点目录 + 政治边界契约
 *   确定性提取领域字符串（省名 + 省会名 + 岛礁名），不存在第二份中文名副本。
 * - collectRequiredLabelFontStrings：领域字符串 + 页面静态文案（附图标题 / 合规角标 / 页面标题区）。
 * - 静态文案唯一事实源（src/lib/static-copy.ts）：SPEC §8 免责声明逐字、字段齐全、顺序固定。
 * - validateLabelFontManifest：合法清单通过；结构违规（kind / 排序 / 重复 / SHA-256 格式 /
 *   计数一致 / fontFile 约束 / disclaimer）逐条确定性失败。
 * - validateLabelFontCoverage：覆盖通过；删除必需字符 → coverage-incomplete 且携带缺失字符；
 *   结构非法清单 → manifest-contract-invalid（不进入覆盖判定）。
 * - loadLabelFontManifest（TASK-010 运行时清单加载）：成功路径返回经结构校验的清单且对
 *   「生产地点目录渲染字符串」覆盖校验通过（加载 → 覆盖闭环）；fetch 失败 / HTTP 非 2xx /
 *   结构非法 → 各自稳定 code 抛 LabelFontLoadError，绝不返回伪造清单。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateLabelFontManifest,
  type LabelFontManifestContract,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../src/geo-contracts'
import { expectValid, expectInvalidContainingCodes } from './_assertions'
import {
  LabelFontLoadError,
  collectAllLabelDomainStrings,
  collectRequiredLabelFontStrings,
  extractCharactersFromStrings,
  loadLabelFontManifest,
  partitionLabelDomainStrings,
  validateLabelFontCoverage,
} from '../src/lib/label-font'
import { collectRenderedPlaceLabelStrings } from '../src/lib/place-labels'
import { PLACE_LABELS_CONFIG } from '../src/config/place-labels'
import {
  COMPLIANCE_DISCLAIMER,
  SOUTH_CHINA_SEA_INSET_TITLE,
  collectStaticCopyStrings,
} from '../src/lib/static-copy'

/** 合成一个最小地点目录契约（2 省 × 2 角色）。 */
function makeSyntheticPlaces(): PlaceDirectoryContract {
  return {
    kind: 'place-directory',
    version: '1.0.0',
    crs: 'EPSG:4326',
    entries: [
      { id: 'CN-110000-anchor', adminId: 'CN-110000', role: 'provinceNameAnchor', name: '北京', coordinate: { lon: 116.4, lat: 39.9 } },
      { id: 'CN-110000-capital', adminId: 'CN-110000', role: 'administrativeCapital', name: '北京', coordinate: { lon: 116.4, lat: 39.9 } },
      { id: 'CN-710000-anchor', adminId: 'CN-710000', role: 'provinceNameAnchor', name: '台湾', coordinate: { lon: 121.0, lat: 23.7 } },
      { id: 'CN-710000-capital', adminId: 'CN-710000', role: 'administrativeCapital', name: '台北', coordinate: { lon: 121.5, lat: 25.0 } },
    ],
    source: { sourceId: 'src-project-capitals' },
  }
}

/** 合成一个最小政治边界契约（1 段九段线 + 2 岛礁点）。 */
function makeSyntheticPolitical(): PoliticalBoundaryContract {
  return {
    kind: 'political-boundary',
    version: '1.0.0',
    crs: 'EPSG:4326',
    features: [
      {
        type: 'nineDashLineSegment',
        segmentIndex: 1,
        coordinates: [
          { lon: 121, lat: 24.5 },
          { lon: 121.5, lat: 22.5 },
        ],
      },
      { type: 'islandOrReefPoint', name: '钓鱼岛', coordinate: { lon: 123.46, lat: 25.75 } },
      { type: 'islandOrReefPoint', name: '曾母暗沙', coordinate: { lon: 112.3, lat: 3.58 } },
    ],
    source: { sourceId: 'src-project-political' },
  }
}

/** 由字符串集合合成一份结构合法的清单（characters 排序去重、integrity 自洽）。 */
function makeLegalManifest(sourceStrings: {
  placeNames: readonly string[]
  islandNames: readonly string[]
  staticCopy: readonly string[]
}): LabelFontManifestContract {
  const characters = extractCharactersFromStrings([
    ...sourceStrings.placeNames,
    ...sourceStrings.islandNames,
    ...sourceStrings.staticCopy,
  ])
  return {
    kind: 'label-font-manifest',
    version: '1.0.0',
    fontFile: 'china-labels-font.subset.ttf',
    characters,
    sourceStrings,
    integrity: {
      fontSha256: '0'.repeat(64),
      characterCount: characters.length,
      fontByteLength: 1024,
    },
    disclaimer: '仅供内部展示。',
  }
}

describe('extractCharactersFromStrings', () => {
  it('排序去重：同一字符串集合多次提取得到逐字符一致结果', () => {
    const a = extractCharactersFromStrings(['台湾', '台北', '北京'])
    const b = extractCharactersFromStrings(['台北', '北京', '台湾'])
    expect(a).toEqual(b)
    expect(a).toEqual(['北', '台', '京', '湾'].sort((x, y) => x.codePointAt(0)! - y.codePointAt(0)!))
    expect(new Set(a).size).toBe(a.length)
  })

  it('空输入得到空集合', () => {
    expect(extractCharactersFromStrings([])).toEqual([])
    expect(extractCharactersFromStrings([''])).toEqual([])
  })

  it('按 Unicode 码点切分（BMP 外字符不被拆成代理对）', () => {
    const chars = extractCharactersFromStrings(['𪚥中'])
    expect(chars).toContain('𪚥')
    expect(chars).toContain('中')
    expect(chars.every((ch) => Array.from(ch).length === 1)).toBe(true)
  })
})

describe('领域字符串收集（地点目录 + 政治边界契约）', () => {
  it('collectAllLabelDomainStrings = 省名 + 省会名（按条目序）+ 岛礁名（按要素序）', () => {
    const names = collectAllLabelDomainStrings(makeSyntheticPlaces(), makeSyntheticPolitical())
    expect(names).toEqual(['北京', '北京', '台湾', '台北', '钓鱼岛', '曾母暗沙'])
  })

  it('partitionLabelDomainStrings 按来源分区（placeNames / islandNames）', () => {
    const { placeNames, islandNames } = partitionLabelDomainStrings(makeSyntheticPlaces(), makeSyntheticPolitical())
    expect(placeNames).toEqual(['北京', '北京', '台湾', '台北'])
    expect(islandNames).toEqual(['钓鱼岛', '曾母暗沙'])
  })

  it('collectRequiredLabelFontStrings = 领域字符串 + 全部页面静态文案', () => {
    const required = collectRequiredLabelFontStrings(makeSyntheticPlaces(), makeSyntheticPolitical())
    const domain = collectAllLabelDomainStrings(makeSyntheticPlaces(), makeSyntheticPolitical())
    const staticCopy = collectStaticCopyStrings()
    expect(required).toEqual([...domain, ...staticCopy])
  })
})

describe('页面静态文案唯一事实源（static-copy）', () => {
  it('免责声明与 SPEC §8 原文逐字一致', () => {
    expect(COMPLIANCE_DISCLAIMER).toBe('本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版/发布用途')
  })

  it('南海附图标题为「南海诸岛」（SPEC §3.8 标注）', () => {
    expect(SOUTH_CHINA_SEA_INSET_TITLE).toBe('南海诸岛')
  })

  it('收集器返回全部文案、顺序固定、无空串', () => {
    const copy = collectStaticCopyStrings()
    expect(copy.length).toBeGreaterThanOrEqual(7)
    expect(copy.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
    // 顺序固定：两次收集逐条一致（字体清单确定性重产的前提）。
    expect(collectStaticCopyStrings()).toEqual(copy)
    expect(copy).toContain(COMPLIANCE_DISCLAIMER)
    expect(copy).toContain(SOUTH_CHINA_SEA_INSET_TITLE)
  })
})

describe('validateLabelFontManifest（清单结构契约）', () => {
  it('合法清单通过', () => {
    const manifest = makeLegalManifest({ placeNames: ['台湾', '台北'], islandNames: ['钓鱼岛'], staticCopy: ['南海诸岛'] })
    expectValid(validateLabelFontManifest(manifest))
  })

  it('kind 错误 / characters 未排序 / 字符重复 被确定性拒绝', () => {
    const legal = makeLegalManifest({ placeNames: ['台湾'], islandNames: [], staticCopy: [] })
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, kind: 'wrong' } as unknown), [
      'label-font-manifest.wrong-kind',
    ])
    expectInvalidContainingCodes(
      // 码点 湾(U+6E7E) > 台(U+53F0)，逆序。
      validateLabelFontManifest({ ...legal, characters: ['湾', '台'] }),
      ['label-font-manifest.characters-unsorted'],
    )
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, characters: ['台', '台'] }), [
      'label-font-manifest.character-duplicate',
    ])
  })

  it('fontFile 约束：路径分隔符与非法扩展名被拒绝', () => {
    const legal = makeLegalManifest({ placeNames: ['台湾'], islandNames: [], staticCopy: [] })
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, fontFile: '../x.ttf' }), [
      'label-font-manifest.font-file-not-sibling',
    ])
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, fontFile: 'font.otf' }), [
      'label-font-manifest.font-file-extension',
    ])
    expectValid(validateLabelFontManifest({ ...legal, fontFile: 'subset.woff' }))
  })

  it('integrity 约束：SHA-256 格式 / characterCount 与 characters.length 一致', () => {
    const legal = makeLegalManifest({ placeNames: ['台湾'], islandNames: [], staticCopy: [] })
    expectInvalidContainingCodes(
      validateLabelFontManifest({ ...legal, integrity: { ...legal.integrity, fontSha256: 'xyz' } }),
      ['label-font-manifest.integrity-sha-invalid'],
    )
    expectInvalidContainingCodes(
      validateLabelFontManifest({ ...legal, integrity: { ...legal.integrity, characterCount: legal.characters.length + 1 } }),
      ['label-font-manifest.integrity-count-mismatch'],
    )
  })

  it('空 characters / 空 disclaimer / 缺 sourceStrings 被拒绝', () => {
    const legal = makeLegalManifest({ placeNames: ['台湾'], islandNames: [], staticCopy: [] })
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, characters: [] }), [
      'label-font-manifest.characters-empty',
    ])
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, disclaimer: '' }), [
      'label-font-manifest.disclaimer-empty',
    ])
    expectInvalidContainingCodes(validateLabelFontManifest({ ...legal, sourceStrings: undefined } as unknown), [
      'label-font-manifest.source-strings-not-object',
    ])
  })
})

describe('validateLabelFontCoverage（覆盖校验）', () => {
  it('清单字符集合 ⊇ 必需字符串字符集合时通过', () => {
    const manifest = makeLegalManifest({ placeNames: ['台湾', '台北'], islandNames: ['钓鱼岛'], staticCopy: ['南海诸岛'] })
    const outcome = validateLabelFontCoverage(manifest, ['台湾', '台北', '钓鱼岛', '南海诸岛'])
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.manifest.characters).toEqual(manifest.characters)
    }
  })

  it('缺失字符检测：删除一个必需汉字 → coverage-incomplete 且携带缺失字符列表', () => {
    // 清单只含「台湾台北」，但必需字符串要求「钓鱼岛」。
    const manifest = makeLegalManifest({ placeNames: ['台湾', '台北'], islandNames: [], staticCopy: [] })
    const outcome = validateLabelFontCoverage(manifest, ['台湾', '钓鱼岛'])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      // 缺失字符按码点升序（岛 U+5C9B < 钓 U+9493 < 鱼 U+9C7C）。
      expect(outcome.missingCharacters).toEqual(['岛', '钓', '鱼'])
      expect(outcome.message).toContain('钓')
    }
  })

  it('结构非法清单 → manifest-contract-invalid（不进入覆盖判定）', () => {
    const outcome = validateLabelFontCoverage({ kind: 'wrong-kind' }, ['台湾'])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.manifest-contract-invalid')
      expect(outcome.missingCharacters).toBeUndefined()
    }
  })
})

describe('loadLabelFontManifest（TASK-010 运行时清单加载；fetch 以 vi.stubGlobal 注入 stub，不触网）', () => {
  /** 构造一个最小 fetch stub 响应。 */
  function stubResponse(init: { ok: boolean; status?: number; json?: () => Promise<unknown> }): Response {
    return {
      ok: init.ok,
      status: init.status ?? (init.ok ? 200 : 500),
      json: init.json ?? (async () => ({})),
    } as unknown as Response
  }

  /** 生产字体清单载荷（与运行时 fetch 的 JSON 同一份）。 */
  function loadProductionManifestPayload(): unknown {
    return JSON.parse(
      readFileSync(
        resolve(fileURLToPath(import.meta.url), '..', '..', 'public', 'fonts', 'china-labels-font.manifest.json'),
        'utf-8'),
    ) as unknown
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功路径：stub fetch 返回生产清单 JSON → 返回经结构校验的 manifest（kind / characters 非空）', async () => {
    const payload = loadProductionManifestPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const manifest = await loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
    expect(manifest.kind).toBe('label-font-manifest')
    expect(manifest.characters.length).toBeGreaterThan(0)
    expect(manifest.fontFile).toBe('china-labels-font.subset.ttf')
  })

  it('成功路径：生产清单对「生产地点目录渲染字符串」覆盖校验通过（加载 → 覆盖闭环）', async () => {
    // 与 App 装配层同一闭环：loadLabelFontManifest → validateLabelFontCoverage（渲染字符串由
    // collectRenderedPlaceLabelStrings 从生产地点目录提取）。缺字会在此确定性失败。
    const payload = loadProductionManifestPayload()
    vi.stubGlobal('fetch', async () => stubResponse({ ok: true, json: async () => payload }))
    const manifest = await loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
    const places = JSON.parse(
      readFileSync(
        resolve(fileURLToPath(import.meta.url), '..', '..', 'public', 'geo', 'china-places.json'),
        'utf-8'),
    ) as PlaceDirectoryContract
    const coverage = validateLabelFontCoverage(manifest, collectRenderedPlaceLabelStrings(places))
    expect(coverage.ok, coverage.ok ? '' : coverage.message).toBe(true)
  })

  it('fetch 抛错（网络层失败）→ LabelFontLoadError(manifest-fetch-failed)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down')
    })
    try {
      await loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
      expect.unreachable('网络失败应抛 LabelFontLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(LabelFontLoadError)
      expect((e as LabelFontLoadError).code).toBe('label-font.manifest-fetch-failed')
    }
  })

  it('HTTP 非 2xx → LabelFontLoadError(manifest-fetch-failed)', async () => {
    vi.stubGlobal('fetch', async () => stubResponse({ ok: false, status: 404 }))
    try {
      await loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
      expect.unreachable('HTTP 404 应抛 LabelFontLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(LabelFontLoadError)
      expect((e as LabelFontLoadError).code).toBe('label-font.manifest-fetch-failed')
      expect((e as LabelFontLoadError).message).toContain('404')
    }
  })

  it('载荷未通过清单结构契约 → LabelFontLoadError(manifest-contract-invalid)，绝不返回伪造清单', async () => {
    vi.stubGlobal('fetch', async () =>
      stubResponse({ ok: true, json: async () => ({ kind: 'wrong-kind', characters: [] }) }),
    )
    try {
      await loadLabelFontManifest(PLACE_LABELS_CONFIG.fontManifestPath)
      expect.unreachable('结构非法应抛 LabelFontLoadError')
    } catch (e) {
      expect(e).toBeInstanceOf(LabelFontLoadError)
      expect((e as LabelFontLoadError).code).toBe('label-font.manifest-contract-invalid')
    }
  })
})
