/**
 * 合规角标配置——审图状态与发布限制的事实源（TASK-021，SPEC §8 / §6 / §13）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），只承载「合规角标展示所需的呈现常量」：审图号占位文案、
 *   审图状态、免责声明文案、必须覆盖的数据来源类别、来源注册表路径、深色科技风样式。**数据来源
 *   署名的具体名称不在本模块**——来源详情唯一来自 public/geo/data-sources.json 来源注册表
 *   （TASK-001 来源声明契约）；本模块只声明「角标必须覆盖哪几类来源」，由合规角标准备层
 *   （src/lib/compliance-badge）从注册表派生具体署名，绝不复制来源名称 / 免责声明字面量
 *   （TASK-021 实现约束「合规角标只消费来源 / 审图状态，不得反向控制资产、场景或交互」）。
 * - 单向依赖：本模块只依赖契约层 src/geo-contracts（DataSourceKind 类型），不依赖 React / R3F / Three.js /
 *   DOM，故自动化测试可在 Node 环境断言「审图号占位为未送审形态、免责声明完整、必须覆盖的来源类别齐全、
 *   配置冻结」。
 *
 * 审图状态——不得伪装已审图（SPEC §8「发布前必须取得并填入审图号」、TASK-021 实现约束「不得以占位审图号
 *   暗示已经审图」、SPEC §6 红线「程序生成 / 拼装的地图公开发布前依法须送审」）：
 * - 当前页面未取得自然资源主管部门审图号（生产政治边界资产的可追溯数字化、人工核对、官方审图均未闭环，
 *   见 docs/political-review-record.md §4）。故审图号占位为「未填写」形态：字面 `GS(202x)xxxx 号`，
 *   其中 `202x` 的 `x` 与 `xxxx` 均为占位字母 / 占位 x，**不是**已批复的具体年号 / 编号——任何把这个
 *   字符串读作「真实审图号」的解读都与字面矛盾（含字母 x 的审图号不存在）。
 * - 审图状态文字显式标注「未取得审图号 · 仅内部展示」，使「未审图」状态在视觉上无可误读。取得真实审图号
 *   后，由外部审图流程把真实号码填入本占位并移除「未取得」状态文字——本模块不自行生成 / 伪造号码。
 *
 * 发布限制——免责声明不得缺失（SPEC §8「注明非官方审图数据」、TASK-021 实现约束「不得删除『非官方、
 *   仅内部展示、不得正式发布』的限制」）：
 * - 免责声明恒定为 TASK-021 输出要求的完整文本：「本图边界数据为非官方审图数据，仅供内部展示，不得作为
 *   正式出版 / 发布用途」。该文本同时出现在合规角标准备层对每条来源署名的尾部强调，使「非官方 / 仅内部 /
 *   不得正式发布」三重限制在角标上明确呈现，直至外部审图流程提供真实审图号。
 *
 * 来源类别覆盖（TASK-021 输出要求「覆盖 DEM、DataV.GeoAtlas 及项目补充十段线 / 岛礁数据」、验证方式 2
 *   「DEM、边界、项目补充数据三类署名……均存在；缺少任一项时失败」）：
 * - 角标必须覆盖三类来源：数字高程模型（digitalElevationModel，DEM）、行政区边界
 *   （administrativeBoundary，DataV 省级边界）、政治边界补充（politicalBoundarySupplement，项目自补十段线 /
 *   岛礁 / 争议区修正）。这三类对应 TASK-003 / TASK-004 / TASK-006 的三类生产资产来源，是 SPEC §8「标注
 *   DEM / 边界 / 九段线岛礁来源」的落点。来源注册表还可能含其它类别（如地点目录 placeGazetteer），角标
 *   一并展示（透明署名），但「三类必备」是准备层硬校验的下限——缺任一类即抛错，绝不静默显示缺来源的
 *   角标（TASK-021 验证方式 2「缺少任一项时失败」）。
 */

