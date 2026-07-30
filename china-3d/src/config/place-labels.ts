/**
 * 省名 Billboard 标签与省会光点的视觉与几何配置——唯一事实源（TASK-010，SPEC §3.7）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「省名标签浮高 / 字号 / 基线色、省会光点半径 /
 *   基线色 / 可选光柱高度、省会名小字浮高 / 字号 / 基线色、贴地 epsilon、离线字体子集与清单
 *   的 URL」的**唯一**权威。标签准备层（src/lib/place-labels 的纯函数）、渲染层
 *   （src/three/PlaceLabels 经组件注入材质参数）、字体清单运行时加载（App 装配层经
 *   src/lib/label-font 的 loadLabelFontManifest）、自动化测试都只能通过本模块取得这些参数——
 *   禁止在准备函数 / 组件 / 测试里各自复制一份浮高、字号或字体 URL（TASK-010 实现约束
 *   「不得在组件内补写坐标或样式常量」「字体子集必须离线加载，不得依赖系统字体 / 在线字体」）。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS——主图世界米制
 *   包围盒的唯一源，用来把浮高、光点半径、字号表达成主图尺度的分数）。不依赖 React / R3F /
 *   Three.js / DOM，故自动化测试可在 Node 环境直接断言「浮高为正、派生自主图宽度」「字体 URL
 *   指向本地路径（无在线请求）」「基线色与省界可区分」等不变量。
 *
 * 锚点职责边界（SPEC §3.7「默认固定于省几何中心/省会坐标，不做实时碰撞推开；京津沪港澳密集区
 * 接受默认布局」）：
 * - 本配置只决定「标签浮多高、光点多大、文字什么色 / 字号」——不承载也不校正省名锚点与省会
 *   的经纬度。坐标唯一事实源是地点目录契约（public/geo/china-places.json，TASK-004），其中
 *   狭长 / 多岛省份的人工校正锚点已附 anchorAdjustmentNote 并经 point-in-polygon 验证。本配置
 *   与渲染层都不得复制、手改或在组件内补写坐标。
 * - 固定锚点 + 固定浮高：标签不随相机 / 其他标签移动，不实现实时碰撞推开。遮挡透明度
 *   （src/config/label-occlusion）与 hover 放大置顶（src/config/province-hover 的三常量）
 *   各有唯一事实源，本模块不复制。
 *
 * 字体子集离线加载（SPEC §3.7「裁剪字体子集仅含 34 省名 + 省会名 + 附图所需汉字…troika 加载
 * 该子集 .ttf/.woff；不打包完整思源黑体」）：
 * - fontPath / fontManifestPath 指向 public/fonts 下的本地静态资产（Vite 以根相对路径
 *   /fonts/... 提供），由 TASK-005 字体子集生产管线确定性生成并带清单（字符集合 + 完整性
 *   哈希）。本配置不引用任何 https:// CDN 字体（避免 troika 默认的在线字体请求），运行时只
 *   从同源 /fonts/ 取字体与清单——离线可用、断网仍完整。渲染前由 App 装配层做覆盖校验
 *   （清单字符集合 ⊇ 实际渲染字符串的字符集合），缺字即显式失败，不静默显示空白 / fallback
 *   网络字体。
 *
 * 与省界的视觉分工（SPEC §3.6 / §3.7）：
 * - 省名标签：浅青白偏亮（#cff5ec，与省界 #9fe8d8 同色系但更亮，从地形分层设色中跳出可读），
 *   Billboard 始终面向相机。
 * - 省会光点：暖琥珀（#ffd180，与省界冷色相对），球体 + additive 发光，标记省级行政中心位置。
 * - 省会名小字：同暖色系更亮一档（#ffe0a0），仅 hover 该省时以小字呈现于光点上方（SPEC §3.7
 *   「省会名以 tooltip / 小字呈现」的落点：默认仅省名 + 光点，hover 时省会名小字），字号小于
 *   省名，形成「省名 > 省会名」的读图层次，不与省名争夺视觉焦点。
 *
 * 非官方审图限制（SPEC §6 / §8）：本配置只决定「如何画文字 / 光点」，不承载也不校验坐标；
 * 标签呈现属于「内部展示状态」，公开发布前必须取得自然资源主管部门审图号。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * 主图世界宽度（米），用于派生标签浮高、光点半径、字号（全部表达成主图尺度的分数，不写死绝对
 * 米数）。与省界 / 相机约束配置同源（MAIN_MAP_WORLD_BOUNDS），保证标签尺度与地形 / 省界在同一
 * 地图尺度下协调。
 */
const MAIN_MAP_WORLD_WIDTH_METERS = MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX

