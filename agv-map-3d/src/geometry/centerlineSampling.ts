/*
 * 边中心线方向性采样、切线、弧长与车道偏移（geometry 层，SPEC 9.1 / 9.3 / 9.4 / 10.2）。
 *
 * 信任边界定位（TASK-006）：
 *   - 本模块只消费 TASK-005 的 SceneEdge（场景坐标 x/z），输出 LaneGeometry 的几何部分。
 *   - 它不决定车道偏移取值（由 trackGrouping 给出 0 / PAIRED_LANE_OFFSET），只负责把给定
 *     偏移沿“边自身行驶方向的左法线”精确应用到采样中心线上。
 *   - 不创建 Three / React / 浏览器对象；输出全是 number 精度的不可变数据。
 *
 * 方向性采样不变量（SPEC 9.1）：
 *   - LINE 固定 2 个中心线点 [S,E]；BEZIER 固定 t = i/32 产生 33 个点、32 段。
 *   - 点序永远保持“边自身 start → end”；isBackEdge 与车道分组都不反转点序。
 *   - 32 段 / 33 点在采样、诊断与测试中必须一致；禁止自适应采样。
 *
 * 左法线与车道偏移不变量（SPEC 9.3）：
 *   - 端点用首 / 尾段切线求左法线；内部点用相邻归一化切线之和求稳定切线，再取左法线。
 *   - 相邻切线和长度 < TANGENT_EPSILON 时视为 U 形折返，整体报错；
 *     禁止任取相邻段或零角度降级。
 *   - 左法线固定为 (tx,tz) → (-tz,tx)；成对反向边的左法线天然相反，所以两条中心线相距 0.06m。
 *
 * 零切线不变量（SPEC 5.3 第 10 项 / 9.4）：
 *   - 任一采样段长度 < TANGENT_EPSILON 视为零切线，整体报错。
 *   - 全部输出坐标、弧长、切线分量必须为有限数，否则整体报错（不输出部分车道）。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层 trackModel，不依赖上层。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { SceneEdge, ScenePoint } from '../domain/sceneMap'
import {
  BEZIER_POINT_COUNT,
  BEZIER_SEGMENTS,
  PAIRED_LANE_OFFSET,
  TANGENT_EPSILON,
} from './trackModel'
import type { LaneGeometry } from './trackModel'

/*
 * 几何层逻辑路径前缀：几何错误发生在已转换的 SceneEdge 上，不再对应原始 JSON path。
 * 用稳定的逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const EDGE_LOGICAL_PATH = 'sceneMap.edges'

/*
 * 构造“零切线 / U 形折返 / 非有限几何”统一错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 失败时整体拒绝，不返回部分车道几何。
 */
function geometryError(
  edgeId: string,
  message: string,
  context?: Readonly<Record<string, unknown>>,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: `${EDGE_LOGICAL_PATH}#${edgeId}`,
    entityId: edgeId,
    context,
  })
}

/*
 * 三次贝塞尔单点求值（SPEC 9.1 标准三次贝塞尔）。
 * 使用 t ∈ [0,1] 的多项式系数；不依赖自适应采样，保证 33 点确定性。
 * 输出仍为 number 精度的 ScenePoint；调用方负责有限性校验。
 */
function cubicBezierAt(
  p0: ScenePoint,
  p1: ScenePoint,
  p2: ScenePoint,
  p3: ScenePoint,
  t: number,
): ScenePoint {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  }
}

/*
 * 方向性采样中心线（SPEC 9.1）。
 *
 * - LINE：直接返回 [start, end]，2 个点。
 * - BEZIER：按 t = i / BEZIER_SEGMENTS（i = 0..32）产生 BEZIER_POINT_COUNT（33）个点。
 *   固定 32 段；采样点序保持 start → end，与 isBackEdge 无关。
 *
 * 返回只读数组；坐标为 number 精度，未做任何舍入。
 */
export function sampleCenterline(edge: SceneEdge): readonly ScenePoint[] {
  if (edge.kind === 'line') {
    return [edge.start, edge.end]
  }
  const points: ScenePoint[] = new Array<ScenePoint>(BEZIER_POINT_COUNT)
  for (let i = 0; i <= BEZIER_SEGMENTS; i++) {
    const t = i / BEZIER_SEGMENTS
    points[i] = cubicBezierAt(
      edge.start,
      edge.control1,
      edge.control2,
      edge.end,
      t,
    )
  }
  return points
}

/*
 * 计算每段单位切线 + 零切线校验（SPEC 9.4 每段单位切线 / SPEC 5.3 第 10 项零切线）。
 *
 * segTangents[i] = normalize(points[i+1] - points[i])，长度 = points.length - 1。
 * 任一段长度 < TANGENT_EPSILON 视为零切线，整体报错；
 * 禁止取相邻段、零角度或其它降级。
 */