import type { DataSourceKind } from '../geo-contracts'

/**
 * 审图号占位文案——未送审形态。
 *
 * 字面 `GS(202x)xxxx 号`：`202x` 含占位字母 x（非具体年号）、`xxxx` 为四个占位 x（非已批复编号）。
 * 这是 SPEC §8「文字如 GS(202x)xxxx 号」的占位形态，也是 TASK-021 输出要求的「示例状态明确为
 * GS(202x)xxxx号 或等价未填写标识，不得伪装成已获批号码」。取得真实审图号后由外部流程替换本常量。
 */
export const COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER = 'GS(202x)xxxx 号'

/**
 * 审图状态文字——显式标注未审图，避免占位被误读为已批复。
 *
 * 与审图号占位一同呈现：占位给出格式、状态文字给出「未取得」语义。二者合力使「未审图」状态在视觉上
 * 无可误读（SPEC §8、TASK-021 实现约束「不得以占位审图号暗示已经审图」）。
 */
export const COMPLIANCE_AUDIT_NUMBER_STATUS = '未取得审图号 · 仅内部展示'

/**
 * 完整免责声明——发布限制三重门（非官方 / 仅内部 / 不得正式发布）。
 *
 * 文本与 TASK-021 输出要求逐字一致：「本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版 /
 * 发布用途」。该限制在取得真实审图号前不得删除（SPEC §8、TASK-021 实现约束）。
 */
export const COMPLIANCE_DISCLAIMER =
  '本图边界数据为非官方审图数据，仅供内部展示，不得作为正式出版 / 发布用途'

/**
 * 数据来源注册表的运行时路径（相对站点根，Vite 投递 public/ 到根）。
 *
 * 与 scripts/verify-assets 各 scope 读取的生产注册表 public/geo/data-sources.json 同一份资产——角标准备层
 * 经 loadDataSourceRegistry（src/lib/data-source-registry）fetch 并契约校验该资产，从中派生三类署名，
 * 不复制来源名称 / 免责声明字面量（单一事实源）。
 */
export const COMPLIANCE_DATA_SOURCES_PATH = '/geo/data-sources.json'

/**
 * 合规角标必须覆盖的数据来源类别（TASK-021 验证方式 2「DEM、边界、项目补充数据三类署名……均存在」）。
 *
 * - digitalElevationModel：数字高程模型（DEM，TASK-003）。
 * - administrativeBoundary：行政区边界（DataV 省级边界，TASK-004）。
 * - politicalBoundarySupplement：政治边界补充（项目自补十段线 / 岛礁 / 争议区修正，TASK-006）。
 *
 * 准备层对来源注册表做硬校验：这三类必须各至少一条来源，缺任一类即抛
 * compliance-badge.required-source-kind-missing，绝不静默显示缺来源的角标。
 */
export const COMPLIANCE_REQUIRED_SOURCE_KINDS: readonly DataSourceKind[] = Object.freeze([
  'digitalElevationModel',
  'administrativeBoundary',
  'politicalBoundarySupplement',
])

/** 角标标题（如「数据来源 / 审图」），概括角标内容。 */
export const COMPLIANCE_BADGE_CAPTION = '数据来源 · 审图'

/** 审图号标签（角标中审图号占位行的前缀）。 */
export const COMPLIANCE_AUDIT_NUMBER_LABEL = '审图号'

/** 来源署名标签（角标中来源列表的前缀）。 */
export const COMPLIANCE_SOURCES_LABEL = '来源'

/** 角标文字色（浅冷白，与深色科技风背景对比可读；低调，不喧宾夺主）。 */
export const COMPLIANCE_BADGE_TEXT_HEX = '#c7d0e0'

/** 角标标题文字色（略亮冷白）。 */
export const COMPLIANCE_BADGE_CAPTION_HEX = '#dfe7f2'

