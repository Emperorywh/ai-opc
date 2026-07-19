/**
 * 地表分层设色色阶——唯一事实源（TASK-010）。
 *
 * 角色与依赖方向：
 * - 本模块属于运行时配置层（src/config），是「真实米制海拔 → 颜色」的**唯一**权威。GPU 片元着色器
 *   （src/three/terrain-shaders）、自动化测试、以及 TASK-021 的海拔图例都只能通过本模块取得断点、
 *   基线色与 256×1 ramp——禁止在着色器、测试或图例里各自复制一份断点或颜色（TASK-010 实现约束
 *   「色阶事实源必须唯一」）。本模块单向依赖 TypeScript 自身，不依赖 React / R3F / Three.js
 *   或任何 UI 组件——材质层与图例层都单向消费本模块，互不反向依赖（实现约束「材质/着色层不得
 *   反向依赖 UI 图例组件」）。
 *
 * 真实海拔查色（SPEC §3.1；TASK-010 实现约束「颜色归一化必须使用元数据真实上下限」）：
 * - 颜色只由「真实米制海拔 h」决定，与垂直夸张系数 k 无关——k 只放大世界 y（§3.2），不进入色阶。
 *   故同一真实高程在 k=1.5/2.0/3.0 下颜色完全一致（TASK-010 验证方式 2）。**绝不**用位移后的
 *   world-y 查色：world-y 已被 k 放大，用它查色会让整图颜色偏移 k 倍（SPEC §3.1、§7.1）。
 * - GPU 片元着色器按像素 UV 重新采样 heightmap 得到真实 h，再按 u = (h − minH)/(maxH − minH)
 *   归一化（minH/maxH 取自经契约校验的 heightmap 元数据），采样 256×1 ramp 纹理得到颜色。
 * - 本模块导出 CPU 侧的精确采样器 sampleElevationColor（直接在控制点上做分段线性，不经过 256
 *   纹素离散），供自动化测试在断点处断言「精确等于基线色」、供图例绘制色条；256 纹素 ramp 数据
 *   由 buildElevationRampRgbData 派生（在纹素中心调用同一采样器），GPU 与 CPU 共用同一份控制点 +
 *   插值策略，差异仅在 256 纹素的亚纹素量化（视觉不可察）。
 *
 * 色阶域与元数据绑定（TASK-010 验证方式 5「错误的 minH/maxH 预期契约拒绝而非产生偏色结果」）：
 * - SPEC §5.1 把生产高程编码区间固定为 [-1500m, 9000m]，SPEC §3.1 的断点表（雪线 5000m、极高山
 *   3500–5000m 等）正是相对该跨度定义的。若某份元数据的 minH/maxH 偏离该域，着色器按错误上下限
 *   归一化会使断点颜色落到错误纹素位置——即「偏色」。故本模块以 resolveElevationColorConfig
 *   断言元数据上下限严格等于 ELEVATION_COLOR_DOMAIN（与 SPEC §5.1 生产编码区间一致），不匹配即
 *   抛 elevation-color.domain-mismatch（确定性拒绝，绝不静默产生偏色）。
 *
 * 插值策略（TASK-010 实现约束「断点处选择平滑插值或硬切，选择后须有一致测试，不得多套逻辑并存」）：
 * - 全局采用「分段线性平滑插值」：相邻控制点之间按高程线性插值 RGB；控制点本身（即各断点海拔）
 *   颜色精确等于基线色。这是**唯一**的插值策略，CPU 采样器、256 纹素 ramp、测试断言都走同一套，
 *   不存在第二套硬切逻辑。水下（< 0）到平原（0）、雪线（5000）以上到上限（9000）同样分段线性，
 *   使整图过渡连续——既符合 SPEC §3.1「断点处可做平滑插值」，也让近岸到深海、高山到雪线自然过渡。
 */

