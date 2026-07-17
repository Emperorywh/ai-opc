/*
 * 边方向箭头实例数据生成（geometry 层，SPEC 2.3 / 2.4 / 2.6 / 5.2 / 7.1 / 7.2 / 9 / 10 / 15.2 / 15.3 / 16）。
 *
 * 信任边界定位（TASK-010）：
 *   - 本模块消费 TASK-006 交付的 LaneGeometry（偏移后折线 + 累计弧长 + 段切线 + isBackEdge 颜色语义），
 *     输出可供单一边箭头 InstancedMesh 直接消费的实例矩阵、线性颜色 typed array、真实几何
 *     bounds 与诊断计数；主线程只把结果填入 InstancedMesh，不再回读边 DTO 或重复推导。
 *   - 纯数值逻辑：不创建 Three BufferGeometry / Material / Mesh，也不依赖 R3F / React /
 *     浏览器 API。基准三角形以纯数据导出，渲染层负责据此构造共享 BufferGeometry。
 *
 * 唯一车道事实来源不变量（SPEC 9.3 / 10.2 / 任务约束）：
 *   - 箭头复用 LaneGeometry 的偏移后折线与累计弧长，不重新采样、不重新判断重合轨迹、
 *     不让箭头留在未偏移中心线上。tip 定位、切线取值与 ribbon / 边标签共享同一份车道数据。
 *   - 双车道成对边的 laneOffset 已在 LaneGeometry.points 中体现；本模块不再计算偏移，
 *     成对两条边的箭头天然落在各自 0.03m 偏移的车道上。
 *
 * LINE / BEZIER 共享语义不变量（SPEC 10.1 / 10.2 / 任务约束）：
 *   - LINE 与 BEZIER 共用一个局部朝 +X 的单位三角形 EDGE_ARROW_VERTICES 和同一套实例数据契约，
 *     不按边类型产生两套箭头语义。差异只在 LaneGeometry 自身的点数（LINE 2 点 / BEZIER 33 点），
 *     对本模块而言都是“沿偏移折线按累计弧长定位 tip 并取段切线”。
 *
 * 弧长定位不变量（SPEC 10.2 / 任务约束）：
 *   - tip 固定位于总弧长的 40% 处，必须按累计弧长定位（在偏移后折线上找包含目标弧长的段并插值）。
 *   - 严禁把贝塞尔参数 t = 0.4 当成弧长比例：参数均匀不代表弧长均匀，本模块只认累计弧长。
 *   - 定位段取该段累计弧长端点做线性插值得到 tip 坐标，切线直接复用该段单位切线 segmentTangents[i]。
 *
 * 短边自适应长度不变量（SPEC 10.2 / 任务约束）：
 *   - 箭头长度 L = min(0.30m, totalArcLength × 0.32)；X/Z 等比缩放（半宽 0.55L）。
 *   - 短边不得使用固定 0.30m：0.04m 最短边 L = 0.0128m，tip 位于 0.016m 弧长处，
 *     箭身末尾在 0.016 - 0.0128 = 0.0032m > 0 处，不越过起点。
 *   - 0.32 < 0.40 保证箭身末尾弧长 = (0.40 - 0.32) × total = 0.08 × total > 0，恒不越过起点。
 *
 * 切线方向与旋转不变量（SPEC 10.2 / 任务约束）：
 *   - 箭头始终从边自身 start 指向 end；方向取自偏移折线 tip 所在段的单位场景切线 (tx,tz)。
 *   - 旋转 yaw = atan2(-tz, tx)：使局部 +X（tip 朝向）经 Ry(yaw) 后对齐行驶方向 (tx,tz)。
 *   - isBackEdge 只选择颜色，不改变点序、切线、旋转、位置或配对判断。
 *
 * 矩阵列主序不变量（SPEC 5.2 / 10.2，Three.js Matrix4.toArray 兼容）：
 *   - 16 元素列主序，组合顺序固定 T × R × S；平移位于索引 12 / 13 / 14。
 *   - S = diag(L, 1, L)：X/Z 按箭头长度 L 等比缩放；Y 不缩放（三角形顶点 y 恒为 0）。
 *   - R = Ry(yaw) 写入：m[0] = cos·L、m[2] = -sin·L、m[8] = sin·L、m[10] = cos·L，
 *     其余旋转分量恒为 0；与 Three.js makeRotationY 列主序完全一致。
 *   - T = (tipX, 0.014, tipZ)：Y 为 SPEC 7.1 Edge Arrow Y；tipX/tipZ 来自弧长定位，不再做坐标转换。
 *
 * 范围贡献不变量（SPEC 12.1 / 任务约束）：
 *   - bounds 为全部箭头真实变换后顶点的紧致轴对齐包围盒（minY = maxY = Edge Arrow Y），
 *     供后续 computeContentBounds 合并 ribbon / 两类箭头 / 节点圆柱的真实几何范围。
 *
 * 异常不变量（SPEC 5.3 第 10 项 / 14.1 / 16 / 任务约束）：
 *   - 切线长度 ≤ TANGENT_EPSILON、累计弧长无效（非有限 / ≤ 阈值）、车道结构不一致、
 *     非有限采样点或任何输出非有限时整体失败：抛出 MAP_GEOMETRY_INVALID，不返回部分实例数组，
 *     不选择相邻段、零角度或其它降级。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层（colorSpace / trackModel）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NumericBox3 } from '../domain/sceneMap'
import { hexToLinearRGB } from './colorSpace'
import type { LaneGeometry } from './trackModel'
import { TANGENT_EPSILON } from './trackModel'

/*
 * SPEC 10.1：边箭头共享基准三角形（局部朝 +X，位于 XZ 平面）。
 * 顶点顺序 [tip, right, left] 从 +Y 观察为逆时针，正面朝上：
 *   - tip   = ( 0, 0,  0.00)：箭尖位于局部原点。
 *   - right = (-1, 0, -0.55)：右后角，箭身沿 -X 后伸、-Z 侧。
 *   - left  = (-1, 0,  0.55)：左后角，箭身沿 -X 后伸、+Z 侧。
 * 三角形为“单位尺度”（箭身长 1、半宽 0.55），具体尺寸由实例矩阵的 X/Z 缩放（= 箭头长度 L）赋予；
 * tip 位于原点意味着实例平移即 tip 世界坐标。顶点本身不含方向，每个实例只在矩阵中旋转一次。
 * 渲染层据此构造共享非索引 BufferGeometry（属性 itemSize = 3），LINE 与 BEZIER 共用同一几何。
 */
