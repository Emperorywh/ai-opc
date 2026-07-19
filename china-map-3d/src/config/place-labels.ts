/**
 * 省名 / 省会光点 / 岛礁名称标注的视觉与几何配置——唯一事实源（TASK-016）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「省名 Billboard 标签浮高、省会光点尺寸与基线色、
 *   岛礁名称标签浮高与基线色、文本字号、离线字体子集与清单的 URL、贴地 epsilon、海平面 y」的
 *   **唯一**权威。主图标签准备层（src/lib/place-labels 的纯函数）、渲染层（src/three/PlaceLabels 经
 *   组件注入材质参数）、字体加载与覆盖校验层（src/lib/label-font）、自动化测试都只能通过本模块取得
 *   这些参数——禁止在准备函数 / 组件 / 测试里各自复制一份浮高、字号或字体 URL
 *   （TASK-016 实现约束「不得在组件内补写坐标或样式常量」「字体子集必须离线加载，不得依赖系统字体 /
 *   在线字体 / 完整思源字体包」）。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界米制包围盒的唯一源，
 *   用来把浮高、光点半径、字号表达成主图尺度的分数）、同层 src/config/sea-surface
 *   （SEA_LEVEL_Y_METERS —— 海平面世界 y 的唯一源，使岛礁名称标签的「海平面贴合 + 浮高」与动态海面 /
 *   十段线 / 岛礁点位共用同一米制海平面，不复制第二份 y=0）。不依赖 React / R3F / Three.js / DOM，故
 *   自动化测试可在 Node 环境直接断言「浮高为正、派生自主图宽度」「字体 URL 指向本地路径（无在线请求）」
 *   「基线色与省界 / 十段线可区分」等不变量（TASK-016 验证方式 1、3）。
 *
 * 锚点职责边界（TASK-016 实现约束「标签使用固定锚点，不实现实时碰撞推开；京津沪港澳等密集区域可使用
 * 数据层已有的可审计锚点校正」）：
 * - 本配置只决定「标签浮多高、光点多大、文字什么色 / 字号」——不承载也不校正省名锚点的经纬度。锚点
 *   唯一事实源是地点目录契约（public/geo/china-places.json，TASK-005），其中狭长 / 多岛省份的人工校正
 *   锚点已附 anchorAdjustmentNote 并经 point-in-polygon 验证。本配置与渲染层都不得复制、手改或在组件内
 *   补写锚点经纬度（TASK-016 实现约束）。
 * - 固定锚点 + 固定浮高：标签不随相机 / 其他标签移动，不实现实时碰撞推开（TASK-017 交付遮挡透明度、
 *   TASK-018 交付 hover 放大置顶，本 TASK 不复制其状态逻辑）。
 *
 * 字体子集离线加载（SPEC §3.7「裁剪字体子集仅含 34 省名 + 省会名 + 附图 / 岛礁所需汉字…troika 加载该
 * 子集 .ttf/.woff；不打包完整思源黑体」、TASK-016 实现约束「字体子集必须覆盖全部实际字符串并离线加载」、
 * 验证方式 3「无在线字体请求」）：
 * - fontPath / fontManifestPath 指向 public/fonts 下的本地静态资产（Vite 以根相对路径 /fonts/... 提供），
 *   由项目内字体子集生产脚本（scripts/fonts/build-font-subset）确定性生成。本配置不引用任何 https://
 *   CDN 字体（避免 troika 默认的在线 Roboto 请求），运行时只从同源 /fonts/ 取字体与清单——离线可用、
 *   断网仍完整（TASK-016 验证方式 5）。
 * - 字体清单（manifest）记录「字体实际包含的字符集合 + 来源字符串 + 完整性哈希」，供字体加载层做覆盖
 *   校验：渲染前断言清单字符集合 ⊇ 实际渲染字符串的字符集合，缺字即抛稳定错误码（不静默显示空白 /
 *   fallback 字体，TASK-016 输出约束「不因单个字符串缺字而静默显示空白或 fallback 网络字体」）。
 *
 * 与省界 / 十段线 / 岛礁点位的视觉分工（SPEC §3.6 / §3.7 / §5.3、TASK-016 输出约束「省名 + 省会光点 +
 * 岛礁名称全部呈现」）：
 * - 省名标签：浅青白（与省界同色系，#cff5ec，比省界 #9fe8d8 更亮以从地形中跳出），Billboard 始终面向相机。
 * - 省会光点：与十段线 / 岛礁点位同色系的暖琥珀（#ffd180，与省界冷色相对），球体 + additive 发光，
 *   标记省级行政中心位置。
 * - 岛礁名称标签：暖琥珀（与岛礁点位同色系，#ffe0a0），Billboard 文本，浮于岛礁点位之上。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-016 实现约束「本 TASK 不宣称取得审图号」）：
 * - 本配置只决定「如何画文字 / 光点」（色 / 字号 / 浮高 / 半径），不承载也不校验坐标——坐标唯一事实源是
 *   TASK-005 地点目录与 TASK-006 政治边界补充资产。本配置与渲染层的呈现属于「内部展示状态」，公开发布前
 *   必须取得自然资源主管部门审图号。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'
import { SEA_LEVEL_Y_METERS } from './sea-surface'

/**
 * 主图世界宽度（米），用于派生标签浮高、光点半径、字号（全部表达成主图尺度的分数，不写死绝对米数）。
 * 与省界 / 政治要素配置同源（MAIN_MAP_WORLD_BOUNDS），保证标签尺度与地形 / 省界 / 十段线在同一地图尺度下协调。
 */
