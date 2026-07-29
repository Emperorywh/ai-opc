/**
 * 标签字体子集生产管线测试（TASK-005，SPEC §3.7）。
 *
 * 覆盖确定性：
 * - scripts/fonts/build-font-subset.ts 的 buildLabelFontSubset：从生产地点目录 + 政治边界契约
 *   重产的字体二进制与清单文本同已交付资产逐字节一致（证明资产确由管线产出、未漂移）。
 * - 同一输入重复生产得到逐字节一致的字体二进制（纯函数确定性）。
 * - 重产产物过资产级深度校验（verifyLabelFontAsset 全绿），证明「生产 → 校验」闭环一致。
 * - 空字符集合被确定性拒绝（不产出空字体）。
 *
 * 依赖方向：测试基线（vitest，Node 环境），import scripts/ 生产模块、scripts/verify-assets
 * 深度校验与 src/ 领域层，读取 public/ 已交付资产做比对。不改写任何正式资产。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLabelFontBytes, buildLabelFontSubset } from '../../scripts/fonts/build-font-subset'
import { verifyLabelFontAsset } from '../../scripts/verify-assets/fonts-deep'
import {
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts'

const projectRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')

function loadProductionContracts(): { places: PlaceDirectoryContract; political: PoliticalBoundaryContract } {
  const places = JSON.parse(
    readFileSync(resolve(projectRoot, 'public/geo/china-places.json'), 'utf-8'),
  ) as PlaceDirectoryContract
  const political = JSON.parse(
    readFileSync(resolve(projectRoot, 'public/geo/china-political-boundary.json'), 'utf-8'),
  ) as PoliticalBoundaryContract
  expect(validatePlaceDirectory(places).ok).toBe(true)
  expect(validatePoliticalBoundary(political).ok).toBe(true)
  return { places, political }
}

describe('标签字体子集生产管线（build-font-subset）', () => {
  it('重产字体二进制与已交付 china-labels-font.subset.ttf 逐字节一致（资产未漂移）', () => {
    const { places, political } = loadProductionContracts()
    const rebuilt = buildLabelFontSubset(places, political)
    const delivered = readFileSync(resolve(projectRoot, 'public/fonts/china-labels-font.subset.ttf'))
    expect(Buffer.from(rebuilt.fontBytes).equals(delivered)).toBe(true)
  })

  it('重产清单文本与已交付 china-labels-font.manifest.json 逐字节一致（资产未漂移）', () => {
    const { places, political } = loadProductionContracts()
    const rebuilt = buildLabelFontSubset(places, political)
    const deliveredText = readFileSync(
      resolve(projectRoot, 'public/fonts/china-labels-font.manifest.json'),
      'utf-8',
    )
    expect(rebuilt.manifestText).toBe(deliveredText)
  })

  it('同一输入重复生产得到逐字节一致的字体二进制（纯函数确定性）', () => {
    const { places, political } = loadProductionContracts()
    const first = buildLabelFontSubset(places, political)
    const second = buildLabelFontSubset(places, political)
    expect(Buffer.from(first.fontBytes).equals(Buffer.from(second.fontBytes))).toBe(true)
    expect(first.manifestText).toBe(second.manifestText)
    expect(first.manifest.integrity.fontSha256).toBe(second.manifest.integrity.fontSha256)
  })

  it('重产产物过资产级深度校验（生产 → 校验闭环一致）', () => {
    const { places, political } = loadProductionContracts()
    const rebuilt = buildLabelFontSubset(places, political)
    const outcome = verifyLabelFontAsset({
      manifest: rebuilt.manifest,
      fontBytes: rebuilt.fontBytes,
      manifestText: rebuilt.manifestText,
      places,
      political,
      provenance: undefined,
      placesText: readFileSync(resolve(projectRoot, 'public/geo/china-places.json'), 'utf-8'),
      politicalText: readFileSync(resolve(projectRoot, 'public/geo/china-political-boundary.json'), 'utf-8'),
    })
    expect(outcome.ok, outcome.errors.map((e) => `${e.code} ${e.message}`).join('\n')).toBe(true)
    expect(outcome.samples.cmapChecked).toBe(true)
  })

  it('空字符集合被确定性拒绝（不产出空字体）', () => {
    expect(() => buildLabelFontBytes([])).toThrowError(/字符集合为空/)
  })

  it('空格（U+0020）映射到零轮廓空字形，其余字符为占位矩形（空格不得渲染出方块）', () => {
    // 码点升序：空格(0x20) < 中(0x4E2D) < 国(0x56FD) → 字形序：.notdef(0) 空格(1) 中(2) 国(3)。
    const font = buildLabelFontBytes(['中', ' ', '国'])
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
    const numTables = view.getUint16(4, false)
    const tableOffsets = new Map<string, number>()
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16
      const tag = String.fromCharCode(font[base], font[base + 1], font[base + 2], font[base + 3])
      tableOffsets.set(tag, view.getUint32(base + 8, false))
    }
    const glyfOffset = tableOffsets.get('glyf')!
    const locaOffset = tableOffsets.get('loca')!
    // 长格式 loca：numGlyphs+1 个 uint32 偏移。
    const glyphStart = (index: number): number => view.getUint32(locaOffset + index * 4, false)
    const contoursAt = (index: number): number => view.getInt16(glyfOffset + glyphStart(index), false)
    expect(contoursAt(1)).toBe(0) // 空格 → 零轮廓（无墨迹）
    expect(contoursAt(2)).toBe(1) // 中 → 占位矩形
    expect(contoursAt(3)).toBe(1) // 国 → 占位矩形
  })
})
