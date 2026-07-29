/**
 * 标签字体清单契约（CJK 字体子集的字符清单 + 完整性锚点）。
 *
 * 依赖方向：契约层，依赖 codes.ts、errors.ts。字体清单是 public/fonts 下的静态资产契约
 * （kind=label-font-manifest），与地点目录 / 政治边界等地理契约同层；离线字体生产脚本
 * （scripts/fonts/build-font-subset.ts）产出它，资产校验（scripts/verify-assets/fonts-deep.ts）
 * 与测试基线消费它。本契约只冻结清单的「结构不变量」，不做字符覆盖判定——覆盖判定需要
 * 地点 / 政治契约与页面静态文案作为输入，属于领域层（src/lib/label-font.ts）与资产级
 * 深度校验的职责。
 *
 * 冻结的不变量：
 * - fontFile 必须与清单同目录（禁止路径分隔符），扩展名为 .ttf / .woff——字体二进制是
 *   public/fonts 下的本地静态资产，运行时零外部网络依赖（SPEC §3.7「troika 加载该子集
 *   .ttf/.woff；不打包完整思源黑体」）。
 * - characters 为非空数组，每项为单个 Unicode 码点字符，按码点升序且无重复——排序去重是
 *   确定性重产（同一输入逐字节一致）与防篡改比对的前提。
 * - sourceStrings 记录字符集合的三类来源（省名/省会名、岛礁名、页面静态文案），供审计与
 *   「characters 与来源字符串提取结果精确一致」校验复用。
 * - integrity.fontSha256 为 64 位小写十六进制（字体二进制 SHA-256 防篡改锚点），
 *   characterCount 必须与 characters.length 一致，fontByteLength 为正整数（字体字节数）。
 * - disclaimer 非空：字体子集为非官方审图流程产物，必须随资产携带免责声明（SPEC §8）。
 */

import { isRecognizedDataVersion } from './codes'
import { type ContractValidationOutcome, error, invalid, valid } from './errors'

/** 字体清单记录的字符来源字符串分区（与离线生产脚本的来源对应）。 */
export interface LabelFontManifestSourceStrings {
  /** 省名 + 省会名（来自地点目录 entries[].name，按契约出现顺序）。 */
  readonly placeNames: readonly string[]
  /** 岛礁 / 附属岛屿规范名称（来自政治边界 islandOrReefPoint.name，按契约出现顺序）。 */
  readonly islandNames: readonly string[]
  /** 页面静态文案（来自 src/lib/static-copy.ts 的 collectStaticCopyStrings，顺序固定）。 */
  readonly staticCopy: readonly string[]
}

/** 字体清单的完整性摘要（防篡改锚点 + 统计量）。 */
export interface LabelFontManifestIntegrity {
  /** 字体二进制的 SHA-256（64 位小写十六进制），与落盘字体字节同源。 */
  readonly fontSha256: string
  /** 字体包含的字符数（必须等于 characters.length）。 */
  readonly characterCount: number
  /** 字体二进制字节数（正整数，体积受控审计用）。 */
  readonly fontByteLength: number
}

/** 标签字体清单契约主体（与 public/fonts/china-labels-font.manifest.json 同构）。 */
export interface LabelFontManifestContract {
  readonly kind: 'label-font-manifest'
  readonly version: string
  /** 字体文件名（与清单同目录，如 china-labels-font.subset.ttf）。 */
  readonly fontFile: string
  /** 字体实际包含的字符集合（按码点升序、无重复的单字符数组，覆盖校验的权威集合）。 */
  readonly characters: readonly string[]
  /** 生成该字符集合的来源字符串（省名/省会名 + 岛礁名 + 页面静态文案），便于审计与重产。 */
  readonly sourceStrings: LabelFontManifestSourceStrings
  /** 完整性摘要（SHA-256 + 统计量）。 */
  readonly integrity: LabelFontManifestIntegrity
  /** 非空免责声明（字体子集为非官方审图流程产物，仅供内部展示）。 */
  readonly disclaimer: string
}

/** 字体文件扩展名白名单（SPEC §3.7「.ttf/.woff」）。 */
const RECOGNIZED_FONT_FILE_EXTENSIONS = ['.ttf', '.woff', '.woff2'] as const

/** SHA-256 十六进制摘要的字面量格式（64 位小写十六进制）。 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** 校验字符串数组字段：必须为数组且每项为非空字符串。 */
function collectStringArrayErrors(
  value: unknown,
  path: string,
  codePrefix: string,
): ReturnType<typeof error>[] {
  const errors: ReturnType<typeof error>[] = []
  if (!Array.isArray(value)) {
    errors.push(error(`${codePrefix}-not-array`, path, `${path} 必须为字符串数组。`))
    return errors
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      errors.push(
        error(`${codePrefix}-empty`, `${path}[${index}]`, `${path}[${index}] 必须为非空字符串。`),
      )
    }
  })
  return errors
}