/**
 * 省名 Billboard 标签浮于地形之上的世界 y 偏移（米）。
 *
 * world_y = h·k + 本值。派生自主图世界宽度（唯一源）：宽度 / 120 ≈ 59 km。在 k=2 下足以让省名
 * 标签浮在所在省的地形（含青藏高原 ~5000m 真实 → ~10000m 世界 y）之上、可读，又不过高漂浮
 * （浮高占主图宽度 < 1%，视觉上标签贴近所在省）。
 */
export const PLACE_LABEL_PROVINCE_HEIGHT_OFFSET_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 120

/**
 * 省会名小字标签浮于省会光点之上的世界 y 偏移（米）。
 *
 * world_y = h·k + epsilon + 本值。派生自主图世界宽度：宽度 / 200 ≈ 35 km。仅 hover 呈现的小字
 * 浮于光点正上方、低于省名标签（省名浮高 ≈59 km），形成清晰的读图层次。
 */
export const PLACE_LABEL_CAPITAL_HEIGHT_OFFSET_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 200

/**
 * 贴地 epsilon（米，世界 y 偏移）。
 *
 * 省会光点 world_y = h·k + 本值（贴合地形表面外侧）。与省界贴地 epsilon 同值（15 m，见
 * src/config/province-borders）：补偿 CPU/GPU 高程采样的亚米级浮点差异，把光点放到地表外侧。
 * z-fighting 的主防线是 depthTest（光点被前方山体正确遮挡、在地表之上可见），epsilon 是辅助。
 */
export const PLACE_LABEL_TERRAIN_EPSILON_METERS = 15

/**
 * 省名标签的 troika 字号（世界空间米）。
 *
 * 派生自主图世界宽度：宽度 / 220 ≈ 32 km。地图尺度下 2–4 字省名呈清晰可读的标签，又不过大
 * 遮盖省份。
 */
export const PLACE_LABEL_PROVINCE_FONT_SIZE_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 220

/**
 * 省会名小字标签的 troika 字号（世界空间米）。
 *
 * 派生自主图世界宽度：宽度 / 350 ≈ 20 km。小于省名字号（≈32 km），使 hover 呈现的省会名
 * （2–3 字）呈次要标注层次，不与省名争夺视觉焦点。
 */
export const PLACE_LABEL_CAPITAL_FONT_SIZE_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 350

/**
 * 省会光点球体的米制半径（世界空间）。
 *
 * 派生自主图世界宽度：宽度 / 512 ≈ 13.9 km。地图尺度下呈清晰可见的光点，又不至于糊盖省会
 * 周边地形。
 */
export const PLACE_LABEL_CAPITAL_POINT_RADIUS_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 512

/**
 * 省名标签基线色（SPEC §3.7「Billboard 文本」，十六进制）。
 *
 * 取 #cff5ec（r=207、g=245、b=236）：浅青白偏亮，与省界 #9fe8d8 同色系但更亮，使省名标签
 * 从地形分层设色中跳出可读，又不与暖色的省会光点（#ffd180）混淆。恒定基线，不随省 / 高程
 * 变化——纯地理展示，不映射业务数据（SPEC 非目标）。
 */
export const PLACE_LABEL_PROVINCE_COLOR_HEX = '#cff5ec'

/**
 * 省会光点基线色（SPEC §3.7「省会城市光点」，十六进制）。
 *
 * 取 #ffd180（r=255、g=209、b=128）：暖琥珀，与省界 / 省名标签（浅青白冷色）冷暖相对，
 * 色相分明，标记省级行政中心位置。
 */
export const PLACE_LABEL_CAPITAL_POINT_COLOR_HEX = '#ffd180'

/**
 * 省会名小字标签基线色（SPEC §3.7「省会名以小字呈现」，十六进制）。
 *
 * 取 #ffe0a0（r=255、g=224、b=160）：与省会光点同色系的更亮一档，hover 呈现时与光点在
 * 视觉上归为同一「省会标注」族（小字浮于光点正上方，同色暗示关联）。
 */
export const PLACE_LABEL_CAPITAL_COLOR_HEX = '#ffe0a0'

/**
 * 省会光点可选细光柱的世界 y 高度（米）。0 表示不画光柱（仅球体光点）。
 *
 * SPEC §3.7「可叠一束细光柱」。当前取 0：默认画面保证「省名 + 省会光点」即可，光柱为可选
 * 增强，默认关闭以保持画面简洁、减少 draw call。留作配置项，后续若需增强省会标识可上调为
 * 正数启用。
 */
export const PLACE_LABEL_CAPITAL_BEAM_HEIGHT_METERS = 0

/** 离线字体子集的运行时 URL（Vite 根相对路径，指向 public/fonts 下的静态资产，TrueType .ttf）。 */
export const PLACE_LABEL_FONT_PATH = '/fonts/china-labels-font.subset.ttf'

