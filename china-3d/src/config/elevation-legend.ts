/**
 * 海拔色阶图例配置——图例呈现层的唯一事实源（TASK-014，SPEC §9 / §3.1）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），只承载「图例展示所需的呈现常量」：关键刻度海拔、
 *   色条采样段数、色条几何尺寸与纯 DOM 界面文案（标题 / 单位 / 海平面注释）。色阶**断点与
 *   颜色本身不在本模块**——断点 / 颜色 / 色阶域的唯一事实源是 TASK-006 的
 *   src/config/elevation-color-ramp；本模块只引用其 ELEVATION_COLOR_DOMAIN（同一对象引用，
 *   不复制数值），由图例准备层（src/lib/elevation-legend）调 sampleElevationColor /
 *   normalizeElevationToRampU 现场派生色条与刻度颜色，绝不复制断点或颜色字面量。
 * - 单向依赖：本模块只依赖同层 elevation-color-ramp 的色阶域常量，不依赖 React / R3F /
 *   Three.js / DOM，故自动化测试可在 Node 环境直接断言「关键刻度齐全且升序、全部落在色阶域
 *   内、色阶域与 ramp 同一引用、配置冻结」。
 *
 * 色阶复用（SPEC §9「对应 §3.1 分层设色断点」、验收「图例配色与地表 ramp 同源」）：
 * - 关键刻度 ELEVATION_LEGEND_KEY_TICKS（0 / 1000 / 2000 / 3500 / 5000 / 8848m）是「读图辅助
 *   刻度」，不是色阶控制点——色阶控制点（含 -1500 / 200 / 500 / 9000 等）唯一来自
 *   elevation-color-ramp。刻度的颜色与位置都不在本模块硬编码：颜色由准备层对每个刻度海拔调
 *   sampleElevationColor 得到（与地表片元着色器同一函数），位置由 normalizeElevationToRampU
 *   按色阶域归一化得到（与地表 ramp 纹理同一归一化）。「刻度海拔 h 处图例显示的颜色」≡
 *   「地表真实海拔 h 处着色器渲染的颜色」，单一事实源由自动化测试逐刻度断言。
 * - 色条连续渐变同样不存颜色：准备层按 ELEVATION_LEGEND_BAR_SAMPLE_COUNT 个均匀采样点对
 *   色阶域调 sampleElevationColor 拼 CSS linear-gradient，所有颜色来自同一采样器。
 *
 * 色阶域与 shader 一致（SPEC §3.1 / §5.1）：色条纵向覆盖完整色阶域 [-1500m, 9000m]（与
 * heightmap 元数据编码区间、与 shader ramp 纹理跨度严格一致）。底部 -1500m 为深海近黑
 * （透过半透明海面可见的水下地形），0m 标注「海平面」使水下色段有读图含义（近岸浅、
 * 远海深，SPEC §3.5），顶部 9000m 为雪线以上恒定雪白。
 *
 * 文案边界：图例标题 / 单位 / 海平面注释是纯 DOM overlay 界面文案（系统字体渲染，不消费
 * 离线 CJK 字体子集），按 TASK-013 确立的边界由本特性配置层承载，不进入
 * src/lib/static-copy（该模块只收需子集覆盖的文案与 §8 法定合规文案）。
 */

import { ELEVATION_COLOR_DOMAIN } from './elevation-color-ramp'

/**
 * 图例关键刻度海拔（米，升序）——SPEC §9 点名的六个读图刻度。
 *
 * 取值：0（海平面 / 平原下界）、1000（低山-中山界）、2000（中山-高山界）、3500（高山-
 * 极高山界）、5000（雪线）、8848（珠峰海拔，读图上限参考）。全部落在色阶域
 * [−1500, 9000] 内，sampleElevationColor 与 normalizeElevationToRampU 均给出有限确定结果。
 */
export const ELEVATION_LEGEND_KEY_TICKS: readonly number[] = Object.freeze([0, 1000, 2000, 3500, 5000, 8848])

/**
 * 色条连续渐变的采样段数（CSS linear-gradient 的 color stop 数 = 段数 + 1）。
 * 取 64：大屏色条宽度下肉眼无可见阶梯，且所有颜色仍来自唯一采样器；段数更大只增 CSS
 * 字符串体积，无视觉收益。
 */
export const ELEVATION_LEGEND_BAR_SAMPLE_COUNT = 64

/**
 * 色条纵向像素高度。取 240：左侧竖向贴边图例下六个刻度间距舒展、文字不挤，
 * 纵向居中后不侵占主图核心（中央地形）。
 */
export const ELEVATION_LEGEND_BAR_HEIGHT_PIXELS = 240

/** 色条横向像素宽度。取 16：足够呈现色阶渐变，又不喧宾夺主（SPEC §9 低调贴边）。 */
export const ELEVATION_LEGEND_BAR_WIDTH_PIXELS = 16

/** 图例标题（色条上方）。恒定「海拔」：色条含义是真实米制海拔（SPEC §3.1 真实 h 查色）。 */
export const ELEVATION_LEGEND_CAPTION = '海拔'

/** 海拔单位标注（刻度数值后缀）。恒定「m」：真实米制海拔。 */
export const ELEVATION_LEGEND_UNIT_LABEL = 'm'

/**
 * 海平面刻度（0m）的读图注释。0m 在 [-1500, 9000] 域中的归一化位置约 14%（色条下方向上），
 * 其下方为水下地形色（透过半透明海面可见，SPEC §3.5）。标注「海平面」使色条下方水色段
 * 有明确读图含义，而非误读为「陆地低海拔」。
 */
export const ELEVATION_LEGEND_SEA_LEVEL_LABEL = '海平面'

/**
 * 图例全部呈现参数（冻结）。准备层（src/lib/elevation-legend）读取刻度海拔 + 采样段数 +
 * 色阶域；渲染层（src/components/ui/ElevationLegend）读取几何尺寸与界面文案。色阶域引用
 * elevation-color-ramp 的 ELEVATION_COLOR_DOMAIN（同一对象引用，不复制数值），保证图例域
 * 与 shader 域是同一事实源。
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
  /** 图例标题。 */
  caption: ELEVATION_LEGEND_CAPTION,
  /** 海拔单位标注。 */
  unitLabel: ELEVATION_LEGEND_UNIT_LABEL,
  /** 海平面刻度读图注释。 */
  seaLevelLabel: ELEVATION_LEGEND_SEA_LEVEL_LABEL,
})
