/**
 * 生产字体子集资产深度校验测试（TASK-016 验证方式 2、3）。
 * 覆盖：清单字符集合覆盖生产契约全部领域字符串、字体完整性摘要与落盘字体逐项一致、
 * 字体 URL 为本地路径（无在线字体请求）、缺字路径确定性失败。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts'
import { collectAllLabelDomainStrings } from '../../src/lib/place-labels'
import {
  extractCharactersFromStrings,
  validateLabelFontCoverage,
  type LabelFontManifest,
} from '../../src/lib/label-font'
import { PLACE_LABELS_CONFIG } from '../../src/config/place-labels'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const MANIFEST_PATH = 'public/fonts/china-labels-font.manifest.json'
const FONT_PATH = 'public/fonts/china-labels-font.subset.ttf'

function loadManifest(): LabelFontManifest {
  return JSON.parse(readFileSync(resolve(projectRoot, MANIFEST_PATH), 'utf-8')) as LabelFontManifest
}

function loadDomainStrings(): readonly string[] {
  const places = JSON.parse(readFileSync(resolve(projectRoot, 'public/geo/china-places.json'), 'utf-8')) as PlaceDirectoryContract
  const political = JSON.parse(readFileSync(resolve(projectRoot, 'public/geo/china-political-boundary.json'), 'utf-8')) as PoliticalBoundaryContract
  expect(validatePlaceDirectory(places).ok).toBe(true)
  expect(validatePoliticalBoundary(political).ok).toBe(true)
  return collectAllLabelDomainStrings(places, political)
}

describe('生产字体子集资产（TASK-016 验证方式 2、3）', () => {
  it('清单字符集合覆盖生产契约全部领域字符串（省名 + 省会名 + 岛礁名）', () => {
    const manifest = loadManifest()
    const domainStrings = loadDomainStrings()
    const outcome = validateLabelFontCoverage(manifest, domainStrings)
    expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true)
  })

  it('清单 characters 与从 sourceStrings 提取的字符集合一致（无遗漏 / 无冗余）', () => {
    const manifest = loadManifest()
    const allStrings = [...manifest.sourceStrings.placeNames, ...manifest.sourceStrings.islandNames]
    const expected = extractCharactersFromStrings(allStrings)
    expect(manifest.characters).toEqual(expected)
    expect(manifest.integrity.characterCount).toBe(manifest.characters.length)
  })

  it('字体完整性摘要与落盘字体逐项一致（SHA-256 / 字节数）', () => {
    const manifest = loadManifest()
    const fontBytes = readFileSync(resolve(projectRoot, FONT_PATH))
    const sha256 = createHash('sha256').update(fontBytes).digest('hex')
    expect(manifest.integrity.fontSha256).toBe(sha256)
    expect(manifest.integrity.fontByteLength).toBe(fontBytes.length)
  })

  it('字体 URL 为本地路径，无在线字体请求（https:// CDN）', () => {
    expect(PLACE_LABELS_CONFIG.fontPath.startsWith('/fonts/')).toBe(true)
    expect(PLACE_LABELS_CONFIG.fontPath).not.toMatch(/^https?:\/\//)
    expect(PLACE_LABELS_CONFIG.fontManifestPath.startsWith('/fonts/')).toBe(true)
    expect(PLACE_LABELS_CONFIG.fontManifestPath).not.toMatch(/^https?:\/\//)
  })

  it('字体体积受控（不含完整 CJK 字体，约数十 KB 级）', () => {
    const manifest = loadManifest()
    // 101 字符占位字体 ~6KB；可读字体子集应仍在百 KB 级内，远小于完整思源黑体（数 MB）。
    expect(manifest.integrity.characterCount).toBeLessThan(300)
    expect(manifest.integrity.fontByteLength).toBeLessThan(500_000)
  })

  it('缺字路径确定性失败：从清单删除一个必需汉字 → coverage-incomplete', () => {
    const manifest = loadManifest()
    const domainStrings = loadDomainStrings()
    // 删除第一个必需字符。
    const tampered: LabelFontManifest = {
      ...manifest,
      characters: manifest.characters.filter((_, i) => i !== 0),
    }
    const outcome = validateLabelFontCoverage(tampered, domainStrings)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('label-font.coverage-incomplete')
      expect(outcome.missingCharacters?.length).toBeGreaterThan(0)
    }
  })

  it('字体二进制可识别为合法 SFNT（TrueType 魔数 0x00010000）', () => {
    const fontBytes = readFileSync(resolve(projectRoot, FONT_PATH))
    const view = new DataView(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength)
    // SFNT 版本：TrueType = 0x00010000，或 'OTTO'（CFF），或 'true'。
    const sfntVersion = view.getUint32(0, false)
    expect([0x00010000, 0x74727565, 0x4f54544f]).toContain(sfntVersion)
    // numTables > 0。
    const numTables = view.getUint16(4, false)
    expect(numTables).toBeGreaterThan(0)
  })
})