const MAIN_MAP_WORLD_WIDTH_METERS = MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX

/**
 * 省名 Billboard 标签浮于地形之上的世界 y 偏移（米）。
 *
 * world_y = h·k + 本值。派生自主图世界宽度（唯一源）：宽度 / 120 ≈ 59 km。在 k=2 下对应约 30 km 真实
 * 高度偏移，足以让省名标签浮在所在省的地形（含青藏高原 ~5000m 真实 → ~10000m 世界 y）之上、可读，
 * 又不过高漂浮（地图宽度 ~7134 km，浮高占宽度 < 1%，视觉上标签贴近所在省）。
 */
export const PLACE_LABEL_PROVINCE_HEIGHT_OFFSET_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 120

/**
 * 岛礁名称 Billboard 标签浮于岛礁点位之上的世界 y 偏移（米）。
 *
 * world_y = max(h·k, seaLevel) + epsilon + 本值。派生自主图世界宽度：宽度 / 200 ≈ 35 km。岛礁点位多在
 * 海域（海平面贴合 y ≈ epsilon），标签浮于其上 ~35 km，在海面之上清晰可读，又与省名标签（更高）在
 * 视觉层次上区分（岛礁名称标签比省名标签低，符合「岛礁是次要标注」的读图层次）。
 */
export const PLACE_LABEL_ISLAND_HEIGHT_OFFSET_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 200

/**
 * 贴地 epsilon（米，世界 y 偏移）。
 *
 * 省会光点 world_y = h·k + 本值（贴合地形表面外侧）。与省界 / 政治要素同值（15 m）：补偿 CPU/GPU 高程
 * 采样的亚米级浮点差异，把光点放到地表外侧（上方）。z-fighting 的主防线是 depthTest（光点被前方山体
 * 遮挡、在地表之上可见），epsilon 是辅助。
 */
export const PLACE_LABEL_TERRAIN_EPSILON_METERS = 15

/**
 * 省名标签的 troika 字号（世界空间米）。
 *
 * 派生自主图世界宽度：宽度 / 220 ≈ 32 km。地图尺度下 2–4 字省名呈清晰可读的标签（占宽度约 0.9%–1.8%），
 * 又不过大遮盖省份。岛礁名称标签字号更小（见下），形成省名 > 岛礁名的读图层次。
 */
export const PLACE_LABEL_PROVINCE_FONT_SIZE_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 220

/**
 * 岛礁名称标签的 troika 字号（世界空间米）。
 *
 * 派生自主图世界宽度：宽度 / 350 ≈ 20 km。比省名字号小（32 km），使岛礁名称（钓鱼岛 / 赤尾屿 / 曾母暗沙
 * 等 3–4 字）呈次要标注层次，不与省名争夺视觉焦点。
 */
export const PLACE_LABEL_ISLAND_FONT_SIZE_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 350

/**
 * 省会光点球体的米制半径（世界空间）。
 *
 * 派生自主图世界宽度：宽度 / 512 ≈ 13.9 km（与岛礁点位 POLITICAL_POINT_RADIUS_METERS 同公式、同值），
 * 使省会光点与岛礁点位在视觉上归为同一「地点标记」尺度，地图尺度下呈清晰可见的光点。
 */
export const PLACE_LABEL_CAPITAL_POINT_RADIUS_METERS = MAIN_MAP_WORLD_WIDTH_METERS / 512

/**
 * 省名标签基线色（SPEC §3.7「Billboard 文本」、TASK-016 输出约束「省名 + 省会光点 + 岛礁名称全部呈现」，
 * 十六进制）。
 *
 * 取 #cff5ec（r=207、g=245、b=236）：浅青白偏亮，与省界 #9fe8d8 同色系但更亮，使省名标签从地形分层设色
 * 中跳出可读，又不与暖色的十段线 / 岛礁点位（#ffd180 / #ffe0a0）混淆。恒定基线，不随省 / 高程变化——
 * 纯地理展示，不映射业务数据（SPEC 非目标）。
 */