function computeSegmentTangents(
  edgeId: string,
  points: readonly ScenePoint[],
): readonly ScenePoint[] {
  const segTangents: ScenePoint[] = new Array<ScenePoint>(points.length - 1)
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dz = points[i + 1].z - points[i].z
    const len = Math.hypot(dx, dz)
    if (len < TANGENT_EPSILON) {
      throw geometryError(
        edgeId,
        `边中心线第 ${i} 段长度 ${len} 小于 ${TANGENT_EPSILON}m，存在零切线，不支持的车道几何。`,
        { segmentIndex: i, length: len },
      )
    }
    segTangents[i] = { x: dx / len, z: dz / len }
  }
  return segTangents
}

/*
 * 计算每个采样点的单位切线方向（用于推导车道左法线，SPEC 9.3）。
 *
 * - 端点：直接使用首 / 尾段切线。
 * - 内部点：normalize(segTangents[i-1] + segTangents[i])；和长度 < TANGENT_EPSILON
 *   视为 U 形折返，整体报错。
 *
 * 输出长度 = points.length，每个分量均为单位向量。
 */
function computePointTangents(
  edgeId: string,
  points: readonly ScenePoint[],
  segTangents: readonly ScenePoint[],
): readonly ScenePoint[] {
  const pointTangents: ScenePoint[] = new Array<ScenePoint>(points.length)
  const last = points.length - 1
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      pointTangents[0] = segTangents[0]
      continue
    }
    if (i === last) {
      pointTangents[last] = segTangents[last - 1]
      continue
    }
    // 内部点：相邻归一化切线之和求稳定切线方向（SPEC 9.3）。
    const sumX = segTangents[i - 1].x + segTangents[i].x
    const sumZ = segTangents[i - 1].z + segTangents[i].z
    const sumLen = Math.hypot(sumX, sumZ)
    if (sumLen < TANGENT_EPSILON) {
      throw geometryError(
        edgeId,
        `边中心线内部点 ${i} 的相邻切线之和长度 ${sumLen} 小于 ${TANGENT_EPSILON}m，` +
          '存在 U 形折返，不支持的车道几何。',
        { pointIndex: i, sumLength: sumLen },
      )
    }
    pointTangents[i] = { x: sumX / sumLen, z: sumZ / sumLen }
  }
  return pointTangents
}

/*
 * 沿左法线应用车道偏移，得到偏移后中心线（SPEC 9.3）。
 *
 * 左法线固定 (tx,tz) → (-tz, tx)；laneOffset = 0 时偏移后中心线与原中心线重合。
 * 单边 laneOffset = 0；成对 laneOffset = PAIRED_LANE_OFFSET，两条反向边天然错开 0.06m。
 */
function applyLaneOffset(
  points: readonly ScenePoint[],
  pointTangents: readonly ScenePoint[],
  laneOffset: number,
): readonly ScenePoint[] {
  const offset: ScenePoint[] = new Array<ScenePoint>(points.length)
  for (let i = 0; i < points.length; i++) {
    const t = pointTangents[i]
    // 左法线 = (-tz, tx)。
    const leftX = -t.z
    const leftZ = t.x
    offset[i] = {
      x: points[i].x + laneOffset * leftX,
      z: points[i].z + laneOffset * leftZ,
    }
  }
  return offset
}

/*
 * 在偏移后中心线上计算每段单位切线与累计弧长（SPEC 10.2 偏移后折线 + 累计弧长复用）。
 *
 * - segmentTangents：偏移后折线每段单位切线，长度 = points.length - 1。
 *   边箭头按累计弧长定位段后直接复用，不再从原始边重新推导切线。
 * - cumulativeArcLength：从首点开始的累计弧长，长度 = points.length，首值 0。
 *   边箭头 tip 位于 totalArcLength × 0.40 处，必须基于偏移后折线弧长，而非贝塞尔参数。
 */
function computeArcLengthAndTangents(
  edgeId: string,
  points: readonly ScenePoint[],
): {
  readonly cumulativeArcLength: readonly number[]
  readonly segmentTangents: readonly ScenePoint[]
  readonly totalArcLength: number
} {
  const cumulativeArcLength: number[] = new Array<number>(points.length)
  const segmentTangents: ScenePoint[] = new Array<ScenePoint>(points.length - 1)
  cumulativeArcLength[0] = 0
  let arc = 0
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dz = points[i + 1].z - points[i].z
    const len = Math.hypot(dx, dz)
    // 偏移后折线段退化为零也视为不支持的车道几何（捕获极端输入）。
    if (len < TANGENT_EPSILON) {
      throw geometryError(
        edgeId,
        `偏移后中心线第 ${i} 段长度 ${len} 小于 ${TANGENT_EPSILON}m，存在零切线，不支持的车道几何。`,
        { segmentIndex: i, length: len },
      )
    }
    segmentTangents[i] = { x: dx / len, z: dz / len }
    arc += len
    cumulativeArcLength[i + 1] = arc
  }
  return {
    cumulativeArcLength,
    segmentTangents,
    totalArcLength: arc,
  }
}

