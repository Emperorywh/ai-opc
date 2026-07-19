/**
 * 标签字体子集确定性生产：地点目录 + 政治边界契约 → china-labels-font.subset.ttf + manifest.json。
 *
 * 角色与依赖方向（离线资产生产层，scripts/fonts，tsx 运行）：
 * - 单向依赖 src/geo-contracts（契约校验）、src/lib/place-labels（collectAllLabelDomainStrings ——
 *   「从契约提取字体必须覆盖的领域字符串」的唯一入口；运行时字体覆盖校验与本离线脚本共用同一提取逻辑，
 *   不存在第二份中文名副本）、src/lib/label-font（extractCharactersFromStrings —— 字符集合提取的唯一入口）。
 *   严禁依赖浏览器 / React / Three.js / troika 或任何运行时状态（SPEC §3.7、TASK-016 实现约束）。
 *
 * 字体子集离线生成（SPEC §3.7「裁剪字体子集仅含 34 省名 + 省会名 + 附图 / 岛礁所需汉字…troika 加载该子集
 * .ttf/.woff；不打包完整思源黑体」、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载，不得依赖
 * 系统字体偶然存在、在线字体或完整思源字体包」、验证方式 3「无在线字体请求」）：
 * - 字符集合由 collectAllLabelDomainStrings 从生产地点目录 + 政治边界契约确定性提取（省名 + 省会名 + 岛礁名），
 *   再经 extractCharactersFromStrings 排序去重。字体二进制只含这些字符的 cmap 映射 + 字形——不打包完整 CJK
 *   字体（体积受控：字符数 ≈ 百余，字体文件数十 KB 级）。
 * - 字体二进制为本脚本确定性生成的合法 TrueType（.ttf）：每个必需字符映射到一个字形（占位矩形），troika
 *   可离线加载、渲染。字形为占位矩形（非可读汉字）——本脚本产出的是「字体管线可用的合法离线字体」，证明
 *   字体加载 / 覆盖校验 / 渲染管线端到端可用；正式发布前由人工以可读 CJK 字体子集替换该二进制（清单与覆盖
 *   校验管线不变），属人工视觉验收范畴（TASK-016 验证方式 4「人工执行 pnpm dev」）。
 *
 * 可重复性与防篡改（与 build-places 同构）：
 * - 同一地点 + 政治契约多次重产得到逐字节一致的字体二进制 + 清单（字段顺序固定、字符按码点升序）。
 * - 清单 integrity.fontSha256 = 字体二进制 SHA-256，字体字节字节数 = fontByteLength，供资产校验
 *   （scripts/verify-assets）与运行时完整性核对复用。字体缺字（清单 characters ⊇ 实际字符串）由运行时
 *   validateLabelFontCoverage 与资产校验共同把关（TASK-016 验证方式 2「删除任一必需汉字…时应明确失败」）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts/index'
import { collectAllLabelDomainStrings } from '../../src/lib/place-labels'
import { extractCharactersFromStrings } from '../../src/lib/label-font'

/** 字体设计单位（em 的 1000 等分，TrueType 常用值）。 */
const UNITS_PER_EM = 1000
/** 占位字形矩形：左下 (margin, margin) 到右上 (em - margin, em - margin)。 */
const GLYPH_MARGIN = 100
const GLYPH_BOX_SIZE = UNITS_PER_EM - 2 * GLYPH_MARGIN // 800

// ────────────────────────────────────────────────────────────────────────────
// 二进制写入缓冲（大端，SFNT/TrueType 字节序）
// ────────────────────────────────────────────────────────────────────────────

/** 可变字节数组缓冲，按 SFNT 大端序写入。 */
class BufferWriter {
  private readonly bytes: number[] = []

  get length(): number {
    return this.bytes.length
  }

  /** 写入无符号 8 位。 */
  u8(value: number): void {
    this.bytes.push(value & 0xff)
  }

  /** 写入无符号大端 16 位。 */
  u16(value: number): void {
    this.bytes.push((value >>> 8) & 0xff, value & 0xff)
  }