export const EDGE_ARROW_VERTICES: readonly number[] = [
  0, 0, 0,
  -1, 0, -0.55,
  -1, 0, 0.55,
]

/*
 * SPEC 7.1：Edge Arrow Y（米）。箭头实例平移 Y 固定 0.014，位于 Ribbon Y（0.006）之上、
 * 节点底面（0.010）之下，避免与 ribbon 共面闪烁。该值同时作为 bounds 的 minY / maxY。
 * 与 config 视觉常量同源 SPEC 7.1，两层各自引用同一规格，不形成第二套语义。
 */
const EDGE_ARROW_Y = 0.014

/*
 * SPEC 10.2：箭头最大长度（米）。长边箭头不超过 0.30m；短边按弧长比例收缩。
 * 与 config 视觉常量同源 SPEC 7.1 边箭头最大长度，两层各自引用同一规格。
 */
const EDGE_ARROW_MAX_LENGTH = 0.30

/*
 * SPEC 10.2：短边自适应长度比例。箭长 = min(0.30, totalArcLength × 0.32)。
 * - 0.32 < 0.40（tip 弧长比例）保证最短 0.04m 直线的箭身不会越过起点。
 * - 0.04m 边：L = 0.0128m，tip 位于 0.016m，箭身末尾 0.0032m > 0。
 */
const EDGE_ARROW_LENGTH_RATIO = 0.32

/*
 * SPEC 10.2：tip 弧长定位比例。tip 位于总弧长 40% 处（按累计弧长，非贝塞尔参数 t）。
 * 0.40 > 0.32 保证箭身末尾弧长恒为正，不越过边起点。
 */
const EDGE_ARROW_TIP_ARC_RATIO = 0.40

/*
 * SPEC 7.2 / 10.2：边箭头实例色 = 边色（仅由 isBackEdge 选择）。
 *   - isBackEdge = false：灰色 #BDBDBD。
 *   - isBackEdge = true：红色 #E57373。
 * 与 ribbon 颜色同源 SPEC 7.2 / 9.1，两层各自引用同一规格，不形成隐式第二套语义。
 * 颜色在模块加载时一次性线性化为 [0,1] sRGB 浮点，避免每实例重复转换。
 */