/** 离线字体清单的运行时 URL（记录字体实际包含的字符集合 + 来源字符串 + 完整性哈希）。 */
export const PLACE_LABEL_FONT_MANIFEST_PATH = '/fonts/china-labels-font.manifest.json'

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
interface PlaceLabelsRgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 RGB（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): PlaceLabelsRgbColor {
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

/** 省名标签基线色的字节 RGB（= parseHex(PLACE_LABEL_PROVINCE_COLOR_HEX)，冻结）。 */
export const PLACE_LABEL_PROVINCE_RGB: Readonly<PlaceLabelsRgbColor> = Object.freeze(
  parseHex(PLACE_LABEL_PROVINCE_COLOR_HEX),
)

/** 省会光点基线色的字节 RGB（= parseHex(PLACE_LABEL_CAPITAL_POINT_COLOR_HEX)，冻结）。 */
export const PLACE_LABEL_CAPITAL_POINT_RGB: Readonly<PlaceLabelsRgbColor> = Object.freeze(
  parseHex(PLACE_LABEL_CAPITAL_POINT_COLOR_HEX),
)

/** 省会名小字标签基线色的字节 RGB（= parseHex(PLACE_LABEL_CAPITAL_COLOR_HEX)，冻结）。 */
export const PLACE_LABEL_CAPITAL_RGB: Readonly<PlaceLabelsRgbColor> = Object.freeze(
  parseHex(PLACE_LABEL_CAPITAL_COLOR_HEX),
)

/**
 * 省名标签 / 省会光点 / 省会名小字的全部参数（冻结）。
 *
 * 这是标签准备层（src/lib/place-labels 的纯函数）、渲染层（src/three/PlaceLabels）、字体清单
 * 运行时加载（App 装配层）与自动化测试共享的同一份事实源：浮高 / epsilon / 字号 / 光点半径 /
 * 基线色·字节 RGB / 字体与清单 URL 全部在此，不存在第二套标签常量。冻结防止运行时被偷偷改
 * （如把字体 URL 改成 CDN 会在断网时静默失败、把浮高改 0 会让标签穿地形），任何调整都必须改
 * 本模块并同步测试。
 */
export const PLACE_LABELS_CONFIG = Object.freeze({
  /** 省名标签浮于地形之上的世界 y 偏移（米）。 */
  provinceLabelHeightOffsetMeters: PLACE_LABEL_PROVINCE_HEIGHT_OFFSET_METERS,
  /** 省会名小字标签浮于省会光点之上的世界 y 偏移（米）。 */
  capitalLabelHeightOffsetMeters: PLACE_LABEL_CAPITAL_HEIGHT_OFFSET_METERS,
  /** 贴地 epsilon（米），省会光点 world_y = h·k + 本值。 */
  terrainEpsilonMeters: PLACE_LABEL_TERRAIN_EPSILON_METERS,
  /** 省名标签 troika 字号（世界空间米）。 */
  provinceLabelFontSizeMeters: PLACE_LABEL_PROVINCE_FONT_SIZE_METERS,
  /** 省会名小字标签 troika 字号（世界空间米）。 */
  capitalLabelFontSizeMeters: PLACE_LABEL_CAPITAL_FONT_SIZE_METERS,
  /** 省会光点球体米制半径（世界空间）。 */
  capitalPointRadiusMeters: PLACE_LABEL_CAPITAL_POINT_RADIUS_METERS,
  /** 省会光点可选细光柱高度（米，0 = 不画）。 */
  capitalBeamHeightMeters: PLACE_LABEL_CAPITAL_BEAM_HEIGHT_METERS,
  /** 省名标签基线色（浅青白偏亮，十六进制）。 */
  provinceLabelColorHex: PLACE_LABEL_PROVINCE_COLOR_HEX,
  /** 省名标签基线色的字节 RGB（每通道 0–255）。 */
  provinceLabelColorRgb: PLACE_LABEL_PROVINCE_RGB,
  /** 省会光点基线色（暖琥珀，十六进制）。 */
  capitalPointColorHex: PLACE_LABEL_CAPITAL_POINT_COLOR_HEX,
  /** 省会光点基线色的字节 RGB（每通道 0–255）。 */
  capitalPointColorRgb: PLACE_LABEL_CAPITAL_POINT_RGB,
  /** 省会名小字标签基线色（暖琥珀更亮一档，十六进制）。 */
  capitalLabelColorHex: PLACE_LABEL_CAPITAL_COLOR_HEX,
  /** 省会名小字标签基线色的字节 RGB（每通道 0–255）。 */
  capitalLabelColorRgb: PLACE_LABEL_CAPITAL_RGB,
  /** 离线字体子集的运行时 URL（本地 /fonts/ 路径，无在线请求）。 */
  fontPath: PLACE_LABEL_FONT_PATH,
  /** 离线字体清单的运行时 URL。 */
  fontManifestPath: PLACE_LABEL_FONT_MANIFEST_PATH,
})
