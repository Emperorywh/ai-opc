/*
 * 本地字体预加载边界（labels 层，SPEC 2.5 / 4.2 / 11.1 / 14.1 / 任务约束）。
 *
 * 信任边界定位（TASK-015）：
 *   - 本模块是“标签文本契约 → 本地字体就绪信号”的唯一编排入口，供 application 层消费。
 *   - 只消费标签文本（LabelDescriptor.text 或同等名称数组）与字形清单码点集合；
 *     不读取原始 JSON、不重建标签描述符、不维护第二套名称来源（任务约束）。
 *   - 不创建 Troika Text 对象、不实现空间索引 / 可见集 / billboard / R3F 标签图层（任务约束）。
 *   - 不直接 import troika-three-text（labels 层禁止 troika，SPEC 3.3）：
 *     Troika preloadFont 通过 LabelFontPreloadPort 依赖注入由调用方（后续 scene / app-root 装配层）提供。
 *
 * 两道字体门禁（SPEC 11.1 / 14.1）：
 *   1. 字形覆盖门禁：调用 checkLabelGlyphCoverage 校验全部标签文本码点都在字形清单内。
 *      缺字 → FONT_GLYPH_MISSING（含缺失码点与首次出现文本），先于预加载、先于 Troika 联网补字。
 *   2. 资产加载门禁：覆盖通过后调用 port.preloadFont 显式传入本地 .woff URL 与全部去重名称字符；
 *      只有成功回调发出就绪信号，任何失败统一映射为 FONT_ASSET_FAILED（含资产上下文）。
 *
 * 无 fallback 不变量（SPEC 11.1 / 任务约束）：
 *   - fontUrl 由调用方从 config（LABEL_FONT_URL）传入，固定为同源本地 .woff。
 *   - 失败时不切换系统字体、不回退远端 / Unicode CDN、不使用 WOFF2；只产出结构化错误。
 *   - 去重字符覆盖全部标签文本码点后，Troika 无需也无法触发 Unicode CDN 补字。
 *
 * 单次就绪信号不变量（任务“预期只发出一次字体就绪信号”）：
 *   - preloadLabelFont 返回的 Promise 恰好 resolve 一次；port 回调被防重入保护，
 *     即使 port 实现误触发多次回调，也只采纳首次结果（ready 或 error）。
 *
 * 依赖方向（SPEC 3.3）：domain（MapDataError / 错误码）+ labels（fontGlyphGate）；外部仅 Node 内置。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import { checkLabelGlyphCoverage, collectTextCodePoints } from './fontGlyphGate'
import type { MissingGlyphInfo } from './fontGlyphGate'

/*
 * 字体预加载逻辑路径前缀：预加载失败发生在标签文本与本地字体资产上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败集合，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const LABEL_FONT_LOGICAL_PATH = 'labelFont.preload'

/*
 * 字体预加载端口（依赖注入，对应 Troika preloadFont）。
 *
 * 设计意图（SPEC 3.3 + 任务约束）：
 *   - labels 层禁止 import troika；实际 Troika preloadFont 调用由调用方包装为本端口实现。
 *   - 端口契约比 Troika 原签名更严格：onDone 必须被调用恰好一次，
 *     err === null 表示成功，err !== null 表示资产加载 / 解析 / 预渲染失败。
 *   - 这层收紧使本模块能稳定区分“就绪”与“失败”，不依赖 Troika 在字体加载失败时
 *     仅 console.error 且永不回调的内部行为（那种行为由端口实现负责收敛为 onDone(err)）。
 *
 * 字段语义：
 *   - font：本地字体 URL（调用方固定传 LABEL_FONT_URL，禁止远端）。
 *   - characters：全部去重名称字符组成的字符串（按 Unicode code point 去重）。
 *   - sdfGlyphSize：SDF 字形尺寸（调用方固定传 LABEL_FONT_SDF_GLYPH_SIZE = 64）。
 *   - onDone：预加载完成回调，err === null 为成功，否则为失败（err 形态不限，本模块按未知错误描述）。
 */
export interface LabelFontPreloadPort {
  preloadFont(
    options: {
      readonly font: string
      readonly characters: string
      readonly sdfGlyphSize: number
    },
    onDone: (err: unknown | null) => void,
  ): void
}

/*
 * 字体预加载编排参数。
 *   - texts：标签文本数组（LabelDescriptor.text 或实体名称），每个元素为 string。
 *   - manifestCodePoints：字形清单覆盖的码点集合（从 public/fonts/glyphs.json 派生）。
 *   - port：依赖注入的预加载端口（见 LabelFontPreloadPort）。
 *   - fontUrl：本地字体 URL（调用方从 config LABEL_FONT_URL 传入；禁止远端）。
 *   - sdfGlyphSize：SDF 字形尺寸（调用方从 config LABEL_FONT_SDF_GLYPH_SIZE 传入）。
 */
export interface LabelFontPreloadParams {
  readonly texts: readonly string[]
  readonly manifestCodePoints: ReadonlySet<number>
  readonly port: LabelFontPreloadPort
  readonly fontUrl: string
  readonly sdfGlyphSize: number
}

/*
 * 字体预加载失败阶段（写进 FONT_ASSET_FAILED 的 context，便于 overlay / 日志定位）。
 *   - 'coverage'：字形覆盖门禁未通过（实际归 FONT_GLYPH_MISSING，但保留枚举完整性）。
 *   - 'asset'：端口报告本地字体资产加载 / 解析 / 预渲染失败。
 */
