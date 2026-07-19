/**
 * 海拔色阶图例配置——图例展示层的事实源（TASK-021，SPEC §9 / §3.1 / §8）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），只承载「图例展示所需的呈现常量」：关键刻度海拔、色条采样数、
 *   图例文字、深色科技风样式（色条宽高、字号、描边色等）。色阶**断点与颜色本身不在本模块**——
 *   断点 / 颜色 / 域的唯一事实源是 TASK-010 的 src/config/elevation-color-ramp；本模块只引用其
 *   ELEVATION_COLOR_DOMAIN（色阶域），由图例准备层（src/lib/elevation-legend）调 sampleElevationColor /
 *   normalizeElevationToRampU 现场派生色条与刻度颜色，绝不复制断点或颜色字面量（TASK-021 实现约束
 *   「图例不得复制色阶断点和颜色，必须从 TASK-010 的单一事实源派生」）。
 * - 单向依赖：本模块只依赖 TASK-010 的色阶域常量（ELEVATION_COLOR_DOMAIN），不依赖 React / R3F / Three.js /
 *   DOM，故自动化测试可在 Node 环境直接断言「关键刻度齐全且升序、样式有限、文案非空、配置冻结」。
 *
 * 色阶复用（SPEC §9「直接消费地表唯一色阶配置」、TASK-021 验证方式 1「图例颜色和断点与地表配置引用
 *   同一事实源」）：
 * - 关键刻度 ELEVATION_LEGEND_KEY_TICKS 的海拔（0 / 1000 / 2000 / 3500 / 5000 / 8848m）是「读图辅助刻度」，
 *   不是色阶控制点——色阶控制点（含 -1500 / 200 / 500 / 9000 等）唯一来自 elevation-color-ramp。刻度的
 *   **颜色**与**位置**都不在本模块硬编码：颜色由图例准备层对每个刻度海拔调 sampleElevationColor 得到
 *   （与地表片元着色器同一函数），位置由 normalizeElevationToRampU 按色阶域归一化得到（与地表 ramp
 *   纹理同一归一化）。这样「刻度海拔 h 处图例显示的颜色」≡「地表真实海拔 h 处着色器渲染的颜色」，
 *   单一事实源可由自动化证明（TASK-021 完成标准「图例与 shader 色阶单一事实源可由自动化证明」）。
 * - 色条本身（连续渐变）同样不在本模块存颜色：图例准备层按 ELEVATION_LEGEND_BAR_SAMPLE_COUNT 个均匀
 *   采样点对色阶域调 sampleElevationColor，拼成 CSS linear-gradient。采样数越多色条越平滑（64 段在
 *   大屏下肉眼无阶梯），但所有颜色仍来自同一采样器，不存在第二套色阶。
 *
 * 色阶域与 shader 一致（SPEC §3.1 / §5.1）：
 * - 色条纵向范围覆盖完整色阶域 [minH, maxH] = [-1500m, 9000m]（与 heightmap 元数据编码区间、与 shader
 *   ramp 纹理跨度严格一致）。底部 -1500m 为深海近黑（透过半透明海面可见的水下地形），0m 为海平面，
 *   顶部 9000m 为雪线以上恒定雪白。图例把 0m 标注为「海平面」，使色条下方的水下色段有明确读图含义
 *   （近岸浅、远海深，SPEC §3.5）。色条位置归一化用 normalizeElevationToRampU，与 shader 片元归一化
 *   同一公式，故同一海拔在色条与地表处于同一相对位置。
 */

import { ELEVATION_COLOR_DOMAIN } from './elevation-color-ramp'

/**
 * 图例关键刻度海拔（米，升序）——SPEC §9 / TASK-021 输出要求的六个读图刻度。
 *
 * 这些是「读图辅助刻度」（帮助用户把地表颜色映射回海拔），**不是**色阶控制点：色阶控制点的海拔与
 * 颜色唯一来自 elevation-color-ramp 的 ELEVATION_COLOR_BREAKPOINTS。刻度的颜色由图例准备层对每个海拔
 * 调 sampleElevationColor 现场取得（与地表着色器同源），故本数组只存「在哪些海拔放刻度」，不存颜色。
 *
 * 取值：0（海平面 / 平原下界）、1000（低山-中山界）、2000（中山-高山界）、3500（高山-极高山界）、
 * 5000（雪线）、8848（珠峰海拔，读图上限参考）。全部落在色阶域 [−1500, 9000] 内，故 sampleElevationColor
 * 与 normalizeElevationToRampU 均给出有限、确定的结果。
 */
export const ELEVATION_LEGEND_KEY_TICKS: readonly number[] = Object.freeze([0, 1000, 2000, 3500, 5000, 8848])

/**
 * 色条连续渐变的采样段数（CSS linear-gradient 的 color stop 数 = 段数 + 1）。
 *
 * 图例准备层在色阶域 [minH, maxH] 上均匀取「段数 + 1」个海拔，各自调 sampleElevationColor 得到颜色，
 * 拼成 linear-gradient。取 64：在大屏色条宽度下肉眼无可见阶梯，且所有颜色仍来自唯一采样器（不存在
 * 第二套色阶）。段数越大越平滑但 CSS 字符串越长；64 是视觉与体积的折中。
 */
export const ELEVATION_LEGEND_BAR_SAMPLE_COUNT = 64