/** 角标正文文字字号（像素）。取 11：低调角标，可读但不抢主图视觉。 */
export const COMPLIANCE_BADGE_FONT_SIZE_PX = 11

/** 角标标题文字字号（像素）。取 12：略大于正文，作为角标小标题。 */
export const COMPLIANCE_BADGE_CAPTION_FONT_SIZE_PX = 12

/** 角标免责声明文字字号（像素）。取 10：最小字号，低调但完整可读。 */
export const COMPLIANCE_BADGE_DISCLAIMER_FONT_SIZE_PX = 10

/** 角标面板背景色（半透明深蓝黑，与 .china-map-overlay 控件同系，深色科技风）。 */
export const COMPLIANCE_BADGE_PANEL_BG_RGBA = 'rgba(8, 14, 26, 0.72)'

/** 角标面板描边色（半透明冷蓝，与图例 / 附图边框同系）。 */
export const COMPLIANCE_BADGE_PANEL_STROKE_HEX = '#3a5675'

/** 角标面板描边宽度（像素）。取 1：勾勒面板边界，抗深色背景糊化。 */
export const COMPLIANCE_BADGE_PANEL_STROKE_WIDTH_PX = 1

/** 角标面板最大宽度（像素）。取 260：足以容纳最长来源名称 + 完整免责声明，又不侵占主图核心。 */
export const COMPLIANCE_BADGE_PANEL_MAX_WIDTH_PX = 260

/** 合规角标全部呈现参数（冻结）。准备层读取必备来源类别 + 文案；渲染层读取样式。 */
export const COMPLIANCE_BADGE_CONFIG = Object.freeze({
  /** 审图号占位（未送审形态）。 */
  auditNumberPlaceholder: COMPLIANCE_AUDIT_NUMBER_PLACEHOLDER,
  /** 审图状态文字。 */
  auditNumberStatus: COMPLIANCE_AUDIT_NUMBER_STATUS,
  /** 完整免责声明。 */
  disclaimer: COMPLIANCE_DISCLAIMER,
  /** 来源注册表运行时路径。 */
  dataSourcesPath: COMPLIANCE_DATA_SOURCES_PATH,
  /** 角标必须覆盖的来源类别。 */
  requiredSourceKinds: COMPLIANCE_REQUIRED_SOURCE_KINDS,
  /** 角标标题。 */
  caption: COMPLIANCE_BADGE_CAPTION,
  /** 审图号标签。 */
  auditNumberLabel: COMPLIANCE_AUDIT_NUMBER_LABEL,
  /** 来源署名标签。 */
  sourcesLabel: COMPLIANCE_SOURCES_LABEL,
  /** 角标文字色（十六进制）。 */
  textHex: COMPLIANCE_BADGE_TEXT_HEX,
  /** 角标标题文字色（十六进制）。 */
  captionHex: COMPLIANCE_BADGE_CAPTION_HEX,
  /** 角标正文文字字号（像素）。 */
  fontSizePx: COMPLIANCE_BADGE_FONT_SIZE_PX,
  /** 角标标题文字字号（像素）。 */
  captionFontSizePx: COMPLIANCE_BADGE_CAPTION_FONT_SIZE_PX,
  /** 角标免责声明文字字号（像素）。 */
  disclaimerFontSizePx: COMPLIANCE_BADGE_DISCLAIMER_FONT_SIZE_PX,
  /** 角标面板背景色（rgba）。 */
  panelBgRgba: COMPLIANCE_BADGE_PANEL_BG_RGBA,
  /** 角标面板描边色（十六进制）。 */
  panelStrokeHex: COMPLIANCE_BADGE_PANEL_STROKE_HEX,
  /** 角标面板描边宽度（像素）。 */
  panelStrokeWidthPx: COMPLIANCE_BADGE_PANEL_STROKE_WIDTH_PX,
  /** 角标面板最大宽度（像素）。 */
  panelMaxWidthPx: COMPLIANCE_BADGE_PANEL_MAX_WIDTH_PX,
})
