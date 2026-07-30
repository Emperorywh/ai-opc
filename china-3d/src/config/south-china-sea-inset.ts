/**
 * 南海诸岛 2D 标准附图的配置——唯一事实源（TASK-012，SPEC §3.8 / §5.4 / §6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「附图 2D 子范围四至（InsetExtent）+ SVG viewBox 派生高度
 *   + 渲染样式（线色 / 线宽 / 虚线节拍 / 点径 / 字号 / 标注间隔 / 边框描边）」的唯一权威。
 *   附图领域准备层（src/lib/south-china-sea-inset 的纯函数）、渲染层（src/components/SouthChinaSeaInset
 *   经组件读取样式）、自动化测试都只能通过本模块取得这些参数——禁止在准备函数 / 组件 / 测试里各自复制
 *   一份四至、viewBox 高度、线宽或锚定阈值。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（InsetExtent 类型——附图子范围四至的契约形态；
 *   projectToMercator——派生 viewBox 高度时复用同一墨卡托，使附图视觉比例与投影一致，不写死像素）、
 *   同层 src/config/political-features（POLITICAL_LINE_COLOR_HEX / POLITICAL_POINT_COLOR_HEX——附图与
 *   主图十段线 / 岛礁点位同属「政治边界补充要素」族，基线色同一事实源，主图改色附图自动跟随，不复制
 *   第二份色值）。不依赖 React / R3F / Three.js / DOM，故自动化测试可在 Node 环境直接断言「四至自洽、
 *   包含全部十段线与岛礁」「viewBox 高度按墨卡托比例派生」「样式参数有限、非负、冻结」等不变量。
 *
 * 附图 2D 子范围四至（SPEC §3.3 / §3.8 / §5.4）：
 * - 附图是独立于 3D 主世界的 2D overlay（SVG，SPEC §3.8「DOM overlay，非 3D」）。其视口沿用标准地图
 *   阅读方向（u 随经度向东、v 随纬度向北）。四至取 [104°E, 0°N, 126°E, 27°N]：
 *     · 西 104°E：含中南半岛边缘，与「标准南海诸岛附图」矩形构图惯例一致；
 *     · 东 126°E：容赤尾屿（≈124.55°E）与台湾东侧段，附图范围内完整容纳钓鱼岛 / 赤尾屿等附属岛屿；
 *     · 南 0°N：到赤道，容曾母暗沙（≈3.58°N，中国领土最南标志）并留出读图余量；
 *     · 北 27°N：过赤尾屿纬度（≈25.92°N），含台湾南侧与十段线北端。
 *   该四至完整容纳 SPEC §6 红线点名的全部十段线段与岛礁点位（含台湾东侧段、钓鱼岛 / 赤尾屿 / 曾母暗沙），
 *   且呈「标准南海诸岛附图」的纵向矩形构图（生产资产全部十段线顶点与岛礁点位落在 lon 110–124.55°E、
 *   lat 3.58–25.92°N，均在四至内，由配置不变量测试锁定）。坐标变换不走本配置——附图领域准备层调
 *   projectToInset（src/lib/projection，TASK-002 同一墨卡托投影的唯一入口）把经纬度映射到该四至的
 *   归一化视口 (u,v)，与主图共享同一墨卡托结果、仅视口映射不同（SPEC §3.8「坐标用同一 geoMercator
 *   投影的 2D 子范围」）。本配置只决定「四至是多少」，不复制投影公式、不内置坐标。
 *
 * viewBox 高度按墨卡托比例派生（避免附图被拉伸变形）：
 * - projectToInset 把 (lon,lat) 归一化到 (u,v)∈[0,1]²，归一化消去了墨卡托的横向 / 纵向米制尺度差。若
 *   SVG viewBox 直接取正方形，附图会被等比拉伸——南北距离（墨卡托纵向）与东西距离（墨卡托横向）比例
 *   失真。故本配置按四至的墨卡托宽 / 高比派生 viewBox 高度（高度 = viewBox 宽度 / 墨卡托宽高比），
 *   使附图视觉比例与投影一致，构图可信。墨卡托宽高比由 projectToMercator 投影四至西南 / 东北角得到
 *   （与主图、附图坐标同一投影），不写死像素、不引入第二套比例公式。
 *
 * 标注摆放（「标注齐全」的两层含义：名称都在 + 全部可读）：
 * - 岛礁规范名称的摆放决策（右 / 左 / 上 / 下锚定）由领域准备层（src/lib/south-china-sea-inset）按
 *   确定性贪心算法裁决：固定候选序 [右 → 左 → 上 → 下] 取第一个「完整落在边框内且不与已摆放标注盒
 *   相交」的候选。本配置只提供裁决所需的度量参数（viewBox 宽高、字号、点径、间隔、边框内边距），
 *   由渲染层装配处取出传入准备函数——钓鱼岛 / 赤尾屿这类同纬度相邻的贴东缘点位由此得到「左锚 +
 *   上方居中」的可读摆放，而非越框裁剪或互叠（详见领域层模块头注释）。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13）：
 * - 附图与主图复用同一份政治边界补充事实源（public/geo/china-political-boundary.json，
 *   isOfficialSurvey=false）。页面级免责声明与审图号占位属合规角标职责（SPEC §8，后续外围 UI 任务），
 *   本配置不承载、不以任何视觉手段宣称已审图；附图图名唯一来自静态文案事实源 src/lib/static-copy
 *   （SOUTH_CHINA_SEA_INSET_TITLE，渲染层直接引用，本配置不复制第二份）。
 */

