/**
 * 海拔色阶图例的数据准备（领域层，TASK-014，SPEC §9 / §3.1）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时领域层（src/lib），把「图例配置（src/config/elevation-legend 的关键刻度
 *   海拔 + 采样段数 + 色阶域引用）」确定性地变换为「色条 CSS 渐变的 color stop 序列 + 关键刻度
 *   的归一化位置 / 颜色 / 文字」，供渲染层（src/components/ui/ElevationLegend 的 DOM overlay）
 *   只消费、不再计算。
 * - 单向依赖：配置层 src/config/elevation-legend（呈现常量）、TASK-006 色阶唯一事实源
 *   src/config/elevation-color-ramp（sampleElevationColor——真实海拔→颜色的唯一采样器；
 *   normalizeElevationToRampU——真实海拔→ramp 归一化坐标的唯一入口；RgbColor 类型）。禁止依赖
 *   React / R3F / Three.js / DOM / hover 状态——本模块是纯函数，可在 Node 环境完整断言「色条
 *   与刻度颜色来自同一采样器、位置来自同一归一化、六个关键刻度齐全且升序」。
 *
 * 色阶复用——单一事实源的形式保证（验收「图例配色与地表 ramp 同源（测试保证一致性）」）：
 * - 色条 color stop 的颜色 = sampleElevationColor(该 stop 对应的真实海拔)；关键刻度的颜色 =
 *   sampleElevationColor(刻度海拔)。二者都用**同一**采样器——与地表片元着色器（ChinaTerrainMesh
 *   经 resolveElevationColorConfig 派生 256×1 ramp、片元按真实 h 归一化采样）同一事实源。
 *   本模块不内置任何断点 / 颜色字面量，不存在第二套色阶。
 * - 色条 color stop 的纵向位置 = normalizeElevationToRampU(真实海拔, minH, maxH)；关键刻度的
 *   位置同一公式。该归一化与 shader 片元归一化（u = (h−minH)/(maxH−minH)）严格一致，故同一
 *   海拔在色条与地表处于同一相对位置。
 * - 色阶域 minH/maxH 引用 ELEVATION_LEGEND_CONFIG.domain——即 elevation-color-ramp 的
 *   ELEVATION_COLOR_DOMAIN 冻结常量（同一对象引用），与 shader 经 resolveElevationColorConfig
 *   复核 meta 上下限所对照的域同一事实源。本函数不接收 minH/maxH 入参，避免引入第二套域。
 *
 * 输出形态（渲染层 DOM overlay 直接消费的稳定产物）：
 * - barStops：色条 CSS linear-gradient 的 color stop 序列，按位置升序、首末分别落在色阶域
 *   下限 / 上限。渲染层据此拼 `linear-gradient(to top, ...)`（to top = 低海拔在底、高海拔在顶）。
 * - ticks：关键刻度数组，每项含海拔、归一化位置（0=色条底、1=色条顶）、该海拔颜色（十六进制，
 *   供刻度色块复用）、文字标签。渲染层据此在色条侧边标注刻度。
 */

import {
  normalizeElevationToRampU,
  sampleElevationColor,
  type RgbColor,
} from '../config/elevation-color-ramp'
import { ELEVATION_LEGEND_CONFIG } from '../config/elevation-legend'

/**
 * 色条 CSS linear-gradient 的单个 color stop。
 *
 * positionFraction ∈ [0,1]：0 = 色阶域下限（深海近黑，色条底部）、1 = 色阶域上限（雪白，
 * 色条顶部）。由 normalizeElevationToRampU(真实海拔, minH, maxH) 派生——与 shader 片元归一化
 * 同一公式。colorHex = sampleElevationColor(真实海拔) 转 #rrggbb——与地表片元着色器同一采样器。
 */
export interface LegendBarStop {
  /** 在色条上的归一化纵向位置（0=底/深海、1=顶/雪白），由色阶域归一化得到。 */
  readonly positionFraction: number
  /** 该位置的颜色（#rrggbb），由色阶唯一采样器对该位置的真实海拔取样得到。 */
  readonly colorHex: string
}

/**
 * 准备好的单个关键刻度（读图辅助）。
 *
 * 颜色与位置都不硬编码：颜色 = sampleElevationColor(海拔)，位置 = normalizeElevationToRampU
 * (海拔, minH, maxH)，二者与地表着色器同源。label 为刻度文字（如「1000」），渲染层拼接单位。
 */
