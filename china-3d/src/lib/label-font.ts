/**
 * 标签字体子集的领域逻辑与运行时加载：必需字符串收集、字符集合提取、覆盖校验与清单取数
 * （SPEC §3.7）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时领域层（src/lib），单向依赖契约层 src/geo-contracts（地点目录 / 政治边界
 *   类型与清单结构校验器）与同层 src/lib/static-copy（页面静态文案唯一事实源）。不依赖
 *   React / Three.js / troika / DOM——字符集合运算是纯函数，可在 Node 直接断言；清单加载用
 *   fetch（Web 标准 API），与 loadPlaceDirectory / loadProvinceGeometry 同层同构。
 * - 三方消费同一组入口，不存在第二份中文名 / 文案副本：
 *     1. 离线字体生产脚本（scripts/fonts/build-font-subset.ts）——从生产契约确定性收集
 *        必需字符串并裁剪字体子集；
 *     2. 资产校验（scripts/verify-assets/fonts-deep.ts 的 fonts scope）——重算必需字符串
 *        并断言清单覆盖；
 *     3. 测试基线（tests/label-font.test.ts、tests/assets/font-asset.test.ts）——缺失字符
 *        检测（删除任一必需汉字 → 确定性失败）。
 *   标签渲染层（src/three/PlaceLabels，TASK-010）只在覆盖校验通过后才把本地字体 URL 喂给
 *   troika Text：App 装配层经本模块的 loadLabelFontManifest 取清单、经
 *   validateLabelFontCoverage 做缺字把关（requiredStrings 由 src/lib/place-labels 的
 *   collectRenderedPlaceLabelStrings 从同一地点契约提取），缺字即显式失败，绝不静默显示
 *   空白 / fallback 网络字体。任何消费者不得自行维护字符串清单。
 *
 * 覆盖范围（SPEC §3.7「仅含 34 省名 + 省会名 + 附图所需汉字（约百余字）」+ §3.8 附图标注 +
 * §8 合规角标）：
 * - 省名 + 省会名：来自地点目录契约 entries[].name（provinceNameAnchor / administrativeCapital
 *   两角色全部纳入——省会名即便最终以 tooltip / 小字呈现，字体也必须覆盖）。
 * - 附图标注：政治边界契约 islandOrReefPoint.name（钓鱼岛 / 赤尾屿 / 曾母暗沙 / 黄岩岛 /
 *   永兴岛）+ 附图标题「南海诸岛」（静态文案）。
 * - 合规角标：免责声明（SPEC §8 原文）+ 审图号占位 + 署名引导词（静态文案；来源名称由
 *   运行时来源注册表派生，不进入字体子集覆盖集合）。
 * - 页面标题区（静态文案）。
 */

import {
  validateLabelFontManifest,
  type LabelFontManifestContract,
  type PlaceDirectoryContract,
  type PoliticalBoundaryContract,
} from '../geo-contracts'
import { collectStaticCopyStrings } from './static-copy'

/** 字体覆盖校验失败的稳定错误码，供自动化测试精确断言「缺字时明确失败」。 */
export type LabelFontCoverageFailureCode =
  | 'label-font.manifest-contract-invalid'
  | 'label-font.coverage-incomplete'

/** 字体覆盖校验失败结果：携带稳定 code、缺失字符列表与简体中文说明。 */
export interface LabelFontCoverageFailure {
  readonly ok: false
  readonly code: LabelFontCoverageFailureCode
  readonly message: string
  /** 覆盖失败时，实际需要但字体缺失的字符（按码点升序去重），便于定位。 */
  readonly missingCharacters?: readonly string[]
}

/** 字体覆盖校验成功结果：携带经结构校验的清单。 */
export interface LabelFontCoverageSuccess {
  readonly ok: true
  readonly manifest: LabelFontManifestContract
}

/** 字体覆盖校验的统一结果类型：成功带 manifest，失败带 code / message / 缺失字符。 */
export type LabelFontCoverageOutcome = LabelFontCoverageSuccess | LabelFontCoverageFailure

/**
 * 把任意字符串集合展开为「按码点升序去重的字符集合」。
 *
 * 用 Array.from 按 Unicode 码点（而非 UTF-16 码元）切分，正确处理 BMP 外字符（当前 CJK
 * 标签均在 BMP 内）。纯函数，供覆盖校验与离线字体生产脚本共用「从字符串提取字符集合」的
 * 同一逻辑（无第二份实现）；排序去重使同一来源字符串集合多次提取得到逐字符一致的结果，
 * 是字体清单确定性重产（逐字节一致）的前提。
 */
export function extractCharactersFromStrings(strings: readonly string[]): string[] {
  const set = new Set<string>()
  for (const s of strings) {
    for (const ch of Array.from(s)) {
      set.add(ch)
    }
  }
  return Array.from(set).sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
}

/**
 * 从地点目录 + 政治边界契约确定性提取「字体子集必须覆盖的全部领域字符串」。
 *
 * 包括：全部省名（provinceNameAnchor 的 name）+ 全部省会名（administrativeCapital 的 name）+
 * 全部岛礁规范名称（islandOrReefPoint 的 name）。顺序固定（地点目录条目序 + 政治要素序），
 * 使字体清单的 sourceStrings 可逐字节重产。本函数是「从契约提取领域字符串」的唯一入口，
 * 不存在第二份中文名副本。
 */
export function collectAllLabelDomainStrings(
  placeContract: PlaceDirectoryContract,
  politicalContract: PoliticalBoundaryContract,
): readonly string[] {
  const names: string[] = []
  for (const entry of placeContract.entries) {
    names.push(entry.name)
  }
  for (const feature of politicalContract.features) {
    if (feature.type === 'islandOrReefPoint') {
      names.push(feature.name)
    }
  }
  return names
}

