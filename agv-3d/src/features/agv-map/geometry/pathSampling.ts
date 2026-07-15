import type { DirectedEdge, DirectedPath, Point2 } from '../domain/domainModel'
import type { SamplingConfig } from '../config/geometryConfig'

/**
 * 路径采样：将 LINE 与三次贝塞尔统一为有序采样点（SPEC §7.3）。
 *
 * 不变量：
 * - 纯函数：相同输入与相同配置产生字节级稳定的输出，不读取系统时间、
 *   随机源或任何展示状态（SPEC §7.1）。
 * - 方向稳定：采样点始终从 sourceNodeId 指向 targetNodeId。LINE 直出起终点；
 *   BEZIER 以确定性的 de Casteljau 中点递归细分，从起点向终点推进。
 * - 端点完整：采样结果首点恒为路径起点、末点恒为路径终点。
 * - 三约束同时成立：每个 BEZIER 叶段必须同时满足最大弦长与最大平坦度，
 *   仅当二者都达标才接受；递归深度上限只作为有限性保证，不作为合格判据。
 *   达到深度上限仍未满足约束时属于病理输入，抛出可定位错误终止编译，
 *   不返回假合格段、不退化为 LINE（SPEC §7.3、TASK-002 实现约束）。
 * - 零长度禁止：相邻采样点不得重合，否则抛出可定位的几何编译错误，
 *   不删除重合点后继续、不静默跳过（SPEC §7.3、TASK-002）。
 */

/** 一条路径的采样结果。点序列至少 2 个，沿源→目标方向。 */
export interface SampledPath {
  readonly points: readonly Point2[]
}

/**
 * 一条有向边采样后与其拓扑信息的绑定结果，供下游车道分组与中心计算消费。
 * 携带 sourceNodeId/targetNodeId 使车道分组能依据反向拓扑关系配对，无需回查原始 DTO，
 * 保持几何层与领域层之间的单向依赖（SPEC §5.1）。
 */
export interface SampledEdge {
  readonly edgeId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly path: SampledPath
}

/** 几何编译错误码封闭联合。 */
export type GeometryErrorCode =
  | 'ZERO_LENGTH_SAMPLE_SEGMENT'
  | 'BEZIER_SUBDIVISION_LIMIT_REACHED'
  | 'EMPTY_COMPUTE_BOUNDS'
  | 'INVALID_RIBBON_GEOMETRY'
  | 'RIBBON_INDEX_OUT_OF_BOUNDS'

/**
 * 几何编译错误。携带错误码与可定位上下文（边 id、采样点序号），
 * 便于加载状态机映射为稳定的 GEOMETRY_COMPILE_FAILED 状态（SPEC §10.2）。
 *
 * 字段显式声明并在构造体中赋值，避免 erasableSyntaxOnly 禁止的构造参数属性。
 */
export class GeometryCompileError extends Error {
  readonly code: GeometryErrorCode
  readonly edgeId: string | undefined
  readonly pointIndex: number | undefined

  constructor(
    code: GeometryErrorCode,
    message: string,
    edgeId?: string,
    pointIndex?: number,
  ) {
    super(message)
    this.name = 'GeometryCompileError'
    this.code = code
    this.edgeId = edgeId
    this.pointIndex = pointIndex
  }

  /** 返回附带边 id 的新实例，保持不可变语义，供批量采样补充定位信息。 */
  withEdgeId(edgeId: string): GeometryCompileError {
    return new GeometryCompileError(
      this.code,
      `${this.message}（edge=${edgeId}）`,
      edgeId,
      this.pointIndex,
    )
  }
}

/**
 * 对单条有向路径采样。LINE 直出起终点；BEZIER 按配置递归细分。
 * 出现零长度采样段时抛出 GeometryCompileError（不带边 id，由批量入口补充）。
 */
export function samplePath(path: DirectedPath, config: SamplingConfig): SampledPath {
  const points = collectPoints(path, config)
  assertNoZeroLength(points)
  return { points }
}

/**
 * 批量采样全部有向边，按输入顺序返回绑定结果。
 * 任一边出现零长度段时终止编译并抛出携带边 id 的 GeometryCompileError。
 */
export function sampleEdges(edges: readonly DirectedEdge[], config: SamplingConfig): SampledEdge[] {
  const result: SampledEdge[] = []
  for (const edge of edges) {
    try {
      result.push({
        edgeId: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        path: samplePath(edge.path, config),
      })
    } catch (error) {
      // 单条采样错误补充边 id 后向上传播，使加载层能定位到具体边。
      if (error instanceof GeometryCompileError && error.edgeId === undefined) {
        throw error.withEdgeId(edge.id)
      }
      throw error
    }
  }
  return result
}