export interface LegendTick {
  /** 真实海拔（米）。 */
  readonly elevationMeters: number
  /** 在色条上的归一化纵向位置（0=底、1=顶），由色阶域归一化得到。 */
  readonly positionFraction: number
  /** 该海拔的颜色（#rrggbb），由色阶唯一采样器得到——与地表同海拔处颜色一致。 */
  readonly colorHex: string
  /** 刻度文字（海拔数值字符串，不含单位；渲染层拼接单位标注）。 */
  readonly label: string
}

/** 准备好的海拔色阶图例（渲染层 DOM overlay 直接消费的稳定产物）。 */
export interface PreparedElevationLegend {
  /** 色条 CSS linear-gradient 的 color stop 序列（按位置升序，首末落色阶域下限 / 上限）。 */
  readonly barStops: readonly LegendBarStop[]
  /** 关键刻度数组（按海拔升序），颜色 / 位置均从 TASK-006 色阶唯一事实源派生。 */
  readonly ticks: readonly LegendTick[]
}

/** 把 RgbColor（每通道 0–255）转为 #rrggbb 十六进制字符串（CSS color stop / 刻度色块用）。 */
function rgbColorToHex(color: RgbColor): string {
  const toHex2 = (channel: number): string => {
    // 量化到 [0,255] 整数（sampleElevationColor 在控制点精确、分段间为浮点插值，需 round）。
    const clamped = Math.min(255, Math.max(0, Math.round(channel)))
    return clamped.toString(16).padStart(2, '0')
  }
  return `#${toHex2(color.r)}${toHex2(color.g)}${toHex2(color.b)}`
}

/**
 * 把海拔色阶图例配置确定性地准备为渲染层可消费的色条 + 关键刻度（颜色 / 位置全部从 TASK-006
 * 色阶唯一事实源派生）。
 *
 * 流水线：
 * 1. 色条 color stop：在色阶域 [minH, maxH] 上均匀取「采样段数 + 1」个真实海拔，各自经
 *    normalizeElevationToRampU 得位置、sampleElevationColor 得颜色，组成升序 color stop 序列。
 * 2. 关键刻度：对配置的每个关键刻度海拔，同一归一化得位置、同一采样器得颜色，附文字标签。
 *
 * 色阶域来自 ELEVATION_LEGEND_CONFIG.domain（即 elevation-color-ramp 的 ELEVATION_COLOR_DOMAIN
 * 冻结常量），与 shader 经 resolveElevationColorConfig 复核 meta 上下限所对照的域同一事实源。
 * 所有颜色由 sampleElevationColor 现场取得，本函数不内置断点 / 颜色字面量。
 */
export function prepareElevationLegend(): PreparedElevationLegend {
  const { keyTicks, barSampleCount, domain } = ELEVATION_LEGEND_CONFIG
  const minH = domain.minValueMeters
  const maxH = domain.maxValueMeters

  // 色条 color stop：均匀采样「段数 + 1」个海拔。i=0 → minH（深海近黑，色条底）、i=段数 → maxH
  // （雪白，顶）。颜色与位置都从 TASK-006 唯一事实源派生，不存在第二套色阶。
  const barStops: LegendBarStop[] = []
  const segmentCount = Math.max(1, Math.floor(barSampleCount))
  for (let i = 0; i <= segmentCount; i++) {
    const elevation = minH + ((maxH - minH) * i) / segmentCount
    const positionFraction = normalizeElevationToRampU(elevation, minH, maxH)
    const colorHex = rgbColorToHex(sampleElevationColor(elevation))
    barStops.push({ positionFraction, colorHex })
  }

  // 关键刻度：位置 = normalizeElevationToRampU(海拔)、颜色 = sampleElevationColor(海拔)，与地表同源。
  const ticks: LegendTick[] = keyTicks.map((elevationMeters) => ({
    elevationMeters,
    positionFraction: normalizeElevationToRampU(elevationMeters, minH, maxH),
    colorHex: rgbColorToHex(sampleElevationColor(elevationMeters)),
    label: String(elevationMeters),
  }))

  return { barStops, ticks }
}

/**
 * 由色条 color stop 序列拼成 CSS linear-gradient 字符串（渲染层直接写入 style）。
 *
 * `to top`：低海拔（深海近黑）在色条底部、高海拔（雪白）在顶部，与读图直觉一致（越高越白）。
 * 导出供渲染层拼样式、供测试内省渐变字符串形状（首 stop 在底、末 stop 在顶、颜色来自采样器）。
 */
export function buildElevationLegendBarGradientCss(stops: readonly LegendBarStop[]): string {
  if (stops.length === 0) return ''
  const parts = stops.map((stop) => `${stop.colorHex} ${(stop.positionFraction * 100).toFixed(2)}%`)
  return `linear-gradient(to top, ${parts.join(', ')})`
}