  /** 写入无符号大端 32 位。 */
  u32(value: number): void {
    this.bytes.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    )
  }

  /** 写入有符号大端 16 位。 */
  i16(value: number): void {
    this.u16(value & 0xffff)
  }

  /** 写入 4 字节标签（ASCII）。 */
  tag(value: string): void {
    for (let i = 0; i < 4; i++) this.u8(value.charCodeAt(i) & 0xff)
  }

  /** 写入原始字节数组。 */
  bytes_(value: number[] | readonly number[]): void {
    for (const b of value) this.bytes.push(b & 0xff)
  }

  /** 写入 UTF-16BE 字符串（name 表用）。 */
  utf16be(value: string): void {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      this.u16(code)
    }
  }

  /** 4 字节对齐填充（SFNT 表要求 4 字节边界）。 */
  padTo4(): void {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0)
  }

  /** 导出为 Uint8Array。 */
  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

/** 计算字节数组的 SFNT 表校验和（uint32 大端累加，不足 4 字节补 0）。 */
function tableChecksum(bytes: Uint8Array): number {
  let sum = 0
  const len = bytes.length
  for (let i = 0; i < len; i += 4) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const b3 = bytes[i + 3] ?? 0
    sum = (sum + ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)) >>> 0
  }
  return sum >>> 0
}

/** 按标签升序排序后的表记录（SFNT 表目录要求按标签升序）。 */
interface TableRecord {
  readonly tag: string
  readonly data: Uint8Array
}

// ────────────────────────────────────────────────────────────────────────────
// 单个 SFNT 表构建
// ────────────────────────────────────────────────────────────────────────────

/** 构建 .notdef 空字形（0 轮廓，仅 10 字节头；调用方负责 4 字节对齐填充）。 */
function buildGlyphEmpty(): Uint8Array {
  const w = new BufferWriter()
  w.i16(0) // numberOfContours = 0（空字形，无轮廓）
  w.i16(0) // xMin
  w.i16(0) // yMin
  w.i16(0) // xMax
  w.i16(0) // yMax
  return w.toUint8Array()
}

/**
 * 构建单个占位矩形字形（1 轮廓 × 4 点，填充矩形）。
 *
 * 字形为 (margin, margin) 到 (em-margin, em-margin) 的填充矩形——troika SDF 渲染呈可见方块，证明字体加载 /
 * 覆盖 / 渲染管线端到端可用（占位字形，非可读汉字；正式发布前由人工替换为可读 CJK 字体子集）。
 */
function buildGlyphBox(): Uint8Array {
  const w = new BufferWriter()
  w.i16(1) // numberOfContours = 1
  w.i16(GLYPH_MARGIN) // xMin
  w.i16(GLYPH_MARGIN) // yMin
  w.i16(UNITS_PER_EM - GLYPH_MARGIN) // xMax
  w.i16(UNITS_PER_EM - GLYPH_MARGIN) // yMax
  w.u16(3) // endPtsOfContours[0] = 3（4 个点，最后索引 3）
  w.u16(0) // instructionLength = 0
  // 4 个点的 flags：全 on-curve、x/y 均为 2 字节（bit1=0, bit2=0），故 flag = 0x01。
  w.u8(0x01)
  w.u8(0x01)
  w.u8(0x01)
  w.u8(0x01)
  // x 坐标增量（绝对点 (100,100) (900,100) (900,900) (100,900) 的相邻增量）。
  w.i16(GLYPH_MARGIN) // P0 dx = 100
  w.i16(GLYPH_BOX_SIZE) // P1 dx = 800
  w.i16(0) // P2 dx = 0
  w.i16(-GLYPH_BOX_SIZE) // P3 dx = -800
  // y 坐标增量。
  w.i16(GLYPH_MARGIN) // P0 dy = 100
  w.i16(0) // P1 dy = 0
  w.i16(GLYPH_BOX_SIZE) // P2 dy = 800
  w.i16(0) // P3 dy = 0
  return w.toUint8Array()
}

/**
 * 构建 glyf + loca 表。
 *
 * 字形顺序：glyph 0 = .notdef（空），glyph i (i≥1) = 第 i 个排序字符（占位矩形）。
 * loca 用长格式（indexToLocFormat=1）：numGlyphs+1 个 uint32 字节偏移。
 */
