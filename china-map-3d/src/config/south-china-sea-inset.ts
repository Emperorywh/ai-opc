/**
 * 南海诸岛 2D 标准附图的配置——唯一事实源（TASK-019，SPEC §3.8 / §5.4 / §8）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「附图 2D 子范围四至（InsetExtent）+ SVG viewBox 派生高
 *   度 + 渲染样式（线色 / 线宽 / 虚线节拍 / 点径 / 字号 / 标签偏移 / 边框描边 / 半透明背景）+ 合规角标
 *   文案（图名 / 非审图免责声明）」的唯一权威。附图领域准备层（src/lib/south-china-sea-inset 的纯函数）、
 *   渲染层（src/components/SouthChinaSeaInset 经组件读取样式）、自动化测试都只能通过本模块取得这些参数
 *   ——禁止在准备函数 / 组件 / 测试里各自复制一份四至、viewBox 高度、线宽或免责文案（TASK-019 实现
 *   约束「主图与附图数据、投影单一事实源」「不引入重复坐标」）。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（InsetExtent 类型——附图子范围四至的契约形态；
 *   projectToMercator —— 派生 viewBox 高度时复用同一墨卡托，使附图视觉比例与投影一致，不写死像素）。
 *   不依赖 React / R3F / Three.js / DOM，故自动化测试可在 Node 环境直接断言「四至自洽、包含全部十段线
 *   与岛礁」「viewBox 高度按墨卡托比例派生」「样式参数有限、非负」等不变量。
 *
 * 附图 2D 子范围四至（SPEC §3.3 / §3.8 / §5.4）：
 * - 附图是独立于 3D 主世界的 2D overlay（SVG，SPEC §3.8「DOM overlay，非 3D」）。其视口沿用标准地图
 *   阅读方向（u 随经度向东、v 随纬度向北）。四至取 [104°E, 0°N, 126°E, 27°N]：
 *     · 西 104°E：含中南半岛边缘，与「标准南海诸岛附图」矩形构图惯例一致；
 *     · 东 126°E：容赤尾屿（≈124.55°E）与台湾东侧段，附图范围内能完整容纳钓鱼岛 / 赤尾屿等附属岛屿；
 *     · 南 0°N：到赤道，容曾母暗沙（≈3.58°N，中国领土最南标志）并留出读图余量；
 *     · 北 27°N：过赤尾屿纬度（≈25.92°N），含台湾南侧与十段线北端。
 *   该四至完整容纳 SPEC §6 红线点名的全部十段线段与岛礁点位（含台湾东侧段、钓鱼岛 / 赤尾屿 / 曾母暗沙），
 *   且呈「标准南海诸岛附图」的纵向矩形构图。坐标变换不走本配置——附图领域准备层调 projectToInset
 *   （src/lib/projection，TASK-007 同一墨卡托投影的唯一入口）把经纬度映射到该四至的归一化视口 (u,v)，
 *   与主图共享同一墨卡托结果、仅视口映射不同（SPEC §3.8、TASK-019 验证方式 1「同一坐标与主图投影
 *   结果一致」）。本配置只决定「四至是多少」，不复制投影公式、不内置坐标。
 *
 * viewBox 高度按墨卡托比例派生（避免附图被拉伸变形）：
 * - projectToInset 把 (lon,lat) 归一化到 (u,v)∈[0,1]²，归一化消去了墨卡托的横向 / 纵向米制尺度差。若
 *   SVG viewBox 直接取正方形，附图会被等比拉伸——南北距离（墨卡托纵向）与东西距离（墨卡托横向）比例
 *   失真。故本配置按四至的墨卡托宽 / 高比派生 viewBox 高度（高度 = viewBox 宽度 / 墨卡托宽高比），
 *   使附图视觉比例与投影一致，构图可信。墨卡托宽高比由 projectToMercator 投影四至西南 / 东北角得到
 *   （与主图、附图坐标同一投影），不写死像素、不引入第二套比例公式。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-019 实现约束「本 TASK 不声称获得审图号，仍只能内部展示」）：
 * - 附图与主图复用同一份政治边界补充事实源（public/geo/china-political-boundary.json，
 *   isOfficialSurvey=false）。本配置的 disclaimer 文案如实声明「非官方审图数据，仅供内部展示」，
 *   不填审图号、不以任何视觉手段宣称已审图。正式发布由 TASK-021 的合规状态与外部审图流程约束。
 */

import type { InsetExtent } from '../lib/projection'
import { projectToMercator } from '../lib/projection'

