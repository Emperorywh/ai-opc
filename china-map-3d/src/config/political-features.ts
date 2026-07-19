/**
 * 政治边界补充要素（十段线 + 岛礁点位）主图呈现的视觉与几何配置——唯一事实源（TASK-015）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「十段线 densify 间距、海平面贴合 epsilon、NDC 深度偏移、
 *   十段线基线色·线宽·虚线节拍、岛礁点位基线色·米制半径」的**唯一**权威。主图政治要素准备层
 *   （src/lib/political-features 的纯函数）、渲染层（src/three/PoliticalFeatures 经组件注入材质参数）、
 *   自动化测试都只能通过本模块取得这些参数——禁止在准备函数 / 组件 / 测试里各自复制一份间距、
 *   海平面 y 或线宽（TASK-015 实现约束「唯一事实源来自 TASK-006」「不得在组件内补写坐标或样式常量」）。
 * - 单向依赖：本模块只依赖坐标层 src/lib/projection（MAIN_MAP_WORLD_BOUNDS —— 主图世界米制包围盒的唯一源，
 *   用来把 densify 间距与点位半径表达成主图尺度的分数）、同层 src/config/sea-surface
 *   （SEA_LEVEL_Y_METERS —— 海平面世界 y 的唯一源，使十段线 / 岛礁点位的「海平面贴合」与动态海面
 *   共用同一米制海平面，不复制第二份 y=0）。不依赖 React / R3F / Three.js / DOM，故自动化测试可在
 *   Node 环境直接断言「间距 ≈ 主图宽度 / 4096」「海平面 y = 0（与海面同源）」「基线色与省界可区分」
 *   等不变量（TASK-015 验证方式 1）。
 *
 * 与省界配置（src/config/province-borders）的分工与共享（SPEC §3.6 省界 / §5.3 九段线、TASK-015 输出
 * 约束「十段线与省界视觉可区分」）：
 * - 共享：densify 间距口径（= 主图世界宽度 / 4096，与 heightmap 纹素分辨率一一对应）、NDC 深度偏移口径
 *   （Line2 在地图尺度下抗 z-fighting 的同一种结构性手段，由 src/three/line-depth-bias 的同一注入函数应用）。
 *   两处各自定义同值常量而非跨配置 import——二者是相互独立的渲染层，同值反映同一类问题在同一地图尺度下的
 *   同一解，任一层调整不应隐式波及另一层。
 * - 区分（SPEC §5.3「样式与省界区分（如更亮的发光虚线）」）：十段线基线色取暖琥珀（#ffd180），与省界
 *   浅青白（#9fe8d8）冷暖相对、色相分明；线宽略粗（2.0 vs 1.6 px）；并启用虚线节拍（dashSize / gapSize），
 *   使十段线在视觉上「更亮、暖色、虚线」，与省界「轻发光、冷色、实线」明确区分，不混淆。
 *
 * 海平面贴合（SPEC §3.5 海面 / §5.3 九段线贴地或海面、TASK-015 输出约束「高度由共享高程 / 海平面语义确定，
 * 既不被海面完全吞没，也不使用与地图脱节的固定世界坐标」）：
 * - 十段线绝大部段与岛礁点位落在海域（九段线本就是海域主张线，曾母暗沙等是水下礁滩）。若照省界公式
 *   world_y = h·k + epsilon 直接贴合地形，海域负高程（h<0，水下大陆架）会把线 / 点压到海面（y=0）之下，
 *   被半透明海面（depthWrite=false，但其片元仍参与透明混合）与水下地形在视觉上吞没——违反「不被海面
 *   完全吞没」。
 * - 故政治要素采用「海平面贴合」语义：world_y = max(h·k, SEA_LEVEL_Y_METERS) + epsilon。陆地（h·k>0）
 *   贴合真实地形（与省界一致）；海域（h·k≤0）钳制到海平面 y=0 之上 epsilon，使线 / 点恒位于半透明海面
 *   之上、可见。海平面 y 取自 SEA_LEVEL_Y_METERS（=0，与动态海面同一米制海平面，非「与地图脱节的
 *   固定世界坐标」），高程 h 取自共享 ElevationProvider（与地形 GPU 位移同一份高程事实源）——
 *   二者共同构成「共享高程 / 海平面语义」（TASK-015 输出约束）。
 *
 * 非官方审图限制（SPEC §6 / §8 / §13、TASK-015 实现约束「本 TASK 不宣称取得审图号；只能在内部展示状态
 * 下验收，正式发布仍被 TASK-006 的待审图状态禁止」）：
 * - 本配置只决定「如何画线 / 画点」（颜色 / 线宽 / 虚线 / 半径 / 深度偏移），不承载也不校验坐标——
 *   坐标唯一事实源是 TASK-006 的政治边界补充资产（public/geo/china-political-boundary.json）。本配置
 *   与渲染层都不得复制、手改或在组件内补写十段线 / 岛礁坐标（TASK-015 实现约束）。
 * - 本配置与渲染层的呈现属于「内部展示状态」：政治边界补充数据为非官方审图数据（isOfficialSurvey=false），
 *   九段线几何顶点与争议区边界的国标逐点一致性以人工核对为准（docs/political-review-record.md），
 *   公开发布前必须取得自然资源主管部门审图号。本 TASK 不通过任何视觉手段（如加审图号角标）宣称已审图。
 */