export type LabelFontFailureStage = 'coverage' | 'asset'

/*
 * 字体预加载结果（任务“可供 application 层消费的显式契约”）。
 *   - status='ready'：本地字体预加载成功，application 可据此把状态机推进到 ready。
 *   - status='error'：携带 MapDataError（code 为 FONT_GLYPH_MISSING 或 FONT_ASSET_FAILED），
 *     application 据此进入 error 状态，不挂载任何标签。
 */
export type LabelFontPreloadOutcome =
  | { readonly status: 'ready' }
  | { readonly status: 'error'; readonly error: MapDataError }

/*
 * 把缺失码点清单格式化为稳定可读串，写入 FONT_GLYPH_MISSING 的 message 与 context。
 * 以码点的 hex 为稳定键（不依赖字符渲染），便于自动化断言精确匹配。
 */
function describeMissingGlyphs(missing: readonly MissingGlyphInfo[]): string {
  const head = missing[0]
  const detail = missing
    .slice(0, 8)
    .map(
      (m) =>
        `${m.hex} (${m.char}) 首次出现在标签 "${m.firstText}"`,
    )
    .join('；')
  const suffix = missing.length > 8 ? ` 等 ${missing.length} 个` : ''
  return `首个缺失码点 ${head.hex} (${head.char})${suffix}：${detail}`
}

/*
 * 构造 FONT_GLYPH_MISSING 结构化错误（SPEC 14.1）。
 * 阶段固定为 coverage；context 含缺失码点清单（hex / char / 首次出现文本）。
 */
function buildGlyphMissingError(
  missing: readonly MissingGlyphInfo[],
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.FONT_GLYPH_MISSING,
    message: `标签存在未打包进本地字体的字符，禁止 Troika 联网补字：${describeMissingGlyphs(missing)}`,
    jsonPath: LABEL_FONT_LOGICAL_PATH,
    context: {
      stage: 'coverage' satisfies LabelFontFailureStage,
      missing: missing.map((m) => ({
        codePoint: m.codePoint,
        hex: m.hex,
        char: m.char,
        firstText: m.firstText,
      })),
    },
  })
}

/*
 * 构造 FONT_ASSET_FAILED 结构化错误（SPEC 14.1）。
 * 阶段固定为 asset；context 含本地字体 URL、SDF 尺寸与底层错误描述（资产上下文）。
 */
function buildAssetFailedError(
  fontUrl: string,
  sdfGlyphSize: number,
  cause: unknown,
): MapDataError {
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  return new MapDataError({
    code: MapErrorCode.FONT_ASSET_FAILED,
    message: `本地字体预加载失败，不切换系统/远端字体：${causeMessage}`,
    jsonPath: LABEL_FONT_LOGICAL_PATH,
    context: {
      stage: 'asset' satisfies LabelFontFailureStage,
      fontUrl,
      sdfGlyphSize,
      cause: causeMessage,
    },
  })
}

/*
 * 字体预加载编排主入口（SPEC 11.1 / 14.1 / 任务约束）。
 *
 * 编排顺序（任务“只在成功回调后发出字体就绪信号”）：
 *   1. 字形覆盖门禁：checkLabelGlyphCoverage(texts, manifest)。
 *      - 缺字 → resolve({ status:'error', error: FONT_GLYPH_MISSING })，先于端口调用。
 *   2. 去重名称字符：collectTextCodePoints(texts) → 码点数组 → 字符串（按 code point 重组）。
 *   3. 调用 port.preloadFont(fontUrl, characters, sdfGlyphSize)：
 *      - onDone(null) → resolve({ status:'ready' })。
 *      - onDone(err)  → resolve({ status:'error', error: FONT_ASSET_FAILED })。
 *      - 防重入：只采纳首次 onDone；后续回调忽略，保证就绪信号恰好一次。
 *
 * 无副作用保证：本函数不创建 Text、不写全局状态、不抛同步异常；
 * 所有失败路径都经 resolve({ status:'error', ... }) 交付，便于 application 层统一消费。
 */
export function preloadLabelFont(
  params: LabelFontPreloadParams,
): Promise<LabelFontPreloadOutcome> {
  const { texts, manifestCodePoints, port, fontUrl, sdfGlyphSize } = params

  // 1. 字形覆盖门禁（先于预加载、先于 Troika 联网补字）。
  const coverage = checkLabelGlyphCoverage(texts, manifestCodePoints)
  if (!coverage.ok) {
    return Promise.resolve({
      status: 'error',
      error: buildGlyphMissingError(coverage.missing),
    })
  }

  // 2. 全部去重名称字符（按 Unicode code point 重组为字符串）。
  const codePoints = collectTextCodePoints(texts)
  const characters = codePoints.map((cp) => String.fromCodePoint(cp)).join('')

  // 3. 调用端口预加载；防重入保护使就绪信号恰好一次。
  return new Promise<LabelFontPreloadOutcome>((resolve) => {
    let settled = false
    port.preloadFont({ font: fontUrl, characters, sdfGlyphSize }, (err) => {
      if (settled) {
        // 端口实现误触发多次回调；只采纳首次结果，保证就绪信号恰好一次。
        return
      }
      settled = true
      if (err === null || err === undefined) {
        resolve({ status: 'ready' })
      } else {
        resolve({ status: 'error', error: buildAssetFailedError(fontUrl, sdfGlyphSize, err) })
      }
    })
  })
}