function buildGlyfAndLoca(
  numChars: number,
): { glyf: Uint8Array; loca: Uint8Array; maxPoints: number; maxContours: number } {
  const glyphs: Uint8Array[] = []
  // glyph 0 = .notdef（空）。
  const notdef = buildGlyphEmpty()
  glyphs.push(notdef)
  // glyph 1..numChars = 占位矩形。
  const box = buildGlyphBox()
  for (let i = 0; i < numChars; i++) {
    glyphs.push(box)
  }

  // glyf：顺序拼接各字形，每个 4 字节对齐填充。
  const glyfWriter = new BufferWriter()
  const offsets: number[] = []
  for (const glyph of glyphs) {
    offsets.push(glyfWriter.length)
    glyfWriter.bytes_(Array.from(glyph))
    glyfWriter.padTo4()
  }
  offsets.push(glyfWriter.length) // 末尾偏移（loca 多一项）
  const glyf = glyfWriter.toUint8Array()

  // loca：长格式，numGlyphs+1 个 uint32 字节偏移。
  const locaWriter = new BufferWriter()
  for (const off of offsets) {
    locaWriter.u32(off)
  }
  return { glyf, loca: locaWriter.toUint8Array(), maxPoints: 4, maxContours: 1 }
}

/** 构建 head 表（54 字节）。checksumAdjustment 占位，由 assembleFont 在最后回填。 */
function buildHead(): Uint8Array {
  const w = new BufferWriter()
  w.u32(0x00010000) // version 1.0
  w.u32(0x00010000) // fontRevision 1.0
  w.u32(0x00000000) // checksumAdjustment（占位，assembleFont 回填）
  w.u32(0x5f0f3cf5) // magicNumber
  w.u16(0x000b) // flags（baseline at 0, lsb at 0, instructions may depend on point size）
  w.u16(UNITS_PER_EM) // unitsPerEm
  // created / modified（LONGDATETIME，8 字节各，置 0）。
  w.u32(0)
  w.u32(0)
  w.u32(0)
  w.u32(0)
  w.i16(0) // xMin（字体整体包围盒）
  w.i16(0) // yMin
  w.i16(UNITS_PER_EM) // xMax
  w.i16(UNITS_PER_EM) // yMax
  w.u16(0) // macStyle
  w.u16(8) // lowestRecPPEM
  w.i16(2) // fontDirectionHint
  w.i16(1) // indexToLocFormat = 1（长格式 loca）
  w.i16(0) // glyphDataFormat
  return w.toUint8Array()
}

/** 构建 hhea 表（36 字节）。 */
function buildHhea(numGlyphs: number): Uint8Array {
  const w = new BufferWriter()
  w.u32(0x00010000) // version 1.0
  w.i16(800) // ascent
  w.i16(-200) // descent
  w.i16(0) // lineGap
  w.u16(UNITS_PER_EM) // advanceWidthMax
  w.i16(0) // minLeftSideBearing
  w.i16(0) // minRightSideBearing
  w.i16(UNITS_PER_EM) // xMaxExtent
  w.i16(1) // caretSlopeRise
  w.i16(0) // caretSlopeRun
  w.i16(0) // caretOffset
  w.i16(0) // reserved
  w.i16(0) // reserved
  w.i16(0) // reserved
  w.i16(0) // reserved
  w.i16(0) // metricDataFormat
  w.u16(numGlyphs) // numberOfHMetrics
  return w.toUint8Array()
}

/** 构建 hmtx 表（numGlyphs × 4 字节：每个字形 advanceWidth + lsb）。 */
function buildHmtx(numGlyphs: number): Uint8Array {
  const w = new BufferWriter()
  for (let i = 0; i < numGlyphs; i++) {
    w.u16(UNITS_PER_EM) // advanceWidth（等宽，每字 1em）
    w.i16(0) // lsb
  }
  return w.toUint8Array()
}

/** 构建 maxp 表（32 字节，TrueType 版本 1.0）。 */
function buildMaxp(numGlyphs: number, maxPoints: number, maxContours: number): Uint8Array {
  const w = new BufferWriter()
  w.u32(0x00010000) // version 1.0（TrueType）
  w.u16(numGlyphs) // numGlyphs
  w.u16(maxPoints) // maxPoints
  w.u16(maxContours) // maxContours
  w.u16(0) // maxCompositePoints
  w.u16(0) // maxCompositeContours
  w.u16(2) // maxZones
  w.u16(0) // maxTwilightPoints
  w.u16(0) // maxStorage
  w.u16(0) // maxFunctionDefs
  w.u16(0) // maxInstructionDefs
  w.u16(0) // maxStackElements
  w.u16(0) // maxSizeOfInstructions
  w.u16(0) // maxComponentElements
  w.u16(0) // maxComponentDepth
  return w.toUint8Array()
}