/*
 * 断言全部输出为有限数（SPEC 16：任何 NaN/Infinity 立即构建失败）。
 * 逐一检查点坐标、累计弧长与切线分量，发现非有限值立即整体报错。
 */
function assertFiniteGeometry(
  edgeId: string,
  points: readonly ScenePoint[],
  cumulativeArcLength: readonly number[],
  segmentTangents: readonly ScenePoint[],
  totalArcLength: number,
): void {
  for (let i = 0; i < points.length; i++) {
    if (!Number.isFinite(points[i].x) || !Number.isFinite(points[i].z)) {
      throw geometryError(edgeId, '车道中心线坐标含非有限数。', {
        pointIndex: i,
        x: points[i].x,
        z: points[i].z,
      })
    }
    if (!Number.isFinite(cumulativeArcLength[i])) {
      throw geometryError(edgeId, '车道中心线累计弧长含非有限数。', {
        pointIndex: i,
        arc: cumulativeArcLength[i],
      })
    }
  }
  for (let i = 0; i < segmentTangents.length; i++) {
    if (
      !Number.isFinite(segmentTangents[i].x) ||
      !Number.isFinite(segmentTangents[i].z)
    ) {
      throw geometryError(edgeId, '车道中心线切线分量含非有限数。', {
        segmentIndex: i,
        x: segmentTangents[i].x,
        z: segmentTangents[i].z,
      })
    }
  }
  if (!Number.isFinite(totalArcLength)) {
    throw geometryError(edgeId, '车道中心线总弧长非有限。', { totalArcLength })
  }
}

/*
 * 单条边的方向性车道几何构建（SPEC 9.1 / 9.3 / 10.2）。
 *
 * 调用方契约：
 *   - edge 是 TASK-005 交付的 SceneEdge；laneOffset 由 trackGrouping 决定（0 或 PAIRED_LANE_OFFSET）。
 *   - 成功返回 LaneGeometry（除 paired 外的全部几何字段）；失败抛出 MAP_GEOMETRY_INVALID。
 *   - paired 由调用方（buildTrackModel）按分组结果填入；本函数不查分组表。
 *
 * 几何流水：
 *   原始中心线采样 → 每段切线（零切线校验）→ 每点切线（U 形校验）
 *     → 沿左法线应用 laneOffset → 偏移后折线切线 + 累计弧长 → 有限性校验。
 */
export function buildLaneGeometry(
  edge: SceneEdge,
  laneOffset: number,
): Omit<LaneGeometry, 'paired'> {
  // 1. 方向性采样：LINE 2 点，BEZIER 33 点；点序保持 start → end。
  const centerline = sampleCenterline(edge)

  // 2. 每段单位切线 + 零切线校验（基于原始中心线，决定后续法线方向）。
  const segTangents = computeSegmentTangents(edge.id, centerline)

  // 3. 每点单位切线方向（端点用单段，内部用相邻切线和；U 形折返校验）。
  const pointTangents = computePointTangents(edge.id, centerline, segTangents)

  // 4. 沿左法线应用车道偏移；laneOffset = 0 时偏移后中心线与原中心线一致。
  const offsetPoints = applyLaneOffset(centerline, pointTangents, laneOffset)

  // 5. 偏移后折线的每段切线 + 累计弧长（边箭头 / ribbon / 标签共同复用）。
  const { cumulativeArcLength, segmentTangents, totalArcLength } =
    computeArcLengthAndTangents(edge.id, offsetPoints)

  // 6. 有限性校验：任一 NaN / Infinity 立即整体失败。
  assertFiniteGeometry(
    edge.id,
    offsetPoints,
    cumulativeArcLength,
    segmentTangents,
    totalArcLength,
  )

  return {
    edgeId: edge.id,
    kind: edge.kind === 'line' ? 'line' : 'cubic',
    isBackEdge: edge.isBackEdge,
    points: offsetPoints,
    cumulativeArcLength,
    segmentTangents,
    totalArcLength,
    laneOffset,
  }
}

/*
 * 重新导出 PAIRED_LANE_OFFSET，供 buildTrackModel 决定成对边偏移时引用同一常量。
 */
export { PAIRED_LANE_OFFSET }
