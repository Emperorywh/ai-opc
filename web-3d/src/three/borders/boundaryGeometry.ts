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
import type { BoundaryData, DisputedData } from '../../data/types'

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

/**
 * 把争议折线（DisputedData，line strip）展开为 lineSegments 顶点 + `lineDistance` attribute。
 *
 * 每条 line strip（n 顶点 → n−1 段）展开成**成对独立顶点**（(n−1)×2 顶点），供 lineSegments
 * （gl.LINES）绘制。关键：**手动构建 lineDistance attribute 让累积弧长沿 strip 连续**——
 * LineDashedMaterial fragment shader 据插值 `vLineDistance` 取 mod(dashSize+gapSize) 切虚实；
 * 若用 `geometry.computeLineDistances()`（lineSegments 实现对每段重置 0→segLen），虚线会逐段
 * 断裂、疏密不均。手动累积保证虚线沿整条争议线均匀连续。每条 line 的 lineDistance 从 0 重置
 * （争议线相距甚远，跨线 phase 不连续无碍）。
 *
 *   x,z = project(lon, lat)                       // R2 投影，与边界/地形/标签同源
 *   y   = max(sampleWorldY, seaLevelWorldY) + ε    // 贴地，与 buildBoundaryPositions 同源
 *
 * 纯函数（输入 data + assets，输出 typed arrays）；可在 Node 单测（合成 elevation）。
 *
 * @returns positions(Float32Array xyz) + lineDistances(Float32Array)，逐顶点一一对应
 */
export function buildDisputedSegments(
  data: DisputedData,
  elevation: ElevationData,
  meta: ElevationMeta,
): { positions: Float32Array; lineDistances: Float32Array } {
  const seaY = metersToWorldY(meta.seaLevelMeters)

  // 先投影每条 line 的顶点（暂存），并累计输出顶点数（每段 2 顶点）。
  const projected: Array<{ x: number; y: number; z: number }[]> = []
  let outVertexCount = 0
  for (const line of data.lines) {
    if (line.vertexCount < 2) continue
    const pts: { x: number; y: number; z: number }[] = []
    for (let i = 0; i < line.vertexCount; i++) {
      const lon = data.vertices[(line.vertexOffset + i) * 2]
      const lat = data.vertices[(line.vertexOffset + i) * 2 + 1]
      const [x, z] = project(lon, lat)
      const groundY = sampleWorldY(elevation, meta, lon, lat)
      pts.push({ x, y: Math.max(groundY, seaY) + BOUNDARY_Y_OFFSET, z })
    }
    projected.push(pts)
    outVertexCount += (pts.length - 1) * 2
  }

  const positions = new Float32Array(outVertexCount * 3)
  const lineDistances = new Float32Array(outVertexCount)
  let o = 0
  for (const pts of projected) {
    let acc = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      const segLen = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      // 段起点 lineDistance = acc（a 的累积弧长）；段终点 = acc + segLen（b 的累积）。
      positions[o * 3] = a.x
      positions[o * 3 + 1] = a.y
      positions[o * 3 + 2] = a.z
      lineDistances[o] = acc
      o++
      positions[o * 3] = b.x
      positions[o * 3 + 1] = b.y
      positions[o * 3 + 2] = b.z
      lineDistances[o] = acc + segLen
      o++
      acc += segLen
    }
  }
  return { positions, lineDistances }
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

// ---------------------------------------------------------------------------
// 争议虚线材质（SPEC §6.3 / §2.4：LineDashedMaterial 暖灰虚线，Task 21 / D10）
// ---------------------------------------------------------------------------

/** 争议虚线色（SPEC §2.1 palette.disputed 暖灰）。 */
export const DISPUTED_LINE_COLOR = palette.disputed
/** 争议虚线不透明度（半透明柔和；虚线断续本身已降低视觉权重，故略高于实线描边 0.55）。 */
export const DISPUTED_LINE_OPACITY = 0.6
/**
 * 虚线段长 / 间隔（世界单位，与顶点空间一致；dashSize=实线段，gapSize=空白段）。
 * LineDashedMaterial 沿累积 lineDistance 取 mod(dashSize+gapSize) 切虚实。MVP 占位值；
 * 真实观感（疏密 / 与 zoom 联动 / 真实 NE 争议线尺度）交 Review。
 */
export const DISPUTED_DASH_SIZE = 0.012
export const DISPUTED_GAP_SIZE = 0.008

/**
 * 争议虚线材质透明属性（与描边同契约：transparent + depthWrite=false 读 Terrain 深度，山体遮挡
 * 后方争议线）。LineDashedMaterial 需 geometry 带 `lineDistance` attribute（见 buildDisputedSegments
 * 手动构建，非 computeLineDistances）。导出 plain object 供单测断言渲染顺序契约。
 */
export const DISPUTED_LINE_MATERIAL_OPTS = {
  transparent: true,
  depthWrite: false,
} as const

/** 争议虚线渲染顺序（SPEC §4.3：描边=3 → 争议虚线=4，最上层边界表达；< AtmosphereRim=10）。 */
export const DISPUTED_RENDER_ORDER = 4
