/*
 * 边标签定位纯函数（labels 层，SPEC 5.2 / 7.1 / 9.3 / 11.2 / 16）。
 *
 * 信任边界定位（TASK-011）：
 *   - 本模块消费 TASK-005 交付的不可变 SceneEdge（坐标已一次性转换到场景系 x/z）与
 *     TASK-006 确认的车道偏移标量 laneOffset，输出该边的 LabelDescriptor。
 *   - 纯数值逻辑：不创建 Troika Text / Three / React / 浏览器对象，也不读写全局状态。
 *   - 本模块与 nodeLabel 相互独立：节点与边标签的定位公式由两个纯函数分别实现，
 *     禁止用包含隐式类型分支的巨型逻辑合并两套规则（SPEC 11.2 / 任务约束）。
 *
 * 来源点不变量（SPEC 11.2 / 任务约束）：
 *   - LINE 标签来源点为边几何 1/3 处（start + (end - start) × 1/3）。
 *   - BEZIER 标签来源点为标准三次贝塞尔参数 t = 2/3 处（多项式求值，不得用弧长 2/3 替代）。
 *   - 来源点取自边自身控制点（边几何），不从节点坐标或偏移中心线推导。
 *
 * 车道偏移复用不变量（SPEC 9.3 / 11.2 / 任务约束）：
 *   - laneOffset 是 TASK-006 确认的标量（单边 0、成对 PAIRED_LANE_OFFSET = 0.03），
 *     由上层从 TrackModel 提取后直接传入；本模块不重新判断轨迹是否重合，也不导入 geometry。
 *   - 偏移方向 = 来源点处行驶方向的左法线 (-tz, tx)，与 ribbon / 边箭头同源 SPEC 9.3。
 *   - 成对两条边的行驶方向相反，左法线天然相反，因此两条标签中心相距 2 × laneOffset = 0.06m，
 *     与 ribbon / 边箭头共享同一车道偏移事实，不会只偏移 ribbon 而留下标签。
 *
 * 平面偏移不变量（SPEC 11.2）：
 *   - 车道偏移后再在场景平面加 (x + 0.20, z + 0.20)；Y 固定 0.250。
 *   - 边标签局部屏幕偏移为 (0, 0)：平面偏移已烘焙进世界锚点，不再叠加屏幕位移。
 *
 * 异常不变量（SPEC 5.3 第 10 项 / 16 / 任务约束）：
 *   - 来源点、切线、车道偏移或锚点任一非有限时整体失败：抛出 MAP_GEOMETRY_INVALID，
 *     不返回部分描述符、不跳过边、不补默认值。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain（MapDataError / SceneEdge）与本层 labelDescriptor。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { SceneBezierEdge, SceneEdge, ScenePoint } from '../domain/sceneMap'
import { LABEL_ANCHOR_Y } from './labelDescriptor'
import type { LabelDescriptor } from './labelDescriptor'

/*
 * SPEC 11.2：LINE 标签来源点比例 = 边几何 1/3 处。
 * 来源点 = start + (end - start) × (1/3)，取自边自身端点。
 */
const LINE_LABEL_SOURCE_RATIO = 1 / 3

/*
 * SPEC 11.2：BEZIER 标签来源点参数 t = 2/3（标准三次贝塞尔参数，非弧长比例）。
 * 多项式求值 B(2/3)；严禁用累计弧长 2/3 处替代参数 2/3 处。
 */
const BEZIER_LABEL_SOURCE_T = 2 / 3

/*
 * SPEC 11.2：边标签场景平面固定偏移（米）。车道偏移后再加 (x + 0.20, z + 0.20)，
 * 使标签偏离边线一定距离以提升可读性；单边与成对边都应用同一固定偏移。
 */
const EDGE_LABEL_PLANE_OFFSET_X = 0.2
const EDGE_LABEL_PLANE_OFFSET_Z = 0.2

/*
 * SPEC 5.3 第 10 项：切线退化阈值（米）。
 * 来源点处切线长度小于本值视为零切线，整体报错（与 centerlineSampling / TANGENT_EPSILON 同源 SPEC，
 * 单独定义避免跨层导入 geometry）。
 */
const LABEL_TANGENT_EPSILON = 1e-9

/*
 * 边标签描述符稳定 ID 前缀。
 * 基于实体身份（边 ID）构造，不依赖数组下标；与节点标签 ID 命名空间隔离，保证全集合唯一。
 */
