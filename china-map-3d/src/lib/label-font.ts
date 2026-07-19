/**
 * 离线字体子集的清单契约、覆盖校验与运行时加载（数据访问层，TASK-016）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时访问层（src/lib），与 place-directory.ts / political-boundary.ts 同层。它定义「字体清单
 *   契约（字体实际包含哪些字符 + 来源字符串 + 完整性哈希）」、提供「清单 ⊇ 实际渲染字符串的覆盖校验」纯函数、
 *   并在运行时 fetch 字体清单做结构 + 完整性校验。标签渲染层（src/three/PlaceLabels）只在覆盖校验通过后
 *   才把本地字体 URL 喂给 troika Text——缺字即在此显式失败，绝不静默显示空白 / fallback 网络字体
 *   （TASK-016 输出约束「不因单个字符串缺字而静默显示空白或 fallback 网络字体」）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（无 —— 字体清单是独立的资源清单契约，不复用地理契约）、
 *   TypeScript 自身。不依赖 React / R3F / Three.js / troika / DOM（覆盖校验是纯字符串集合运算，可在 Node
 *   直接断言；运行时 fetch 是 Web 标准 API）。
 *
 * 字体子集离线加载（SPEC §3.7「裁剪字体子集仅含 34 省名 + 省会名 + 附图 / 岛礁所需汉字…troika 加载该子集
 * .ttf/.woff；不打包完整思源黑体」、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载，不得依赖
 * 系统字体偶然存在、在线字体或完整思源字体包」、验证方式 3「无在线字体请求」、验证方式 5「断网仍完整」）：
 * - 字体清单记录「字体实际包含的字符集合」（characters，排序去重的 CJK 字符数组）。覆盖校验断言该集合 ⊇
 *   实际渲染字符串（省名 + 省会名 + 岛礁名）的字符集合——缺任一必需汉字即抛 font-manifest.coverage-incomplete，
 *   阻断渲染（TASK-016 验证方式 2「删除任一必需汉字…时应明确失败」）。
 * - 字体二进制 + 清单都是 public/fonts 下的本地静态资产，运行时只从同源 /fonts/ 取（无 https:// CDN 请求，
 *   避免 troika 默认的在线 Roboto）。清单的 integrity.fontSha256 是字体二进制的 SHA-256 防篡改锚点，供
 *   资产校验（scripts/verify-assets）与运行时完整性核对复用。
 *
 * 职责边界（TASK-016 实现约束「标签和光点视图只能消费地点 / 政治领域数据…不得自行维护…中文名称副本」）：
 * - 本模块**不**维护任何省名 / 省会名 / 岛礁名字符串副本。「实际渲染字符串」由标签准备层
 *   （src/lib/place-labels 的 collectRenderedLabelStrings）从地点目录契约 + 政治边界契约确定性地提取，
 *   喂给本模块的覆盖校验。字体清单中的 sourceStrings 由离线字体生产脚本（scripts/fonts/build-font-subset）
 *   从同一资产确定性生成并落盘——运行时与生产期共用同一份领域字符串事实源，无第二份副本。
 */

/** 字体清单里记录的「字体实际包含字符集合 + 来源字符串」来源分类（与离线生产脚本的来源对应）。 */
export interface LabelFontManifestSourceStrings {
  /** 省名 + 省会名（来自地点目录 entries[].name，按出现顺序去重）。 */
  readonly placeNames: readonly string[]
  /** 岛礁 / 附属岛屿规范名称（来自政治边界 islandOrReefPoint.name，按出现顺序去重）。 */
  readonly islandNames: readonly string[]
}

/** 字体清单的完整性摘要（防篡改锚点 + 统计量）。 */
export interface LabelFontManifestIntegrity {
  /** 字体二进制的 SHA-256（十六进制），与落盘字体字节同源。 */
  readonly fontSha256: string
  /** 字体包含的字符数（= characters.length，便于审计）。 */
  readonly characterCount: number
  /** 字体二进制字节数（便于审计体积受控）。 */
  readonly fontByteLength: number
}

/** 字体清单契约主体（与 public/fonts/china-labels-font.manifest.json 同构）。 */
export interface LabelFontManifest {
  readonly kind: 'label-font-manifest'
  readonly version: string
  /** 字体文件名（相对清单所在目录，如 china-labels-font.subset.woff）。 */
  readonly fontFile: string
  /** 字体实际包含的字符集合（排序去重的 CJK 字符数组，覆盖校验的权威集合）。 */
  readonly characters: readonly string[]
  /** 生成该字符集合的来源字符串（省名 / 省会名 / 岛礁名），便于审计与重产。 */
  readonly sourceStrings: LabelFontManifestSourceStrings
  /** 完整性摘要（SHA-256 + 统计量）。 */
  readonly integrity: LabelFontManifestIntegrity
  /** 非空免责声明（字体子集为非官方审图流程产物，仅供内部展示）。 */
  readonly disclaimer: string
}