import { MAIN_MAP_WORLD_BOUNDS } from '../lib/projection'
import { SEA_LEVEL_Y_METERS } from './sea-surface'

/**
 * heightmap 纹素数（每边），用于派生十段线 densify 间距。
 *
 * 与生产资产 china-heightmap-4096 的分辨率一致（与省界 PROVINCE_BORDER_HEIGHTMAP_TEXEL_COUNT 同值）。
 * 间距 = 主图世界宽度 / 本值，使十段线 densify 密度与地形纹理分辨率、与省界 densify 密度三者一一对应
 * （SPEC §3.6「plane 宽/4096」）。十段线绝大部段在海域（海面平坦），densify 主要保证跨岛礁 / 跨陆海
 * 交界处逐顶点贴合，而非追随海底起伏。
 */
export const POLITICAL_FEATURES_HEIGHTMAP_TEXEL_COUNT = 4096

/**
 * 十段线 densify 间距（米，世界弧长度量）= 主图世界宽度 / 4096。
 *
 * 与省界 PROVINCE_BORDER_DENSIFY_SPACING_METERS 同公式、同值（≈ 1742 m，落在 SPEC §3.6 的 1–2 km 区间）。
 * 沿世界 XZ 平面弧长度量，使十段线全境 densify 密度与省界一致。冻结派生自主图世界包围盒（唯一源），
 * 不写死绝对米数。
 */