const EDGE_LABEL_ID_PREFIX = 'edge-label:'

/*
 * 几何层逻辑路径前缀：边标签错误发生在已转换的 SceneEdge 上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const EDGE_LABEL_LOGICAL_PATH = 'sceneMap.edges#label'

/*
 * 构造边标签错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分描述符；message 含可读中文，便于 overlay 与测试匹配。
 */
function edgeLabelError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
  entityId?: string | null,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: EDGE_LABEL_LOGICAL_PATH,
    entityId: entityId ?? null,
    context,
  })
}

/*
 * 三次贝塞尔单点求值（SPEC 9.1 标准三次贝塞尔，与 centerlineSampling 同口径）。
 * 使用 t ∈ [0,1] 的多项式系数；输出 number 精度的 ScenePoint，调用方负责有限性校验。
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
 * 三次贝塞尔一阶导数求值（用于来源点处切线方向，进而求左法线）。
 * B'(t) = 3(1-t)²(P1-P0) + 6(1-t)t(P2-P1) + 3t²(P3-P2)。
 * 返回未归一化的导数向量；调用方归一化后取左法线 (-tz, tx)。
 */
function cubicBezierDerivative(
  p0: ScenePoint,
  p1: ScenePoint,
  p2: ScenePoint,
  p3: ScenePoint,
  t: number,
): ScenePoint {
  const mt = 1 - t
  const a = 3 * mt * mt
  const b = 6 * mt * t
  const c = 3 * t * t
  return {
    x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
    z: a * (p1.z - p0.z) + b * (p2.z - p1.z) + c * (p3.z - p2.z),
  }
}

/*
 * 边标签来源点与来源点处单位切线（SPEC 11.2 来源点 + 9.3 左法线方向）。
 *
 * - LINE：来源点 = start + (end - start) × (1/3)；切线 = normalize(end - start)。
 * - BEZIER：来源点 = cubicBezierAt(t=2/3)；切线 = normalize(cubicBezierDerivative(t=2/3))。
 *
 * 切线用于推导左法线，从而把 laneOffset 沿“自身行驶方向的左侧”应用到来源点。
 *
 * 异常不变量（SPEC 5.3 第 10 项 / 任务“非有限来源点”）：
 *   - 任一控制点非有限 → 来源点 / 切线含 NaN，由调用方有限性兜底捕获。
 *   - 切线长度 ≤ LABEL_TANGENT_EPSILON 视为零切线，整体报错；
 *     禁止取相邻方向或零角度降级。
 */
function computeEdgeLabelSource(
  edge: SceneEdge,
): { readonly source: ScenePoint; readonly tangent: ScenePoint } {
  if (edge.kind === 'line') {
    // LINE 来源点 = 1/3 处；切线 = 弦方向（常数）。
    const sx = edge.start.x
    const sz = edge.start.z
    const dx = edge.end.x - sx
    const dz = edge.end.z - sz
    const len = Math.hypot(dx, dz)
    if (!Number.isFinite(len) || len <= LABEL_TANGENT_EPSILON) {
      throw edgeLabelError(
        `边 ${edge.id} 弦长 ${len} 退化（非有限或 ≤ ${LABEL_TANGENT_EPSILON}m），无法计算标签来源点切线。`,
        { edgeId: edge.id, chord: len },
        edge.id,
      )
    }
    return {
      source: {
        x: sx + dx * LINE_LABEL_SOURCE_RATIO,
        z: sz + dz * LINE_LABEL_SOURCE_RATIO,
      },
      tangent: { x: dx / len, z: dz / len },
    }
  }

  // BEZIER 来源点 = 参数 t = 2/3 处（多项式求值，非弧长 2/3）；切线 = t=2/3 处导数。
  const bez = edge as SceneBezierEdge
  const source = cubicBezierAt(
    bez.start,
    bez.control1,
    bez.control2,
    bez.end,
    BEZIER_LABEL_SOURCE_T,
  )
  const derivative = cubicBezierDerivative(
    bez.start,
    bez.control1,
    bez.control2,
    bez.end,
    BEZIER_LABEL_SOURCE_T,
  )
  const len = Math.hypot(derivative.x, derivative.z)
  if (!Number.isFinite(len) || len <= LABEL_TANGENT_EPSILON) {
    throw edgeLabelError(
      `边 ${edge.id} 在参数 t=${BEZIER_LABEL_SOURCE_T} 处切线长度 ${len} 退化（非有限或 ≤ ${LABEL_TANGENT_EPSILON}m），无法计算标签来源点切线。`,
      { edgeId: edge.id, t: BEZIER_LABEL_SOURCE_T, tangentLength: len },
      edge.id,
    )
  }
  return {
    source,
    tangent: { x: derivative.x / len, z: derivative.z / len },
  }
}