/**
 * 南海附图 2D 子范围四至（EPSG:4326 度）。
 *
 * [104°E, 0°N, 126°E, 27°N]：完整容纳 SPEC §6 红线点名的全部十段线段与岛礁点位（含台湾东侧段、
 * 钓鱼岛 / 赤尾屿 / 曾母暗沙），且呈「标准南海诸岛附图」的纵向矩形构图（详见模块头注释）。
 */
export const SOUTH_CHINA_SEA_INSET_EXTENT: InsetExtent = Object.freeze({
  west: 104,
  south: 0,
  east: 126,
  north: 27,
})

/**
 * 附图 SVG viewBox 宽度（user units）。高度由墨卡托宽高比派生（见下），使附图视觉比例与投影一致。
 * 取 220：与右下角角标尺寸匹配，岛礁光点 / 规范名称在大屏下清晰可读（SPEC §3.8「大屏目标尺寸下可读」）。
 */
export const SOUTH_CHINA_SEA_INSET_VIEWBOX_WIDTH = 220

/**
 * 附图四至的墨卡托宽高比（module-load 派生，用于计算 viewBox 高度）。
 *
 * 宽 = projectToMercator(east) − projectToMercator(west)（墨卡托 x = R·lon，与纬度无关）；
 * 高 = projectToMercator(north) − projectToMercator(south)（墨卡托 y 随纬度非线性增长）。
 * 四至自洽且在墨卡托域内，projectToMercator 必然成功；失败即常量与投影漂移，立即暴露而非吞掉。
 */
const SOUTH_CHINA_SEA_INSET_MERCATOR_ASPECT: number = (() => {
  const sw = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.west, SOUTH_CHINA_SEA_INSET_EXTENT.south)
  const ne = projectToMercator(SOUTH_CHINA_SEA_INSET_EXTENT.east, SOUTH_CHINA_SEA_INSET_EXTENT.north)
  if (!sw.ok || !ne.ok) {
    throw new Error(`南海附图四至投影失败：SOUTH_CHINA_SEA_INSET_EXTENT 与 projectToMercator 漂移。`)
  }
  return (ne.value.x - sw.value.x) / (ne.value.y - sw.value.y)
})()

/**
 * 附图 SVG viewBox 高度（user units）= viewBox 宽度 / 墨卡托宽高比。
 *
 * 按墨卡托比例派生：使 (u,v)∈[0,1]² 线性映射到 viewBox 后，南北 / 东西距离比例与投影一致，附图不被
 * 拉伸变形（详见模块头注释）。
 */
export const SOUTH_CHINA_SEA_INSET_VIEWBOX_HEIGHT =
  SOUTH_CHINA_SEA_INSET_VIEWBOX_WIDTH / SOUTH_CHINA_SEA_INSET_MERCATOR_ASPECT

/** 十段线基线色（暖琥珀 #ffd180，与主图 POLITICAL_LINE_COLOR_HEX 同色——附图与主图同属「政治边界补充要素」族）。 */
export const SOUTH_CHINA_SEA_INSET_LINE_COLOR_HEX = '#ffd180'

/** 十段线屏幕线宽（user units）。取 1.4：在大屏 viewBox 下清晰可辨、不糊。 */
export const SOUTH_CHINA_SEA_INSET_LINE_STROKE_WIDTH = 1.4

/**
 * 十段线虚线节拍（SVG stroke-dasharray，user units）。
 *
 * 取 '4 3'（实线 4 + 空白 3）：与主图十段线「发光虚线」语义一致（SPEC §5.3），在 2D SVG 下呈清晰虚线，
 * 区别于省界实线。节拍以 viewBox user units 度量（SVG stroke-dasharray 的单位）。
 */
export const SOUTH_CHINA_SEA_INSET_LINE_DASH = '4 3'

/** 岛礁光点基线色（更亮暖琥珀 #ffe0a0，与主图 POLITICAL_POINT_COLOR_HEX 同色）。 */
export const SOUTH_CHINA_SEA_INSET_POINT_FILL_HEX = '#ffe0a0'

/** 岛礁光点半径（user units）。取 2.2：在大屏 viewBox 下呈清晰光点、不过大遮盖名称。 */
export const SOUTH_CHINA_SEA_INSET_POINT_RADIUS = 2.2

/** 岛礁规范名称标注的文字颜色（浅冷白，与深色科技风背景对比可读）。 */
export const SOUTH_CHINA_SEA_INSET_LABEL_FILL_HEX = '#dfe7f2'

