/**
 * 省级贴地边界的视觉与几何配置——唯一事实源（TASK-009，SPEC §3.6）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「省界 densify 间距、贴地 epsilon、NDC 深度偏移、
 *   基线色、屏幕线宽」的**唯一**权威。省界准备层（src/lib/province-borders 的纯函数）、省界渲染层
 *   （src/three/ProvinceBorders 经组件注入材质参数）、自动化测试都只能通过本模块取得这些参数——
 *   禁止在准备函数 / 组件 / 测试里各自复制一份间距或 epsilon。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS——主图世界米制包围盒
 *   的唯一源），用来把 densify 间距表达成「主图世界宽度 / heightmap 纹素数」，使间距随地形纹理
 *   分辨率自动伸缩而非写死一个绝对米数。不依赖 React / R3F / Three.js / DOM，故自动化测试可在
 *   Node 环境直接断言「间距 ≈ 主图宽度 / 4096」「epsilon 为正且有限」「基线色为浅青白」等不变量。
 *
 * densify 间距（SPEC §3.6「沿弧长 densify，重采样间距接近 heightmap 分辨率，如每 1–2 km 或约
 * plane 宽 / 4096 一个点」）：
 * - 取主图世界宽度 / HEIGHTMAP_TEXEL_COUNT_4096：主图经度跨度 72°E–136°E 在墨卡托下约 7.13e6 m，
 *   除以 4096 纹素 ≈ 1742 m/纹素，落在 SPEC 的 1–2 km 区间。该间距与 heightmap 纹理分辨率一一
 *   对应——每个 densify 子段约一个纹素宽，使贴地采样既不漏掉纹理级起伏（不会因过稀而跨山脊穿山
 *   或悬空），也不过密（不徒增顶点却不增加视觉信息）。
 * - 间距以「世界米制弧长」度量（在投影后的世界 XZ 平面上均分），而非经纬度度数：墨卡托在高纬
 *   放大，同样的经纬度跨度在北方对应更长的世界弧长，按世界米制度量才能保证全境 densify 密度一致。
 *
 * 贴地 epsilon（SPEC §3.6「+ epsilon 避免 z-fighting」）：
 * - 一个小的正世界 y 偏移（米），与「真实海拔 h × 夸张系数 k」相加：world_y = h·k + epsilon。
 * - epsilon 的语义：把省界顶点放到地形表面的「外侧」（上方），补偿 CPU 双线性高程查询
 *   （src/lib/elevation 的米制双线性）与 GPU 顶点位移（归一化纹理硬件双线性 + 着色器线性解码）
 *   之间亚米级的浮点差异，使省界恒位于地表之上而非偶尔陷入地表之下。它**不是** z-fighting 的
 *   唯一防线——z-fighting 由渲染层的 NDC 深度偏移（depthBiasNdc）结构性消除（epsilon 在米级
 *   远不足以跨越地图尺度下的一个深度桶，深度偏移是主防线，epsilon 是浮点对齐的辅助防线）。
 *
 * NDC 深度偏移（与海面共存时的 z-fighting 边界，SPEC §3.5/§3.6）：
 * - 一个小的 NDC（归一化设备坐标）深度减量，在渲染层的 LineMaterial 顶点着色器里从 gl_Position.z
 *   减去（× clip.w 还原到裁剪空间）。它使省界片元在深度测试中恒胜过「同一位置的地表」，而仍被
 *   「真正更近的山体」（NDC z 差远大于偏移）正确遮挡——这是大屏地图尺度下（相机远、24 位深度
 *   量化粗，单靠世界 epsilon 无法跨越一个深度桶）结构性消除省界-地表 z-fighting 的关键。
 * - 取 1e-5 NDC：约 80 个 24 位深度 ULP，足以稳定胜过同位置地表，又远小于任何前方山体与省界的
 *   NDC 差，故不会让省界错误地穿透前方地形。
 *
 * 基线色与线宽（SPEC §3.6「浅青白 #9fe8d8 左右，additive 轻发光」「可设线宽」）：
 * - 基线色 #9fe8d8（r=159、g=232、b=216）：青绿占优、明度高，深色科技风背景下呈浅青白发光。
 *   颜色是恒定基线，不随省份 / 高程变化——省界是纯地理展示，不映射任何业务数据（SPEC 非目标）。
 *   hover 加亮加粗 / 压暗的派生色由 src/config/province-hover 定义（同一 SPEC §4.2 交互规格）。
 * - 线宽取屏幕空间 1.6 px（LineMaterial linewidth）：细而清晰，不喧宾夺主。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'

/**
 * heightmap 纹素数（每边），用于派生 densify 间距。
 *
 * 与生产资产 china-heightmap-4096 的分辨率一致（terrain-meta 的 widthPixels）。间距 = 主图世界
 * 宽度 / 本值，使 densify 密度与地形纹理分辨率一一对应（SPEC §3.6「约 plane 宽 / 4096 一个点」）。
 */
export const PROVINCE_BORDER_HEIGHTMAP_TEXEL_COUNT = 4096

/**
 * densify 间距（米，世界弧长度量）= 主图世界宽度 / 4096。
 *
 * 主图经度 72°E–136°E 在墨卡托下约 7.13e6 m，除以 4096 ≈ 1742 m，落在 SPEC §3.6 的 1–2 km
 * 区间。沿世界 XZ 平面弧长度量，使全境 densify 密度一致（不受墨卡托高纬放大影响）。派生自
 * 主图世界包围盒（唯一源）并冻结，不写死绝对米数。
 */