/**
 * SPEC §5.1 生产高程编码区间，也是分层设色断点表所相对的色阶域（米）。
 *
 * 该域必须与 heightmap 元数据的 elevationEncoding.minValueMeters / maxValueMeters 严格一致——
 * 否则着色器归一化会使断点颜色错位（偏色）。下限 -1500m 保留浅水负高程（呈现大陆架，
 * SPEC §3.5）；上限 9000m 覆盖珠峰（8848m）并留余量。
 */
export const ELEVATION_COLOR_DOMAIN = Object.freeze({
  minValueMeters: -1500,
  maxValueMeters: 9000,
})

/**
 * 256×1 ramp 纹理的宽度（纹素数）。SPEC §3.1：一张 256×1 的 ramp texture。
 * 纹素 i 中心对应归一化坐标 u = (i + 0.5) / 256，即高程 minH + u·(maxH − minH)。
 */
export const ELEVATION_RAMP_WIDTH = 256

/** RGB 颜色（每通道 0–255，与浏览器 / three.js DataTexture UnsignedByteType 一致）。 */
export interface RgbColor {
  readonly r: number
  readonly g: number
  readonly b: number
}

/**
 * 分层设色控制点：真实海拔（米）→ 基线色。
 *
 * 列必须按 elevationMeters 严格升序排列；首点等于色阶域下限（−1500m，深海），末点等于上限
 * （9000m，雪线以上）。各断点海拔取自 SPEC §3.1 分层设色表的「区间下界」，颜色取该区间基线色，
 * 使「断点海拔 → 基线色」在 CPU 采样器上精确成立（TASK-010 验证方式 1）。
 */
export interface ElevationColorStop {
  /** 控制点真实海拔（米）。 */
  readonly elevationMeters: number
  /** 该海拔的基线色（每通道 0–255）。 */
  readonly color: RgbColor
}

/** 把 #rrggbb 形式的十六进制色串解析为 RgbColor（每通道 0–255）。仅供本模块内部构建控制点表。 */
function parseHex(hex: string): RgbColor {
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

/**
 * SPEC §3.1 分层设色控制点表（色阶唯一事实源）。
 *
 * 各行：区间（地貌）→ 基线色（参考）。控制点海拔取区间下界；末两行（5000m 雪线、9000m 上限）
 * 同为雪白色，使雪线以上保持恒定雪白。水下（−1500m → 0m）从深海近黑过渡到平原青绿，
 * 体现 SPEC §3.5「近岸浅、远海深」的深度梯度（透过半透明海面可见）。
 */
export const ELEVATION_COLOR_BREAKPOINTS: readonly ElevationColorStop[] = Object.freeze([
  { elevationMeters: -1500, color: parseHex('#06121c') }, // 水下：深海近黑（远海）
  { elevationMeters: 0, color: parseHex('#1f4d3a') }, // 平原 / 近岸
  { elevationMeters: 200, color: parseHex('#2f6b4a') }, // 丘陵
  { elevationMeters: 500, color: parseHex('#5a7a3a') }, // 低山
  { elevationMeters: 1000, color: parseHex('#8a7a33') }, // 中山
  { elevationMeters: 2000, color: parseHex('#7a5a2e') }, // 高山
  { elevationMeters: 3500, color: parseHex('#5e4030') }, // 极高山
  { elevationMeters: 5000, color: parseHex('#d8e4ea') }, // 雪线
  { elevationMeters: 9000, color: parseHex('#d8e4ea') }, // 雪线以上（至上限，恒定雪白）
])

/** 色阶解析失败的稳定错误码，供自动化测试精确断言「错误 minH/maxH 被拒绝」。 */
export type ElevationColorFailureCode = 'elevation-color.domain-mismatch'

/**
 * 由真实米制海拔查色（CPU 精确采样器，色阶唯一事实源的求值入口）。
 *
 * 在 ELEVATION_COLOR_BREAKPOINTS 上做分段线性：先夹到色阶域 [minH, maxH]，再定位所属分段，
 * 在相邻两控制点的 RGB 间按高程线性插值。控制点海拔本身返回精确基线色（无量化误差）——
 * 自动化测试据此断言「0m → 平原青绿、5000m → 雪白」等（TASK-010 验证方式 1）。
 *
 * 该函数只消费本模块的控制点表，不接受 minH/maxH 入参——色阶域已冻结在控制点跨度内，
 * 不存在第二套归一化。GPU 着色器的归一化（u = (h−minH)/(maxH−minH)）只是把真实 h 映射到
 * 256 纹素 ramp 的纹理坐标，ramp 数据本身由本采样器在纹素中心派生，故 GPU/CPU 共用同一事实源。
 */
export function sampleElevationColor(elevationMeters: number): RgbColor {
  if (!Number.isFinite(elevationMeters)) {
    throw new RangeError(`海拔必须为有限数值，实际为 ${elevationMeters}。`)
  }
  const stops = ELEVATION_COLOR_BREAKPOINTS
  // 夹到色阶域：低于下限取首点（深海近黑），高于上限取末点（雪白）。
  const lo = stops[0]
  const hi = stops[stops.length - 1]
  if (elevationMeters <= lo.elevationMeters) return lo.color
  if (elevationMeters >= hi.elevationMeters) return hi.color
  // 定位所属分段（控制点升序，线性扫描——9 个控制点无需二分）。
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (elevationMeters >= a.elevationMeters && elevationMeters <= b.elevationMeters) {
      const t = (elevationMeters - a.elevationMeters) / (b.elevationMeters - a.elevationMeters)
      return {
        r: a.color.r + (b.color.r - a.color.r) * t,
        g: a.color.g + (b.color.g - a.color.g) * t,
        b: a.color.b + (b.color.b - a.color.b) * t,
      }
    }
  }
  // 理论不可达（夹断 + 升序覆盖全域）；保留防御，避免返回 undefined。
  return hi.color
}