/** 岛礁规范名称标注的字号（user units）。取 6.5：大屏 viewBox 下中文清晰可读。 */
export const SOUTH_CHINA_SEA_INSET_LABEL_FONT_SIZE = 6.5

/**
 * 岛礁规范名称相对光点的横向偏移（user units）。
 *
 * 名称放在光点右侧（x = cx + pointRadius + 本值），避免覆盖光点；纵向上沿基线微抬（y = cy + fontSize/3）
 * 使文字与光点视觉居中对齐。
 */
export const SOUTH_CHINA_SEA_INSET_LABEL_OFFSET_X = 1.5

/** 附图边框描边色（半透明冷蓝，与 .china-map-overlay 控件边框同系）。 */
export const SOUTH_CHINA_SEA_INSET_FRAME_STROKE_HEX = '#3a5675'

/** 附图边框描边宽度（user units）。取 1：勾勒矩形构图，不过粗。 */
export const SOUTH_CHINA_SEA_INSET_FRAME_STROKE_WIDTH = 1

/**
 * 附图图名（SPEC §3.8「南海诸岛岛礁点、标注」、合规惯例）。
 *
 * 恒定「南海诸岛」：与「标准南海诸岛附图」的图名惯例一致，不映射任何业务数据（SPEC 非目标）。
 */
export const SOUTH_CHINA_SEA_INSET_CAPTION = '南海诸岛'

/**
 * 附图非审图免责声明（SPEC §8「注明非官方审图数据」、TASK-019 实现约束「不声称获得审图号」）。
 *
 * 如实声明「非官方审图数据，仅供内部展示」——与政治边界补充事实源的 disclaimer（public/geo/
 * china-political-boundary.provenance.json）一致，不填审图号、不以任何视觉手段宣称已审图。
 * 正式发布由 TASK-021 的合规状态与外部审图流程约束。
 */
export const SOUTH_CHINA_SEA_INSET_DISCLAIMER = '非官方审图数据，仅供内部展示'

/** 附图全部参数（冻结）。领域准备层、渲染层、自动化测试共享同一份事实源，不存在第二套附图常量。 */
export const SOUTH_CHINA_SEA_INSET_CONFIG = Object.freeze({
  /** 附图 2D 子范围四至（EPSG:4326 度）。 */
  extent: SOUTH_CHINA_SEA_INSET_EXTENT,
  /** SVG viewBox 宽度（user units）。 */
  viewboxWidth: SOUTH_CHINA_SEA_INSET_VIEWBOX_WIDTH,
  /** SVG viewBox 高度（user units，按墨卡托比例派生）。 */
  viewboxHeight: SOUTH_CHINA_SEA_INSET_VIEWBOX_HEIGHT,
  /** 十段线基线色（暖琥珀，十六进制）。 */
  lineColorHex: SOUTH_CHINA_SEA_INSET_LINE_COLOR_HEX,
  /** 十段线屏幕线宽（user units）。 */
  lineStrokeWidth: SOUTH_CHINA_SEA_INSET_LINE_STROKE_WIDTH,
  /** 十段线虚线节拍（SVG stroke-dasharray）。 */
  lineDash: SOUTH_CHINA_SEA_INSET_LINE_DASH,
  /** 岛礁光点基线色（更亮暖琥珀，十六进制）。 */
  pointFillHex: SOUTH_CHINA_SEA_INSET_POINT_FILL_HEX,
  /** 岛礁光点半径（user units）。 */
  pointRadius: SOUTH_CHINA_SEA_INSET_POINT_RADIUS,
  /** 岛礁规范名称标注文字色（十六进制）。 */
  labelFillHex: SOUTH_CHINA_SEA_INSET_LABEL_FILL_HEX,
  /** 岛礁规范名称标注字号（user units）。 */
  labelFontSize: SOUTH_CHINA_SEA_INSET_LABEL_FONT_SIZE,
  /** 岛礁规范名称相对光点的横向偏移（user units）。 */
  labelOffsetX: SOUTH_CHINA_SEA_INSET_LABEL_OFFSET_X,
  /** 附图边框描边色（十六进制）。 */
  frameStrokeHex: SOUTH_CHINA_SEA_INSET_FRAME_STROKE_HEX,
  /** 附图边框描边宽度（user units）。 */
  frameStrokeWidth: SOUTH_CHINA_SEA_INSET_FRAME_STROKE_WIDTH,
  /** 附图图名。 */
  caption: SOUTH_CHINA_SEA_INSET_CAPTION,
  /** 附图非审图免责声明。 */
  disclaimer: SOUTH_CHINA_SEA_INSET_DISCLAIMER,
})
