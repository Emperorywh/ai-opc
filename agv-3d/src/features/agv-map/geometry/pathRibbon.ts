import type { LaneGroupingConfig, PathRibbonConfig } from '../config/geometryConfig'
import type { Point2 } from '../domain/domainModel'
import type { PathGeometryPacket } from '../domain/renderPacket'
import type { MapSpace } from './worldCoords'
import { mapToWorld } from './worldCoords'
import { GeometryCompileError, type SampledPath } from './pathSampling'
import type { LaneGroup } from './laneGrouping'

// 路径几何包契约 PathGeometryPacket 已上移至 domain 层（SPEC §5.1 依赖方向），
// 此处重新导出以保持 geometry 公共 API 稳定。
export type { PathGeometryPacket }

/**
 * 路径扁带编译（SPEC §7.5、§7.6）。
 *
 * 不变量：
 * - 纯函数：相同车道分组、地图空间与配置产生字节级稳定的扁带几何，不读取系统时间、
 *   随机源、相机或任何展示状态（SPEC §7.1）。
 * - 坐标约定：中心线偏移与扁带展开在地图 XY 平面完成，再统一映射到世界 XZ 平面
 *   （SPEC §6.1、§7.5）。所有顶点 Y 分量恒为扁带离地高度，法线恒为地面法线 (0,1,0)。
 * - 米制弧长：每条车道 pathU 从自身中心线起点按累计弧长单调递增；双向组两条车道
 *   共享规范方向中心线，故 pathU 序列完全一致，仅靠 flowDirection 区分流向（SPEC §7.6）。
 * - 边界完整：全部车道合并为单一顶点/索引缓冲；edgeVertexRanges 为每条有向边保留
 *   不相交的顶点区间，支持逐边定位（SPEC §7.5、TASK-004）。
 *
 * 折角处理（SPEC §7.5）：
 * - 每个中心线采样点用相邻点计算稳定切线，进而得到法线方向。
 * - 普通折角使用斜接（miter）：法线乘以斜接比例 1/cos(θ/2) 延伸到内外边交点。
 * - 比例超过 miterLimitRatio 时稳定切换为斜切（bevel）：该点产生两份横截面
 *   （分别用入向、出向法线），二者之间的四边形由统一的相邻横截面 Quad 规则自动填充，
 *   不产生尖刺、裂缝或不确定结果。
 */

/**
 * 单条车道扁带两条边界沿法线的有符号展开距离（米）。
 * expandNear = shift − halfWidth、expandFar = shift + halfWidth（shift = offsetSign × 偏移）。
 * 近/远按数值大小命名（expandNear < expandFar）：单向组二者关于 0 对称；双向规范车道
 * 均为正、反方向车道均为负，因此“近侧”不一定距共享中心线更近，仅指标签稳定一致。
 */
interface LaneExpansion {
  readonly expandNear: number
  readonly expandFar: number
}

/**
 * 扁带编译结果。geometry 为可转移的纯数据包；edgeIds 与 edgeVertexRanges 成对对齐，
 * edgeIds[i] 对应 edgeVertexRanges[2i..2i+1] 的顶点区间，使调用方能逐边定位（TASK-004）。
 */
export interface CompiledPath {
  readonly geometry: PathGeometryPacket
  readonly edgeIds: readonly string[]
}

/**
 * 横截面：中心线某点处扁带两条边界的一对顶点，携带该点的米制弧长。
 * near 取 expandNear、far 取 expandFar 沿该点法线的展开结果（见 LaneExpansion 命名说明）。
 */
interface CrossSection {
  /** expandNear 对应的边界顶点（地图 XY）。 */
  readonly near: Point2
  /** expandFar 对应的边界顶点（地图 XY）。 */
  readonly far: Point2
  /** 该横截面对应中心线点的累计弧长（米）。 */
  readonly pathU: number
}

/** 中心线某点的入向与出向单位切线；端点处二者相等（均取唯一邻段方向）。 */
interface PointTangent {
  readonly inTangent: Point2
  readonly outTangent: Point2
}

