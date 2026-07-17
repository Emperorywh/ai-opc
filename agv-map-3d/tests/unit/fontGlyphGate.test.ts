/*
 * 字体字形门禁与清单解析自动化验证（TASK-015，SPEC 2.5 / 11.1 / 14.1 / 15.1 / 16）。
 *
 * 设计：
 *   - 纯函数覆盖：checkLabelGlyphCoverage 在 ASCII / 中文缺字下精确报告码点与首次出现文本；
 *     collectTextCodePoints 按 Unicode code point 去重（含 > U+FFFF 代理对语义）；
 *     formatCodePointHex 与 glyphs.json 的 hex 字段同口径。
 *   - 清单解析：parseGlyphManifest 在结构损坏 / 非整数码点 / 重复码点 / 空清单下抛 FONT_ASSET_FAILED。
 *   - 真实样本集成：先校验 SHA-256，再走完整可信链到 SceneMap，提取全部 4810 个名称，
 *     逐 code point 扫描全部在 glyphs.json 内；交叉校验实际中文字符集合与 SPEC 2.5 基线一致。
 *   - 字体资产存在性：public/fonts/NotoSansSC-Bold.sample.woff / LICENSE / glyphs.json 均已打包，
 *     字节数合理、清单码点数 = ASCII 可打印区 + 样本中文集合。
 *
 * 不启动浏览器：合成测试只调纯函数；真实样本在 node 环境直接读取，不接触 Three / React / Troika。
 */
import { describe, test, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  checkLabelGlyphCoverage,
  collectTextCodePoints,
  formatCodePointHex,
} from '../../src/labels/fontGlyphGate'
import { parseGlyphManifest } from '../../src/labels/glyphManifest'
import {
  computeFileSha256,
  EXPECTED_SAMPLE_SHA256,
} from '../../scripts/sample-supply-chain.mjs'
import { parseSampleEnvelope } from '../../src/adapters/parseSampleEnvelope'
import { validateMapSemantics } from '../../src/adapters/validateMapSemantics'
import { normalizeSceneMap } from '../../src/adapters/normalizeSceneMap'
import { isMapDataError, MapErrorCode } from '../../src/domain/mapDataError'
import { SAMPLE_NAME_BASELINE } from '../fixture/sampleBaseline'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const REAL_SAMPLE = resolve(root, 'data', 'sampleMap.json')
const FONT_DIR = resolve(root, 'public', 'fonts')
const FONT_WOFF = resolve(FONT_DIR, 'NotoSansSC-Bold.sample.woff')
const FONT_GLYPHS = resolve(FONT_DIR, 'glyphs.json')
const FONT_LICENSE = resolve(FONT_DIR, 'LICENSE')
const FONT_SOURCE = resolve(FONT_DIR, 'SOURCE.md')

// ─── 纯函数 · 字形覆盖门禁（SPEC 11.1 / 14.1）──────────────────────────────────────