/**
 * 把真实米制海拔按色阶域归一化到 ramp 纹理坐标 u ∈ [0,1]（GPU 片元着色器用）。
 *
 * u = (h − minH)/(maxH − minH)；minH/maxH 由调用方取自已通过 resolveElevationColorConfig 校验的
 * 元数据（保证与 ELEVATION_COLOR_DOMAIN 一致）。h 超域时夹到 [0,1]（与 sampleElevationColor 的
 * 夹断语义一致；ramp 的 ClampToEdge wrapping 同样在 [0,1] 外收敛到端点）。
 */
export function normalizeElevationToRampU(
  elevationMeters: number,
  minValueMeters: number,
  maxValueMeters: number,
): number {
  if (!(minValueMeters < maxValueMeters)) {
    throw new RangeError(
      `色阶域必须满足 minValueMeters < maxValueMeters，实际为 ${minValueMeters} / ${maxValueMeters}。`,
    )
  }
  if (!Number.isFinite(elevationMeters)) {
    throw new RangeError(`海拔必须为有限数值，实际为 ${elevationMeters}。`)
  }
  const u = (elevationMeters - minValueMeters) / (maxValueMeters - minValueMeters)
  return Math.min(1, Math.max(0, u))
}

/**
 * 派生 256×1 ramp 的 RGB 字节序列（每纹素 3 字节，行主序，供 three.js RGBDataTexture 使用）。
 *
 * 纹素 i 中心对应真实海拔 minH + (i + 0.5)/width · (maxH − minH)；调用本模块的精确采样器
 * sampleElevationColor 取色，再量化到 [0,255] 整数。minH/maxH 必须等于 ELEVATION_COLOR_DOMAIN
 * （由 resolveElevationColorConfig 在调用前保证），使纹素跨度与控制点跨度严格一致。
 *
 * 导出供渲染层（ChinaTerrainMesh）构建 GPU DataTexture、供测试在 Node 环境内省 ramp 形状。
 */
