/*
 * Ribbon 三角化与合并（geometry 层，SPEC 7.1 / 7.2 / 9.3 / 9.4 / 15.2 / 15.3 / 16）。
 *
 * 信任边界定位（TASK-007）：
 *   - 本模块消费 TASK-006 的 LaneGeometry（偏移后中心线 + isBackEdge 颜色语义），
 *     输出可直接交给渲染适配层的单一非索引 ribbon position/color 数据、数值 bounds 与顶点诊断。
 *   - 纯数值逻辑：不创建 Three BufferGeometry / BufferAttribute / Material / Mesh / React 对象。
 *   - 渲染层无需理解业务边、车道与三角化规则，只消费一份已验证数组与 bounds。
 *
 * 合并策略不变量（SPEC 9.4 / 15.3 / 任务约束）：
 *   - 全部业务边合并为一份连续 Float32 结果；不得为每条边创建单独结果对象供 JSX 遍历。
 *   - 后续只能创建一个 ribbon Mesh（SPEC 15.3：Ribbon Mesh = 1）。
 *   - 不去重、不合并业务边、不以后绘制者覆盖前者；每条边独立三角化后顺序拼接。
 *
 * 绕序不变量（SPEC 9.4 第 4 / 5 项，从 +Y 观察恒为逆时针）：
 *   - 每段 quad 的两个三角形固定为 [startLeft, endRight, startRight] 与
 *     [startLeft, endLeft, endRight]，叉积法线指向 +Y。
 *   - 内部点 bevel 补片连接"上一段外点、中心点、下一段外点"；根据转向符号交换两个外点，
 *     使补片从 +Y 观察也始终为逆时针（禁止依赖双面材质掩盖错误绕序）。
 *
 * 端点不变量（SPEC 9.4 第 6 项 butt cap）：
 *   - 首尾使用 butt cap：既不延长中心线，也不增加圆帽 / 方帽。
 *   - 首段 startLeft / startRight 与末段 endLeft / endRight 即 ribbon 真实边界，不越界。
 *
 * 有限数不变量（SPEC 16 / 任务约束）：
 *   - 所有输出 position、color、bounds 必须为有限数；任何 NaN / Infinity 在跨层前立即失败。
 *   - 数值计算保持 JavaScript number 精度；只有最终 typed array 写入时转 Float32。
 *
 * 依赖方向（SPEC 3.3）：仅依赖 domain 与本层（trackModel / colorSpace）。
 */
import { MapDataError, MapErrorCode } from '../domain/mapDataError'
import type { NumericBox3, ScenePoint } from '../domain/sceneMap'
import { hexToLinearRGB } from './colorSpace'
import type { LaneGeometry } from './trackModel'

/*
 * SPEC 9.4 第 2 项：ribbon 半宽（米）。固定 0.025m（全宽 0.05m）。
 * 这是 SPEC 9.4 明确给出的三角化算法参数，属几何层常量；
 * 渲染层如同名视觉常量由 config 自行定义，两层引用同一 SPEC 来源，不形成第二套语义。
 */
export const RIBBON_HALF_WIDTH = 0.025

/*
 * SPEC 9.4 第 1 项：连续重复点清理阈值（米）。距前一点 < 本值的点视为重复并删除。
 * 与 TANGENT_EPSILON 同源（SPEC 5.3 第 10 项 / 9.4），单独定义避免跨模块耦合。
 */
const RIBBON_DEDUP_EPSILON = 1e-9

/*
 * SPEC 7.2 / 9.1 / 9.4：ribbon 颜色仅由 isBackEdge 选择。
 *   - isBackEdge = false：灰色 #BDBDBD。
 *   - isBackEdge = true：红色 #E57373。
 * isBackEdge 只决定颜色，不改变中心线、车道偏移或顶点顺序。
 * hex 值与 config 颜色表同源（SPEC 7.2），两层各自引用同一规格，不形成隐式第二套语义。
 * 颜色在模块加载时一次性线性化，避免每顶点重复转换。
 */