const EDGE_ARROW_FORWARD_COLOR = hexToLinearRGB('#BDBDBD')
const EDGE_ARROW_BACK_COLOR = hexToLinearRGB('#E57373')

/*
 * 几何层逻辑路径前缀：边箭头错误发生在已偏移的 LaneGeometry 上，不对应原始 JSON path。
 * 用稳定逻辑路径标识失败位置，使测试与诊断可定位，同时不伪造原始响应路径。
 */
const EDGE_ARROW_LOGICAL_PATH = 'sceneMap.edges#edgeArrow'

/*
 * 边箭头实例数据输出契约（SPEC 5.2 edgeArrowMatrices / edgeArrowColors /
 * SceneDiagnostics.edgeArrowCount / 12.1 contentBounds）。
 *
 * 字段语义：
 *   - matrices：列主序实例矩阵 Float32Array，长度 = arrowCount × 16，每个矩阵组合顺序
 *     T × R × S，平移位于索引 12 / 13 / 14。
 *   - colors：线性 sRGB [0,1] Float32Array，长度 = arrowCount × 3，元素序为 (r, g, b)。
 *   - arrowCount：箭头实例数（真实样本固定 3043，每条边恰一个），与 matrices / colors
 *     长度交叉一致；实例顺序与来源 LaneGeometry 数组一一对应（即与 SceneMap.edges 顺序一致）。
 *   - bounds：全部箭头真实变换后顶点的紧致 NumericBox3（minY = maxY = Edge Arrow Y），
 *     供 computeContentBounds 合并。输入非空时 bounds 恒非空（每条边必产一个箭头）。
 *
 * 所有权不变量：主线程只把本结果填入单一 InstancedMesh（SPEC 10.1 LINE 与 BEZIER 共用一个 mesh），
 * 不再回读边 DTO 或重复推导车道偏移 / 弧长 / 切线 / 颜色。
 */
export interface EdgeArrowData {
  readonly matrices: Float32Array
  readonly colors: Float32Array
  readonly arrowCount: number
  readonly bounds: NumericBox3
}

/*
 * 构造边箭头错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分实例数据；message 含可读中文，便于 overlay 与测试匹配。
 */
function edgeArrowError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
  entityId?: string | null,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: EDGE_ARROW_LOGICAL_PATH,
    entityId: entityId ?? null,
    context,
  })
}

/*
 * 按 isBackEdge 选择边箭头线性颜色（SPEC 7.2 / 10.2）。
 * 返回只读三元组 [r, g, b]，调用方据此为该箭头写入颜色。
 * isBackEdge 只影响颜色选择，不影响 tip 位置、切线、旋转或车道偏移。
 */
function resolveEdgeArrowColor(
  isBackEdge: boolean,
): readonly [number, number, number] {
  return isBackEdge ? EDGE_ARROW_BACK_COLOR : EDGE_ARROW_FORWARD_COLOR
}

/*
 * 沿偏移后折线按累计弧长定位 tip，并取出 tip 所在段的单位切线（SPEC 10.2 弧长定位）。
 *
 * - 在 cumulativeArcLength 上线性扫描包含 targetArc 的段 [i, i+1]（cum[i] ≤ targetArc < cum[i+1]）。
 * - 段内按弧长比例 frac 线性插值 tip 坐标；切线直接复用 segmentTangents[i]，不做二次推导。
 * - 严禁用贝塞尔参数 t 替代弧长比例：累计弧长才是 tip 定位的唯一依据。
 *
 * 异常不变量：定位段弧长非有限或 ≤ TANGENT_EPSILON 视为零切线段，整体报错；
 * 禁止取相邻段或零角度降级。
 */