function collectPoints(path: DirectedPath, config: SamplingConfig): Point2[] {
  if (path.kind === 'line') {
    // LINE 直接生成起点与终点；校验层已保证起终点不重合（SPEC §4.4 ZERO_LENGTH_LINE）。
    return [path.start, path.end]
  }
  // BEZIER：首点为起点，递归细分不断追加子段终点，末点恒为路径终点。
  const points: Point2[] = [path.start]
  flattenCubicBezier(
    path.start,
    path.control1,
    path.control2,
    path.end,
    0,
    config,
    points,
  )
  return points
}

/**
 * 三次贝塞尔的确定性递归细分（de Casteljau 中点切分）。
 *
 * 合格判据（必须同时成立，TASK-002 实现约束）：
 * - 当前子段弦长 ≤ maxChordLengthM；
 * - 控制点到弦的平坦度偏差 ≤ maxFlatnessErrorM。
 *
 * 终止行为：
 * - 合格：把子段终点追加到 points，子段不再细分；
 * - 仍不合格但未达深度上限：在 t=0.5 处切分为左右两条三次贝塞尔继续细分；
 * - 仍不合格且已达 maxRecursionDepth：属于病理输入，抛出 GeometryCompileError
 *   终止整条边的编译，不接受假合格段、不退化、不静默跳过（SPEC §7.3、TASK-002）。
 *   抛出时 points 中已追加的局部点随调用栈一同丢弃，不产生部分采样结果。
 *
 * maxRecursionDepth 仅作为有限性安全上限，不是合格判据：深度耗尽本身不使段合格。
 * 合格段无论在何深度都接受，保证正常曲线在远低于上限处自然终止（V76 全部 109 条
 * 贝塞尔实测最大递归深度远小于 12，由 samplingIntegration.test.ts 平坦度断言守护）。
 */
function flattenCubicBezier(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2,
  depth: number,
  config: SamplingConfig,
  points: Point2[],
): void {
  const chord = distance(p0, p3)
  const flatness = bezierFlatness(p0, p1, p2, p3)
  const flatEnough =
    chord <= config.maxChordLengthM && flatness <= config.maxFlatnessErrorM
  if (flatEnough) {
    points.push(p3)
    return
  }
  // 三约束未同时满足且已达深度上限：病理输入，终止编译并提供可定位错误。
  // depth 从 0 起计，maxRecursionDepth=0 表示根调用即不允许再细分。
  if (depth >= config.maxRecursionDepth) {
    throw new GeometryCompileError(
      'BEZIER_SUBDIVISION_LIMIT_REACHED',
      `贝塞尔递归细分达到深度上限 ${config.maxRecursionDepth} 仍未满足平坦度约束`
        + `（depth=${depth}，chord=${chord}m，flatness=${flatness}m）`,
      undefined,
      undefined,
    )
  }

  // de Casteljau 在 t=0.5 处切分为左右两条三次贝塞尔；分量级运算保证确定性。
  const q0 = midpoint(p0, p1)
  const q1 = midpoint(p1, p2)
  const q2 = midpoint(p2, p3)
  const r0 = midpoint(q0, q1)
  const r1 = midpoint(q1, q2)
  const s = midpoint(r0, r1)

  flattenCubicBezier(p0, q0, r0, s, depth + 1, config, points)
  flattenCubicBezier(s, r1, q2, p3, depth + 1, config, points)
}

/**
 * 控制点到弦 p0-p3 的最大距离，作为曲线与弦的平坦度度量（单位米）。
 * 弦退化为点时改用控制点到端点的欧氏距离，避免除零并保持度量语义。
 */
function bezierFlatness(p0: Point2, p1: Point2, p2: Point2, p3: Point2): number {
  const dx = p3.x - p0.x
  const dy = p3.y - p0.y
  const chordLenSq = dx * dx + dy * dy
  if (chordLenSq === 0) {
    return Math.max(distance(p1, p0), distance(p2, p0))
  }
  const chordLen = Math.sqrt(chordLenSq)
  // 二维叉积绝对值 / 弦长 = 点到弦所在直线的垂直距离。
  const d1 = Math.abs(dx * (p0.y - p1.y) - dy * (p0.x - p1.x)) / chordLen
  const d2 = Math.abs(dx * (p0.y - p2.y) - dy * (p0.x - p2.x)) / chordLen
  return Math.max(d1, d2)
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Point2, b: Point2): Point2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * 校验相邻采样点不重合（SPEC §7.3、TASK-002）。
 * 用坐标精确相等判定零长度段，避免阈值带来的歧义。
 */
function assertNoZeroLength(points: Point2[]): void {
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]
    const curr = points[i]
    if (prev.x === curr.x && prev.y === curr.y) {
      throw new GeometryCompileError(
        'ZERO_LENGTH_SAMPLE_SEGMENT',
        `第 ${i} 段采样点与前一点重合（${curr.x}, ${curr.y}）`,
        undefined,
        i,
      )
    }
  }
}