/**
 * 把车道分组编译为合并后的路径扁带数据。
 *
 * 算法步骤：
 * 1. 按 groups 顺序、每组 lanes 顺序遍历全部车道，保证输出顺序确定。
 * 2. 每条车道计算近/远展开距离（offsetSign 决定侧向，带宽决定厚度）。
 * 3. 在地图 XY 平面生成横截面序列（miter/bevel），按相邻横截面 Quad 输出三角形。
 * 4. 横截面顶点统一映射到世界 XZ 平面，写入主缓冲并记录该边的顶点区间。
 * 5. 全部写入完成后做有限性与索引校验，任一非法即抛出几何编译错误。
 */
export function compilePathGeometry(
  groups: readonly LaneGroup[],
  space: MapSpace,
  ribbonConfig: PathRibbonConfig,
  groupingConfig: LaneGroupingConfig,
): CompiledPath {
  const halfWidth = ribbonConfig.ribbonWidthM / 2
  const offsetM = groupingConfig.laneCenterOffsetM

  const positions: number[] = []
  const pathU: number[] = []
  const flowDirections: number[] = []
  const indices: number[] = []
  const edgeVertexRanges: number[] = []
  const edgeIds: string[] = []

  for (const group of groups) {
    for (const lane of group.lanes) {
      const expansion = laneExpansion(lane.offsetSign, halfWidth, offsetM)
      const laneResult = compileLane(
        group.centerline,
        expansion,
        lane.flowDirection,
        ribbonConfig,
      )

      const startVertex = positions.length / 3

      // 将横截面顶点映射到世界坐标并写入主缓冲。
      for (const section of laneResult.sections) {
        const nearWorld = mapToWorld(section.near, space, ribbonConfig.ribbonHeightM)
        const farWorld = mapToWorld(section.far, space, ribbonConfig.ribbonHeightM)
        // 近侧顶点。
        positions.push(nearWorld.x, nearWorld.y, nearWorld.z)
        pathU.push(section.pathU)
        flowDirections.push(lane.flowDirection)
        // 远侧顶点。
        positions.push(farWorld.x, farWorld.y, farWorld.z)
        pathU.push(section.pathU)
        flowDirections.push(lane.flowDirection)
      }

      // 相邻横截面之间输出一个 Quad（两个三角形），共享 near/far 命名以保持绕序一致。
      // 横截面 k 的近/远顶点索引为 baseNear=2k、baseFar=2k+1。
      const sectionCount = laneResult.sections.length
      for (let k = 0; k < sectionCount - 1; k += 1) {
        const a = startVertex + k * 2
        const b = startVertex + k * 2 + 1
        const c = startVertex + (k + 1) * 2
        const d = startVertex + (k + 1) * 2 + 1
        indices.push(a, b, c)
        indices.push(b, d, c)
      }

      const endVertex = positions.length / 3
      edgeIds.push(lane.edgeId)
      edgeVertexRanges.push(startVertex, endVertex)
    }
  }

  const vertexCount = positions.length / 3
  const geometry: PathGeometryPacket = {
    positions: new Float32Array(positions),
    // 扁带贴地、法线恒为地面法线 (0,1,0)，按顶点复制三份。
    normals: fillGroundNormal(vertexCount),
    pathU: new Float32Array(pathU),
    flowDirections: new Float32Array(flowDirections),
    indices: new Uint32Array(indices),
    edgeVertexRanges: new Uint32Array(edgeVertexRanges),
  }

  validateGeometry(geometry, edgeIds.length)

  return { geometry, edgeIds }
}

/** 由 offsetSign 与带宽派生近/远有符号展开距离。 */
function laneExpansion(offsetSign: number, halfWidth: number, offsetM: number): LaneExpansion {
  // 展开等价于先把中心线侧向平移 offsetSign×offsetM，再以 halfWidth 对称展开。
  // 近侧 = 平移 − halfWidth，远侧 = 平移 + halfWidth；单向组 offsetSign=0 退化为对称展开。
  const shift = offsetSign * offsetM
  return { expandNear: shift - halfWidth, expandFar: shift + halfWidth }
}

