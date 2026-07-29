/**
 * 生产标签字体子集资产深度校验测试（TASK-005 验收条件 1、2，SPEC §3.7）。
 *
 * 覆盖：
 * - 生产清单覆盖全部必需字符：34 省名 + 34 省会名（地点目录）、附图标注（岛礁名 +
 *   南海诸岛标题）、合规角标（SPEC §8 免责声明 / 审图号占位 / 数据源署名）与页面标题区。
 * - 缺失字符检测：从清单删除任一必需汉字 → 覆盖校验确定性失败（coverage-incomplete），
 *   深度校验同步失败。
 * - 清单 characters 与 sourceStrings 提取结果精确一致（无遗漏 / 无冗余）；sourceStrings
 *   与生产契约 / 静态文案逐条一致。
 * - 完整性锚点：字体 SHA-256 / 字节数与落盘字体逐项一致；审计 sidecar 与输入契约哈希闭环。
 * - 体积受控：KB 级，远小于完整 CJK 字体（数 MB 级）。
 * - 字体二进制合法：SFNT 魔数、必备表、整字体校验和、numGlyphs = 字符数 + 1、cmap 逐字核验。
 * - 篡改发现：清单缺字 / 字体字节被改 / 审计摘要被改 / 来源字符串失真 → 各自确定性失败。
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateLabelFontManifest,
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type LabelFontManifestContract,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts'
import {
  collectRequiredLabelFontStrings,
  extractCharactersFromStrings,
  validateLabelFontCoverage,
} from '../../src/lib/label-font'
import {
  COMPLIANCE_DISCLAIMER,
  COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER,
  PAGE_TITLE,
  SOUTH_CHINA_SEA_INSET_TITLE,
  collectStaticCopyStrings,
} from '../../src/lib/static-copy'
import { LABEL_FONT_MAX_BYTES, verifyLabelFontAsset } from '../../scripts/verify-assets/fonts-deep'
import { buildLabelFontBytes } from '../../scripts/fonts/build-font-subset'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const MANIFEST_PATH = 'public/fonts/china-labels-font.manifest.json'
const FONT_PATH = 'public/fonts/china-labels-font.subset.ttf'
const PROVENANCE_PATH = 'public/fonts/china-labels-font.provenance.json'

function readAssetText(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), 'utf-8')
}

function loadManifest(): LabelFontManifestContract {
  return JSON.parse(readAssetText(MANIFEST_PATH)) as LabelFontManifestContract
}

function loadFontBytes(): Uint8Array {
  return readFileSync(resolve(projectRoot, FONT_PATH))
}

function loadProductionContracts(): { places: PlaceDirectoryContract; political: PoliticalBoundaryContract } {
  const places = JSON.parse(readAssetText('public/geo/china-places.json')) as PlaceDirectoryContract
  const political = JSON.parse(readAssetText('public/geo/china-political-boundary.json')) as PoliticalBoundaryContract
  expect(validatePlaceDirectory(places).ok).toBe(true)
  expect(validatePoliticalBoundary(political).ok).toBe(true)
  return { places, political }
}

/** 以生产资产为入参调用深度校验（可逐项覆盖篡改）。 */
function verifyProduction(overrides: {
  manifest?: unknown
  fontBytes?: Uint8Array
  manifestText?: string
  provenance?: unknown
} = {}) {
  const { places, political } = loadProductionContracts()
  return verifyLabelFontAsset({
    manifest: overrides.manifest ?? loadManifest(),
    fontBytes: overrides.fontBytes ?? loadFontBytes(),
    manifestText: overrides.manifestText ?? readAssetText(MANIFEST_PATH),
    places,
    political,
    provenance: overrides.provenance ?? JSON.parse(readAssetText(PROVENANCE_PATH)),
    placesText: readAssetText('public/geo/china-places.json'),
    politicalText: readAssetText('public/geo/china-political-boundary.json'),
  })
}