export const PROVINCE_BORDER_DENSIFY_SPACING_METERS =
  (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / PROVINCE_BORDER_HEIGHTMAP_TEXEL_COUNT

/**
 * densify 间距的下限（含，米）：防止退化几何（极短边）或异常配置产生零间距导致无限细分。
 *
 * 正常 densify 间距（≈1742 m）远大于该下限；该下限仅作防御性兜底，使 prepareProvinceBorders
 * 在收到畸形 spacing（0 / 负 / 极小）时显式失败而非死循环。
 */
export const PROVINCE_BORDER_DENSIFY_SPACING_MIN_METERS = 1

/**
 * 贴地 epsilon（米，世界 y 偏移）。
 *
 * world_y = 真实海拔 h · 夸张系数 k + 本值。可解释的小正偏移：把省界放到地表外侧（上方），
 * 补偿 CPU/GPU 高程采样的亚米级浮点差异。z-fighting 的主防线是 NDC 深度偏移（见下），epsilon
 * 是辅助。取 15 m：在 k=2 下对应 7.5 m 真实高程偏移，地图尺度下视觉不可辨，又足以恒位于地表之上。
 */
export const PROVINCE_BORDER_TERRAIN_EPSILON_METERS = 15

/**
 * 省界片元的 NDC 深度偏移（无量纲，约 1e-5）。
 *
 * 在 LineMaterial 顶点着色器内从 gl_Position.z 减去（× gl_Position.w 还原裁剪空间）。使省界在
 * 深度测试中恒胜过同位置地表（结构性消除 z-fighting），仍被前方山体正确遮挡。约 80 个 24 位
 * 深度 ULP，足够稳定胜过同位置地表，又远小于前方山体的 NDC 差，不致穿透前方地形。
 */
export const PROVINCE_BORDER_DEPTH_BIAS_NDC = 1e-5

/**
 * 省界基线色（SPEC §3.6 浅青白，十六进制）。
 *
 * #9fe8d8（r=159、g=232、b=216）：青绿占优、明度高，深色背景下呈浅青白发光。恒定基线，不随
 * 省份 / 高程变化（纯地理展示，不映射业务数据，SPEC 非目标）。hover 派生色见 config/province-hover。
 */
export const PROVINCE_BORDER_COLOR_HEX = '#9fe8d8'

/** 省界屏幕线宽（px，LineMaterial linewidth）。细而清晰，不喧宾夺主（SPEC §3.6「可设线宽」）。 */
export const PROVINCE_BORDER_LINE_WIDTH_PX = 1.6

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
export interface ProvinceBorderRgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 ProvinceBorderRgbColor（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): ProvinceBorderRgbColor {
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

/** 省界基线色的字节 RGB（= parseHex(PROVINCE_BORDER_COLOR_HEX)，冻结）。 */
export const PROVINCE_BORDER_RGB: Readonly<ProvinceBorderRgbColor> = Object.freeze(
  parseHex(PROVINCE_BORDER_COLOR_HEX),
)

/**
 * 判断给定 densify 间距是否合法（有限且 ≥ 下限）。
 *
 * 供自动化测试断言「生产间距合法」，也供准备层调用方在构造入参时自检——畸形 spacing（零 / 负 /
 * 极小 / 非有限）必须显式失败而非无限细分。
 */
export function provinceBorderSpacingIsValid(spacingMeters: number): boolean {
  return (
    Number.isFinite(spacingMeters) && spacingMeters >= PROVINCE_BORDER_DENSIFY_SPACING_MIN_METERS
  )
}

/**
 * 省级贴地边界的全部参数（冻结）。
 *
 * 这是省界准备层（src/lib/province-borders 的纯函数）、省界渲染层（src/three/ProvinceBorders）与
 * 自动化测试共享的同一份事实源：densify 间距 / 间距下限 / 贴地 epsilon / NDC 深度偏移 / 基线色·
 * 字节 RGB / 屏幕线宽全部在此，不存在第二套省界常量。冻结防止运行时被偷偷改（如把 epsilon 改成 0
 * 会让省界陷入地表、把深度偏移改成 0 会复发 z-fighting），任何调整都必须改本模块并同步测试。
 */
export const PROVINCE_BORDERS_CONFIG = Object.freeze({
  /** densify 间距（米，世界弧长）= 主图世界宽度 / 4096 ≈ 1742 m。 */
  densifySpacingMeters: PROVINCE_BORDER_DENSIFY_SPACING_METERS,
  /** densify 间距下限（含，米），防御畸形 spacing 的无限细分。 */
  densifySpacingMinMeters: PROVINCE_BORDER_DENSIFY_SPACING_MIN_METERS,
  /** 贴地 epsilon（米，世界 y 偏移），把省界放到地表外侧。 */
  terrainEpsilonMeters: PROVINCE_BORDER_TERRAIN_EPSILON_METERS,
  /** NDC 深度偏移（无量纲），结构性消除省界-地表 z-fighting。 */
  depthBiasNdc: PROVINCE_BORDER_DEPTH_BIAS_NDC,
  /** 基线色（浅青白，十六进制）。 */
  colorHex: PROVINCE_BORDER_COLOR_HEX,
  /** 基线色的字节 RGB（每通道 0–255）。 */
  colorRgb: PROVINCE_BORDER_RGB,
  /** 屏幕线宽（px）。 */
  lineWidthPx: PROVINCE_BORDER_LINE_WIDTH_PX,
})