import type { InsetExtent } from '../lib/projection'
import { projectToMercator } from '../lib/projection'
import { POLITICAL_LINE_COLOR_HEX, POLITICAL_POINT_COLOR_HEX } from './political-features'

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
 * 取 220：与右下角角标尺寸匹配，岛礁光点 / 规范名称在大屏下清晰可读（SPEC §3.8）。
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

/**
 * 十段线基线色（暖琥珀，与主图十段线 POLITICAL_LINE_COLOR_HEX 同一事实源——附图与主图同属
 * 「政治边界补充要素」族，主图改色附图自动跟随，不存在第二份色值）。
 */
export const SOUTH_CHINA_SEA_INSET_LINE_COLOR_HEX = POLITICAL_LINE_COLOR_HEX

/** 十段线屏幕线宽（user units）。取 1.4：在大屏 viewBox 下清晰可辨、不糊。 */
export const SOUTH_CHINA_SEA_INSET_LINE_STROKE_WIDTH = 1.4

/**
 * 十段线虚线节拍（SVG stroke-dasharray，user units）。
 *
 * 取 '4 3'（实线 4 + 空白 3）：与主图十段线「发光虚线」语义一致（SPEC §5.3），在 2D SVG 下呈清晰虚线，
 * 区别于省界实线。节拍以 viewBox user units 度量（SVG stroke-dasharray 的单位）。
 */
export const SOUTH_CHINA_SEA_INSET_LINE_DASH = '4 3'

/** 岛礁光点基线色（更亮暖琥珀，与主图岛礁点位 POLITICAL_POINT_COLOR_HEX 同一事实源）。 */
export const SOUTH_CHINA_SEA_INSET_POINT_FILL_HEX = POLITICAL_POINT_COLOR_HEX

/** 岛礁光点半径（user units）。取 2.2：在大屏 viewBox 下呈清晰光点、不过大遮盖名称。 */
export const SOUTH_CHINA_SEA_INSET_POINT_RADIUS = 2.2

/** 岛礁规范名称标注的文字颜色（浅冷白，与深色科技风背景对比可读）。 */
export const SOUTH_CHINA_SEA_INSET_LABEL_FILL_HEX = '#dfe7f2'

/** 岛礁规范名称标注的字号（user units）。取 7.5：附图面板 CSS 宽度下中文清晰可读。 */
export const SOUTH_CHINA_SEA_INSET_LABEL_FONT_SIZE = 7.5

/**
 * 岛礁规范名称相对光点的间隔（user units）。
 *
 * 右锚（text-anchor=start）时 x = cx + pointRadius + 本值；左锚（end）时 x = cx − pointRadius − 本值；
 * 上 / 下锚（middle）时基线距光点中心的纵向间隔含本值。准备层的摆放裁决与渲染层的最终坐标都消费
 * 本值（同一事实源）。
 */
export const SOUTH_CHINA_SEA_INSET_LABEL_OFFSET_X = 1.5

/** 附图边框描边色（半透明冷蓝，与深色科技风面板描边同系）。 */
export const SOUTH_CHINA_SEA_INSET_FRAME_STROKE_HEX = '#3a5675'

/** 附图边框描边宽度（user units）。取 1：勾勒矩形构图，不过粗。 */
export const SOUTH_CHINA_SEA_INSET_FRAME_STROKE_WIDTH = 1

/** 附图全部参数（冻结）。领域准备层、渲染层、自动化测试共享同一份事实源，不存在第二套附图常量。 */
export const SOUTH_CHINA_SEA_INSET_CONFIG = Object.freeze({
  /** 附图 2D 子范围四至（EPSG:4326 度）。 */
  extent: SOUTH_CHINA_SEA_INSET_EXTENT,
  /** SVG viewBox 宽度（user units）。 */
  viewboxWidth: SOUTH_CHINA_SEA_INSET_VIEWBOX_WIDTH,
  /** SVG viewBox 高度（user units，按墨卡托比例派生）。 */
  viewboxHeight: SOUTH_CHINA_SEA_INSET_VIEWBOX_HEIGHT,
  /** 十段线基线色（暖琥珀，与主图十段线同一事实源，十六进制）。 */
  lineColorHex: SOUTH_CHINA_SEA_INSET_LINE_COLOR_HEX,
  /** 十段线屏幕线宽（user units）。 */
  lineStrokeWidth: SOUTH_CHINA_SEA_INSET_LINE_STROKE_WIDTH,
  /** 十段线虚线节拍（SVG stroke-dasharray）。 */
  lineDash: SOUTH_CHINA_SEA_INSET_LINE_DASH,
  /** 岛礁光点基线色（更亮暖琥珀，与主图岛礁点位同一事实源，十六进制）。 */
  pointFillHex: SOUTH_CHINA_SEA_INSET_POINT_FILL_HEX,
  /** 岛礁光点半径（user units）。 */
  pointRadius: SOUTH_CHINA_SEA_INSET_POINT_RADIUS,
  /** 岛礁规范名称标注文字色（十六进制）。 */
  labelFillHex: SOUTH_CHINA_SEA_INSET_LABEL_FILL_HEX,
  /** 岛礁规范名称标注字号（user units）。 */
  labelFontSize: SOUTH_CHINA_SEA_INSET_LABEL_FONT_SIZE,
  /** 岛礁规范名称相对光点的间隔（user units）。 */
  labelOffsetX: SOUTH_CHINA_SEA_INSET_LABEL_OFFSET_X,
  /** 附图边框描边色（十六进制）。 */
  frameStrokeHex: SOUTH_CHINA_SEA_INSET_FRAME_STROKE_HEX,
  /** 附图边框描边宽度（user units，兼作标注摆放的边框内边距）。 */
  frameStrokeWidth: SOUTH_CHINA_SEA_INSET_FRAME_STROKE_WIDTH,
})