function locateTipAndTangent(
  lane: LaneGeometry,
  targetArc: number,
): { readonly tipX: number; readonly tipZ: number; readonly tx: number; readonly tz: number } {
  const cum = lane.cumulativeArcLength
  const pts = lane.points
  const n = pts.length
  // 扫描定位段：cum[i+1] < targetArc 时继续推进；保证 i 停在包含 targetArc 的段（末段含等号）。
  let i = 0
  while (i < n - 1 && cum[i + 1] < targetArc) {
    i++
  }
  const segStart = cum[i]
  const segEnd = cum[i + 1]
  const segLen = segEnd - segStart
  // 定位段弧长必须有限且 > TANGENT_EPSILON，否则视为零切线段（SPEC 5.3 第 10 项 / 任务约束）。
  if (!Number.isFinite(segLen) || segLen <= TANGENT_EPSILON) {
    throw edgeArrowError(
      `边 ${lane.edgeId} 箭头定位段 ${i} 弧长 ${segLen} 无效（非有限或 ≤ ${TANGENT_EPSILON}m），存在零切线。`,
      { edgeId: lane.edgeId, segmentIndex: i, segmentArcLength: segLen },
      lane.edgeId,
    )
  }
  // 段内弧长比例插值 tip（线性插值等价于按弧长比例取点，因段内折线为直线）。
  const frac = (targetArc - segStart) / segLen
  const p0 = pts[i]
  const p1 = pts[i + 1]
  const tipX = p0.x + frac * (p1.x - p0.x)
  const tipZ = p0.z + frac * (p1.z - p0.z)
  // 切线直接复用 tip 所在段单位切线，不再从原始边重新推导。
  const tangent = lane.segmentTangents[i]
  return { tipX, tipZ, tx: tangent.x, tz: tangent.z }
}

/*
 * 边箭头实例数据生成主入口（SPEC 4.1 / 10.1 / 10.2）。
 *
 * 调用方契约：
 *   - 输入是 TASK-006 交付的 LaneGeometry 数组（偏移后折线 + 累计弧长 + 段切线 + isBackEdge），
 *     顺序与 SceneMap.edges 一致，实例顺序与来源边一一对应。
 *   - 成功返回 EdgeArrowData：单一合并 matrices / colors typed array、arrowCount 与真实几何 bounds。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：零切线、无效累计弧长、车道结构不一致、非有限采样点或
 *     非有限输出均整体拒绝，不返回部分实例或填默认值。
 *
 * 矩阵写入（列主序 T × R × S，见模块头不变量）：
 *   - m[0] = cos·L、m[2] = -sin·L、m[8] = sin·L、m[10] = cos·L；
 *     m[5] = 1（Y 不缩放）；m[12]/m[13]/m[14] = tipX / 0.014 / tipZ；m[15] = 1。
 *   - 行主序实现会把平移放到索引 3/7/11、把 -sin/sin 放到 1/8，本布局会使其失败。
 */