const RIBBON_FORWARD_COLOR = hexToLinearRGB('#BDBDBD')
const RIBBON_BACK_COLOR = hexToLinearRGB('#E57373')

/*
 * Ribbon 几何 Y 固定为 0：几何层只表达 x-z 平面 ribbon（SPEC 6.2 单次坐标转换不变量）。
 * 渲染层把 Mesh 平移到 Ribbon Y（SPEC 7.1 Ribbon Y = 0.006），该值由 config 决定，
 * 不进入几何数据；因此 ribbon bounds 的 minY = maxY = 0。
 */
const RIBBON_GEOMETRY_Y = 0

/*
 * 几何层逻辑路径前缀：ribbon 错误发生在已偏移的 LaneGeometry 上，不对应原始 JSON path。
 * 用稳定逻辑路径让测试与诊断可定位失败位置，同时不伪造原始响应路径。
 */
const RIBBON_LOGICAL_PATH = 'sceneMap.edges#ribbon'

/*
 * Ribbon 输出契约（SPEC 5.2 ribbonPositions / ribbonColors / ribbonVertexCount）。
 *
 * 字段语义：
 *   - positions：非索引顶点坐标 Float32Array，长度 = vertexCount × 3，元素序为 (x, y, z)，y 恒为 0。
 *   - colors：线性 sRGB [0,1] Float32Array，长度 = vertexCount × 3，元素序为 (r, g, b)。
 *   - vertexCount：非索引顶点总数（真实样本固定 48,669），等价 SceneDiagnostics.ribbonVertexCount。
 *   - bounds：ribbon 数值 bounds（NumericBox3），minY = maxY = 0；供后续 computeContentBounds 合并。
 *
 * 合并不变量：positions / colors 是全部业务边的单一份连续结果，渲染层只创建一个 Mesh。
 */
export interface RibbonGeometry {
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly vertexCount: number
  readonly bounds: NumericBox3
}

/*
 * 构造 ribbon 几何错误（SPEC 14.1 MAP_GEOMETRY_INVALID）。
 * 整体拒绝，不返回部分 ribbon；message 含可读中文，便于 overlay 与测试匹配。
 */
function ribbonError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
): MapDataError {
  return new MapDataError({
    code: MapErrorCode.MAP_GEOMETRY_INVALID,
    message,
    jsonPath: RIBBON_LOGICAL_PATH,
    context,
  })
}

/*
 * 按 isBackEdge 选择 ribbon 线性颜色（SPEC 7.2 / 9.1 / 9.4）。
 * 返回只读三元组 [r, g, b]，调用方据此为该边全部顶点写入相同颜色。
 * isBackEdge 只影响颜色选择，不影响点序、车道或顶点排列。
 */
function resolveRibbonColor(
  isBackEdge: boolean,
): readonly [number, number, number] {
  return isBackEdge ? RIBBON_BACK_COLOR : RIBBON_FORWARD_COLOR
}

/*
 * 连续重复点清理（SPEC 9.4 第 1 项）。
 * 删除与前一个保留点欧氏距离 < RIBBON_DEDUP_EPSILON 的点；首点始终保留。
 * 返回 number 精度的 ScenePoint[]（未做任何取整），供后续三角化使用。
 *
 * 有限性前置不变量（SPEC 16 / TASK-007 关键异常路径）：
 *   - 去重前必须先逐点确认坐标均为有限数，任一非有限立即整体失败。
 *   - 必要性：Math.hypot 对 NaN 参数返回 NaN，而 NaN >= RIBBON_DEDUP_EPSILON 恒为 false；
 *     若不在此显式拦截，位于序列中间或末尾的 NaN 点会被当作重复点静默丢弃，
 *     可能把含 NaN 的 3 点折线压成 2 点合法折线后构建成功，让非有限几何泄漏到
 *     ribbon 输出，违反“注入非有限坐标 → 构建立即失败”的契约。
 *   - edgeId 只用于错误上下文定位，不参与去重判定。
 */
