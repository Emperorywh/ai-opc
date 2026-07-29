/**
 * 省级悬停焦点的视觉配置——唯一事实源（TASK-009，SPEC §4.2）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「悬停焦点省的边界色 / 线宽、非焦点省的压暗色、
 *   焦点省名标签的放大倍率 / 置顶透明度 / 提亮色」的**唯一**权威。渲染层（src/three/ProvinceBorders
 *   按 adminId 寻址更新单一省份的 Line color / lineWidth；TASK-010 标签模块按 adminId 寻址更新单一
 *   省名标签的字号 / 透明度 / 颜色）、自动化测试都只能通过本模块取得这些参数——禁止在组件 / 测试
 *   里各自复制一份焦点色或放大倍率。
 * - 单向依赖：本模块不依赖 React / R3F / Three.js / DOM（纯数值常量），故自动化测试可在 Node 环境
 *   直接断言「焦点色比基线色更亮」「压暗色比基线色更暗」「线宽加粗」「放大倍率 > 1」等不变量。
 *
 * 与基线的关系（SPEC §4.2「该省边界线加亮加粗」「其余省份边界可轻微压暗」「标签放大并置顶」）：
 * - 省界基线色 / 基线线宽取自 PROVINCE_BORDERS_CONFIG（#9fe8d8 / 1.6 px），本配置只额外定义
 *   「焦点态」与「压暗态」两套派生样式：焦点态比基线更亮更粗（视觉跳出），压暗态比基线更暗
 *   （弱化非焦点、衬托焦点）。焦点态 = hoveredAdminId 命中省份的样式；压暗态 = hoveredAdminId 非空
 *   且未命中省份的样式；hoveredAdminId 为 null（无焦点）时全部省份回到基线态（移出还原不变量）。
 * - 压暗是「可选的视觉衬托」，不是识别焦点的必要条件——焦点本身已由加亮加粗标识（SPEC §4.2）。
 * - 标签三常量（放大倍率 / 置顶透明度 / 提亮色）本 TASK 先行定义为唯一事实源，由 TASK-010 标签
 *   模块消费（标签基线字号 / 基线色届时由标签配置提供，本模块只承载 hover 派生量）。
 *
 * 非官方审图限制（SPEC §6 / §8）：本配置只决定「悬停时怎么变色 / 变粗 / 放大」，不承载也不校验
 * 坐标或边界完整性；悬停只是视觉焦点反馈，不改变任何省界 / 标签的地理数据（adminId 寻址）。
 */

/**
 * 焦点省界色（SPEC §4.2「加亮」，十六进制）。
 *
 * #eafff8（r=234、g=255、b=248）：比基线 #9fe8d8（159,232,216）逐通道更亮，呈近白偏青的高亮
 * 发光，在深色科技风背景下从一众基线省界中跳出，明确传达「这是当前焦点省份」。仅在 hoveredAdminId
 * 命中该省时应用（单一焦点）。
 */
export const PROVINCE_HOVER_FOCUSED_BORDER_COLOR_HEX = '#eafff8'

/**
 * 焦点省界屏幕线宽（SPEC §4.2「加粗」，px）。
 *
 * 取 3.2 px：基线 1.6 px 的 2 倍，地图尺度下加粗明显但不至于糊成一团。焦点态线宽与焦点色一同
 * 使焦点省界从基线中视觉跳出。
 */
export const PROVINCE_HOVER_FOCUSED_BORDER_LINE_WIDTH_PX = 3.2

/**
 * 非焦点省界压暗色（SPEC §4.2「其余省份边界可轻微压暗」，十六进制）。
 *
 * #3d6b5e（r=61、g=107、b=94）：基线 #9fe8d8 的逐通道约 0.4 倍，呈暗青，弱化非焦点省界以衬托
 * 焦点。仅在 hoveredAdminId 非空且未命中该省时应用；hoveredAdminId 为 null 时全部省份回到基线色
 * （移出还原不变量）。
 */
export const PROVINCE_HOVER_DIMMED_BORDER_COLOR_HEX = '#3d6b5e'

/**
 * 焦点省名标签字号放大倍率（无量纲，> 1）（SPEC §4.2「标签放大」；TASK-010 消费）。
 *
 * 取 1.6：焦点省名标签字号 = 标签基线字号 × 1.6，从一众基线省名中放大跳出。仅在 hoveredAdminId
 * 命中该省时应用；非焦点省名标签字号 = 基线字号。
 */
export const PROVINCE_HOVER_FOCUSED_LABEL_SCALE = 1.6

