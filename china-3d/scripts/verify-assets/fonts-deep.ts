/**
 * 标签字体子集资产级深度校验（SPEC §3.7）。
 *
 * 依赖方向：属于离线资产生产 / 校验层（scripts/verify-assets，tsx 运行），单向依赖
 * src/geo-contracts 契约层（清单 / 地点目录 / 政治边界校验器）与 src/lib/label-font
 * （必需字符串收集与覆盖校验的唯一入口）、src/lib/static-copy（页面静态文案唯一事实源）。
 * 不依赖浏览器 / React / Three.js。被 CLI（scripts/verify-assets/run.ts 的 fonts scope）
 * 与测试基线（tests/assets/font-asset.test.ts）共同复用，避免校验逻辑双轨：
 * CLI 读盘后调用本函数，测试以篡改副本调用同一函数。
 *
 * 与契约校验的关系：契约校验（validateLabelFontManifest）只验清单字段结构；本模块在其之上
 * 追加「资产级」不变量——
 *   清单字符集合 ⊇ 生产契约（省名 + 省会名 + 岛礁名）与页面静态文案（附图标题 + 合规角标 +
 *   页面标题区）的全部必需字符（缺失字符检测：缺任一必需汉字即确定性失败）；
 *   清单 sourceStrings 与生产契约 / 静态文案逐条一致，characters 与来源字符串提取结果精确一致
 *   （无遗漏 / 无冗余）；
 *   字体二进制为合法 SFNT（TrueType 魔数、必备表齐全、整字体校验和 = 0xB1B0AFBA、
 *   numGlyphs = 字符数 + 1），且 cmap format 4 把每个清单字符映射到互不相同的非零字形——
 *   即「清单声称的字符」与「字体实际可渲染的字符」一致，而非仅清单自说自话；
 *   字体体积受控（KB 级，远小于完整 CJK 字体的数 MB 级，SPEC §13「中文字体体积」风险行）；
 *   清单 integrity 与字体字节逐项一致（SHA-256 / 字节数）；审计 sidecar 完整性摘要与输入契约
 *   哈希逐项一致（产物被替换或输入契约漂移都被检出）。
 */