/**
 * 在地图 XY 平面把一条车道的中心线展开为横截面序列。
 *
 * 切线/法线约定：
 * - 端点切线取唯一相邻段方向；内部点取入向 t1、出向 t2。
 * - 左法线 perp(t) = (−t.y, t.x)。近/远顶点 = P + expandNear/Far × 法线。
 * - 斜接比例 = 1 / dot(bisector, t1) = 1/cos(θ/2)，θ 为入出向夹角。
 *
 * 边界条件：
 * - 采样器保证 points.length ≥ 2 且相邻点不重合，故切线长度恒为正。
 * - bisector 退化（180° 折返）或比例超限时切换为斜切：该点输出两份横截面，
 *   分别使用入向、出向法线，由统一的相邻 Quad 规则自动缝合。
 */
function compileLane(
  centerline: SampledPath,
  expansion: LaneExpansion,
  flowDirection: number,
  ribbonConfig: PathRibbonConfig,
): { sections: CrossSection[] } {
  void flowDirection // 流向以常量写入顶点，不参与横截面几何。
  const pts = centerline.points
  const n = pts.length

  const tangents = computeTangents(pts)
  const pathU = computeArcLength(pts)

  const sections: CrossSection[] = []
  // 每个原始点贡献 1 份（miter/端点）或 2 份（bevel）横截面。
  for (let i = 0; i < n; i += 1) {
    const p = pts[i]
    const u = pathU[i]
    const { inTangent: t1, outTangent: t2 } = tangents[i]

    if (i === 0 || i === n - 1) {
      // 端点：入出向相等，取单一法线，无折角。
      pushSection(sections, p, perpendicular(t1), expansion, u)
      continue
    }

    const bisectorX = t1.x + t2.x
    const bisectorY = t1.y + t2.y
    const bisectorLen = Math.hypot(bisectorX, bisectorY)

    // bisector 退化（t2 ≈ −t1，180° 折返）时无法定义斜接方向，直接走斜切。
    if (bisectorLen < MITER_DEGENERATE_EPSILON) {
      pushSection(sections, p, perpendicular(t1), expansion, u)
      pushSection(sections, p, perpendicular(t2), expansion, u)
      continue
    }

    const bx = bisectorX / bisectorLen
    const by = bisectorY / bisectorLen
    const ratio = 1 / (bx * t1.x + by * t1.y)
    if (ratio <= ribbonConfig.miterLimitRatio) {
      // 斜接：法线乘以比例延伸到内外边交点。
      const miterX = -by * ratio
      const miterY = bx * ratio
      pushSection(sections, p, { x: miterX, y: miterY }, expansion, u)
    } else {
      // 斜切：入向、出向各一份横截面，二者之间的 Quad 自动填充外侧缺口。
      pushSection(sections, p, perpendicular(t1), expansion, u)
      pushSection(sections, p, perpendicular(t2), expansion, u)
    }
  }

  return { sections }
}

/** bisector 长度低于该阈值视为退化（180° 折返），避免除零与方向不确定。 */
const MITER_DEGENERATE_EPSILON = 1e-9

/** 追加一份横截面：近/远顶点 = P + expandNear/Far × normal。 */
function pushSection(
  sections: CrossSection[],
  p: Point2,
  normal: Point2,
  expansion: LaneExpansion,
  pathU: number,
): void {
  sections.push({
    near: { x: p.x + expansion.expandNear * normal.x, y: p.y + expansion.expandNear * normal.y },
    far: { x: p.x + expansion.expandFar * normal.x, y: p.y + expansion.expandFar * normal.y },
    pathU,
  })
}

/** 单位左法线：perp(t) = (−t.y, t.x)，要求 t 已归一化。 */
function perpendicular(t: Point2): Point2 {
  return { x: -t.y, y: t.x }
}

/**
 * 计算每个中心线点的入向与出向单位切线。
 *
 * 约定：
 * - 端点（i=0 或 i=n-1）只有一条邻段，入向与出向均取该段方向，二者相等。
 * - 内部点入向取 pts[i]-pts[i-1]，出向取 pts[i+1]-pts[i]。
 *
 * 入参点序列保证相邻点不重合，故各段长度为正，归一化安全；返回数组长度恒等于 pts.length。
 */