/** 字体覆盖校验失败的稳定错误码，供自动化测试精确断言「缺字时明确失败」。 */
export type LabelFontCoverageFailureCode =
  | 'label-font.manifest-not-object'
  | 'label-font.manifest-wrong-kind'
  | 'label-font.characters-not-array'
  | 'label-font.characters-empty'
  | 'label-font.character-not-string'
  | 'label-font.source-strings-missing'
  | 'label-font.integrity-missing'
  | 'label-font.disclaimer-empty'
  | 'label-font.coverage-incomplete'

/** 字体覆盖校验失败结果：携带稳定 code、缺失字符列表与简体中文说明。 */
export interface LabelFontCoverageFailure {
  readonly ok: false
  readonly code: LabelFontCoverageFailureCode
  readonly message: string
  /** 覆盖失败时，实际渲染需要但字体缺失的字符（排序去重），便于定位。 */
  readonly missingCharacters?: readonly string[]
}

/** 字体覆盖校验成功结果：携带经校验的清单。 */
export interface LabelFontCoverageSuccess {
  readonly ok: true
  readonly manifest: LabelFontManifest
}

/** 字体覆盖校验的统一结果类型：成功带 manifest，失败带 code / message / 缺失字符。 */
export type LabelFontCoverageOutcome = LabelFontCoverageSuccess | LabelFontCoverageFailure