import { createHash } from 'node:crypto'
import {
  validateLabelFontManifest,
  validatePlaceDirectory,
  validatePoliticalBoundary,
  type LabelFontManifestContract,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../../src/geo-contracts/index'
import {
  collectRequiredLabelFontStrings,
  extractCharactersFromStrings,
  partitionLabelDomainStrings,
  validateLabelFontCoverage,
} from '../../src/lib/label-font'
import { collectStaticCopyStrings } from '../../src/lib/static-copy'

/**
 * 字体二进制体积硬上限（字节）。
 * 完整 CJK 字体（如思源黑体单字重）为数 MB 级；百馀字子集必须在 KB 级（SPEC §3.7 / §13）。
 * 512KB 上限给「未来替换为可读 CJK 字形子集」（百馀字真实字形约数十 KB）留足余量，
 * 同时保证「远小于完整 CJK 字体」这条不变量可机器断言。
 */
export const LABEL_FONT_MAX_BYTES = 512 * 1024

/**
 * 清单字符数硬上限。SPEC §3.7 估算「约百余字」；512 上限为后续 UI 文案（海拔图例等）
 * 扩展留足余量，同时拦截「误把完整 CJK 字符集（2 万+）塞进清单」的事故。
 */
export const LABEL_FONT_MAX_CHARACTERS = 512

/** TrueType SFNT 版本魔数（0x00010000）。 */
const SFNT_VERSION_TRUETYPE = 0x00010000
/** SFNT 整字体校验和约定值（head.checksumAdjustment 回填后全文件校验和必须等于它）。 */
const SFNT_WHOLE_CHECKSUM_MAGIC = 0xb1b0afba
/** 字体二进制必须携带的 SFNT 表集合。 */
const REQUIRED_SFNT_TABLES = ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post'] as const

/** 资产级校验错误码前缀（与 places-asset / political-asset 同构）。 */
const ASSET_ERROR_CODES = {
  sourceStringsMismatch: 'fonts-asset.source-strings-mismatch',
  charactersMismatch: 'fonts-asset.characters-mismatch',
  tooManyCharacters: 'fonts-asset.too-many-characters',
  fontTooLarge: 'fonts-asset.font-too-large',
  fontByteLengthMismatch: 'fonts-asset.font-byte-length-mismatch',
  fontSha256Mismatch: 'fonts-asset.font-sha256-mismatch',
  sfntInvalid: 'fonts-asset.sfnt-invalid',
  sfntTableMissing: 'fonts-asset.sfnt-table-missing',
  sfntChecksumMismatch: 'fonts-asset.sfnt-checksum-mismatch',
  sfntNumGlyphsMismatch: 'fonts-asset.sfnt-num-glyphs-mismatch',
  sfntCmapMissing: 'fonts-asset.sfnt-cmap-missing',
  sfntCmapMissingGlyph: 'fonts-asset.sfnt-cmap-missing-glyph',
  provenanceIntegrityMismatch: 'fonts-asset.provenance-integrity-mismatch',
} as const

/** 单条资产级错误。结构与契约层 ContractValidationError 对齐，便于 CLI 统一打印。 */
export interface FontsAssetError {
  readonly code: string
  readonly path: string
  readonly message: string
}

/** 抽样摘要（字符数 / 字节数 / 来源构成 / cmap 校验状态），供 CLI 与测试观察，非错误项。 */
export interface FontsAssetSamples {
  readonly characterCount: number
  readonly fontByteLength: number
  readonly placeNameCount: number
  readonly islandNameCount: number
  readonly staticCopyCount: number
  /** SFNT 表目录中实际解析到的字形数（maxp.numGlyphs；未提供字体字节时为 0）。 */
  readonly numGlyphs: number
  /** cmap 字形映射校验是否实际执行（未提供字体字节时为 false，避免「未检却假装通过」）。 */
  readonly cmapChecked: boolean
}

/** 资产级校验结果。 */
export interface FontsAssetOutcome {
  readonly ok: boolean
  readonly errors: readonly FontsAssetError[]
  readonly samples: FontsAssetSamples
}

/** 深度校验入参：清单 + 字体字节 + 生产契约 + 审计 sidecar + 原始文本（哈希核对）。 */
export interface FontsAssetVerificationInput {
  readonly manifest: unknown
  /** 字体二进制原始字节（与落盘字节同源）；缺省时跳过全部字体二进制级校验并在 samples 标记。 */
  readonly fontBytes?: Uint8Array
  /** 清单 JSON 原始文本（与落盘字节同源），用于复算 manifestSha256 防篡改锚点；核对 provenance 时需要。 */
  readonly manifestText?: string
  /** 生产地点目录契约（载荷未知，先校验再提取省名 / 省会名）。 */
  readonly places: unknown
  /** 生产政治边界契约（载荷未知，先校验再提取岛礁名）。 */
  readonly political: unknown
  readonly provenance?: unknown
  /** china-places.json 原始文本（复算 provenance 输入哈希锚点）。 */
  readonly placesText?: string
  /** china-political-boundary.json 原始文本（复算 provenance 输入哈希锚点）。 */
  readonly politicalText?: string
}

// ────────────────────────────────────────────────────────────────────────────
// SFNT 解析（表目录 / maxp / cmap format 4 / 整字体校验和）
// ────────────────────────────────────────────────────────────────────────────

/** SFNT 表目录记录。 */
interface SfntTableRecord {
  readonly tag: string
  readonly offset: number
  readonly length: number
}

/** 解析结果：表目录 + numGlyphs。 */
interface SfntParse {
  readonly tables: readonly SfntTableRecord[]
  readonly numGlyphs: number
}

/** 计算整字体校验和（uint32 大端累加，不足 4 字节补 0；与生产脚本的 tableChecksum 同语义）。 */
function wholeFontChecksum(bytes: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < bytes.length; i += 4) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1] ?? 0
    const b2 = bytes[i + 2] ?? 0
    const b3 = bytes[i + 3] ?? 0
    sum = (sum + ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)) >>> 0
  }
  return sum >>> 0
}