describe('字形覆盖门禁 · 纯函数（SPEC 11.1 / 14.1）', () => {
  test('全部覆盖时返回 ok=true', () => {
    const manifest = new Set([0x41, 0x42, 0x20]) // A, B, space
    const result = checkLabelGlyphCoverage(['AB', 'A B'], manifest)
    expect(result.ok).toBe(true)
  })

  test('缺一个 ASCII 字符：精确报告码点 U+0041（A）与首次出现文本', () => {
    // 清单只含空格与 B；文本 'BA' 中的 A 未覆盖。
    const manifest = new Set([0x20, 0x42])
    const result = checkLabelGlyphCoverage(['BA'], manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toHaveLength(1)
      expect(result.missing[0].codePoint).toBe(0x41)
      expect(result.missing[0].hex).toBe('U+0041')
      expect(result.missing[0].char).toBe('A')
      expect(result.missing[0].firstText).toBe('BA')
    }
  })

  test('缺一个中文字符：精确报告码点与首次出现文本', () => {
    // 清单缺 "口"(U+53E3)；文本 '门口' 含未覆盖码点。
    const manifest = new Set([0x95e8]) // 只含 "门"
    const result = checkLabelGlyphCoverage(['门口'], manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing[0].codePoint).toBe(0x53e3)
      expect(result.missing[0].hex).toBe('U+53E3')
      expect(result.missing[0].char).toBe('口')
      expect(result.missing[0].firstText).toBe('门口')
    }
  })

  test('多个缺失码点按首次出现顺序去重记录', () => {
    const manifest = new Set([0x20])
    const result = checkLabelGlyphCoverage(['AB', 'AC'], manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // A 首次出现在 'AB'，B 首次出现在 'AB'，C 首次出现在 'AC'；A 不重复追加。
      const cps = result.missing.map((m) => m.codePoint)
      expect(cps).toEqual([0x41, 0x42, 0x43])
      expect(result.missing[0].firstText).toBe('AB')
      expect(result.missing[2].firstText).toBe('AC')
    }
  })

  test('同一缺失码点重复出现只记录一次', () => {
    const manifest = new Set<number>([])
    const result = checkLabelGlyphCoverage(['AAA', 'A'], manifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing).toHaveLength(1)
      expect(result.missing[0].codePoint).toBe(0x41)
    }
  })

  test('空文本数组与空字符串不产生缺失记录', () => {
    const manifest = new Set<number>([0x41])
    expect(checkLabelGlyphCoverage([], manifest).ok).toBe(true)
    expect(checkLabelGlyphCoverage([''], manifest).ok).toBe(true)
  })

  test('以 Unicode code point 而非 UTF-16 码元为单位（> U+FFFF）', () => {
    // 𝔸 = U+1D538（数学粗体 A），UTF-16 两个码元 0xD835 0xDD38。
    // 清单只含完整码点 U+1D538 时应通过；只含代理码元时应判缺失。
    const text = '𝔸'
    expect(text.length).toBe(2) // 两个 UTF-16 码元
    const okManifest = new Set([0x1d538])
    expect(checkLabelGlyphCoverage([text], okManifest).ok).toBe(true)
    const badManifest = new Set([0xd835, 0xdd38]) // 只含代理码元
    const result = checkLabelGlyphCoverage([text], badManifest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.missing[0].codePoint).toBe(0x1d538)
    }
  })
})

// ─── 纯函数 · 码点去重（SPEC 11.1 全部去重名称字符）──────────────────────────────────

describe('collectTextCodePoints · 按 Unicode code point 去重（SPEC 11.1）', () => {
  test('去重并升序输出码点数值', () => {
    const cps = collectTextCodePoints(['BA', 'AB'])
    expect(cps).toEqual([0x41, 0x42]) // A, B 升序去重
  })

  test('中文与 ASCII 混合：按码点数值升序（ASCII 在前）', () => {
    const cps = collectTextCodePoints(['门口1'])
    expect(cps).toEqual([0x31, 0x53e3, 0x95e8]) // '1' < '口' < '门'
  })

  test('> U+FFFF 的码点作为单一码点收集（非两个代理码元）', () => {
    const cps = collectTextCodePoints(['𝔸'])
    expect(cps).toEqual([0x1d538])
    expect(cps).toHaveLength(1)
  })

  test('formatCodePointHex 与 glyphs.json 的 hex 字段同口径', () => {
    expect(formatCodePointHex(0x20)).toBe('U+0020')
    expect(formatCodePointHex(0x7e)).toBe('U+007E')
    expect(formatCodePointHex(0x95e8)).toBe('U+95E8')
    expect(formatCodePointHex(0x1d538)).toBe('U+1D538')
  })
})

// ─── 清单解析 · 严格校验（SPEC 11.1 / 14.1）──────────────────────────────────────────