/**
 * 焦点省名标签的置顶透明度（fillOpacity，0–1）（SPEC §4.2「置顶」；TASK-010 消费）。
 *
 * 固定 1.0（完全可见）：焦点省名标签即使被前方地形遮挡也保持完全可见；标签渲染层届时以
 * 「焦点 ? 1.0 : 遮挡目标」显式合成（焦点 > 遮挡的确定优先级，不会互相覆盖造成闪烁）。
 */
export const PROVINCE_HOVER_FOCUSED_LABEL_OPACITY = 1.0

/**
 * 焦点省名标签提亮色（SPEC §4.2「置顶 / 提高透明度」语义下的视觉提亮，十六进制；TASK-010 消费）。
 *
 * #ffffff：纯白，焦点省名标签从地形分层设色中最大对比跳出，强化「这是当前焦点省份的省名」。
 */
export const PROVINCE_HOVER_FOCUSED_LABEL_COLOR_HEX = '#ffffff'

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
interface ProvinceHoverRgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 RGB（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): ProvinceHoverRgbColor {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  if (value.length !== 6) {
    throw new Error(`颜色必须是 #rrggbb 六位十六进制，实际为 ${hex}。`)
  }
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  if ([r, g, b].some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255)) {
    throw new Error(`颜色通道必须落在 [0,255]，实际为 ${hex}。`)
  }
  return { r, g, b }
}

/** 焦点省界色的字节 RGB（冻结）。 */
export const PROVINCE_HOVER_FOCUSED_BORDER_RGB: Readonly<ProvinceHoverRgbColor> = Object.freeze(
  parseHex(PROVINCE_HOVER_FOCUSED_BORDER_COLOR_HEX),
)

/** 非焦点省界压暗色的字节 RGB（冻结）。 */
export const PROVINCE_HOVER_DIMMED_BORDER_RGB: Readonly<ProvinceHoverRgbColor> = Object.freeze(
  parseHex(PROVINCE_HOVER_DIMMED_BORDER_COLOR_HEX),
)

/** 焦点省名标签提亮色的字节 RGB（冻结）。 */
export const PROVINCE_HOVER_FOCUSED_LABEL_RGB: Readonly<ProvinceHoverRgbColor> = Object.freeze(
  parseHex(PROVINCE_HOVER_FOCUSED_LABEL_COLOR_HEX),
)

/**
 * 省级悬停焦点的全部视觉参数（冻结）。
 *
 * 这是渲染层（src/three/ProvinceBorders；TASK-010 标签模块）与自动化测试共享的同一份事实源：
 * 焦点省界色 / 焦点线宽 / 压暗色 / 标签放大倍率 / 标签置顶透明度 / 标签提亮色全部在此，不存在
 * 第二套悬停常量。冻结防止运行时被偷偷改（如把放大倍率改 1.0 会让焦点标签不放大、把置顶透明度
 * 改掉会让焦点标签被遮挡吞没），任何调整都必须改本模块并同步测试。
 */
export const PROVINCE_HOVER_CONFIG = Object.freeze({
  /** 焦点省界色（加亮，十六进制）。 */
  focusedBorderColorHex: PROVINCE_HOVER_FOCUSED_BORDER_COLOR_HEX,
  /** 焦点省界色的字节 RGB（每通道 0–255）。 */
  focusedBorderColorRgb: PROVINCE_HOVER_FOCUSED_BORDER_RGB,
  /** 焦点省界屏幕线宽（加粗，px）。 */
  focusedBorderLineWidthPx: PROVINCE_HOVER_FOCUSED_BORDER_LINE_WIDTH_PX,
  /** 非焦点省界压暗色（十六进制，仅 hoveredAdminId 非空时应用）。 */
  dimmedBorderColorHex: PROVINCE_HOVER_DIMMED_BORDER_COLOR_HEX,
  /** 非焦点省界压暗色的字节 RGB（每通道 0–255）。 */
  dimmedBorderColorRgb: PROVINCE_HOVER_DIMMED_BORDER_RGB,
  /** 焦点省名标签字号放大倍率（> 1；TASK-010 消费）。 */
  focusedLabelScale: PROVINCE_HOVER_FOCUSED_LABEL_SCALE,
  /** 焦点省名标签置顶透明度（fillOpacity，焦点 > 遮挡的合成优先级用；TASK-010 消费）。 */
  focusedLabelOpacity: PROVINCE_HOVER_FOCUSED_LABEL_OPACITY,
  /** 焦点省名标签提亮色（十六进制；TASK-010 消费）。 */
  focusedLabelColorHex: PROVINCE_HOVER_FOCUSED_LABEL_COLOR_HEX,
  /** 焦点省名标签提亮色的字节 RGB（每通道 0–255）。 */
  focusedLabelColorRgb: PROVINCE_HOVER_FOCUSED_LABEL_RGB,
})