/**
 * 解析 SFNT 表目录与 maxp.numGlyphs（严格边界检查）。
 * 任一结构越界 / 版本非法 / maxp 缺失 → 抛错（调用方转为资产级错误）。
 */
function parseSfnt(bytes: Uint8Array): SfntParse {
  if (bytes.length < 12) {
    throw new Error(`字体二进制过短（${bytes.length} 字节），不足以容纳 SFNT 头。`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sfntVersion = view.getUint32(0, false)
  if (sfntVersion !== SFNT_VERSION_TRUETYPE) {
    throw new Error(`SFNT 版本魔数非法：0x${sfntVersion.toString(16)}，期望 0x00010000（TrueType）。`)
  }
  const numTables = view.getUint16(4, false)
  const directoryEnd = 12 + numTables * 16
  if (bytes.length < directoryEnd) {
    throw new Error(`字体二进制过短，不足以容纳 ${numTables} 条表目录记录。`)
  }
  const tables: SfntTableRecord[] = []
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16
    const tag = String.fromCharCode(bytes[base], bytes[base + 1], bytes[base + 2], bytes[base + 3])
    const offset = view.getUint32(base + 8, false)
    const length = view.getUint32(base + 12, false)
    if (offset + length > bytes.length) {
      throw new Error(`SFNT 表 ${tag} 越界：offset=${offset} length=${length} 超出文件长度 ${bytes.length}。`)
    }
    tables.push({ tag, offset, length })
  }
  const maxp = tables.find((t) => t.tag === 'maxp')
  if (maxp === undefined || maxp.length < 6) {
    throw new Error('SFNT 缺少 maxp 表或 maxp 表过短，无法读取 numGlyphs。')
  }
  const numGlyphs = view.getUint16(maxp.offset + 4, false)
  return { tables, numGlyphs }
}

/**
 * 解析 cmap 表（平台 3 / 编码 1 的 format 4 子表），返回「码点 → 字形索引」映射。
 *
 * format 4 查找语义（OpenType 规范）：
 * - idRangeOffset[i] = 0：glyph = (codepoint + idDelta[i]) mod 65536。
 * - idRangeOffset[i] ≠ 0：glyph 取自 glyphIdArray（相对 idRangeOffset[i] 字自身的偏移），
 *   非零时再 (glyph + idDelta[i]) mod 65536。
 * 末尾 0xFFFF 哨兵段映射到字形 0（.notdef），不纳入映射。
 */
function parseCmapFormat4(bytes: Uint8Array, cmap: SfntTableRecord): Map<number, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (cmap.length < 4) {
    throw new Error('cmap 表过短，缺少表头。')
  }
  const numSubtables = view.getUint16(cmap.offset + 2, false)
  // 优先平台 3 / 编码 1（Unicode BMP）；缺省时退而取平台 0。
  let subtableOffset = -1
  let fallbackOffset = -1
  for (let i = 0; i < numSubtables; i++) {
    const recordBase = cmap.offset + 4 + i * 8
    if (recordBase + 8 > cmap.offset + cmap.length) {
      throw new Error('cmap 编码记录越界。')
    }
    const platformId = view.getUint16(recordBase, false)
    const encodingId = view.getUint16(recordBase + 2, false)
    const offset = view.getUint32(recordBase + 4, false)
    if (platformId === 3 && encodingId === 1) {
      subtableOffset = cmap.offset + offset
      break
    }
    if (platformId === 0 && fallbackOffset === -1) {
      fallbackOffset = cmap.offset + offset
    }
  }
  if (subtableOffset === -1) {
    subtableOffset = fallbackOffset
  }
  if (subtableOffset === -1) {
    throw new Error('cmap 表缺少平台 3/编码 1（或平台 0）子表。')
  }
  if (subtableOffset + 14 > cmap.offset + cmap.length) {
    throw new Error('cmap 子表越界。')
  }
  const format = view.getUint16(subtableOffset, false)
  if (format !== 4) {
    throw new Error(`cmap 子表 format=${format}，期望 format 4（BMP 字符映射）。`)
  }
  const subtableLength = view.getUint16(subtableOffset + 2, false)
  if (subtableOffset + subtableLength > cmap.offset + cmap.length) {
    throw new Error('cmap format 4 子表长度越界。')
  }
  const segCount = view.getUint16(subtableOffset + 6, false) / 2
  const endCodeBase = subtableOffset + 14
  const startCodeBase = endCodeBase + segCount * 2 + 2 // +2 = reservedPad
  const idDeltaBase = startCodeBase + segCount * 2
  const idRangeOffsetBase = idDeltaBase + segCount * 2
  if (idRangeOffsetBase + segCount * 2 > subtableOffset + subtableLength) {
    throw new Error('cmap format 4 段数组越界。')
  }

  const mapping = new Map<number, number>()
  for (let i = 0; i < segCount; i++) {
    const endCode = view.getUint16(endCodeBase + i * 2, false)
    const startCode = view.getUint16(startCodeBase + i * 2, false)
    const idDelta = view.getInt16(idDeltaBase + i * 2, false)
    const idRangeOffset = view.getUint16(idRangeOffsetBase + i * 2, false)
    if (startCode === 0xffff && endCode === 0xffff) {
      continue // 末尾哨兵段（映射到 .notdef），不纳入。
    }
    for (let code = startCode; code <= endCode; code++) {
      let glyphId: number
      if (idRangeOffset === 0) {
        glyphId = (code + idDelta) & 0xffff
      } else {
        const glyphAddress = idRangeOffsetBase + i * 2 + idRangeOffset + (code - startCode) * 2
        if (glyphAddress + 2 > subtableOffset + subtableLength) {
          throw new Error('cmap format 4 glyphIdArray 越界。')
        }
        glyphId = view.getUint16(glyphAddress, false)
        if (glyphId !== 0) {
          glyphId = (glyphId + idDelta) & 0xffff
        }
      }
      mapping.set(code, glyphId)
    }
  }
  return mapping
}