export const PLACE_LABEL_PROVINCE_COLOR_HEX = '#cff5ec'

/**
 * 省会光点基线色（SPEC §3.7「省会城市光点」、TASK-016 输出约束「省会光点位置正确」，十六进制）。
 *
 * 取 #ffd180（r=255、g=209、b=128）：暖琥珀，与十段线 POLITICAL_LINE_COLOR_HEX 同色同值，使省会光点
 * 与十段线在视觉上归为同一「暖色地点标记」族；又通过「球体光点 vs 虚线」的形态差异与十段线区分。
 * 与省界 / 省名标签（浅青白冷色）冷暖相对，色相分明。
 */
export const PLACE_LABEL_CAPITAL_POINT_COLOR_HEX = '#ffd180'

/**
 * 岛礁名称标签基线色（SPEC §3.7 / §6 岛礁名称、TASK-016 输出约束「岛礁名称全部稳定关联」，十六进制）。
 *
 * 取 #ffe0a0（r=255、g=224、b=160）：与岛礁点位 POLITICAL_POINT_COLOR_HEX 同色同值，使岛礁名称标签与
 * 岛礁点位光点在视觉上归为同一「岛礁标注」族（名称浮于光点正上方，同色暗示关联）。
 */
export const PLACE_LABEL_ISLAND_COLOR_HEX = '#ffe0a0'

/**
 * 省会光点可选细光柱的世界 y 高度（米）。0 表示不画光柱（仅球体光点）。
 *
 * SPEC §3.7「可选细光柱」。当前取 0（默认画面保证「省名 + 省会光点」即可，光柱为可选增强，本 TASK
 * 默认关闭以保持画面简洁、减少 draw call）。留作配置项，后续若需增强省会标识可上调为正数启用。
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

/** 岛礁名称标签基线色的字节 RGB（= parseHex(PLACE_LABEL_ISLAND_COLOR_HEX)，冻结）。 */
export const PLACE_LABEL_ISLAND_RGB: Readonly<PlaceLabelsRgbColor> = Object.freeze(
  parseHex(PLACE_LABEL_ISLAND_COLOR_HEX),
)

/**
 * 省名 / 省会光点 / 岛礁名称标注的全部参数（冻结）。
 *
 * 这是标签准备层（src/lib/place-labels 的纯函数）、渲染层（src/three/PlaceLabels）、字体加载层
 * （src/lib/label-font）与自动化测试共享的同一份事实源：浮高 / epsilon / 海平面 y / 字号 / 光点半径 /
 * 基线色·字节 RGB / 字体与清单 URL 全部在此，不存在第二套标签常量。冻结防止运行时被偷偷改
 * （如把字体 URL 改成 CDN 会在断网时静默失败、把浮高改 0 会让标签穿地形），任何调整都必须改本模块并同步测试。
 */
export const PLACE_LABELS_CONFIG = Object.freeze({
  /** 省名标签浮于地形之上的世界 y 偏移（米）。 */
  provinceLabelHeightOffsetMeters: PLACE_LABEL_PROVINCE_HEIGHT_OFFSET_METERS,
  /** 岛礁名称标签浮于岛礁点位之上的世界 y 偏移（米）。 */
  islandLabelHeightOffsetMeters: PLACE_LABEL_ISLAND_HEIGHT_OFFSET_METERS,
  /** 贴地 epsilon（米），省会光点 world_y = h·k + 本值。 */
  terrainEpsilonMeters: PLACE_LABEL_TERRAIN_EPSILON_METERS,
  /** 海平面世界 y（米）= 0，与动态海面同一米制海平面（SEA_LEVEL_Y_METERS）。 */
  seaLevelYMeters: SEA_LEVEL_Y_METERS,
  /** 省名标签 troika 字号（世界空间米）。 */
  provinceLabelFontSizeMeters: PLACE_LABEL_PROVINCE_FONT_SIZE_METERS,
  /** 岛礁名称标签 troika 字号（世界空间米）。 */
  islandLabelFontSizeMeters: PLACE_LABEL_ISLAND_FONT_SIZE_METERS,
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
  /** 岛礁名称标签基线色（暖琥珀，十六进制）。 */
  islandLabelColorHex: PLACE_LABEL_ISLAND_COLOR_HEX,
  /** 岛礁名称标签基线色的字节 RGB（每通道 0–255）。 */
  islandLabelColorRgb: PLACE_LABEL_ISLAND_RGB,
  /** 离线字体子集的运行时 URL（本地 /fonts/ 路径，无在线请求）。 */
  fontPath: PLACE_LABEL_FONT_PATH,
  /** 离线字体清单的运行时 URL。 */
  fontManifestPath: PLACE_LABEL_FONT_MANIFEST_PATH,
})