/**
 * 色条纵向像素高度。取 240：在大屏左侧贴边竖向图例下，刻度间距舒展、文字不挤，且不侵占主图核心。
 * 色条宽度 ELEVATION_LEGEND_BAR_WIDTH_PIXELS 与高度分离，便于独立微调。
 */
export const ELEVATION_LEGEND_BAR_HEIGHT_PIXELS = 240

/** 色条横向像素宽度。取 16：足够呈现色阶渐变，又不喧宾夺主（SPEC §9「低调、贴边」）。 */
export const ELEVATION_LEGEND_BAR_WIDTH_PIXELS = 16

/** 色条描边色（半透明冷蓝，与 .china-map-overlay 控件边框同系，深色科技风）。 */
export const ELEVATION_LEGEND_BAR_STROKE_HEX = '#3a5675'

/** 色条描边宽度（像素）。取 1：勾勒色条边界，抗深色背景糊化。 */
export const ELEVATION_LEGEND_BAR_STROKE_WIDTH_PX = 1

/** 图例标题（色条上方）。恒定「海拔」：说明色条含义是真实米制海拔（SPEC §3.1 真实 h 查色）。 */
export const ELEVATION_LEGEND_CAPTION = '海拔'

/** 图例海拔单位标注（色条下方 / 刻度后缀）。恒定「m」：真实米制海拔。 */
export const ELEVATION_LEGEND_UNIT_LABEL = 'm'

/**
 * 海平面刻度（0m）的读图注释。
 *
 * 色条底部约 14% 处（0m 在 [-1500,9000] 域中的归一化位置）是海平面；其下方为水下地形色（透过半透明
 * 海面可见，近岸浅、远海深，SPEC §3.5）。标注「海平面」使用户明确色条下方水色段的读图含义，
 * 而非误读为「陆地低海拔」。
 */
export const ELEVATION_LEGEND_SEA_LEVEL_LABEL = '海平面'

/** 刻度文字色（浅冷白，与深色科技风背景对比可读）。 */
export const ELEVATION_LEGEND_TICK_LABEL_HEX = '#c7d0e0'

/** 刻度文字字号（像素）。取 11：大屏下清晰可读、不挤刻度间距。 */
export const ELEVATION_LEGEND_TICK_LABEL_FONT_SIZE_PX = 11

/** 标题文字色（略亮冷白，比刻度文字更醒目）。 */
export const ELEVATION_LEGEND_CAPTION_HEX = '#dfe7f2'

/** 标题文字字号（像素）。取 13：略大于刻度文字，作为图例的视觉标题。 */
export const ELEVATION_LEGEND_CAPTION_FONT_SIZE_PX = 13

/** 图例面板背景色（半透明深蓝黑，与 .china-map-overlay 控件同系，深色科技风）。 */
export const ELEVATION_LEGEND_PANEL_BG_RGBA = 'rgba(8, 14, 26, 0.72)'

/**
 * 图例全部呈现参数（冻结）。图例准备层（src/lib/elevation-legend）只读取本配置的刻度海拔 + 采样段数 +
 * 色阶域；渲染层（src/components/ui/ElevationLegend）读取样式 + 文案。色阶域引用 elevation-color-ramp 的
 * ELEVATION_COLOR_DOMAIN（同一对象引用，不复制数值），保证图例域与 shader 域是同一事实源。
 */
export const ELEVATION_LEGEND_CONFIG = Object.freeze({
  /** 关键刻度海拔（米，升序）；颜色 / 位置由准备层从 elevation-color-ramp 派生，不在此存。 */
  keyTicks: ELEVATION_LEGEND_KEY_TICKS,
  /** 色条渐变采样段数。 */
  barSampleCount: ELEVATION_LEGEND_BAR_SAMPLE_COUNT,
  /** 色阶域（米），引用 elevation-color-ramp 的冻结常量——与 shader ramp 纹理跨度同一事实源。 */
  domain: ELEVATION_COLOR_DOMAIN,
  /** 色条纵向像素高度。 */
  barHeightPixels: ELEVATION_LEGEND_BAR_HEIGHT_PIXELS,
  /** 色条横向像素宽度。 */
  barWidthPixels: ELEVATION_LEGEND_BAR_WIDTH_PIXELS,
  /** 色条描边色（十六进制）。 */
  barStrokeHex: ELEVATION_LEGEND_BAR_STROKE_HEX,
  /** 色条描边宽度（像素）。 */
  barStrokeWidthPx: ELEVATION_LEGEND_BAR_STROKE_WIDTH_PX,
  /** 图例标题。 */
  caption: ELEVATION_LEGEND_CAPTION,
  /** 海拔单位标注。 */
  unitLabel: ELEVATION_LEGEND_UNIT_LABEL,
  /** 海平面刻度读图注释。 */
  seaLevelLabel: ELEVATION_LEGEND_SEA_LEVEL_LABEL,
  /** 刻度文字色（十六进制）。 */
  tickLabelHex: ELEVATION_LEGEND_TICK_LABEL_HEX,
  /** 刻度文字字号（像素）。 */
  tickLabelFontSizePx: ELEVATION_LEGEND_TICK_LABEL_FONT_SIZE_PX,
  /** 标题文字色（十六进制）。 */
  captionHex: ELEVATION_LEGEND_CAPTION_HEX,
  /** 标题文字字号（像素）。 */
  captionFontSizePx: ELEVATION_LEGEND_CAPTION_FONT_SIZE_PX,
  /** 图例面板背景色（rgba）。 */
  panelBgRgba: ELEVATION_LEGEND_PANEL_BG_RGBA,
})