describe('生产字体子集资产（验收条件 1：子集字体 + 清单存在且 KB 级）', () => {
  it('public/fonts 下存在子集字体与字符清单，清单通过结构契约校验', () => {
    const manifest = loadManifest()
    expect(validateLabelFontManifest(manifest).ok).toBe(true)
    expect(manifest.fontFile).toBe('china-labels-font.subset.ttf')
    expect(loadFontBytes().length).toBeGreaterThan(0)
  })

  it('字体体积 KB 级：明显小于完整 CJK 字体（数 MB 级）', () => {
    const fontBytes = loadFontBytes()
    const manifest = loadManifest()
    // 占位字形子集约 10KB；硬上限 512KB（即便未来替换为可读字形子集也仍在 KB 级）。
    expect(fontBytes.length).toBeLessThan(LABEL_FONT_MAX_BYTES)
    // 完整 CJK 字体（如思源黑体单字重）数 MB 级——子集必须小一个数量级以上。
    expect(fontBytes.length).toBeLessThan(1024 * 1024)
    expect(manifest.integrity.fontByteLength).toBe(fontBytes.length)
    expect(manifest.characters.length).toBeLessThanOrEqual(512)
  })

  it('字体二进制为合法 SFNT：TrueType 魔数 + 表目录 numTables > 0', () => {
    const fontBytes = loadFontBytes()
    const view = new DataView(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength)
    expect(view.getUint32(0, false)).toBe(0x00010000)
    expect(view.getUint16(4, false)).toBeGreaterThan(0)
  })

  it('审计 sidecar 存在且完整性摘要与产物一致', () => {
    const provenance = JSON.parse(readAssetText(PROVENANCE_PATH)) as {
      kind: string
      integrity: { fontSha256: string; manifestSha256: string; characterCount: number }
      disclaimer: string
    }
    expect(provenance.kind).toBe('label-font-asset-provenance')
    const manifest = loadManifest()
    expect(provenance.integrity.fontSha256).toBe(manifest.integrity.fontSha256)
    expect(provenance.integrity.manifestSha256).toBe(
      createHash('sha256').update(readAssetText(MANIFEST_PATH), 'utf-8').digest('hex'),
    )
    expect(provenance.integrity.characterCount).toBe(manifest.characters.length)
    expect(provenance.disclaimer.length).toBeGreaterThan(0)
  })
})

describe('生产字体子集资产（验收条件 2：字符全覆盖 + 缺失字符检测）', () => {
  it('清单字符集合覆盖全部必需字符串（34 省名 + 省会名 + 附图标注 + 合规角标 + 页面文案）', () => {
    const { places, political } = loadProductionContracts()
    const manifest = loadManifest()
    const outcome = validateLabelFontCoverage(manifest, collectRequiredLabelFontStrings(places, political))
    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
  })

  it('34 省名与 34 省会名的每个汉字都在清单字符集合内', () => {
    const { places } = loadProductionContracts()
    const charSet = new Set(loadManifest().characters)
    const anchors = places.entries.filter((e) => e.role === 'provinceNameAnchor')
    const capitals = places.entries.filter((e) => e.role === 'administrativeCapital')
    expect(anchors.length).toBe(34)
    expect(capitals.length).toBe(34)
    for (const entry of [...anchors, ...capitals]) {
      for (const ch of Array.from(entry.name)) {
        expect(charSet.has(ch), `「${entry.name}」的「${ch}」缺失`).toBe(true)
      }
    }
  })

  it('附图标注（岛礁名 + 南海诸岛标题）的每个汉字都在清单字符集合内', () => {
    const { political } = loadProductionContracts()
    const charSet = new Set(loadManifest().characters)
    const islandNames = political.features
      .filter((f) => f.type === 'islandOrReefPoint')
      .map((f) => f.name)
    expect(islandNames).toEqual(['钓鱼岛', '赤尾屿', '曾母暗沙', '黄岩岛', '永兴岛'])
    for (const name of [...islandNames, SOUTH_CHINA_SEA_INSET_TITLE]) {
      for (const ch of Array.from(name)) {
        expect(charSet.has(ch), `「${name}」的「${ch}」缺失`).toBe(true)
      }
    }
  })

  it('合规角标免责声明（SPEC §8 原文）与审图号占位的每个汉字都在清单字符集合内', () => {
    const charSet = new Set(loadManifest().characters)
    for (const text of [COMPLIANCE_DISCLAIMER, COMPLIANCE_REVIEW_NUMBER_PLACEHOLDER, PAGE_TITLE]) {
      for (const ch of Array.from(text)) {
        expect(charSet.has(ch), `「${text}」的「${ch}」缺失`).toBe(true)
      }
    }
  })

  it('缺失字符检测：删除「台」→ 覆盖校验 coverage-incomplete 且列出缺失字符', () => {
    const { places, political } = loadProductionContracts()
    const manifest = loadManifest()
    expect(manifest.characters).toContain('台')
    const tamperedCharacters = manifest.characters.filter((ch) => ch !== '台')
    // 保持清单其余字段自洽（只制造「缺字」这一类失真），精确命中覆盖失败路径。
    const tampered: LabelFontManifestContract = {
      ...manifest,
      characters: tamperedCharacters,
      integrity: { ...manifest.integrity, characterCount: tamperedCharacters.length },
    }
    const outcome = validateLabelFontCoverage(tampered, collectRequiredLabelFontStrings(places, political))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      expect(outcome.missingCharacters).toEqual(['台'])
    }
  })

  it('缺失字符检测：删除「诸」（南海诸岛附图标题）→ 覆盖校验确定性失败', () => {
    const { places, political } = loadProductionContracts()
    const manifest = loadManifest()
    expect(manifest.characters).toContain('诸')
    const tamperedCharacters = manifest.characters.filter((ch) => ch !== '诸')
    const tampered: LabelFontManifestContract = {
      ...manifest,
      characters: tamperedCharacters,
      integrity: { ...manifest.integrity, characterCount: tamperedCharacters.length },
    }
    const outcome = validateLabelFontCoverage(tampered, collectRequiredLabelFontStrings(places, political))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      expect(outcome.missingCharacters).toEqual(['诸'])
    }
  })

  it('深度校验：缺字清单 → fonts-asset 覆盖失败（与缺字路径同一把关）', () => {
    const manifest = loadManifest()
    const tamperedCharacters = manifest.characters.filter((ch) => ch !== '台')
    const tampered: LabelFontManifestContract = {
      ...manifest,
      characters: tamperedCharacters,
      integrity: { ...manifest.integrity, characterCount: tamperedCharacters.length },
    }
    const outcome = verifyProduction({ manifest: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('label-font.coverage-incomplete')
  })

  it('清单 characters 与 sourceStrings 提取结果精确一致（无遗漏 / 无冗余）', () => {
    const manifest = loadManifest()
    const allStrings = [
      ...manifest.sourceStrings.placeNames,
      ...manifest.sourceStrings.islandNames,
      ...manifest.sourceStrings.staticCopy,
    ]
    const expected = extractCharactersFromStrings(allStrings)
    expect(manifest.characters).toEqual(expected)
    expect(manifest.integrity.characterCount).toBe(manifest.characters.length)
  })

  it('清单 sourceStrings 与生产契约 / 静态文案逐条一致', () => {
    const { places, political } = loadProductionContracts()
    const manifest = loadManifest()
    expect(manifest.sourceStrings.placeNames).toEqual(places.entries.map((e) => e.name))
    expect(manifest.sourceStrings.islandNames).toEqual(
      political.features.filter((f) => f.type === 'islandOrReefPoint').map((f) => f.name),
    )
    expect(manifest.sourceStrings.staticCopy).toEqual(collectStaticCopyStrings())
  })
})