function dedupConsecutive(
  points: readonly ScenePoint[],
  edgeId: string,
): ScenePoint[] {
  if (points.length === 0) return []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) {
      throw ribbonError(
        `边 ${edgeId} 偏移后中心线第 ${i} 个点含非有限坐标，无法三角化。`,
        { edgeId, pointIndex: i, x: p.x, z: p.z },
      )
    }
  }
  const kept: ScenePoint[] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const last = kept[kept.length - 1]
    const dx = points[i].x - last.x
    const dz = points[i].z - last.z
    if (Math.hypot(dx, dz) >= RIBBON_DEDUP_EPSILON) {
      kept.push(points[i])
    }
  }
  return kept
}

/*
 * Ribbon 三角化主入口：合并全部业务边为一份非索引 position/color + bounds（SPEC 9.4）。
 *
 * 调用方契约：
 *   - 输入是 TASK-006 交付的 LaneGeometry 数组（偏移后中心线 + isBackEdge）。
 *   - 成功返回 RibbonGeometry：单一合并 Float32 positions / colors、顶点诊断与有限 bounds。
 *   - 失败抛出 MAP_GEOMETRY_INVALID：清理后不足 2 点、退化段、非有限输出均整体拒绝，
 *     不返回空或部分 ribbon。
 *
 * 顶点预算（SPEC 9.4 / 15.3，真实样本固定 48,669）：
 *   - 每段 quad 贡献 6 个非索引顶点；每个内部点贡献 3 个 bevel 顶点。
 *   - LINE（2 点 / 1 段 / 0 内部）= 6；BEZIER（33 点 / 32 段 / 31 内部）= 192 + 93 = 285。
 *   - 2934 × 6 + 109 × 285 = 17,604 + 31,065 = 48,669。
 */