/** 构建 post 表（32 字节，版本 3.0 = 无字形名称）。 */
function buildPost(): Uint8Array {
  const w = new BufferWriter()
  w.u32(0x00030000) // version 3.0（无字形名称）
  w.u32(0) // italicAngle
  w.i16(-100) // underlinePosition
  w.i16(50) // underlineThickness
  w.u32(0) // isFixedPitch
  w.u32(0) // minMemType42
  w.u32(0) // maxMemType42
  w.u32(0) // minMemType1
  w.u32(0) // maxMemType1
  return w.toUint8Array()
}

/** 构建 name 表（平台 3 / 编码 1 / 语言 0x0409，UTF-16BE）。 */
function buildName(records: ReadonlyArray<readonly [number, string]>): Uint8Array {
  // records: [nameID, string]。
  const storage = new BufferWriter()
  const entries: Array<{ nameId: number; offset: number; length: number }> = []
  for (const [nameId, str] of records) {
    const offset = storage.length
    storage.utf16be(str)
    entries.push({ nameId, offset, length: str.length * 2 })
  }
  const w = new BufferWriter()
  w.u16(0) // format
  w.u16(entries.length) // count
  const stringStorageOffset = 6 + entries.length * 12
  w.u16(stringStorageOffset) // stringOffset
  for (const e of entries) {
    w.u16(3) // platformID（Microsoft）
    w.u16(1) // encodingID（Unicode BMP）
    w.u16(0x0409) // languageID（English US）
    w.u16(e.nameId) // nameID
    w.u16(e.length) // length（字节）
    w.u16(e.offset) // offset（相对 stringStorage）
  }
  w.bytes_(Array.from(storage.toUint8Array()))
  return w.toUint8Array()
}

/**
 * 构建 cmap 表（单一 format 4 子表，平台 3 / 编码 1）。
 *
 * 每个字符码点 c → 字形索引 g = sortIndex + 1（.notdef 为 0）。为简化，每个字符自成一段
 * （startCode = endCode = c，idDelta = g - c，idRangeOffset = 0）。段按 endCode 升序，末尾追加 0xFFFF 段。
 */
function buildCmap(sortedCodepoints: readonly number[]): Uint8Array {
  // 每个字符一段 + 末尾 0xFFFF 段。
  const segments: Array<{ start: number; end: number; delta: number }> = []
  for (let i = 0; i < sortedCodepoints.length; i++) {
    const code = sortedCodepoints[i]
    const glyphIndex = i + 1 // .notdef 占 0
    // idDelta = (glyphIndex - code) mod 65536（有符号 16 位回绕）。
    const delta = (glyphIndex - code) & 0xffff
    segments.push({ start: code, end: code, delta })
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 })

  const segCount = segments.length
  const entrySelector = Math.floor(Math.log2(segCount))
  const searchRange = Math.pow(2, entrySelector) * 2
  const rangeShift = segCount * 2 - searchRange

  // format 4 子表。
  const subtable = new BufferWriter()
  const subtableStart = subtable.length
  subtable.u16(4) // format
  // length 占位（回填）。
  const lengthPlaceholderOffset = subtable.length
  subtable.u16(0) // length（占位）
  subtable.u16(0) // language
  subtable.u16(segCount * 2) // segCountX2
  subtable.u16(searchRange) // searchRange
  subtable.u16(entrySelector) // entrySelector
  subtable.u16(rangeShift) // rangeShift
  // endCode
  for (const seg of segments) subtable.u16(seg.end)
  subtable.u16(0) // reservedPad
  // startCode
  for (const seg of segments) subtable.u16(seg.start)
  // idDelta
  for (const seg of segments) subtable.u16(seg.delta)
  // idRangeOffset（全 0）
  for (let i = 0; i < segCount; i++) subtable.u16(0)
  // 回填 length。
  const subtableLength = subtable.length - subtableStart
  const subtableBytes = subtable.toUint8Array()
  subtableBytes[lengthPlaceholderOffset] = (subtableLength >>> 8) & 0xff
  subtableBytes[lengthPlaceholderOffset + 1] = subtableLength & 0xff

  // cmap 表头（4 字节）+ 编码记录（8 字节）+ 子表。
  const w = new BufferWriter()
  w.u16(0) // version
  w.u16(1) // numTables
  w.u16(3) // platformID（Microsoft）
  w.u16(1) // encodingID（Unicode BMP）
  w.u32(12) // offset 到子表（4 + 8 = 12）
  w.bytes_(Array.from(subtableBytes))
  return w.toUint8Array()
}