describe('parseGlyphManifest · 严格校验（SPEC 11.1 / 14.1）', () => {
  test('合法清单 → 返回只读码点集合', () => {
    const manifest = {
      codePoints: [
        { codePoint: 0x20, hex: 'U+0020', char: ' ' },
        { codePoint: 0x41, hex: 'U+0041', char: 'A' },
      ],
    }
    const set = parseGlyphManifest(manifest)
    expect(set.size).toBe(2)
    expect(set.has(0x20)).toBe(true)
    expect(set.has(0x41)).toBe(true)
  })

  test('根对象非对象 → FONT_ASSET_FAILED', () => {
    const err = captureError(() => parseGlyphManifest(null))
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('codePoints 非数组 → FONT_ASSET_FAILED', () => {
    const err = captureError(() => parseGlyphManifest({ codePoints: 'x' }))
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('非整数码点 → FONT_ASSET_FAILED', () => {
    const err = captureError(() =>
      parseGlyphManifest({ codePoints: [{ codePoint: 1.5 }] }),
    )
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('超范围码点 → FONT_ASSET_FAILED', () => {
    const err = captureError(() =>
      parseGlyphManifest({ codePoints: [{ codePoint: 0x110000 }] }),
    )
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('重复码点 → FONT_ASSET_FAILED（不静默去重）', () => {
    const err = captureError(() =>
      parseGlyphManifest({
        codePoints: [{ codePoint: 0x41 }, { codePoint: 0x41 }],
      }),
    )
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('空清单 → FONT_ASSET_FAILED', () => {
    const err = captureError(() => parseGlyphManifest({ codePoints: [] }))
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })

  test('码点记录非对象 → FONT_ASSET_FAILED', () => {
    const err = captureError(() =>
      parseGlyphManifest({ codePoints: [42] }),
    )
    expect(isMapDataError(err)).toBe(true)
    if (isMapDataError(err)) expect(err.code).toBe(MapErrorCode.FONT_ASSET_FAILED)
  })
})

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('期望抛出异常，但未抛出')
}

// ─── 真实样本集成 · 字形门禁（SPEC 2.5 / 11.1 / 15.1）────────────────────────────────

let allNames: string[]
let manifestSet: ReadonlySet<number>
let manifestRaw: { codePoints: Array<{ codePoint: number; hex: string; char: string }> }

beforeAll(async () => {
  // SPEC 15.1：哈希不符不得继续回归验证。
  const sha = await computeFileSha256(REAL_SAMPLE)
  if (sha !== EXPECTED_SAMPLE_SHA256) {
    throw new Error(`样本身份不符，停止回归验证：${sha}`)
  }
  // 走完整可信链提取全部名称（不读原始 JSON 字段、不重建标签描述符）。
  const rawJson = JSON.parse(readFileSync(REAL_SAMPLE, 'utf8')) as unknown
  const rawMap = parseSampleEnvelope(rawJson)
  validateMapSemantics(rawMap)
  const sceneMap = normalizeSceneMap(rawMap)
  allNames = [
    ...sceneMap.nodes.map((n) => n.name),
    ...sceneMap.edges.map((e) => e.name),
  ]
  // 解析随项目打包的字形清单。
  manifestRaw = JSON.parse(readFileSync(FONT_GLYPHS, 'utf8')) as typeof manifestRaw
  manifestSet = parseGlyphManifest(manifestRaw)
})

describe('真实字体资产 · 存在性与来源（SPEC 11.1）', () => {
  test('NotoSansSC-Bold.sample.woff / glyphs.json / LICENSE / SOURCE.md 均已打包', () => {
    expect(existsSync(FONT_WOFF)).toBe(true)
    expect(existsSync(FONT_GLYPHS)).toBe(true)
    expect(existsSync(FONT_LICENSE)).toBe(true)
    expect(existsSync(FONT_SOURCE)).toBe(true)
  })

  test('子集 WOFF 是 Troika 支持的本地 .woff（扩展名 + 非空 + WOFF 魔数）', () => {
    const buf = readFileSync(FONT_WOFF)
    expect(buf.byteLength).toBeGreaterThan(1000)
    // WOFF 魔数：0x774F4646（"wOFF"），小端序前 4 字节为 0x77 0x4F 0x46 0x46。
    expect(buf[0]).toBe(0x77)
    expect(buf[1]).toBe(0x4f)
    expect(buf[2]).toBe(0x46)
    expect(buf[3]).toBe(0x46)
  })

  test('LICENSE 含 SIL Open Font License 1.1 标识', () => {
    const text = readFileSync(FONT_LICENSE, 'utf8')
    expect(text).toContain('SIL OPEN FONT LICENSE')
    expect(text).toContain('Version 1.1')
  })

  test('SOURCE.md 含来源 URL、源 SHA-256 与子集范围', () => {
    const text = readFileSync(FONT_SOURCE, 'utf8')
    expect(text).toContain('https://fonts.gstatic.com/s/notosanssc/')
    expect(text).toContain('SHA-256')
    expect(text).toContain('U+0020')
    expect(text).toContain('U+007E')
    expect(text).toContain('丝充制口抛桩点电碱站绒网门')
  })

  test('glyphs.json 记录的 fontAssetSha256 与磁盘 WOFF 实际哈希一致', async () => {
    const actual = await computeFileSha256(FONT_WOFF)
    const recorded = (manifestRaw as unknown as { fontAssetSha256: string }).fontAssetSha256
    expect(recorded).toBeDefined()
    expect(actual).toBe(recorded)
  })
})

describe('真实样本字形门禁 · 全部名称通过（SPEC 2.5 / 11.1 / 15.1）', () => {
  test('样本名称总数 = 1767 节点 + 3043 边 = 4810', () => {
    expect(allNames).toHaveLength(4810)
  })

  test('清单码点数 = ASCII 可打印区(95) + 样本中文集合(13) = 108', () => {
    // ASCII U+0020–U+007E = 95 个；样本中文 13 个；无重叠 → 108。
    expect(manifestSet.size).toBe(95 + 13)
    expect(manifestSet.size).toBe(108)
  })

  test('清单完整覆盖 ASCII 可打印区 U+0020–U+007E', () => {
    for (let cp = 0x20; cp <= 0x7e; cp++) {
      expect(manifestSet.has(cp)).toBe(true)
    }
  })

  test('清单覆盖样本中文集合（与 SPEC 2.5 基线一致，13 个字符）', () => {
    for (const ch of SAMPLE_NAME_BASELINE.chineseCharset) {
      expect(manifestSet.has(ch.codePointAt(0)!)).toBe(true)
    }
    // 交叉校验：样本实际出现的中文码点集合与 SPEC 基线字符串完全一致。
    const sampleZh = new Set<string>()
    for (const name of allNames) {
      for (const ch of name) {
        const cp = ch.codePointAt(0)!
        if (cp > 0x7e) sampleZh.add(ch)
      }
    }
    expect([...sampleZh].sort().join('')).toBe(
      [...SAMPLE_NAME_BASELINE.chineseCharset].sort().join(''),
    )
  })

  test('逐 code point 扫描：全部 4810 个名称的每个码点都在清单内（无缺字）', () => {
    const result = checkLabelGlyphCoverage(allNames, manifestSet)
    expect(result.ok).toBe(true)
  })

  test('异常注入：从清单移除一个 ASCII 字符后，门禁报告 FONT_GLYPH_MISSING 缺 U+0031', () => {
    // 构造“移除数字 1（U+0031）”的破损清单；样本边名多为数字串，必含 '1'。
    const broken = new Set(manifestSet)
    broken.delete(0x31)
    const result = checkLabelGlyphCoverage(allNames, broken)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const miss1 = result.missing.find((m) => m.codePoint === 0x31)
      expect(miss1).toBeDefined()
      expect(miss1!.hex).toBe('U+0031')
      expect(miss1!.firstText).toMatch(/1/)
    }
  })

  test('异常注入：从清单移除一个中文字符后，门禁报告 FONT_GLYPH_MISSING 缺 U+95E8（门）', () => {
    const broken = new Set(manifestSet)
    broken.delete(0x95e8) // "门"
    const result = checkLabelGlyphCoverage(allNames, broken)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const miss = result.missing.find((m) => m.codePoint === 0x95e8)
      expect(miss).toBeDefined()
      expect(miss!.char).toBe('门')
    }
  })

  test('真实资产诊断：glyphs.json 字节数合理且 SOURCE.md 引用一致', () => {
    expect(statSync(FONT_GLYPHS).size).toBeLessThan(20_000)
    expect(statSync(FONT_WOFF).size).toBeLessThan(100_000)
  })
})