/*
 * 边标签定位纯函数（SPEC 11.2）。
 *
 * 调用方契约：
 *   - edge 是 TASK-005 交付的 SceneEdge（场景坐标 x/z，实体语义已校验）。
 *   - laneOffset 是 TASK-006 确认的车道偏移标量（单边 0、成对 PAIRED_LANE_OFFSET），
 *     由上层从 TrackModel 提取；本函数不重新判断重合、不导入 geometry。
 *   - 成功返回 LabelDescriptor（kind = 'edge'）；失败抛出 MAP_GEOMETRY_INVALID（整体拒绝）。
 *
 * 定位流水：
 *   1. laneOffset 有限性校验。
 *   2. 来源点 + 来源点处单位切线（LINE 1/3、BEZIER t=2/3）。
 *   3. 左法线 = (-tz, tx)；来源点沿左法线偏移 laneOffset（复用 TASK-006 车道偏移标量）。
 *   4. 世界锚点 = (offsetSource.x + 0.20, 0.250, offsetSource.z + 0.20)。
 *   5. 局部屏幕偏移 = (0, 0)。
 *   6. 来源点 / 偏移 / 锚点有限性兜底。
 */
export function buildEdgeLabelDescriptor(
  edge: SceneEdge,
  laneOffset: number,
): LabelDescriptor {
  // 1. laneOffset 有限性校验（捕获上层传入 NaN / Infinity 的车道偏移）。
  if (!Number.isFinite(laneOffset)) {
    throw edgeLabelError(
      `边 ${edge.id} 车道偏移 ${laneOffset} 非有限，无法生成边标签。`,
      { edgeId: edge.id, laneOffset },
      edge.id,
    )
  }

  // 2. 来源点 + 来源点处单位切线（SPEC 11.2 来源点规则）。
  const { source, tangent } = computeEdgeLabelSource(edge)

  // 3. 左法线 (-tz, tx)，沿其偏移 laneOffset（SPEC 9.3 自身左侧车道偏移复用）。
  //    与 ribbon / 边箭头同源 SPEC 9.3 左法线约定；成对反向边天然错开 2 × laneOffset。
  const leftX = -tangent.z
  const leftZ = tangent.x
  const offsetSourceX = source.x + laneOffset * leftX
  const offsetSourceZ = source.z + laneOffset * leftZ

  // 4. 世界锚点：车道偏移后来源点 + 场景平面固定偏移 (0.20, 0.20)，Y = 0.250（SPEC 11.2）。
  const anchorX = offsetSourceX + EDGE_LABEL_PLANE_OFFSET_X
  const anchorZ = offsetSourceZ + EDGE_LABEL_PLANE_OFFSET_Z

  // 5. 有限性兜底（SPEC 16 / 任务“非有限来源点”异常路径）：
  //    来源点、车道偏移结果或锚点任一非有限立即整体失败，杜绝非有限数据泄漏到描述符。
  if (
    !Number.isFinite(source.x) ||
    !Number.isFinite(source.z) ||
    !Number.isFinite(offsetSourceX) ||
    !Number.isFinite(offsetSourceZ) ||
    !Number.isFinite(anchorX) ||
    !Number.isFinite(anchorZ)
  ) {
    throw edgeLabelError(
      `边 ${edge.id} 标签来源点或锚点含非有限数。`,
      {
        edgeId: edge.id,
        sourceX: source.x,
        sourceZ: source.z,
        offsetSourceX,
        offsetSourceZ,
        anchorX,
        anchorZ,
      },
      edge.id,
    )
  }

  return {
    id: EDGE_LABEL_ID_PREFIX + edge.id,
    ownerId: edge.id,
    kind: 'edge',
    text: edge.name,
    anchorX,
    anchorY: LABEL_ANCHOR_Y,
    anchorZ,
    // 边标签局部屏幕偏移为 (0, 0)：平面偏移 (0.20, 0.20) 已烘焙进世界锚点（SPEC 11.2）。
    localOffsetX: 0,
    localOffsetY: 0,
  }
}
