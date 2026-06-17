/**
 * 国家边界几何 / 材质配置（SPEC §6.3 / §4.3 渲染管线，Task 20：填充面 + 描边）。
 *
 * 非组件模块（导出常量 + 纯函数），使 CountryMeshes.tsx / BorderLines.tsx 满足
 * react-refresh「单组件导出」规则（与 oceanMaterial.ts / labelLayout.ts 同构）。
 *
 * 投影对齐（R2 / R3）：二进制顶点存 lon,lat；渲染时用 `project()` → `[x,z]`（与地形顶点同源），
 * 高度 y = `max(sampleWorldY, seaLevelWorldY) + ε`（陆地贴地表 / 海面贴海平面，与标签锚点
 * labelWorldPosition 同源；+ε 浮起避免与地形 z-fighting）。
 *
 * 几何设计：Task 19 pipeline 已烘焙**全局顶点池 + 全局 fill/border 索引**（GPU-ready），
 * 故填充与描边共用同一份投影顶点（`buildBoundaryPositions`），仅索引不同（fillIndices 三角形 /
 * borderIndices 线段对）。M7 拾取将在同几何加 countryId 顶点属性 + RT，高亮经 shader uniform
 * selectedId（几何不变，仅材质升级），故本 Task 用 MeshBasicMaterial 占位即可。
 */
import * as THREE from 'three'
import { project, metersToWorldY, type ElevationMeta } from '../../config/projection'
import { palette, desaturateHex } from '../../config/palette'
import { sampleWorldY } from '../../data/assets'
import type { ElevationData } from '../../data/types'
import type { BoundaryData } from '../../data/types'

// ---------------------------------------------------------------------------
// 高度采样（贴地 / 贴海面 + ε 浮起）
// ---------------------------------------------------------------------------

/**
 * 边界几何 Y 浮起量（世界单位）。略小于标签的 heightOffset(0.012)：边界需紧贴地表轮廓，
 * 仅需越过深度量化误差防 z-fighting；过大则描边「漂浮」脱离地形。
 */
export const BOUNDARY_Y_OFFSET = 0.003

/**
 * 把全局顶点池（lon,lat 交错）投影为 BufferGeometry position（Float32Array，3 floats/顶点 [x,y,z]）。
 *
 *   x,z = project(lon, lat)                       // R2 投影契约，与地形/标签同源
 *   y   = max(sampleWorldY, seaLevelWorldY)        // 陆地贴地表 / 海面贴海面
 *      + BOUNDARY_Y_OFFSET                        // 浮起避免 z-fighting
 *
 * 纯函数（输入 data + assets，输出 typed array）；可在 Node 单测验证（合成 elevation）。
 * 顶点数 = `data.vertices.length / 2`；与 `fillIndices` / `borderIndices` 的全局索引直接对应。
 */
export function buildBoundaryPositions(
  data: BoundaryData,
  elevation: ElevationData,
  meta: ElevationMeta,
): Float32Array {
  const seaY = metersToWorldY(meta.seaLevelMeters)
  const n = data.vertices.length / 2
  const positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const lon = data.vertices[i * 2]
    const lat = data.vertices[i * 2 + 1]
    const [x, z] = project(lon, lat)
    const groundY = sampleWorldY(elevation, meta, lon, lat)
    const y = Math.max(groundY, seaY) + BOUNDARY_Y_OFFSET
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z
  }
  return positions
}

// ---------------------------------------------------------------------------
// 填充面材质（SPEC §6.3：半透明低饱和，默认几乎不可见）
// ---------------------------------------------------------------------------

/**
 * 国家填充色（SPEC §6.3「半透明低饱和填充（默认几乎不可见）」）。
 * 取草地暖绿低饱和化（与水彩地形协调），低不透明度 ≈ 仅作拾取/高亮几何占位。
 */
export const COUNTRY_FILL_COLOR = desaturateHex(palette.grassland[1])
/** 填充不透明度（≤0.2 满足「默认几乎不可见」，为 M7 hover/selected 高亮留视觉余量）。 */
export const COUNTRY_FILL_OPACITY = 0.16

/**
 * 填充面材质透明属性（SPEC §4.3 透明渲染顺序契约）。
 *   transparent=true + depthWrite=false → 后绘不污染深度；
 *   depthTest=true（默认）→ 与 Terrain 已写深度比较，山体遮挡后方填充；
 *   DoubleSide → 倾斜相机掠射角两面可见（与 Ocean 同）。
 * 导出 plain object 供单测断言渲染顺序契约（同 OCEAN_MATERIAL_OPTS 模式）。
 */
export const COUNTRY_FILL_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
} as const

/** 填充面渲染顺序（SPEC §4.3：透明物体后绘；Terrain=0 → Ocean=1 → 填充=2）。 */
export const COUNTRY_FILL_RENDER_ORDER = 2

// ---------------------------------------------------------------------------
// 描边材质（SPEC §6.3 / §2.4：暖白半透明柔和轮廓线）
// ---------------------------------------------------------------------------

/** 描边色（SPEC §2.1 palette.border 柔光暖白）。 */
export const BORDER_LINE_COLOR = palette.border
/** 描边不透明度（半透明柔和，非纯黑硬线）。 */
export const BORDER_LINE_OPACITY = 0.55
/**
 * 描边像素宽度（SPEC §2.4「宽度随缩放微调」）。
 * ⚠️ WebGL 对 lineBasicMaterial.linewidth 多数驱动仅支持 1（除 IE/旧 macOS）。真正的「随缩放可变
 * 宽度」需 fat-line（Line2/LineMaterial，screen-space），属视觉增强——交 Review 决定是否升级。
 * 本 Task 用原生 lineSegments（与代码库「原生 three、无 examples/jsm」约定一致），诚实设 linewidth。
 */
export const BORDER_LINE_WIDTH = 1

/**
 * 描边材质透明属性。transparent + depthWrite=false + depthTest=true：后绘、读 Terrain 深度
 * （山体遮挡后方边界线）、不污染深度。导出 plain object 供单测。
 */
export const BORDER_LINE_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
} as const

/** 描边渲染顺序（填充=2 → 描边=3，线绘于填充之上；均 < AtmosphereRim=10）。 */
export const BORDER_LINE_RENDER_ORDER = 3