/** 构建 OS/2 表（版本 4，96 字节）。 */
function buildOs2(firstCharIndex: number, lastCharIndex: number): Uint8Array {
  const w = new BufferWriter()
  w.u16(4) // version
  w.i16(UNITS_PER_EM) // xAvgCharWidth
  w.u16(400) // usWeightClass（regular）
  w.u16(5) // usWidthClass（medium）
  w.u16(0) // fsType（installable）
  w.i16(0) // ySubscriptXSize
  w.i16(0) // ySubscriptYSize
  w.i16(0) // ySubscriptXOffset
  w.i16(0) // ySubscriptYOffset
  w.i16(0) // ySuperscriptXSize
  w.i16(0) // ySuperscriptYSize
  w.i16(0) // ySuperscriptXOffset
  w.i16(0) // ySuperscriptYOffset
  w.i16(0) // yStrikeoutSize
  w.i16(0) // yStrikeoutPosition
  w.i16(0) // sFamilyClass
  // panose（10 字节，置 0）。
  for (let i = 0; i < 10; i++) w.u8(0)
  w.u32(1) // ulUnicodeRange1（bit 0 = Basic Latin；占位，标记 CJK 由 ulUnicodeRange2 的 CJK Unified）
  w.u32(0) // ulUnicodeRange2
  w.u32(0) // ulUnicodeRange3
  w.u32(0) // ulUnicodeRange4
  w.tag('NONE') // achVendID
  w.u16(0x0040) // fsSelection（regular）
  w.u16(firstCharIndex) // usFirstCharIndex
  w.u16(lastCharIndex) // usLastCharIndex
  w.i16(800) // sTypoAscender
  w.i16(-200) // sTypoDescender
  w.i16(0) // sTypoLineGap
  w.u16(UNITS_PER_EM) // usWinAscent
  w.u16(200) // usWinDescent
  w.u32(0) // ulCodePageRange1
  w.u32(0) // ulCodePageRange2
  w.i16(500) // sxHeight
  w.i16(700) // sCapHeight
  w.u16(0) // usDefaultChar
  w.u16(0x0020) // usBreakChar（space）
  w.u16(0) // usMaxContext
  return w.toUint8Array()
}

// ────────────────────────────────────────────────────────────────────────────
// SFNT 装配（表目录 + 表数据 + checksumAdjustment 回填）
// ────────────────────────────────────────────────────────────────────────────

/** 计算表目录的 searchRange / entrySelector / rangeShift（numTables 的 2 的幂）。 */
function directoryParams(numTables: number): { searchRange: number; entrySelector: number; rangeShift: number } {
  const entrySelector = Math.floor(Math.log2(numTables))
  const searchRange = Math.pow(2, entrySelector) * 16
  const rangeShift = numTables * 16 - searchRange
  return { searchRange, entrySelector, rangeShift }
}

/**
 * 把全部表记录装配为完整 SFNT 字体二进制（含表目录 + checksumAdjustment 回填）。
 *
 * 表目录按标签升序排列（SFNT 要求）。head.checksumAdjustment 回填为 (0xB1B0AFBA - 全文件校验和)，
 * 使整字体校验和为 0xB1B0AFBA（SFNT 完整性约定）。
 */