/**
 * 把领域字符串分区为 placeNames（省名/省会名，按地点目录条目序）与 islandNames（岛礁名，
 * 按政治要素序），供字体清单 sourceStrings 审计与「清单来源字符串与生产契约一致」校验复用。
 */
export function partitionLabelDomainStrings(
  placeContract: PlaceDirectoryContract,
  politicalContract: PoliticalBoundaryContract,
): { placeNames: string[]; islandNames: string[] } {
  const placeNames: string[] = []
  for (const entry of placeContract.entries) {
    placeNames.push(entry.name)
  }
  const islandNames: string[] = []
  for (const feature of politicalContract.features) {
    if (feature.type === 'islandOrReefPoint') {
      islandNames.push(feature.name)
    }
  }
  return { placeNames, islandNames }
}

/**
 * 收集「字体子集必须覆盖的全部必需字符串」：领域字符串（省名 + 省会名 + 岛礁名）+
 * 页面静态文案（附图标题 + 合规角标 + 页面标题区，src/lib/static-copy.ts）。
 *
 * 这是覆盖范围的权威定义——离线生产脚本按它裁剪字符集合，覆盖校验按它断言清单无缺字。
 */
export function collectRequiredLabelFontStrings(
  placeContract: PlaceDirectoryContract,
  politicalContract: PoliticalBoundaryContract,
): readonly string[] {
  return [...collectAllLabelDomainStrings(placeContract, politicalContract), ...collectStaticCopyStrings()]
}

/**
 * 校验字体清单结构（经契约层 validateLabelFontManifest）并断言其字符集合 ⊇ 必需字符串的
 * 字符集合（覆盖校验，纯函数）。
 *
 * 两阶段：
 * 1. 结构校验：复用契约层 validateLabelFontManifest（kind / characters 排序去重 / sourceStrings /
 *    integrity / disclaimer）。任一不符 → manifest-contract-invalid（消息内联全部契约错误）。
 * 2. 覆盖校验：从 requiredStrings 提取字符集合，断言其 ⊆ manifest.characters。缺任一必需字符 →
 *    coverage-incomplete，携带按码点升序的缺失字符列表，便于调用方 / 测试定位「哪个必需汉字
 *    被删了」（缺失字符检测：删除任一必需汉字必须确定性失败）。
 *
 * @param manifestInput 字体清单载荷（未知类型，先结构校验再收窄）。
 * @param requiredStrings 实际渲染将使用的字符串集合（见 collectRequiredLabelFontStrings）。
 */
export function validateLabelFontCoverage(
  manifestInput: unknown,
  requiredStrings: readonly string[],
): LabelFontCoverageOutcome {
  const structureOutcome = validateLabelFontManifest(manifestInput)
  if (!structureOutcome.ok) {
    return {
      ok: false,
      code: 'label-font.manifest-contract-invalid',
      message:
        '字体清单未通过结构契约校验：' +
        structureOutcome.errors.map((e) => `[${e.code}] ${e.path}: ${e.message}`).join('；'),
    }
  }
  const manifest = manifestInput as LabelFontManifestContract
  const fontCharSet = new Set<string>(manifest.characters)
  const requiredChars = extractCharactersFromStrings(requiredStrings)
  const missing = requiredChars.filter((ch) => !fontCharSet.has(ch))
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'label-font.coverage-incomplete',
      message: `字体子集缺少 ${missing.length} 个必需字符：[${missing.join('、')}]——拒绝使用缺字字体渲染标签（不得静默显示空白或回退在线字体）。`,
      missingCharacters: missing,
    }
  }
  return { ok: true, manifest }
}

/** 运行时加载期失败的稳定错误码（含 fetch / 结构校验 / 覆盖三类根因），供调用方确定性处理。 */
export type LabelFontLoadFailureCode =
  | 'label-font.manifest-fetch-failed'
  | 'label-font.manifest-contract-invalid'
  | 'label-font.coverage-incomplete'

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
 * 从浏览器 fetch 字体清单静态资产并经结构校验。
 *
 * URL 为必传参数——清单（与字体）的运行时路径唯一事实源是 src/config/place-labels 的
 * PLACE_LABELS_CONFIG.fontManifestPath / fontPath，由 App 装配层传入；本模块不持有第二份
 * 路径常量。取回 JSON 后用契约层 validateLabelFontManifest 做结构校验（kind / characters
 * 排序去重 / sourceStrings / integrity / disclaimer 非空）。
 *
 * 注意：本函数只做结构校验，不做覆盖校验——覆盖校验需要「实际渲染字符串」（由标签准备层
 * 从地点契约提取，见 collectRenderedPlaceLabelStrings），由装配层在取得字符串后单独调用
 * validateLabelFontCoverage。fetch 失败或结构非法抛 LabelFontLoadError。
 *
 * 该函数只在浏览器运行（用 fetch）；测试请直接构造清单字面量喂给 validateLabelFontCoverage，
 * 或以 stub 的 fetch 驱动本函数。
 */
export async function loadLabelFontManifest(url: string): Promise<LabelFontManifestContract> {
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
  const structureOutcome = validateLabelFontManifest(payload)
  if (!structureOutcome.ok) {
    throw new LabelFontLoadError(
      'label-font.manifest-contract-invalid',
      `字体清单未通过 label-font-manifest 契约校验：${structureOutcome.errors.map((e) => `${e.code}@${e.path}`).join('; ')}。`,
    )
  }
  return payload as LabelFontManifestContract
}