export function buildEdgeArrowData(
  tracks: readonly LaneGeometry[],
): EdgeArrowData {
  // 空输入无法产生有意义的箭头与 bounds；视为几何异常整体拒绝（与 ribbon 空输入一致）。
  if (tracks.length === 0) {
    throw edgeArrowError('边箭头输入轨迹为空，无法生成实例数据。')
  }

  const arrowCount = tracks.length
  // 预分配连续 Float32 结果：matrices = arrowCount × 16，colors = arrowCount × 3（SPEC 5.2 / 10.1）。
  const matrices = new Float32Array(arrowCount * 16)
  const colors = new Float32Array(arrowCount * 3)

  // bounds 累计器（number 精度）：扫描实际发射箭头的真实变换后顶点；minY = maxY = Edge Arrow Y。
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (let i = 0; i < arrowCount; i++) {
    const lane = tracks[i]
    const pts = lane.points

    // 车道结构一致性校验：points ≥ 2、cumulativeArcLength 等长、segmentTangents 等段数。
    // 结构不一致属于不支持的车道几何，整体失败，不取默认段或跳过。
    if (
      pts.length < 2 ||
      lane.cumulativeArcLength.length !== pts.length ||
      lane.segmentTangents.length !== pts.length - 1
    ) {
      throw edgeArrowError(
        `边 ${lane.edgeId} 车道几何结构不一致（points=${pts.length}、cum=${lane.cumulativeArcLength.length}、tan=${lane.segmentTangents.length}），无法定位边箭头。`,
        {
          edgeId: lane.edgeId,
          pointsLength: pts.length,
          cumulativeLength: lane.cumulativeArcLength.length,
          tangentsLength: lane.segmentTangents.length,
        },
        lane.edgeId,
      )
    }

    // 非有限采样点整体失败（SPEC 16 / 任务异常路径）：任一偏移后中心线点含 NaN / Infinity
    // 立即整体失败，杜绝非有限几何泄漏到箭头矩阵。无论 NaN 位于哪一段都拦截。
    for (let p = 0; p < pts.length; p++) {
      if (!Number.isFinite(pts[p].x) || !Number.isFinite(pts[p].z)) {
        throw edgeArrowError(
          `边 ${lane.edgeId} 偏移后中心线第 ${p} 个点含非有限坐标，无法生成边箭头。`,
          { edgeId: lane.edgeId, pointIndex: p, x: pts[p].x, z: pts[p].z },
          lane.edgeId,
        )
      }
    }

    // 总弧长有效性（SPEC 10.2 / 任务“无效累计弧长”异常路径）：
    // 非有限或 ≤ TANGENT_EPSILON 视为零长度轨迹，整体失败，禁止用零弧长定位 tip。
    const total = lane.totalArcLength
    if (!Number.isFinite(total) || total <= TANGENT_EPSILON) {
      throw edgeArrowError(
        `边 ${lane.edgeId} 总弧长 ${total} 无效（非有限或 ≤ ${TANGENT_EPSILON}m），无法定位边箭头。`,
        { edgeId: lane.edgeId, totalArcLength: total },
        lane.edgeId,
      )
    }

    // 短边自适应箭长 L = min(0.30, total × 0.32)（SPEC 10.2）；0.32 < 0.40 保证箭身不越过起点。
    const arrowLen = Math.min(EDGE_ARROW_MAX_LENGTH, total * EDGE_ARROW_LENGTH_RATIO)
    if (!Number.isFinite(arrowLen) || arrowLen <= 0) {
      // total > TANGENT_EPSILON 已保证 arrowLen > 0；此处防御性兜底非法常量。
      throw edgeArrowError(
        `边 ${lane.edgeId} 箭头长度 ${arrowLen} 非有限或非正，无法生成边箭头。`,
        { edgeId: lane.edgeId, arrowLength: arrowLen, totalArcLength: total },
        lane.edgeId,
      )
    }

    // tip 位于总弧长 40% 处（按累计弧长定位，非贝塞尔参数 t = 0.4）。
    const targetArc = total * EDGE_ARROW_TIP_ARC_RATIO
    const { tipX, tipZ, tx, tz } = locateTipAndTangent(lane, targetArc)

    // tip 坐标有限性（捕获定位插值产生的 NaN）。
    if (!Number.isFinite(tipX) || !Number.isFinite(tipZ)) {
      throw edgeArrowError(
        `边 ${lane.edgeId} 边箭头 tip 坐标含非有限数。`,
        { edgeId: lane.edgeId, tipX, tipZ },
        lane.edgeId,
      )
    }

    // 段切线有效性（SPEC 5.3 第 10 项 / 任务“零切线”异常路径）：
    // 单位切线长度 ≤ TANGENT_EPSILON 视为零切线，整体失败，禁止零角度降级。
    const tangentLen = Math.hypot(tx, tz)
    if (!Number.isFinite(tangentLen) || tangentLen <= TANGENT_EPSILON) {
      throw edgeArrowError(
        `边 ${lane.edgeId} 边箭头定位段切线长度 ${tangentLen} 无效（非有限或 ≤ ${TANGENT_EPSILON}m），存在零切线。`,
        { edgeId: lane.edgeId, tangentLength: tangentLen, tx, tz },
        lane.edgeId,
      )
    }

    // 旋转 yaw = atan2(-tz, tx)：使局部 +X（tip 朝向）对齐行驶方向 (tx,tz)（SPEC 10.2）。
    // 单位切线下 cos(yaw) = tx、sin(yaw) = -tz；数值 cos/sin 决定方向映射，不做特殊常量比较。
    const yaw = Math.atan2(-tz, tx)
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)

    // 列主序实例矩阵 T × R × S（见模块头不变量）。缩放 S = diag(L, 1, L) 与旋转 R 相乘后，
    // 旋转列被箭长等比缩放：m[0]/m[2] = (cos/-sin)·L，m[8]/m[10] = (sin/cos)·L。
    const m = i * 16
    matrices[m + 0] = cos * arrowLen // 列 0 行 0：cos·L
    matrices[m + 1] = 0
    matrices[m + 2] = -sin * arrowLen // 列 0 行 2：-sin·L
    matrices[m + 3] = 0
    matrices[m + 4] = 0
    matrices[m + 5] = 1 // 列 1 行 1：Y 不缩放
    matrices[m + 6] = 0
    matrices[m + 7] = 0
    matrices[m + 8] = sin * arrowLen // 列 2 行 0：sin·L
    matrices[m + 9] = 0
    matrices[m + 10] = cos * arrowLen // 列 2 行 2：cos·L
    matrices[m + 11] = 0
    matrices[m + 12] = tipX // 列 3 行 0：平移 X = tipX
    matrices[m + 13] = EDGE_ARROW_Y // 列 3 行 1：平移 Y = Edge Arrow Y
    matrices[m + 14] = tipZ // 列 3 行 2：平移 Z = tipZ
    matrices[m + 15] = 1 // 列 3 行 3：齐次 1

    // 线性颜色写入（r, g, b）；颜色由 isBackEdge 选择，已在模块加载时一次性线性化。
    const color = resolveEdgeArrowColor(lane.isBackEdge)
    const c = i * 3
    colors[c + 0] = color[0]
    colors[c + 1] = color[1]
    colors[c + 2] = color[2]

    // 真实几何 bounds 贡献（SPEC 12.1）：对基准三角形 3 个顶点做与矩阵一致的 T × R × S 变换，
    // 取紧致 AABB。局部顶点 (lx, lz) ∈ {(0, 0), (-1, -0.55), (-1, 0.55)}（ly 恒 0），
    // 变换后 wx = tipX + (cos·lx + sin·lz)·L、wz = tipZ + (-sin·lx + cos·lz)·L、wy = Edge Arrow Y。
    for (let v = 0; v < EDGE_ARROW_VERTICES.length; v += 3) {
      const lx = EDGE_ARROW_VERTICES[v]
      const lz = EDGE_ARROW_VERTICES[v + 2] // 顶点 y 分量恒为 0，跳过 ly
      const wx = tipX + (cos * lx + sin * lz) * arrowLen
      const wz = tipZ + (-sin * lx + cos * lz) * arrowLen
      if (wx < minX) minX = wx
      if (wx > maxX) maxX = wx
      if (wz < minZ) minZ = wz
      if (wz > maxZ) maxZ = wz
    }
  }

  // 有限性不变量（SPEC 16）：matrices / colors / bounds 任一非有限立即整体失败。
  // 该断言同时兜底“非法视觉常量”——若箭长 / 颜色常量被未来编辑破坏为非有限，
  // 写入结果会在此被捕获，杜绝非有限数据泄漏到渲染层。
  assertFiniteEdgeArrow(matrices, colors, minX, minZ, maxX, maxZ)

  const bounds: NumericBox3 = {
    minX,
    minY: EDGE_ARROW_Y,
    minZ,
    maxX,
    maxY: EDGE_ARROW_Y,
    maxZ,
  }

  return {
    matrices,
    colors,
    arrowCount,
    bounds,
  }
}

/*
 * 断言全部输出为有限数（SPEC 16：任何 NaN / Infinity 立即构建失败）。
 * 逐一检查 matrices、colors 与 bounds 四个 X/Z 分量；发现非有限值立即整体报错，
 * 不输出部分实例数据。bounds 的 minY / maxY 恒为 Edge Arrow Y（常量），由构造保证有限。
 */
function assertFiniteEdgeArrow(
  matrices: Float32Array,
  colors: Float32Array,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): void {
  for (let i = 0; i < matrices.length; i++) {
    if (!Number.isFinite(matrices[i])) {
      throw edgeArrowError('边箭头实例矩阵含非有限数。', {
        index: i,
        value: matrices[i],
      })
    }
  }
  for (let i = 0; i < colors.length; i++) {
    if (!Number.isFinite(colors[i])) {
      throw edgeArrowError('边箭头实例颜色含非有限数。', {
        index: i,
        value: colors[i],
      })
    }
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxZ)
  ) {
    throw edgeArrowError('边箭头 bounds 含非有限数。', {
      minX,
      minZ,
      maxX,
      maxZ,
    })
  }
}