export function buildElevationRampRgbData(
  width: number,
  minValueMeters: number,
  maxValueMeters: number,
): Uint8Array {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError(`ramp 宽度必须为正整数，实际为 ${width}。`)
  }
  if (!(minValueMeters < maxValueMeters)) {
    throw new RangeError(
      `色阶域必须满足 minValueMeters < maxValueMeters，实际为 ${minValueMeters} / ${maxValueMeters}。`,
    )
  }
  const data = new Uint8Array(width * 3)
  for (let i = 0; i < width; i++) {
    // 纹素中心 u = (i + 0.5)/width；对应真实海拔在色阶域内均匀分布。
    const u = (i + 0.5) / width
    const elevation = minValueMeters + u * (maxValueMeters - minValueMeters)
    const color = sampleElevationColor(elevation)
    data[i * 3] = Math.round(color.r)
    data[i * 3 + 1] = Math.round(color.g)
    data[i * 3 + 2] = Math.round(color.b)
  }
  return data
}

/**
 * 已解析的色阶配置（供渲染层与图例层消费的稳定形态）。
 *
 * 携带经校验的色阶域（= SPEC §5.1 编码区间）与 256×1 ramp 字节描述。渲染层据此构建 GPU
 * DataTexture 与着色器 uniform；TASK-021 图例层直接消费 ELEVATION_COLOR_BREAKPOINTS 与本域
 * 绘制色条 + 关键刻度，二者引用同一事实源，不存在复制断点 / 颜色。
 */
export interface ElevationColorConfig {
  /** 色阶域（米），与 heightmap 元数据上下限严格一致。 */
  readonly domain: Readonly<{ minValueMeters: number; maxValueMeters: number }>
  /** 256×1 ramp 的 RGB 字节序列（每纹素 3 字节）。 */
  readonly rampRgbData: Uint8Array
  /** ramp 纹素宽度（= ELEVATION_RAMP_WIDTH）。 */
  readonly rampWidth: number
}

/**
 * 解析色阶配置：断言元数据上下限等于 SPEC 色阶域，再派生 256×1 ramp。
 *
 * 这是「错误 minH/maxH 被拒绝」的确定性失败点（TASK-010 验证方式 5）：若元数据上下限偏离
 * ELEVATION_COLOR_DOMAIN（如缺失水下区间的 [0, 9000]、或上限偏移的 [−1500, 10000]），着色器
 * 归一化会使断点颜色错位（偏色），故在此显式抛 elevation-color.domain-mismatch，绝不静默放行。
 *
 * 元数据自身合法性（结构、CRS、min < max 等）由契约层 validateTerrainMeta 负责，本函数只复核
 * 「上下限是否与色阶域一致」这一着色正确性前提。
 */
export function resolveElevationColorConfig(meta: {
  readonly elevationEncoding: { readonly minValueMeters: number; readonly maxValueMeters: number }
}): ElevationColorConfig {
  const { minValueMeters, maxValueMeters } = meta.elevationEncoding
  if (
    minValueMeters !== ELEVATION_COLOR_DOMAIN.minValueMeters ||
    maxValueMeters !== ELEVATION_COLOR_DOMAIN.maxValueMeters
  ) {
    throw new ElevationColorError(
      'elevation-color.domain-mismatch',
      `色阶域必须为 [${ELEVATION_COLOR_DOMAIN.minValueMeters}, ${ELEVATION_COLOR_DOMAIN.maxValueMeters}]（SPEC §5.1 生产编码区间），` +
        `实际元数据为 [${minValueMeters}, ${maxValueMeters}]；上下限不一致会使断点颜色错位（偏色），已拒绝。`,
    )
  }
  const rampRgbData = buildElevationRampRgbData(
    ELEVATION_RAMP_WIDTH,
    minValueMeters,
    maxValueMeters,
  )
  return Object.freeze({
    domain: Object.freeze({ minValueMeters, maxValueMeters }),
    rampRgbData,
    rampWidth: ELEVATION_RAMP_WIDTH,
  })
}

/**
 * 色阶解析错误：携带稳定 code 与简体中文说明，绝不静默产生偏色。
 * 供自动化测试精确断言「错误 minH/maxH → elevation-color.domain-mismatch」。
 */
export class ElevationColorError extends Error {
  readonly code: ElevationColorFailureCode
  constructor(code: ElevationColorFailureCode, message: string) {
    super(message)
    this.name = 'ElevationColorError'
    this.code = code
  }
}