export function buildRibbonGeometry(
  tracks: readonly LaneGeometry[],
): RibbonGeometry {
  if (tracks.length === 0) {
    // 空输入无法产生有意义的 bounds 与顶点；视为几何异常整体拒绝。
    throw ribbonError('ribbon 输入轨迹为空，无法生成几何。')
  }

  // 1. 每条边偏移后中心线连续重复点清理（SPEC 9.4 第 1 项）；清理后不足 2 点整体报错。
  const cleaned: ScenePoint[][] = new Array<ScenePoint[]>(tracks.length)
  for (let i = 0; i < tracks.length; i++) {
    const pts = dedupConsecutive(tracks[i].points, tracks[i].edgeId)
    if (pts.length < 2) {
      throw ribbonError(
        `边 ${tracks[i].edgeId} 偏移后中心线清理后仅 ${pts.length} 个有效点，少于 2 点，无法三角化。`,
        { edgeId: tracks[i].edgeId, pointCount: pts.length },
      )
    }
    cleaned[i] = pts
  }

  // 2. 预计算总顶点数：每段 6 顶点 quad + 每个内部点 3 顶点 bevel（SPEC 9.4 第 3 / 5 项）。
  //    每个内部点恒发一个 bevel（含近直行退化情况），与真实样本 48,669 顶点预算一致。
  let totalVertexCount = 0
  for (const pts of cleaned) {
    const segments = pts.length - 1
    const internalPoints = pts.length - 2 // pts.length >= 2 保证 internalPoints >= 0
    totalVertexCount += segments * 6 + internalPoints * 3
  }

  // 3. 预分配连续 Float32 结果（SPEC 9.4 合并为一份；禁止索引几何与 Uint16 容量假设）。
  const positions = new Float32Array(totalVertexCount * 3)
  const colors = new Float32Array(totalVertexCount * 3)

  // 4. bounds 累计器（number 精度，扫描实际发射顶点；minY = maxY = RIBBON_GEOMETRY_Y = 0）。
  //    使用可变 let 变量累计，结束时再组装为只读 NumericBox3，避免对 readonly 字段赋值。
  let minX = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  let pv = 0 // 顶点写入游标（按顶点计，非按分量计）

  // 写入一个顶点 (x, y=0, z) 与其线性颜色，并更新 bounds（闭包捕获输出数组与游标）。
  const writeVertex = (
    px: number,
    pz: number,
    cr: number,
    cg: number,
    cb: number,
  ): void => {
    const i3 = pv * 3
    positions[i3] = px
    positions[i3 + 1] = RIBBON_GEOMETRY_Y
    positions[i3 + 2] = pz
    colors[i3] = cr
    colors[i3 + 1] = cg
    colors[i3 + 2] = cb
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (pz < minZ) minZ = pz
    if (pz > maxZ) maxZ = pz
    pv += 1
  }

  // 5. 逐边发射 quad + bevel（SPEC 9.4 第 3 / 4 / 5 项）。
  for (let li = 0; li < tracks.length; li++) {
    const pts = cleaned[li]
    const n = pts.length
    const color = resolveRibbonColor(tracks[li].isBackEdge)
    const cr = color[0]
    const cg = color[1]
    const cb = color[2]

    // 在清理结果上重新计算每段单位切线（SPEC 9.4 第 2 项）。
    // 清理可能改变点序长度，故不复用 LaneGeometry.segmentTangents，保证 quad / bevel
    // 与实际发射点严格一致；左法线固定 (-tz, tx)。
    const tangentsX: number[] = new Array<number>(n - 1)
    const tangentsZ: number[] = new Array<number>(n - 1)
    for (let s = 0; s < n - 1; s++) {
      const dx = pts[s + 1].x - pts[s].x
      const dz = pts[s + 1].z - pts[s].z
      const len = Math.hypot(dx, dz)
      // 清理阈值保证 len >= RIBBON_DEDUP_EPSILON > 0；防御性仍校验退化段。
      if (!(len > 0)) {
        throw ribbonError(
          `边 ${tracks[li].edgeId} 第 ${s} 段长度 ${len} 退化，无法计算单位切线。`,
          { edgeId: tracks[li].edgeId, segmentIndex: s, length: len },
        )
      }
      tangentsX[s] = dx / len
      tangentsZ[s] = dz / len
    }

    // 每段发射一个独立 quad：6 个非索引顶点，两个三角形从 +Y 观察为逆时针（SPEC 9.4 第 4 项）。
    for (let s = 0; s < n - 1; s++) {
      const tx = tangentsX[s]
      const tz = tangentsZ[s]
      // 左法线 = (-tz, tx)；半宽沿左 / 右法线偏移。
      const leftNx = -tz
      const leftNz = tx
      const sx = pts[s].x
      const sz = pts[s].z
      const ex = pts[s + 1].x
      const ez = pts[s + 1].z
      const startLeftX = sx + leftNx * RIBBON_HALF_WIDTH
      const startLeftZ = sz + leftNz * RIBBON_HALF_WIDTH
      const startRightX = sx - leftNx * RIBBON_HALF_WIDTH
      const startRightZ = sz - leftNz * RIBBON_HALF_WIDTH
      const endLeftX = ex + leftNx * RIBBON_HALF_WIDTH
      const endLeftZ = ez + leftNz * RIBBON_HALF_WIDTH
      const endRightX = ex - leftNx * RIBBON_HALF_WIDTH
      const endRightZ = ez - leftNz * RIBBON_HALF_WIDTH
      // 三角形 A：[startLeft, endRight, startRight]。
      writeVertex(startLeftX, startLeftZ, cr, cg, cb)
      writeVertex(endRightX, endRightZ, cr, cg, cb)
      writeVertex(startRightX, startRightZ, cr, cg, cb)
      // 三角形 B：[startLeft, endLeft, endRight]。
      writeVertex(startLeftX, startLeftZ, cr, cg, cb)
      writeVertex(endLeftX, endLeftZ, cr, cg, cb)
      writeVertex(endRightX, endRightZ, cr, cg, cb)
    }

    // 每个内部点发射 bevel 补片：外侧缺口一个三角形（SPEC 9.4 第 5 项）。
    // 根据转向符号决定外侧与是否交换两个外点，保证从 +Y 观察恒为逆时针。
    for (let s = 1; s < n - 1; s++) {
      // s 为内部点在 pts 中的索引；前段切线 = tangents[s-1]，后段切线 = tangents[s]。
      const tpX = tangentsX[s - 1]
      const tpZ = tangentsZ[s - 1]
      const tnX = tangentsX[s]
      const tnZ = tangentsZ[s]
      // 2D 叉积（x-z 平面）：turn = Tp.x * Tn.z - Tp.z * Tn.x。
      // turn > 0 为左转、turn < 0 为右转、turn = 0 为直行（退化补片，仍占 3 顶点以匹配预算）。
      const turn = tpX * tnZ - tpZ * tnX
      const cx = pts[s].x
      const cz = pts[s].z
      // 前段 / 后段左法线。
      const leftNxPrev = -tpZ
      const leftNzPrev = tpX
      const leftNxNext = -tnZ
      const leftNzNext = tnX
      const prevEndLeftX = cx + leftNxPrev * RIBBON_HALF_WIDTH
      const prevEndLeftZ = cz + leftNzPrev * RIBBON_HALF_WIDTH
      const prevEndRightX = cx - leftNxPrev * RIBBON_HALF_WIDTH
      const prevEndRightZ = cz - leftNzPrev * RIBBON_HALF_WIDTH
      const nextStartLeftX = cx + leftNxNext * RIBBON_HALF_WIDTH
      const nextStartLeftZ = cz + leftNzNext * RIBBON_HALF_WIDTH
      const nextStartRightX = cx - leftNxNext * RIBBON_HALF_WIDTH
      const nextStartRightZ = cz - leftNzNext * RIBBON_HALF_WIDTH
      if (turn >= 0) {
        // 左转（含直行退化）：外侧 = 右侧，无需交换。
        // (prevEndRight, center, nextStartRight) 从 +Y 观察为逆时针。
        writeVertex(prevEndRightX, prevEndRightZ, cr, cg, cb)
        writeVertex(cx, cz, cr, cg, cb)
        writeVertex(nextStartRightX, nextStartRightZ, cr, cg, cb)
      } else {
        // 右转：外侧 = 左侧，交换两个外点以保持 +Y 绕序。
        // (nextStartLeft, center, prevEndLeft) 从 +Y 观察为逆时针。
        writeVertex(nextStartLeftX, nextStartLeftZ, cr, cg, cb)
        writeVertex(cx, cz, cr, cg, cb)
        writeVertex(prevEndLeftX, prevEndLeftZ, cr, cg, cb)
      }
    }
  }

  // minY / maxY 全部顶点恒为 RIBBON_GEOMETRY_Y，扫描中未更新；这里显式落定。
  const minY = RIBBON_GEOMETRY_Y
  const maxY = RIBBON_GEOMETRY_Y

  // 6. 写入游标必须等于预算（保证无越界、无遗漏）。
  if (pv !== totalVertexCount) {
    throw ribbonError('ribbon 顶点写入数与预算不符，发射逻辑错误。', {
      written: pv,
      budget: totalVertexCount,
    })
  }

  // 7. 有限性不变量（SPEC 16）：positions / colors / bounds 任一非有限立即失败。
  assertFiniteRibbon(positions, colors, minX, minY, minZ, maxX, maxY, maxZ)

  const bounds: NumericBox3 = { minX, minY, minZ, maxX, maxY, maxZ }

  return {
    positions,
    colors,
    vertexCount: totalVertexCount,
    bounds,
  }
}

/*
 * 断言全部输出为有限数（SPEC 16：任何 NaN / Infinity 立即构建失败）。
 * 逐一检查 positions、colors 与 bounds 六个分量；发现非有限值立即整体报错。
 */
function assertFiniteRibbon(
  positions: Float32Array,
  colors: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw ribbonError('ribbon position 含非有限数。', {
        index: i,
        value: positions[i],
      })
    }
  }
  for (let i = 0; i < colors.length; i++) {
    if (!Number.isFinite(colors[i])) {
      throw ribbonError('ribbon color 含非有限数。', {
        index: i,
        value: colors[i],
      })
    }
  }
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(maxZ)
  ) {
    throw ribbonError('ribbon bounds 含非有限数。', {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
    })
  }
}
