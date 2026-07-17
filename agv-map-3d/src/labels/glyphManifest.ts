/*
 * 字形清单解析（labels 层，SPEC 11.1 / 14.1 / 任务约束）。
 *
 * 信任边界定位（TASK-015）：
 *   - 本模块是“glyphs.json 原始结构 → 只读码点集合”的唯一纯解析器。
 *   - glyphs.json 是 public/fonts/ 下随项目打包的字形清单（SPEC 11.1），不是样本原始 JSON；
 *     解析它不违反“只消费标签文本契约”约束——它是字体资产的清单，不是地图数据来源。
 *   - 解析为 ReadonlySet<number> 后，供 checkLabelGlyphCoverage 与 preloadLabelFont 复用。
 *
 * 严格校验（SPEC 11.1 / 14.1）：
 *   - codePoints 必须是数组；每项必须是 { codePoint: number, ... }，且 codePoint 为整数 ∈ [0, 0x10ffff]。
 *   - 任何结构损坏、非整数码点、重复码点都抛 FONT_ASSET_FAILED（资产清单不可信，整体拒绝）。
 *   - 不接受空清单：子集至少含 ASCII 可打印区，空清单说明资产异常。
 *
 * 依赖方向（SPEC 3.3）：domain（MapDataError / 错误码）+ labels 自身；外部仅 Node 内置。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'

/*
 * 字形清单逻辑路径前缀：清单解析错误发生在 public/fonts/glyphs.json 上，不对应样本 JSON path。
 */
const GLYPH_MANIFEST_LOGICAL_PATH = 'public/fonts/glyphs.json'

/*
 * Unicode 码点合法上界（SPEC / Unicode 规范）。
 */
const UNICODE_CODE_POINT_MAX = 0x10ffff

/*
 * glyphs.json 单条码点记录的最小结构。
 * 字体来源、子集范围等元数据字段不参与运行时码点集合派生，解析时忽略，不做强制校验。
 */
interface GlyphManifestEntry {
  readonly codePoint: unknown
  readonly hex?: unknown
  readonly char?: unknown
}

/*
 * 把“码点记录项”收敛为合法整数码点；非法形态返回 null（由调用方累计失败清单）。
 */
function coerceEntryCodePoint(entry: unknown): number | null {
  if (typeof entry !== 'object' || entry === null) return null
  const cp = (entry as GlyphManifestEntry).codePoint
  if (typeof cp !== 'number' || !Number.isFinite(cp)) return null
  if (!Number.isInteger(cp) || cp < 0 || cp > UNICODE_CODE_POINT_MAX) {
    return null
  }
  return cp
}

/*
 * 字形清单解析主入口（SPEC 11.1 / 14.1）。
 *
 * 调用方契约：
 *   - manifest：glyphs.json 经 JSON.parse 得到的未知值（typically 由 fetch + JSON.parse 产出）。
 *   - 成功返回 ReadonlySet<number>：清单内全部合法码点（去重）。
 *   - 失败抛出 MapDataError（FONT_ASSET_FAILED）：结构损坏 / 非整数码点 / 重复码点 / 空清单。
 *
 * 设计不变量：
 *   - 不读文件、不联网：纯函数，I/O 由调用方完成；便于构建期与运行时共用同一校验口径。
 *   - 重复码点视为清单损坏（glyphs.json 由生成脚本保证唯一）；运行时不再做静默去重。
 */
export function parseGlyphManifest(manifest: unknown): ReadonlySet<number> {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: '字形清单根对象不是对象，资产损坏。',
      jsonPath: GLYPH_MANIFEST_LOGICAL_PATH,
      context: { stage: 'manifest-parse', actualType: typeof manifest },
    })
  }
  const codePointsField = (manifest as { codePoints?: unknown }).codePoints
  if (!Array.isArray(codePointsField)) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: '字形清单 codePoints 字段不是数组，资产损坏。',
      jsonPath: GLYPH_MANIFEST_LOGICAL_PATH,
      context: { stage: 'manifest-parse' },
    })
  }

  const set = new Set<number>()
  for (let i = 0; i < codePointsField.length; i++) {
    const cp = coerceEntryCodePoint(codePointsField[i])
    if (cp === null) {
      throw new MapDataError({
        code: MapErrorCode.FONT_ASSET_FAILED,
        message: `字形清单 codePoints[${i}] 不是合法码点记录，资产损坏。`,
        jsonPath: `${GLYPH_MANIFEST_LOGICAL_PATH}#codePoints[${i}]`,
        context: { stage: 'manifest-parse', index: i },
      })
    }
    if (set.has(cp)) {
      throw new MapDataError({
        code: MapErrorCode.FONT_ASSET_FAILED,
        message: `字形清单存在重复码点 ${cp.toString(16).toUpperCase().padStart(4, '0').replace(/^/, 'U+')}，资产损坏。`,
        jsonPath: `${GLYPH_MANIFEST_LOGICAL_PATH}#codePoints[${i}]`,
        context: { stage: 'manifest-parse', index: i, codePoint: cp },
      })
    }
    set.add(cp)
  }

  if (set.size === 0) {
    throw new MapDataError({
      code: MapErrorCode.FONT_ASSET_FAILED,
      message: '字形清单为空，资产损坏（子集至少应包含 ASCII 可打印区）。',
      jsonPath: GLYPH_MANIFEST_LOGICAL_PATH,
      context: { stage: 'manifest-parse' },
    })
  }

  return set
}