describe('生产字体子集资产（深度校验与篡改发现）', () => {
  it('verifyLabelFontAsset 对生产资产全绿（SFNT/cmap 逐字核验已执行）', () => {
    const outcome = verifyProduction()
    expect(outcome.ok, outcome.errors.map((e) => `${e.code} ${e.message}`).join('\n')).toBe(true)
    expect(outcome.samples.cmapChecked).toBe(true)
    expect(outcome.samples.numGlyphs).toBe(loadManifest().characters.length + 1)
    expect(outcome.samples.characterCount).toBe(loadManifest().characters.length)
    expect(outcome.samples.placeNameCount).toBe(68)
    expect(outcome.samples.islandNameCount).toBe(5)
  })

  it('篡改字体字节 → 清单 SHA-256 锚点确定性失败', () => {
    const tamperedFont = new Uint8Array(loadFontBytes())
    tamperedFont[tamperedFont.length - 1] = tamperedFont[tamperedFont.length - 1] ^ 0xff
    const outcome = verifyProduction({ fontBytes: tamperedFont })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('fonts-asset.font-sha256-mismatch')
  })

  it('篡改字体 cmap（删除一个字符映射）→ cmap 缺字检出', () => {
    // 场景：清单不变，字体被换成「剔除 台 后重产」的缺字字体——cmap 少一段、numGlyphs 少 1，
    // 深度校验必须在 cmap 字形映射核验中确定性检出「清单声称的字符字体实际无法渲染」。
    const manifest = loadManifest()
    const reducedFont = buildLabelFontBytes(manifest.characters.filter((ch) => ch !== '台'))
    const outcome = verifyProduction({ fontBytes: reducedFont })
    expect(outcome.ok).toBe(false)
    const codes = outcome.errors.map((e) => e.code)
    expect(codes).toContain('fonts-asset.sfnt-cmap-missing-glyph')
  })

  it('篡改审计 sidecar 完整性摘要 → provenance 锚点确定性失败', () => {
    const provenance = JSON.parse(readAssetText(PROVENANCE_PATH)) as {
      integrity: { fontSha256: string }
    }
    provenance.integrity.fontSha256 = '0'.repeat(64)
    const outcome = verifyProduction({ provenance })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('fonts-asset.provenance-integrity-mismatch')
  })

  it('清单 sourceStrings 失真（与生产契约不一致）→ 深度校验确定性失败', () => {
    const manifest = loadManifest()
    const tampered: LabelFontManifestContract = {
      ...manifest,
      sourceStrings: { ...manifest.sourceStrings, islandNames: ['不存在的岛'] },
    }
    const outcome = verifyProduction({ manifest: tampered })
    expect(outcome.ok).toBe(false)
    expect(outcome.errors.map((e) => e.code)).toContain('fonts-asset.source-strings-mismatch')
  })

  it('未提供字体字节时跳过 cmap 校验并如实标记（不假装通过）', () => {
    const { places, political } = loadProductionContracts()
    const outcome = verifyLabelFontAsset({
      manifest: loadManifest(),
      places,
      political,
    })
    expect(outcome.samples.cmapChecked).toBe(false)
    // 清单级校验（结构 + 覆盖 + 来源保真 + 体积）仍全部执行并通过。
    expect(outcome.ok, outcome.errors.map((e) => `${e.code} ${e.message}`).join('\n')).toBe(true)
  })
})