function coverageFail(
  code: LabelFontCoverageFailureCode,
  message: string,
  missingCharacters?: readonly string[],
): LabelFontCoverageFailure {
  return { ok: false, code, message, ...(missingCharacters !== undefined ? { missingCharacters } : {}) }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 把任意字符串集合展开为「排序去重的字符集合」（码点数组）。
 *
 * 用 Array.from 按 Unicode 码点（而非 UTF-16 码元）切分，正确处理 BMP 外字符（虽当前 CJK 标签均在 BMP 内）。
 * 纯函数，供覆盖校验与离线字体生产脚本共用「从字符串提取字符集合」的同一逻辑（无第二份实现）。
 */
export function extractCharactersFromStrings(strings: readonly string[]): string[] {
  const set = new Set<string>()
  for (const s of strings) {
    for (const ch of Array.from(s)) {
      set.add(ch)
    }
  }
  // 按码点升序排序，使同一来源字符串集合多次提取得到逐字符一致的字符数组（便于清单重产逐字节稳定）。
  return Array.from(set).sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
}

/**
 * 校验字体清单结构并断言其字符集合 ⊇ 实际渲染字符串的字符集合（覆盖校验，纯函数）。
 *
 * 两阶段：
 * 1. 结构校验：manifest 为对象、kind=label-font-manifest、characters 为非空字符串数组（每项单个字符）、
 *    sourceStrings / integrity 存在、disclaimer 非空。任一不符 → 对应稳定 code。
 * 2. 覆盖校验：从 requiredStrings 提取字符集合，断言其 ⊆ manifest.characters。缺字 → coverage-incomplete，
 *    携带缺失字符列表（排序去重），便于调用方 / 测试定位「哪个必需汉字被删了」。
 *
 * @param manifestInput 字体清单载荷（未知类型，先结构校验再收窄）。
 * @param requiredStrings 实际渲染将使用的字符串集合（省名 / 省会名 / 岛礁名，由标签准备层从契约提取）。
 * @returns 成功带经校验的 manifest；失败带稳定 code + 缺失字符（如有）。
 */
export function validateLabelFontCoverage(
  manifestInput: unknown,
  requiredStrings: readonly string[],
): LabelFontCoverageOutcome {
  if (manifestInput === null || typeof manifestInput !== 'object') {
    return coverageFail('label-font.manifest-not-object', '字体清单必须为对象。')
  }
  const record = manifestInput as Partial<LabelFontManifest>
  if (record.kind !== 'label-font-manifest') {
    return coverageFail(
      'label-font.manifest-wrong-kind',
      '字体清单的 kind 必须为 "label-font-manifest"。',
    )
  }
  if (!Array.isArray(record.characters)) {
    return coverageFail('label-font.characters-not-array', '字体清单 characters 必须为数组。')
  }
  if (record.characters.length === 0) {
    return coverageFail('label-font.characters-empty', '字体清单 characters 不得为空。')
  }
  // 每项必须是单个字符（Array.from(s) 切出的码点字符串）；拒绝空串或多码点项。
  for (let i = 0; i < record.characters.length; i++) {
    const ch = record.characters[i] as unknown
    if (!isNonEmptyString(ch) || Array.from(ch).length !== 1) {
      return coverageFail(
        'label-font.character-not-string',
        `字体清单 characters[${i}] 必须为单个字符，实际为 ${JSON.stringify(ch)}。`,
      )
    }
  }
  if (record.sourceStrings === null || typeof record.sourceStrings !== 'object') {
    return coverageFail('label-font.source-strings-missing', '字体清单 sourceStrings 必须为对象。')
  }
  if (record.integrity === null || typeof record.integrity !== 'object') {
    return coverageFail('label-font.integrity-missing', '字体清单 integrity 必须为对象。')
  }
  if (!isNonEmptyString(record.disclaimer)) {
    return coverageFail('label-font.disclaimer-empty', '字体清单 disclaimer 必须为非空字符串。')
  }

  // 覆盖校验：实际渲染字符串的字符集合 ⊆ 字体清单 characters。
  const fontCharSet = new Set<string>(record.characters as readonly string[])
  const requiredChars = extractCharactersFromStrings(requiredStrings)
  const missing = requiredChars.filter((ch) => !fontCharSet.has(ch))
  if (missing.length > 0) {
    return coverageFail(
      'label-font.coverage-incomplete',
      `字体子集缺少 ${missing.length} 个必需汉字：[${missing.join('、')}]——拒绝渲染缺字标签（不得静默显示空白 / fallback 字体）。`,
      missing,
    )
  }
  return { ok: true, manifest: record as LabelFontManifest }
}

/** 运行时加载期失败的稳定错误码（含 fetch / 结构校验两类根因），供调用方确定性处理。 */
export type LabelFontLoadFailureCode =
  | 'label-font.manifest-fetch-failed'
  | 'label-font.manifest-contract-invalid'

/** 运行时加载期错误：携带稳定 code 与简体中文说明，绝不静默退化（缺字 / 载入失败都有明确状态）。 */
export class LabelFontLoadError extends Error {
  readonly code: LabelFontLoadFailureCode
  constructor(code: LabelFontLoadFailureCode, message: string) {
    super(message)
    this.name = 'LabelFontLoadError'
    this.code = code
  }
}

/**
 * 校验字体清单结构（不做覆盖校验——覆盖校验需要「实际渲染字符串」，由调用方在准备层提供）。
 *
 * 与 validateLabelFontCoverage 共用结构校验分支，但本函数不接收 requiredStrings、只返回经结构校验的清单，
 * 供运行时加载层在 fetch 后立即做结构把关（覆盖校验由场景层在取得「实际渲染字符串」后单独调用）。
 * 结构非法 → 抛 LabelFontLoadError（contract-invalid），绝不返回部分 / 伪造清单。
 */
export function assertLabelFontManifestStructure(manifestInput: unknown): LabelFontManifest {
  // 用空 requiredStrings 走覆盖校验的结构分支（空集不会触发 coverage-incomplete），复用同一结构校验逻辑。
  const outcome = validateLabelFontCoverage(manifestInput, [])
  if (!outcome.ok) {
    throw new LabelFontLoadError(
      'label-font.manifest-contract-invalid',
      `字体清单未通过结构校验：${outcome.message}`,
    )
  }
  return outcome.manifest
}

/**
 * 从浏览器 fetch 字体清单静态资产并经结构校验。
 *
 * 参数是清单的 URL（默认指向 public/fonts 下的生产清单 china-labels-font.manifest.json）。取回 JSON 后用
 * assertLabelFontManifestStructure 做结构校验（kind / characters 非空字符串数组 / sourceStrings / integrity /
 * disclaimer 非空）。fetch 失败或结构非法抛 LabelFontLoadError。
 *
 * 注意：本函数只做结构校验，不做覆盖校验——覆盖校验需要「实际渲染字符串」（由标签准备层从地点 / 政治契约
 * 提取），由场景层在取得字符串后单独调用 validateLabelFontCoverage。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造 LabelFontManifest 字面量喂给 validateLabelFontCoverage，
 * 不走本函数。
 */
export async function loadLabelFontManifest(
  url = '/fonts/china-labels-font.manifest.json',
): Promise<LabelFontManifest> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new LabelFontLoadError(
      'label-font.manifest-fetch-failed',
      `获取字体清单失败（${url}）：${(cause as Error).message}。`,
    )
  }
  if (!response.ok) {
    throw new LabelFontLoadError(
      'label-font.manifest-fetch-failed',
      `获取字体清单失败（${url}）：HTTP ${response.status}。`,
    )
  }
  const payload: unknown = await response.json()
  return assertLabelFontManifestStructure(payload)
}