/** 标签字体清单校验器（只验结构不变量；字符覆盖判定见 src/lib/label-font.ts）。 */
export function validateLabelFontManifest(payload: unknown): ContractValidationOutcome {
  if (payload === null || typeof payload !== 'object') {
    return invalid([error('label-font-manifest.not-object', '$', '标签字体清单必须为对象。')])
  }
  const record = payload as Partial<LabelFontManifestContract>
  const errors: ReturnType<typeof error>[] = []

  if (record.kind !== 'label-font-manifest') {
    errors.push(
      error('label-font-manifest.wrong-kind', '$.kind', '标签字体清单的 kind 必须为 "label-font-manifest"。'),
    )
  }
  if (!isRecognizedDataVersion(record.version)) {
    errors.push(
      error(
        'label-font-manifest.unknown-version',
        '$.version',
        `version 必须为已登记的静态资产版本，实际为 ${String(record.version)}。`,
      ),
    )
  }

  // fontFile：非空、与清单同目录（无路径分隔符）、扩展名白名单。
  if (!isNonEmptyString(record.fontFile)) {
    errors.push(error('label-font-manifest.font-file-empty', '$.fontFile', 'fontFile 必须为非空字符串。'))
  } else if (record.fontFile.includes('/') || record.fontFile.includes('\\')) {
    errors.push(
      error(
        'label-font-manifest.font-file-not-sibling',
        '$.fontFile',
        'fontFile 不得包含路径分隔符——字体二进制必须与清单同目录（public/fonts 本地静态资产）。',
      ),
    )
  } else if (!RECOGNIZED_FONT_FILE_EXTENSIONS.some((ext) => record.fontFile!.endsWith(ext))) {
    errors.push(
      error(
        'label-font-manifest.font-file-extension',
        '$.fontFile',
        `fontFile 扩展名必须为 ${RECOGNIZED_FONT_FILE_EXTENSIONS.join(' / ')} 之一（SPEC §3.7）。`,
      ),
    )
  }

  // characters：非空、每项单码点字符、无重复、按码点升序。
  if (!Array.isArray(record.characters)) {
    errors.push(error('label-font-manifest.characters-not-array', '$.characters', 'characters 必须为数组。'))
  } else {
    if (record.characters.length === 0) {
      errors.push(error('label-font-manifest.characters-empty', '$.characters', 'characters 不得为空。'))
    }
    const seen = new Set<string>()
    let previousCodepoint = -1
    record.characters.forEach((ch, index) => {
      const base = `$.characters[${index}]`
      if (typeof ch !== 'string' || Array.from(ch).length !== 1) {
        errors.push(
          error(
            'label-font-manifest.character-not-single',
            base,
            `characters[${index}] 必须为单个 Unicode 码点字符，实际为 ${JSON.stringify(ch)}。`,
          ),
        )
        return
      }
      if (seen.has(ch)) {
        errors.push(error('label-font-manifest.character-duplicate', base, `字符重复：${ch}。`))
      }
      seen.add(ch)
      const codepoint = ch.codePointAt(0)!
      if (codepoint <= previousCodepoint) {
        errors.push(
          error(
            'label-font-manifest.characters-unsorted',
            base,
            `characters 必须按码点严格升序，characters[${index}]（U+${codepoint.toString(16).toUpperCase()}）打破了顺序。`,
          ),
        )
      }
      previousCodepoint = codepoint
    })
  }

  // sourceStrings：三类来源均为字符串数组。
  if (record.sourceStrings === null || typeof record.sourceStrings !== 'object') {
    errors.push(
      error('label-font-manifest.source-strings-not-object', '$.sourceStrings', 'sourceStrings 必须为对象。'),
    )
  } else {
    const sourceStrings = record.sourceStrings as Partial<LabelFontManifestSourceStrings>
    errors.push(
      ...collectStringArrayErrors(sourceStrings.placeNames, '$.sourceStrings.placeNames', 'label-font-manifest.place-names'),
    )
    errors.push(
      ...collectStringArrayErrors(sourceStrings.islandNames, '$.sourceStrings.islandNames', 'label-font-manifest.island-names'),
    )
    errors.push(
      ...collectStringArrayErrors(sourceStrings.staticCopy, '$.sourceStrings.staticCopy', 'label-font-manifest.static-copy'),
    )
  }

  // integrity：SHA-256 格式、计数与字节数不变量。
  if (record.integrity === null || typeof record.integrity !== 'object') {
    errors.push(error('label-font-manifest.integrity-not-object', '$.integrity', 'integrity 必须为对象。'))
  } else {
    const integrity = record.integrity as Partial<LabelFontManifestIntegrity>
    if (typeof integrity.fontSha256 !== 'string' || !SHA256_HEX_PATTERN.test(integrity.fontSha256)) {
      errors.push(
        error(
          'label-font-manifest.integrity-sha-invalid',
          '$.integrity.fontSha256',
          'integrity.fontSha256 必须为 64 位小写十六进制 SHA-256 摘要。',
        ),
      )
    }
    if (typeof integrity.characterCount !== 'number' || !Number.isInteger(integrity.characterCount) || integrity.characterCount <= 0) {
      errors.push(
        error(
          'label-font-manifest.integrity-count-invalid',
          '$.integrity.characterCount',
          'integrity.characterCount 必须为正整数。',
        ),
      )
    } else if (Array.isArray(record.characters) && integrity.characterCount !== record.characters.length) {
      errors.push(
        error(
          'label-font-manifest.integrity-count-mismatch',
          '$.integrity.characterCount',
          `integrity.characterCount=${integrity.characterCount} 与 characters.length=${record.characters.length} 不一致。`,
        ),
      )
    }
    if (typeof integrity.fontByteLength !== 'number' || !Number.isInteger(integrity.fontByteLength) || integrity.fontByteLength <= 0) {
      errors.push(
        error(
          'label-font-manifest.integrity-bytes-invalid',
          '$.integrity.fontByteLength',
          'integrity.fontByteLength 必须为正整数（字体二进制字节数）。',
        ),
      )
    }
  }

  if (!isNonEmptyString(record.disclaimer)) {
    errors.push(
      error('label-font-manifest.disclaimer-empty', '$.disclaimer', 'disclaimer 必须为非空字符串（SPEC §8）。'),
    )
  }

  return errors.length === 0 ? valid() : invalid(errors)
}