export const POLITICAL_FEATURES_DENSIFY_SPACING_METERS =
  (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / POLITICAL_FEATURES_HEIGHTMAP_TEXEL_COUNT

/**
 * densify 间距的下限（含，米）：防止退化几何或异常配置产生零间距导致无限细分。
 *
 * 与省界 PROVINCE_BORDER_DENSIFY_SPACING_MIN_METERS 同语义。正常间距（≈1742 m）远大于该下限；
 * 该下限仅作为防御性兜底，使 preparePoliticalFeatures 在收到畸形 spacing 时显式失败而非死循环。
 */
export const POLITICAL_FEATURES_DENSIFY_SPACING_MIN_METERS = 1

/**
 * 海平面贴合 epsilon（米，世界 y 偏移）。
 *
 * world_y = max(h·k, SEA_LEVEL_Y_METERS) + 本值。可解释的小正偏移：把十段线 / 岛礁点位放到「贴合面」
 * （陆地地形表面或海平面）的外侧（上方），补偿 CPU/GPU 高程采样的亚米级浮点差异。z-fighting 的主防线
 * 是 NDC 深度偏移（见下），epsilon 是辅助。取 15 m（与省界同值）：在 k=2 下对应 7.5 m 真实高程偏移，
 * 地图尺度下视觉不可辨，又足以恒定位于贴合面之上。
 */
export const POLITICAL_FEATURES_TERRAIN_EPSILON_METERS = 15

/**
 * 政治要素片元的 NDC 深度偏移（无量纲，约 1e-5）。
 *
 * 与省界 PROVINCE_BORDER_DEPTH_BIAS_NDC 同值、同语义：在 LineMaterial 顶点着色器内从 gl_Position.z
 * 减去（× gl_Position.w 还原裁剪空间），使十段线片元在深度测试中恒胜过同位置的贴合面（结构性消除
 * z-fighting），仍被前方山体正确遮挡。约 80 个 24 位深度 ULP，足够稳定胜过同位置地表 / 海面，又远小于
 * 前方山体的 NDC 差，不致穿透前方地形。由 src/three/line-depth-bias 的同一注入函数应用到十段线材质。
 */
export const POLITICAL_FEATURES_DEPTH_BIAS_NDC = 1e-5

/**
 * 十段线基线色（SPEC §5.3「更亮的发光虚线」、TASK-015 输出约束「与省界视觉可区分」，十六进制）。
 *
 * 取 #ffd180（r=255、g=209、b=128）：暖琥珀色，与省界浅青白 #9fe8d8（r=159、g=232、b=216）冷暖相对、
 * 色相分明，在深色科技风背景下呈明亮暖光发光。恒定基线，不随段 / 高程变化——十段线是纯政治地理展示，
 * 不映射任何业务数据（SPEC 非目标）。
 */
export const POLITICAL_LINE_COLOR_HEX = '#ffd180'

/** 十段线屏幕线宽（px，LineMaterial linewidth）。略粗于省界（1.6 px）以更突出（SPEC §5.3「更亮」）。 */
export const POLITICAL_LINE_WIDTH_PX = 2.0

/**
 * 十段线虚线节拍（SPEC §5.3「发光虚线」、TASK-015 输出约束「与省界视觉可区分」）。
 *
 * Line2 / LineMaterial 的 dashed 模式按「dashSize 实线 + gapSize 空白」沿弧长重复。两值均以「世界弧长」
 * 度量（Line2 的 dashed 单位），取约 2 倍间距的节拍（≈ 3.5 km 实线 + ≈ 2.5 km 空白），在主图尺度下呈
 * 清晰可辨的虚线，与省界实线明确区分。drei Line 组件据此设 material.dashed + dashSize / gapSize。
 *
 * dashScale 经验取 1（不额外缩放）；dashOffset 固定 0（不做流水动画，避免与「静态地理展示」相悖）。
 */
export const POLITICAL_LINE_DASH_SIZE = POLITICAL_FEATURES_DENSIFY_SPACING_METERS * 2
export const POLITICAL_LINE_GAP_SIZE = POLITICAL_FEATURES_DENSIFY_SPACING_METERS * 1.4

/**
 * 岛礁 / 附属岛屿点位基线色（SPEC §5.3 / §6 岛礁点位、TASK-015 输出约束「必需点位在真实位置有可见标记」，
 * 十六进制）。
 *
 * 取 #ffe0a0（r=255、g=224、b=160）：与十段线同色系的更亮暖琥珀，使点位与十段线在视觉上归为同一「政治
 * 边界补充要素」族，又比线更亮以突出「点位」。恒定基线，不随岛礁 / 高程变化。点位规范名称（钓鱼岛 /
 * 赤尾屿 / 曾母暗沙等）的文本标注由 TASK-016 的统一标签系统呈现，本 TASK 只画可见标记光点。
 */
export const POLITICAL_POINT_COLOR_HEX = '#ffe0a0'

/**
 * 岛礁点位标记的米制半径（世界空间）。
 *
 * 派生自主图世界宽度（唯一源）：主图宽度 / 512 ≈ 13.9 km。地图尺度下呈清晰可见的光点，又不过大遮盖
 * 岛礁本身。点位用球体（sphereGeometry）+ additive 发光材质渲染（见 PoliticalFeatures 组件），
 * radius 控制球体半径。
 */
export const POLITICAL_POINT_RADIUS_METERS =
  (MAIN_MAP_WORLD_BOUNDS.maxX - MAIN_MAP_WORLD_BOUNDS.minX) / 512

/** RGB 颜色（每通道 0–255，与浏览器 / three.js 字节色一致）。 */
export interface PoliticalFeaturesRgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** 把 #rrggbb 形式的十六进制色串解析为 PoliticalFeaturesRgbColor（每通道 0–255）。仅供本模块内部构建常量。 */
function parseHex(hex: string): PoliticalFeaturesRgbColor {
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

/** 十段线基线色的字节 RGB（= parseHex(POLITICAL_LINE_COLOR_HEX)，冻结）。 */
export const POLITICAL_LINE_RGB: Readonly<PoliticalFeaturesRgbColor> = Object.freeze(
  parseHex(POLITICAL_LINE_COLOR_HEX),
)

/** 岛礁点位基线色的字节 RGB（= parseHex(POLITICAL_POINT_COLOR_HEX)，冻结）。 */
export const POLITICAL_POINT_RGB: Readonly<PoliticalFeaturesRgbColor> = Object.freeze(
  parseHex(POLITICAL_POINT_COLOR_HEX),
)

/**
 * 判断给定 densify 间距是否合法（有限且 ≥ 下限）。
 *
 * 供自动化测试断言「生产间距合法」，也供 preparePoliticalFeatures 在入口处显式拒绝畸形 spacing
 * （零 / 负 / 极小 / 非有限），避免无限细分（与 provinceBorderSpacingIsValid 同构）。
 */
export function politicalFeaturesSpacingIsValid(spacingMeters: number): boolean {
  return (
    Number.isFinite(spacingMeters) && spacingMeters >= POLITICAL_FEATURES_DENSIFY_SPACING_MIN_METERS
  )
}

/**
 * 政治边界补充要素主图呈现的全部参数（冻结）。
 *
 * 这是十段线准备层（src/lib/political-features 的纯函数）、渲染层（src/three/PoliticalFeatures）与自动化
 * 测试共享的同一份事实源：densify 间距 / 间距下限 / 海平面贴合 epsilon / 海平面 y / NDC 深度偏移 /
 * 十段线基线色·字节 RGB·线宽·虚线节拍 / 岛礁点位基线色·字节 RGB·半径全部在此，不存在第二套政治要素常量。
 * 冻结防止运行时被偷偷改（如把 epsilon 改 0 会让海域线段沉到海面之下被吞没、把海平面 y 改非 0 会与
 * 动态海面脱节），任何调整都必须改本模块并同步测试。
 */
export const POLITICAL_FEATURES_CONFIG = Object.freeze({
  /** densify 间距（米，世界弧长）= 主图世界宽度 / 4096 ≈ 1742 m。 */
  densifySpacingMeters: POLITICAL_FEATURES_DENSIFY_SPACING_METERS,
  /** densify 间距下限（含，米），防御畸形 spacing 的无限细分。 */
  densifySpacingMinMeters: POLITICAL_FEATURES_DENSIFY_SPACING_MIN_METERS,
  /** 海平面贴合 epsilon（米，世界 y 偏移），把线 / 点放到贴合面外侧。 */
  terrainEpsilonMeters: POLITICAL_FEATURES_TERRAIN_EPSILON_METERS,
  /**
   * 海平面世界 y（米）= 0，与动态海面同一米制海平面（SEA_LEVEL_Y_METERS）。
   * 海平面贴合语义 world_y = max(h·k, 本值) + epsilon 的「海平面」锚点。
   */
  seaLevelYMeters: SEA_LEVEL_Y_METERS,
  /** NDC 深度偏移（无量纲），结构性消除十段线-贴合面 z-fighting。 */
  depthBiasNdc: POLITICAL_FEATURES_DEPTH_BIAS_NDC,
  /** 十段线基线色（暖琥珀，十六进制）。 */
  lineColorHex: POLITICAL_LINE_COLOR_HEX,
  /** 十段线基线色的字节 RGB（每通道 0–255）。 */
  lineColorRgb: POLITICAL_LINE_RGB,
  /** 十段线屏幕线宽（px）。 */
  lineWidthPx: POLITICAL_LINE_WIDTH_PX,
  /** 十段线虚线实线段长（世界弧长，米）。 */
  lineDashSize: POLITICAL_LINE_DASH_SIZE,
  /** 十段线虚线空白段长（世界弧长，米）。 */
  lineGapSize: POLITICAL_LINE_GAP_SIZE,
  /** 岛礁点位基线色（更亮暖琥珀，十六进制）。 */
  pointColorHex: POLITICAL_POINT_COLOR_HEX,
  /** 岛礁点位基线色的字节 RGB（每通道 0–255）。 */
  pointColorRgb: POLITICAL_POINT_RGB,
  /** 岛礁点位标记米制半径（世界空间）。 */
  pointRadiusMeters: POLITICAL_POINT_RADIUS_METERS,
})