function assembleFont(tables: readonly TableRecord[]): Uint8Array {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
  const numTables = sorted.length
  const { searchRange, entrySelector, rangeShift } = directoryParams(numTables)
  const headerSize = 12 + numTables * 16

  // 先计算各表数据偏移（紧跟表目录，每个表 4 字节对齐）。
  let offset = headerSize
  const tableMeta: Array<{ tag: string; checksum: number; offset: number; length: number; data: Uint8Array; padded: Uint8Array }> = []
  for (const t of sorted) {
    // 表数据 4 字节对齐填充。
    const padded = new Uint8Array(t.data.length + ((4 - (t.data.length % 4)) % 4))
    padded.set(t.data)
    tableMeta.push({
      tag: t.tag,
      checksum: tableChecksum(t.data),
      offset,
      length: t.data.length,
      data: t.data,
      padded,
    })
    offset += padded.length
  }

  const totalSize = offset
  const font = new Uint8Array(totalSize)
  const view = new DataView(font.buffer)

  // SFNT 头。
  view.setUint32(0, 0x00010000, false) // sfnt version（TrueType）
  view.setUint16(4, numTables, false)
  view.setUint16(6, searchRange, false)
  view.setUint16(8, entrySelector, false)
  view.setUint16(10, rangeShift, false)

  // 表目录记录。
  let dirOffset = 12
  for (const m of tableMeta) {
    for (let i = 0; i < 4; i++) font[dirOffset + i] = m.tag.charCodeAt(i) & 0xff
    view.setUint32(dirOffset + 4, m.checksum, false)
    view.setUint32(dirOffset + 8, m.offset, false)
    view.setUint32(dirOffset + 12, m.length, false)
    dirOffset += 16
  }

  // 表数据。
  for (const m of tableMeta) {
    font.set(m.padded, m.offset)
  }

  // 回填 head.checksumAdjustment：全文件校验和（head 表该项视为 0）应为 0xB1B0AFBA。
  const wholeChecksum = tableChecksum(font)
  const adjustment = (0xb1b0afba - wholeChecksum) >>> 0
  // head 表的 checksumAdjustment 位于 head 表偏移 8（version(4) + fontRevision(4) 之后）。
  const headMeta = tableMeta.find((m) => m.tag === 'head')
  if (headMeta !== undefined) {
    view.setUint32(headMeta.offset + 8, adjustment, false)
  }

  return font
}

// ────────────────────────────────────────────────────────────────────────────
// 主入口
// ────────────────────────────────────────────────────────────────────────────

/** CLI 选项。 */
interface FontBuildCliOptions {
  outDir: string
  placesPath: string
  politicalPath: string
}

function parseArgs(argv: string[]): FontBuildCliOptions {
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key?.startsWith('--') && value && !value.startsWith('--')) {
      opts[key.slice(2)] = value
      i++
    }
  }
  return {
    outDir: opts.out ?? 'public/fonts',
    placesPath: opts.places ?? 'public/geo/china-places.json',
    politicalPath: opts.political ?? 'public/geo/china-political-boundary.json',
  }
}