// ────────────────────────────────────────────────────────────────────────────
// 资产级深度校验主入口
// ────────────────────────────────────────────────────────────────────────────

/** 标签字体子集资产级深度校验主入口：返回通过 / 失败 + 抽样摘要。 */
export function verifyLabelFontAsset(input: FontsAssetVerificationInput): FontsAssetOutcome {
  const errors: FontsAssetError[] = []

  // 1) 三份输入契约的结构校验（保留原始错误码，使测试可精确断言）。
  const manifestOutcome = validateLabelFontManifest(input.manifest)
  if (!manifestOutcome.ok) {
    for (const e of manifestOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }
  const placesOutcome = validatePlaceDirectory(input.places)
  if (!placesOutcome.ok) {
    for (const e of placesOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }
  const politicalOutcome = validatePoliticalBoundary(input.political)
  if (!politicalOutcome.ok) {
    for (const e of politicalOutcome.errors) {
      errors.push({ code: e.code, path: e.path, message: e.message })
    }
  }

  const samples: { -readonly [K in keyof FontsAssetSamples]: FontsAssetSamples[K] } = {
    characterCount: 0,
    fontByteLength: 0,
    placeNameCount: 0,
    islandNameCount: 0,
    staticCopyCount: 0,
    numGlyphs: 0,
    cmapChecked: false,
  }

  // 结构非法时不继续资产级判定（样本字段保持 0 占位）。
  if (!manifestOutcome.ok || !placesOutcome.ok || !politicalOutcome.ok) {
    return { ok: false, errors, samples }
  }

  const manifest = input.manifest as LabelFontManifestContract
  const places = input.places as PlaceDirectoryContract
  const political = input.political as PoliticalBoundaryContract
  const { placeNames, islandNames } = partitionLabelDomainStrings(places, political)
  const staticCopy = collectStaticCopyStrings()
  samples.characterCount = manifest.characters.length
  samples.fontByteLength = manifest.integrity.fontByteLength
  samples.placeNameCount = placeNames.length
  samples.islandNameCount = islandNames.length
  samples.staticCopyCount = staticCopy.length

  // 2) 覆盖校验（SPEC §3.7 核心不变量）：清单字符集合 ⊇ 必需字符串字符集合
  //    （34 省名 + 省会名 + 岛礁名 / 附图标注 + 静态文案 / 合规角标免责声明）。
  const coverage = validateLabelFontCoverage(manifest, collectRequiredLabelFontStrings(places, political))
  if (!coverage.ok) {
    errors.push({ code: coverage.code, path: '$.characters', message: coverage.message })
  }

  // 3) 清单 sourceStrings 与生产契约 / 静态文案逐条一致（来源审计不失真）。
  const sourceExpectations: Array<[string, readonly string[], readonly string[]]> = [
    ['placeNames', manifest.sourceStrings.placeNames, placeNames],
    ['islandNames', manifest.sourceStrings.islandNames, islandNames],
    ['staticCopy', manifest.sourceStrings.staticCopy, staticCopy],
  ]
  for (const [field, actual, expected] of sourceExpectations) {
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      errors.push({
        code: ASSET_ERROR_CODES.sourceStringsMismatch,
        path: `$.sourceStrings.${field}`,
        message: `清单 sourceStrings.${field} 与生产契约 / 静态文案不一致（实际 ${actual.length} 条，期望 ${expected.length} 条）——清单来源审计失真。`,
      })
    }
  }

  // 4) characters 与来源字符串提取结果精确一致（无遗漏 / 无冗余）。
  const expectedCharacters = extractCharactersFromStrings([...placeNames, ...islandNames, ...staticCopy])
  if (
    manifest.characters.length !== expectedCharacters.length ||
    manifest.characters.some((ch, index) => ch !== expectedCharacters[index])
  ) {
    errors.push({
      code: ASSET_ERROR_CODES.charactersMismatch,
      path: '$.characters',
      message: `清单 characters（${manifest.characters.length} 字符）与来源字符串提取结果（${expectedCharacters.length} 字符）不一致——存在遗漏或冗余字符。`,
    })
  }

  // 5) 体积受控：字符数与字节数上限（KB 级，远小于完整 CJK 字体的数 MB 级）。
  if (manifest.characters.length > LABEL_FONT_MAX_CHARACTERS) {
    errors.push({
      code: ASSET_ERROR_CODES.tooManyCharacters,
      path: '$.characters',
      message: `清单字符数 ${manifest.characters.length} 超出上限 ${LABEL_FONT_MAX_CHARACTERS}（SPEC §3.7「约百余字」）——疑似误嵌完整 CJK 字符集。`,
    })
  }
  if (manifest.integrity.fontByteLength > LABEL_FONT_MAX_BYTES) {
    errors.push({
      code: ASSET_ERROR_CODES.fontTooLarge,
      path: '$.integrity.fontByteLength',
      message: `字体体积 ${manifest.integrity.fontByteLength} 字节超出上限 ${LABEL_FONT_MAX_BYTES}（完整 CJK 字体为数 MB 级，子集必须为 KB 级）。`,
    })
  }

  // 6) 字体二进制级校验（提供字节时执行）：SFNT 合法性 + cmap 覆盖 + 完整性锚点。
  if (input.fontBytes !== undefined) {
    const fontBytes = input.fontBytes
    if (fontBytes.length !== manifest.integrity.fontByteLength) {
      errors.push({
        code: ASSET_ERROR_CODES.fontByteLengthMismatch,
        path: '$.integrity.fontByteLength',
        message: `清单声明字体字节数 ${manifest.integrity.fontByteLength} 与实际 ${fontBytes.length} 不一致。`,
      })
    }
    const recomputedSha256 = createHash('sha256').update(fontBytes).digest('hex')
    if (recomputedSha256 !== manifest.integrity.fontSha256) {
      errors.push({
        code: ASSET_ERROR_CODES.fontSha256Mismatch,
        path: '$.integrity.fontSha256',
        message: `清单 fontSha256=${manifest.integrity.fontSha256} 与复算 ${recomputedSha256} 不一致（字体二进制可能被替换或篡改）。`,
      })
    }

    let sfnt: SfntParse | undefined = undefined
    try {
      sfnt = parseSfnt(fontBytes)
    } catch (cause) {
      errors.push({
        code: ASSET_ERROR_CODES.sfntInvalid,
        path: manifest.fontFile,
        message: `字体二进制 SFNT 结构非法：${(cause as Error).message}`,
      })
    }
    if (sfnt !== undefined) {
      samples.numGlyphs = sfnt.numGlyphs
      // 必备表齐全。
      const presentTags = new Set(sfnt.tables.map((t) => t.tag))
      const missingTables = REQUIRED_SFNT_TABLES.filter((tag) => !presentTags.has(tag))
      if (missingTables.length > 0) {
        errors.push({
          code: ASSET_ERROR_CODES.sfntTableMissing,
          path: manifest.fontFile,
          message: `字体缺少必备 SFNT 表：${missingTables.join('、')}。`,
        })
      }
      // 整字体校验和（head.checksumAdjustment 回填正确性的端到端证明）。
      const checksum = wholeFontChecksum(fontBytes)
      if (checksum !== SFNT_WHOLE_CHECKSUM_MAGIC) {
        errors.push({
          code: ASSET_ERROR_CODES.sfntChecksumMismatch,
          path: manifest.fontFile,
          message: `整字体校验和 0x${checksum.toString(16)} ≠ 0x${SFNT_WHOLE_CHECKSUM_MAGIC.toString(16)}（checksumAdjustment 回填错误或字节被改）。`,
        })
      }
      // numGlyphs = 字符数 + 1（.notdef）。
      if (sfnt.numGlyphs !== manifest.characters.length + 1) {
        errors.push({
          code: ASSET_ERROR_CODES.sfntNumGlyphsMismatch,
          path: manifest.fontFile,
          message: `maxp.numGlyphs=${sfnt.numGlyphs}，期望 字符数+1=${manifest.characters.length + 1}。`,
        })
      }
      // cmap：每个清单字符都映射到互不相同的非零字形（清单声称 = 字体实际可渲染）。
      const cmapTable = sfnt.tables.find((t) => t.tag === 'cmap')
      if (cmapTable === undefined) {
        errors.push({
          code: ASSET_ERROR_CODES.sfntCmapMissing,
          path: manifest.fontFile,
          message: '字体缺少 cmap 表，无法建立字符 → 字形映射。',
        })
      } else {
        try {
          const mapping = parseCmapFormat4(fontBytes, cmapTable)
          samples.cmapChecked = true
          const missingGlyphs: string[] = []
          const usedGlyphIds = new Set<number>()
          for (const ch of manifest.characters) {
            const codepoint = ch.codePointAt(0)!
            const glyphId = mapping.get(codepoint)
            if (glyphId === undefined || glyphId === 0) {
              missingGlyphs.push(ch)
            } else {
              usedGlyphIds.add(glyphId)
            }
          }
          if (missingGlyphs.length > 0) {
            errors.push({
              code: ASSET_ERROR_CODES.sfntCmapMissingGlyph,
              path: manifest.fontFile,
              message: `cmap 缺少 ${missingGlyphs.length} 个清单字符的字形映射：[${missingGlyphs.join('、')}]——清单声称的字符字体实际无法渲染。`,
            })
          }
          if (usedGlyphIds.size !== manifest.characters.length - missingGlyphs.length) {
            errors.push({
              code: ASSET_ERROR_CODES.sfntCmapMissingGlyph,
              path: manifest.fontFile,
              message: 'cmap 把不同字符映射到同一字形（字形索引冲突），字符 ↔ 字形必须一一对应。',
            })
          }
        } catch (cause) {
          errors.push({
            code: ASSET_ERROR_CODES.sfntCmapMissing,
            path: manifest.fontFile,
            message: `cmap 解析失败：${(cause as Error).message}`,
          })
        }
      }
    }
  }

  // 7) 审计 sidecar 完整性比对（防篡改锚点 + 输入契约漂移检出）。
  if (input.provenance !== undefined && input.provenance !== null) {
    const provenance = input.provenance as {
      integrity?: {
        fontSha256?: string
        manifestSha256?: string
        characterCount?: number
        fontByteLength?: number
      }
      source?: { inputs?: Array<{ path?: string; sha256?: string }> }
    }
    const integrity = provenance.integrity
    if (integrity !== undefined) {
      if (typeof integrity.fontSha256 === 'string' && integrity.fontSha256 !== manifest.integrity.fontSha256) {
        errors.push({
          code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
          path: '$.provenance.integrity.fontSha256',
          message: `审计 fontSha256=${integrity.fontSha256} 与清单 ${manifest.integrity.fontSha256} 不一致。`,
        })
      }
      if (typeof integrity.manifestSha256 === 'string') {
        if (input.manifestText === undefined) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: '$.provenance.integrity.manifestSha256',
            message: '审计声明了 manifestSha256 但校验入参未提供 manifestText，无法复算 SHA-256 防篡改锚点。',
          })
        } else {
          const recomputed = createHash('sha256').update(input.manifestText, 'utf-8').digest('hex')
          if (recomputed !== integrity.manifestSha256) {
            errors.push({
              code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
              path: '$.provenance.integrity.manifestSha256',
              message: `审计 manifestSha256=${integrity.manifestSha256} 与复算 ${recomputed} 不一致（字体清单可能被替换或篡改）。`,
            })
          }
        }
      }
      const countChecks: Array<[string, number | undefined, number]> = [
        ['characterCount', integrity.characterCount, manifest.characters.length],
        ['fontByteLength', integrity.fontByteLength, manifest.integrity.fontByteLength],
      ]
      for (const [field, declared, actual] of countChecks) {
        if (typeof declared === 'number' && declared !== actual) {
          errors.push({
            code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
            path: `$.provenance.integrity.${field}`,
            message: `审计 ${field}=${declared} 与复算 ${actual} 不一致。`,
          })
        }
      }
    }
    // 输入契约哈希锚点：china-places / china-political-boundary 漂移（改后未重产字体）即检出。
    const inputHashChecks: Array<[string, string | undefined]> = [
      ['public/geo/china-places.json', input.placesText],
      ['public/geo/china-political-boundary.json', input.politicalText],
    ]
    for (const inputDeclaration of provenance.source?.inputs ?? []) {
      if (typeof inputDeclaration.path !== 'string' || typeof inputDeclaration.sha256 !== 'string') {
        continue
      }
      const check = inputHashChecks.find(([path]) => path === inputDeclaration.path)
      if (check === undefined) {
        continue
      }
      const [path, text] = check
      if (text === undefined) {
        errors.push({
          code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
          path: `$.provenance.source.inputs[${path}]`,
          message: `审计声明了输入 ${path} 的哈希但校验入参未提供其原始文本，无法复算。`,
        })
        continue
      }
      const recomputed = createHash('sha256').update(text, 'utf-8').digest('hex')
      if (recomputed !== inputDeclaration.sha256) {
        errors.push({
          code: ASSET_ERROR_CODES.provenanceIntegrityMismatch,
          path: `$.provenance.source.inputs[${path}]`,
          message: `审计记录的输入 ${path} 哈希与当前文件不一致——输入契约已漂移，字体子集需重新生产。`,
        })
      }
    }
  }

  return { ok: errors.length === 0, errors, samples }
}