function computeTangents(pts: readonly Point2[]): PointTangent[] {
  const n = pts.length
  const result: PointTangent[] = []
  for (let i = 0; i < n; i += 1) {
    if (i === 0) {
      const t = normalize(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
      result.push({ inTangent: t, outTangent: t })
    } else if (i === n - 1) {
      const t = normalize(pts[n - 1].x - pts[n - 2].x, pts[n - 1].y - pts[n - 2].y)
      result.push({ inTangent: t, outTangent: t })
    } else {
      const inT = normalize(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      const outT = normalize(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
      result.push({ inTangent: inT, outTangent: outT })
    }
  }
  return result
}

/** 累计弧长：pathU[0]=0，pathU[i]=pathU[i-1]+|pts[i]-pts[i-1]|。 */
function computeArcLength(pts: readonly Point2[]): number[] {
  const result = new Array<number>(pts.length)
  result[0] = 0
  for (let i = 1; i < pts.length; i += 1) {
    result[i] = result[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  }
  return result
}

function normalize(x: number, y: number): Point2 {
  const len = Math.hypot(x, y)
  // 调用方保证 len > 0；保守地处理零长度，避免产生 NaN。
  if (len === 0) return { x: 1, y: 0 }
  return { x: x / len, y: y / len }
}

/** 生成全部为地面法线 (0,1,0) 的法线缓冲。 */
function fillGroundNormal(vertexCount: number): Float32Array {
  const normals = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i += 1) {
    normals[i * 3 + 1] = 1
  }
  return normals
}

/**
 * 校验扁带几何完整合法（SPEC §7.5、TASK-004）。
 * 任一位置/法线/弧长/流向非有限或索引越界，抛出可定位的几何编译错误。
 */
function validateGeometry(geometry: PathGeometryPacket, edgeCount: number): void {
  const vertexCount = geometry.positions.length / 3
  if (geometry.normals.length !== vertexCount * 3) {
    throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `法线数量与顶点数不匹配`)
  }
  if (geometry.pathU.length !== vertexCount) {
    throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `弧长数量与顶点数不匹配`)
  }
  if (geometry.flowDirections.length !== vertexCount) {
    throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `流向数量与顶点数不匹配`)
  }
  if (geometry.edgeVertexRanges.length !== edgeCount * 2) {
    throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `边顶点区间数量与边数不匹配`)
  }

  for (let i = 0; i < geometry.positions.length; i += 1) {
    if (!Number.isFinite(geometry.positions[i])) {
      throw new GeometryCompileError(
        'INVALID_RIBBON_GEOMETRY',
        `位置分量 #${i} 非有限值`,
      )
    }
  }
  for (let i = 0; i < geometry.pathU.length; i += 1) {
    if (!Number.isFinite(geometry.pathU[i])) {
      throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `弧长 #${i} 非有限值`)
    }
  }
  for (let i = 0; i < geometry.flowDirections.length; i += 1) {
    if (!Number.isFinite(geometry.flowDirections[i])) {
      throw new GeometryCompileError('INVALID_RIBBON_GEOMETRY', `流向 #${i} 非有限值`)
    }
  }

  // 索引全部落在顶点范围内。
  for (let i = 0; i < geometry.indices.length; i += 1) {
    const idx = geometry.indices[i]
    if (!Number.isFinite(idx) || idx < 0 || idx >= vertexCount) {
      throw new GeometryCompileError(
        'RIBBON_INDEX_OUT_OF_BOUNDS',
        `索引 #${i}=${idx} 越界（顶点数 ${vertexCount}）`,
      )
    }
  }

  // 每条边的顶点区间单调递增、非空且不越界。
  for (let e = 0; e < edgeCount; e += 1) {
    const start = geometry.edgeVertexRanges[e * 2]
    const end = geometry.edgeVertexRanges[e * 2 + 1]
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > vertexCount ||
      start >= end
    ) {
      throw new GeometryCompileError(
        'RIBBON_INDEX_OUT_OF_BOUNDS',
        `边 #${e} 顶点区间 [${start},${end}) 非法（顶点数 ${vertexCount}）`,
      )
    }
  }
}