/** 加载并契约校验地点目录 + 政治边界契约。 */
function loadContracts(
  placesPath: string,
  politicalPath: string,
): { places: PlaceDirectoryContract; political: PoliticalBoundaryContract } {
  const projectRoot = resolve(process.cwd())
  const placesPayload: unknown = JSON.parse(readFileSync(resolve(projectRoot, placesPath), 'utf-8'))
  const placesOutcome = validatePlaceDirectory(placesPayload)
  if (!placesOutcome.ok) {
    throw new Error(
      '地点目录未通过契约校验，拒绝生产字体子集：\n' +
        placesOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  const politicalPayload: unknown = JSON.parse(
    readFileSync(resolve(projectRoot, politicalPath), 'utf-8'),
  )
  const politicalOutcome = validatePoliticalBoundary(politicalPayload)
  if (!politicalOutcome.ok) {
    throw new Error(
      '政治边界契约未通过校验，拒绝生产字体子集：\n' +
        politicalOutcome.errors.map((e) => `  [${e.code}] ${e.path}: ${e.message}`).join('\n'),
    )
  }
  return {
    places: placesPayload as PlaceDirectoryContract,
    political: politicalPayload as PoliticalBoundaryContract,
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  process.stderr.write(
    '标签字体子集确定性生产：从地点目录 + 政治边界契约提取字符集合 → 生成离线 TrueType 子集（无网络取数）\n',
  )

  const { places, political } = loadContracts(options.placesPath, options.politicalPath)

  // 字符集合：从契约确定性提取（省名 + 省会名 + 岛礁名）→ 排序去重。
  const domainStrings = collectAllLabelDomainStrings(places, political)
  const { placeNames, islandNames } = partitionDomainStrings(places, political)
  const characters = extractCharactersFromStrings(domainStrings)
  const sortedCodepoints = characters.map((ch) => ch.codePointAt(0)!)
  sortedCodepoints.sort((a, b) => a - b)
  // characters 已排序（extractCharactersFromStrings 内部排序），双保险再排一次。

  process.stderr.write(`  来源字符串：${domainStrings.length} 条（省名/省会名 ${placeNames.length} + 岛礁名 ${islandNames.length}）\n`)
  process.stderr.write(`  字符集合：${characters.length} 个唯一 CJK 字符\n`)

  if (characters.length === 0) {
    throw new Error('字符集合为空——地点目录 / 政治边界契约未提供任何标签字符串。')
  }

  // 字形总数：.notdef(1) + 字符数。
  const numGlyphs = characters.length + 1

  // 构建各 SFNT 表。
  const { glyf, loca, maxPoints, maxContours } = buildGlyfAndLoca(characters.length)
  const tables: TableRecord[] = [
    { tag: 'OS/2', data: buildOs2(sortedCodepoints[0], sortedCodepoints[sortedCodepoints.length - 1]) },
    { tag: 'cmap', data: buildCmap(sortedCodepoints) },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: buildHhea(numGlyphs) },
    { tag: 'hmtx', data: buildHmtx(numGlyphs) },
    { tag: 'loca', data: loca },
    { tag: 'maxp', data: buildMaxp(numGlyphs, maxPoints, maxContours) },
    {
      tag: 'name',
      data: buildName([
        [0, '内部展示用字体子集（占位），非官方审图数据，仅供内部展示。'],
        [1, 'China Labels Subset'],
        [2, 'Regular'],
        [4, 'China Labels Subset'],
        [5, 'Version 1.0'],
        [6, 'ChinaLabelsSubset'],
      ]),
    },
    { tag: 'post', data: buildPost() },
  ]

  const fontBytes = assembleFont(tables)
  const fontSha256 = createHash('sha256').update(fontBytes).digest('hex')

  // 写字体二进制。
  const absoluteOut = resolve(process.cwd(), options.outDir)
  mkdirSync(absoluteOut, { recursive: true })
  const fontFileName = 'china-labels-font.subset.ttf'
  const fontPath = resolve(absoluteOut, fontFileName)
  writeFileSync(fontPath, fontBytes)

  // 写清单（字段顺序固定，使同一契约重产得到逐字节一致输出）。
  const manifest = {
    kind: 'label-font-manifest',
    version: '1.0.0',
    fontFile: fontFileName,
    characters,
    sourceStrings: {
      placeNames,
      islandNames,
    },
    integrity: {
      fontSha256,
      characterCount: characters.length,
      fontByteLength: fontBytes.length,
    },
    disclaimer:
      '本字体子集为项目确定性生成的离线占位字体（字形为占位矩形，非可读汉字），仅供内部展示，' +
      '不得作为正式出版 / 发布用途；正式发布前须以可读 CJK 字体子集替换并取得自然资源主管部门审图号。',
  }
  const manifestPath = resolve(absoluteOut, 'china-labels-font.manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

  process.stdout.write('标签字体子集生产完成：\n')
  process.stdout.write(`  字体：${fontPath}（${fontBytes.length} 字节，${numGlyphs} 字形）\n`)
  process.stdout.write(`  清单：${manifestPath}（${characters.length} 字符）\n`)
  process.stdout.write(`  字体 SHA-256：${fontSha256}\n`)
}

/** 把领域字符串分区为 placeNames（省名/省会名）与 islandNames（岛礁名），供清单 sourceStrings 审计。 */
function partitionDomainStrings(
  places: PlaceDirectoryContract,
  political: PoliticalBoundaryContract,
): { placeNames: string[]; islandNames: string[] } {
  const placeNames: string[] = []
  for (const entry of places.entries) {
    placeNames.push(entry.name)
  }
  const islandNames: string[] = []
  for (const feature of political.features) {
    if (feature.type === 'islandOrReefPoint') {
      islandNames.push(feature.name)
    }
  }
  return { placeNames, islandNames }
}

// 仅在作为直接脚本入口时运行；被 import 时保持静默（便于复用内部函数做测试）。
const entryHref = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entryHref !== '' && entryHref === import.meta.url) {
  try {
    main()
  } catch (cause: unknown) {
    const err = cause as Error
    console.error(`标签字体子集生产失败：${err?.message ?? cause}`)
    process.exit(1)
  }
}
